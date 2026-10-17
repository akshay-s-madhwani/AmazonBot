import { ShardX, type Profile } from "@proxyshard/shardx";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

const MEMORY_ARGS = [
  "--fleet-bot-browser",
  // "--in-process-gpu",
  // "--renderer-process-limit=1",
  "--disable-site-isolation-trials",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
];
const DISABLED_FEATURES = ["TranslateUI", "BackForwardCache", "IsolateOrigins", "site-per-process"];

/**
 * STEALTH (2026-10-09, after Amazon flagged the browser). Checked on
 * browserleaks.com against the real Chrome on the same machine. The ShardX
 * Windows templates as shipped gave every bot ONE odd identity:
 *   - timezone Europe/Warsaw, language pl-PL (186 of 236 templates) — on an
 *     Indian IP buying on amazon.in;
 *   - Russian Windows voices (Microsoft Irina/Pavel, all 131 Windows templates);
 *   - no canvas/WebGL/audio noise, so every account on a machine had the
 *     host's exact canvas hash, whatever GPU the profile claimed.
 * harden() fixes all three on each run profile: timezone and geolocation
 * follow the proxy's IP ("auto", resolved by ShardX at each launch), an
 * Indian-English language set and matching Windows voices are picked per
 * profile, and per-profile seeded noise is on. TLS (JA4) already matched real
 * Chrome; webdriver, CDP and WebRTC did not leak.
 */
const LOCALES: { weight: number; languages: string[]; accept: string; voices: [string, string][] }[] = [
  {
    weight: 5,
    languages: ["en-US", "en"],
    accept: "en-US,en;q=0.9",
    voices: [["David", "United States"], ["Mark", "United States"], ["Zira", "United States"]],
  },
  {
    weight: 2,
    languages: ["en-IN", "en-GB", "en-US", "en"],
    accept: "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
    voices: [["Heera", "India"], ["Ravi", "India"], ["David", "United States"], ["Zira", "United States"]],
  },
  {
    weight: 2,
    languages: ["en-GB", "en-US", "en"],
    accept: "en-GB,en-US;q=0.9,en;q=0.8",
    voices: [["Hazel", "United Kingdom"], ["George", "United Kingdom"], ["Susan", "United Kingdom"]],
  },
  {
    weight: 1,
    languages: ["en-US", "en", "hi"],
    accept: "en-US,en;q=0.9,hi;q=0.8",
    voices: [["David", "United States"], ["Zira", "United States"]],
  },
];
const VOICE_LANG: Record<string, string> = { "United States": "en-US", India: "en-IN", "United Kingdom": "en-GB" };
/** Noise vectors on by default; SHARDX_NOISE="" turns noise off, or names the vectors. */
const NOISE = (process.env.SHARDX_NOISE ?? "canvas,webgl,audio,client_rects").split(",").map((v) => v.trim()).filter(Boolean);

/** A stable pick in [0, 1) for this profile and purpose. */
function seeded(id: string, what: string): number {
  return createHash("sha256").update(`${id}:${what}`).digest().readUInt32BE(0) / 2 ** 32;
}

/** Applies the stealth settings above; true when the profile changed (save it). */
export function harden(profile: Profile): boolean {
  const cfg = profile.config as Record<string, any>;
  const before = JSON.stringify(cfg);

  cfg.timezone = "auto";
  cfg.geolocation = { mode: "auto" };

  let roll = seeded(profile.id, "locale") * LOCALES.reduce((n, l) => n + l.weight, 0);
  const locale = LOCALES.find((l) => (roll -= l.weight) < 0) ?? LOCALES[0]!;
  const nav = (cfg.navigator ??= {});
  nav.language = locale.languages[0];
  nav.languages = locale.languages;
  nav.accept_language = locale.accept;
  cfg.icu_locale = locale.languages[0];

  const speech = (cfg.speech ??= {});
  const remote = ((speech.voices ?? []) as { local_service?: boolean }[]).filter((v) => !v.local_service);
  speech.voices = [
    ...locale.voices.map(([name, country], i) => ({
      name: `Microsoft ${name} - English (${country})`,
      lang: VOICE_LANG[country],
      local_service: true,
      is_default: i === 0,
    })),
    ...remote,
  ];

  profile.setNoise(...(NOISE as Parameters<Profile["setNoise"]>));
  // setNoise only fills a knob that is missing, and the templates ship them
  // at 0 — which left WebGL and DOMRect noise on but doing nothing.
  const noise = cfg.noise as Record<string, Record<string, unknown>>;
  if (noise.webgl?.enabled) noise.webgl.intensity = 0.0005;
  if (noise.client_rects?.enabled) noise.client_rects.max_offset = 1;
  return JSON.stringify(cfg) !== before;
}

export interface LaunchedBrowser {
  session: {
    pid: number;
    cdpUrl: string | null;
    stop: (ms?: number) => Promise<void>;
    process: { stdout: Readable | null; stderr: Readable | null };
  };
  cdpUrl: string;
  pid: number;
  profileId: string;
  summary: string;
}

let sdk: ShardX | null = null;

