import { ShardX } from "@proxyshard/shardx";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

const MEMORY_ARGS = [
  "--fleet-bot-browser",
  // "--in-process-gpu",
  // "--renderer-process-limit=1",
  "--disable-features=TranslateUI,BackForwardCache,IsolateOrigins,site-per-process",
  "--disable-site-isolation-trials",
  "--disable-dev-shm-usage",
  "--disable-background-networking",
];

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
  touchProfile(id);

  const session = await getSdk().launch(profile as never, {
    cdp: true,
    headless: opts.headless,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    extraArgs: [...MEMORY_ARGS, ...(opts.extraArgs ?? [])],
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
