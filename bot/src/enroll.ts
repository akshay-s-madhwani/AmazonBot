import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
export const IDENTITY_FILE = join(PKG_ROOT, ".bot-identity.json");
export const CREDENTIALS_FILE = join(PKG_ROOT, ".fleet-credentials.json");

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const POLL_INTERVAL_MS = 5_000;

export interface BotIdentity {
  secret: string;
  short_id: string;
}

export interface FleetCredentials {
  bot_id: string;
  api_token: string;
  nats_url: string;
  nats_token?: string;
}

export function shortIdFromSecret(secret: string): string {
  const digest = createHash("sha256").update(secret).digest();
  let out = "";
  for (let i = 0; i < 8; i++) out += ALPHABET[digest[i]! % ALPHABET.length];
  return out;
}

export function formatShortId(shortId: string): string {
  return `${shortId.slice(0, 4)}-${shortId.slice(4)}`;
}

export function loadIdentity(): BotIdentity {
  if (existsSync(IDENTITY_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(IDENTITY_FILE, "utf8")) as { secret?: unknown };
      if (typeof raw.secret === "string" && raw.secret.length >= 16) {
        return { secret: raw.secret, short_id: shortIdFromSecret(raw.secret) };
      }
    } catch {
    }
  }
  const secret = randomBytes(32).toString("base64url");
  const identity: BotIdentity = { secret, short_id: shortIdFromSecret(secret) };
  writeFileSync(IDENTITY_FILE, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  return identity;
}

export function loadCredentials(): FleetCredentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as Partial<FleetCredentials>;
    if (!raw.bot_id || !raw.api_token || !raw.nats_url) return null;
    return raw as FleetCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: FleetCredentials): void {
  mkdirSync(PKG_ROOT, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(creds, null, 2)}\n`, "utf8");
}

export interface EnrollOptions {
  masterUrl: string;
  workerCount?: number;
  agentVersion?: string;
  log?: (msg: string) => void;
  pollIntervalMs?: number;
  maxPolls?: number;
}

type PollResponse =
  | { status: "pending" | "rejected" }
  | ({ status: "approved" } & FleetCredentials);

export async function ensureEnrolled(opts: EnrollOptions): Promise<FleetCredentials | null> {
  const log = opts.log ?? ((m: string) => console.log(`[enroll] ${m}`));
  const existing = loadCredentials();
  if (existing) return existing;

  const identity = loadIdentity();
  const base = opts.masterUrl.replace(/\/+$/, "");
  const pretty = formatShortId(identity.short_id);
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  log("");
  log(`this machine is not part of the fleet yet.`);
  log(`  short id:  ${pretty}`);
  log(`  machine:   ${hostname()}`);
  log(`  master:    ${base}`);
  log(`approve it in the control panel (Bot Grid) — waiting...`);
  log("");

  let announced = false;
  for (let attempt = 0; opts.maxPolls === undefined || attempt < opts.maxPolls; attempt++) {
    try {
      if (!announced || attempt % 12 === 0) {
        const res = await fetch(`${base}/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            secret: identity.secret,
            hostname: hostname(),
            os: osName(),
            agent_version: opts.agentVersion ?? "0.2.0",
            worker_count: opts.workerCount,
          }),
        });
        if (res.status === 409) {
          log(`FATAL: short id ${pretty} is already claimed by another machine.`);
          log(`delete ${IDENTITY_FILE} to generate a new identity, then restart.`);
          return null;
        }
        if (!res.ok) throw new Error(`master returned HTTP ${res.status}`);
        announced = true;
      }

      const poll = await fetch(`${base}/enroll/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ short_id: identity.short_id, secret: identity.secret }),
      });
      if (!poll.ok) throw new Error(`poll returned HTTP ${poll.status}`);
      const body = (await poll.json()) as PollResponse;

      if (body.status === "approved") {
        const creds: FleetCredentials = {
          bot_id: body.bot_id,
          api_token: body.api_token,
          nats_url: body.nats_url,
          ...(body.nats_token ? { nats_token: body.nats_token } : {}),
        };
        saveCredentials(creds);
        log(`approved — joined the fleet as "${creds.bot_id}"`);
        return creds;
      }
      if (body.status === "rejected") {
        log(`this machine's request was REJECTED by the operator.`);
        log(`delete ${IDENTITY_FILE} and restart to ask again.`);
        return null;
      }
    } catch (err) {
      log(`still waiting (${(err as Error).message}) — short id ${pretty}`);
    }
    await sleep(interval);
  }
  return null;
}

function osName(): string {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    default:
      return process.platform;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
