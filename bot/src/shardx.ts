import { ShardX } from "@proxyshard/shardx";
import { createHash } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
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

export function profileIdFor(account: string): string {
  const key = (account || "").trim().toLowerCase();
  if (!key) {
    throw new Error("profileIdFor: empty account — refusing to let two bots share one fingerprint");
  }
  return `acct-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

interface ProfileShape {
  id?: string;
  config?: { webgl?: { renderer?: string } };
}

export async function resolveProfile(
  account: string,
): Promise<{ profile: unknown; id: string; created: boolean }> {
  const s = getSdk();
  const id = profileIdFor(account);

  if (s.listSavedProfiles().includes(id)) {
    return { profile: s.openProfile(id), id, created: false };
  }

  const platform = process.env.SHARDX_PLATFORM ?? "Windows";
  const fresh = (await s.createProfile(undefined, { platform })) as ProfileShape;

  const mintedId = String(fresh.id ?? "");
  if (mintedId && mintedId !== id) {
    const from = join(profilesDir(), mintedId);
    const to = join(profilesDir(), id);
    if (existsSync(to)) throw new Error(`account profile ${id} appeared during creation; refusing to replace its identity`);
    if (existsSync(from)) renameSync(from, to);
  }
  return { profile: s.openProfile(id), id, created: true };
}

export async function launchForAccount(opts: {
  account: string;
  headless: boolean;
  proxy?: string;
  extraArgs?: string[];
}): Promise<LaunchedBrowser> {
  const { profile, id, created } = await resolveProfile(opts.account);

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
      `shardx profile=${id} ${created ? "(NEW identity)" : "(existing identity)"} ` +
      `headless=${opts.headless} gpu="${renderer}"`,
  };
}