export function profilesDir(): string {
  return process.env.SHARDX_PROFILES_DIR ?? join(process.cwd(), "browser-profiles");
}

function getSdk(): ShardX {
  if (!sdk) {
    sdk = new ShardX({ profilesDir: profilesDir() });
  }
  return sdk;
}

/**
 * ONE FRESH PROFILE PER RUN (2026-10-06). Every run starts on a newly minted
 * ShardX profile — new fingerprint, empty cookie jar — never one an earlier
 * run used. The profile is keyed on the run id, so a browser relaunched for
 * the SAME run (restore, reload) gets that run's profile back with its session.
 *
 * Old run profiles are deleted once unused for SHARDX_PROFILE_TTL_HOURS
 * (default 24): the slot touches a marker in its profile while the browser is
 * up, and each launch prunes the stale ones. The pre-2026-10-06 per-account
 * `acct-*` profiles are left alone.
 */
const RUN_PREFIX = "run-";
const LAST_USED = ".fleet-last-used";

export function profileIdForRun(runId: string): string {
  const key = (runId || "").trim();
  if (!key) throw new Error("profileIdForRun: empty run id — refusing to let two runs share one profile");
  return `${RUN_PREFIX}${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

interface ProfileShape {
  id?: string;
  config?: { webgl?: { renderer?: string } };
}

export async function resolveProfile(id: string): Promise<{ profile: unknown; id: string; created: boolean }> {
  const s = getSdk();
  if (s.listSavedProfiles().includes(id)) {
    return { profile: s.openProfile(id), id, created: false };
  }

  const platform = process.env.SHARDX_PLATFORM ?? "Windows";
  const fresh = (await s.createProfile(undefined, { platform })) as ProfileShape;

  const mintedId = String(fresh.id ?? "");
  if (mintedId && mintedId !== id) {
    const from = join(profilesDir(), mintedId);
    const to = join(profilesDir(), id);
    if (existsSync(to)) throw new Error(`profile ${id} appeared during creation; refusing to replace its identity`);
    if (existsSync(from)) renameSync(from, to);
  }
  return { profile: s.openProfile(id), id, created: true };
}

/** Marks a run profile as in use, so pruning leaves it alone. */
export function touchProfile(id: string): void {
  try {
    const dir = join(profilesDir(), id);
    if (existsSync(dir)) writeFileSync(join(dir, LAST_USED), new Date().toISOString());
  } catch {
    // Best effort: a missed touch only matters after a full TTL of silence.
  }
}

/** Deletes run profiles nobody has touched for the TTL. Never the one about to launch. */
export function pruneRunProfiles(keep: string): number {
  const ttlHours = Number(process.env.SHARDX_PROFILE_TTL_HOURS ?? 24);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) return 0;
  const cutoff = Date.now() - ttlHours * 3_600_000;
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(profilesDir());
  } catch {
    return 0;
  }
  for (const id of names) {
    if (!id.startsWith(RUN_PREFIX) || id === keep) continue;
    const dir = join(profilesDir(), id);
    try {
      const marker = join(dir, LAST_USED);
      const usedAt = statSync(existsSync(marker) ? marker : dir).mtimeMs;
      if (usedAt >= cutoff) continue;
      try {
        getSdk().deleteProfile(id);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
      removed += 1;
    } catch {
      // Locked by a live browser, or already gone: try again next launch.
    }
  }
  return removed;
}

export async function launchForRun(opts: {
  /** The run this browser belongs to: it gets its own profile, new on its first launch. */
  runId: string;
  headless: boolean;
  proxy?: string;
  extraArgs?: string[];
}): Promise<LaunchedBrowser> {
  const wanted = profileIdForRun(opts.runId);
  const pruned = pruneRunProfiles(wanted);
  if (pruned) console.log(`[shardx] removed ${pruned} unused run profile(s)`);
  const { profile, id, created } = await resolveProfile(wanted);
  if (harden(profile as Profile)) getSdk().saveProfile(profile as Profile);
  touchProfile(id);

  // ONE --disable-features: Chromium keeps only the last copy of a switch, so
  // a second one here would drop ShardX's WebGPU switch for a profile that
  // claims no WebGPU.
  const disabled = [...DISABLED_FEATURES, ...((profile as Profile).hasWebGPU ? [] : ["WebGPU"])];
  const session = await getSdk().launch(profile as never, {
    cdp: true,
    headless: opts.headless,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    extraArgs: [...MEMORY_ARGS, `--disable-features=${disabled.join(",")}`, ...(opts.extraArgs ?? [])],
    randomize: false,
  });

  if (!session.cdpUrl) {
    await session.stop().catch(() => { });
    throw new Error(
      "ShardX launched without a CDP url — the runner would have nothing to attach to",
    );
  }

  const renderer = (profile as ProfileShape).config?.webgl?.renderer ?? "?";
  return {
    session,
    cdpUrl: session.cdpUrl,
    pid: session.pid,
    profileId: id,
    summary:
      `shardx profile=${id} ${created ? "(new for this run)" : "(this run's, relaunched)"} ` +
      `headless=${opts.headless} gpu="${renderer}"`,
  };
}
