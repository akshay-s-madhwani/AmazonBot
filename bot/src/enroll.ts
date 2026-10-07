import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNodeId } from "./node-id.js";

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

interface IdentityFile {
  secret?: unknown;
  /** The machine the identity was made on; a copied folder carries the wrong one. */
  hostname?: unknown;
}

function readIdentityFile(): IdentityFile | null {
  if (!existsSync(IDENTITY_FILE)) return null;
  try {
    return JSON.parse(readFileSync(IDENTITY_FILE, "utf8")) as IdentityFile;
  } catch {
    return null;
  }
}

function writeIdentityFile(secret: string): void {
  const body = { secret, short_id: shortIdFromSecret(secret), hostname: hostname() };
  writeFileSync(IDENTITY_FILE, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export function loadIdentity(): BotIdentity {
  const raw = readIdentityFile();
  if (raw && typeof raw.secret === "string" && raw.secret.length >= 16) {
    // Made before identities recorded their machine: claim it for this one.
    if (typeof raw.hostname !== "string") writeIdentityFile(raw.secret);
    return { secret: raw.secret, short_id: shortIdFromSecret(raw.secret) };
  }
  const secret = randomBytes(32).toString("base64url");
  writeIdentityFile(secret);
  return { secret, short_id: shortIdFromSecret(secret) };
}

/**
 * The bot id is this machine's .node-id, nothing else. An identity made on
 * another machine (the bot folder was copied) or an approval for a different
 * id is not this machine's: both files are deleted so it asks to join afresh,
 * under a new short id, as the id in .node-id. Returns why, for the log.
 */
export function discardForeignIdentity(nodeId: string): string[] {
  const reasons: string[] = [];
  const raw = readIdentityFile();
  if (raw && typeof raw.hostname === "string" && raw.hostname !== hostname()) {
    reasons.push(`its identity was made on ${raw.hostname}, this machine is ${hostname()}`);
  }
  const creds = loadCredentials();
  if (creds && creds.bot_id !== nodeId) {
    reasons.push(`it was approved as "${creds.bot_id}" but .node-id is "${nodeId}"`);
  }
  if (reasons.length > 0) {
    rmSync(IDENTITY_FILE, { force: true });
    rmSync(CREDENTIALS_FILE, { force: true });
  }
  return reasons;
}

let rejection: string | null = null;

/** Why the master is refusing this machine right now, if it is. */
export function enrollmentRejection(): string | null {
  return rejection;
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

  if (!resolveNodeId().id) {
    log("FATAL: this machine has no node id. Run setup again, or write one into bot/.node-id.");
    return null;
  }
  const identity = loadIdentity();
  const base = opts.masterUrl.replace(/\/+$/, "");
  const pretty = formatShortId(identity.short_id);
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  log("");
  log(`this machine is not part of the fleet yet.`);
  log(`  short id:  ${pretty}`);
  log(`  machine:   ${hostname()}`);
  log(`  node id:   ${resolveNodeId().id}`);
  log(`  master:    ${base}`);
  log(`approve it in the control panel (Bot Grid) — waiting...`);
  log("");

  let announced = false;
  let idTaken = false;
  for (let attempt = 0; opts.maxPolls === undefined || attempt < opts.maxPolls; attempt++) {
    try {
      // While the id is refused, announce every round: .node-id is read afresh
      // each time, so fixing the file is enough — no restart.
      if (!announced || idTaken || attempt % 12 === 0) {
        const nodeId = resolveNodeId().id;
        const res = await fetch(`${base}/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            secret: identity.secret,
            hostname: hostname(),
            // This machine's .node-id: the bot id it is approved as.
            node_id: nodeId,
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
        if (res.status === 400) {
          const err = ((await res.json().catch(() => ({}))) as { error?: string }).error;
          log(`FATAL: the master refused this machine's request: ${err ?? "HTTP 400"}`);
          return null;
        }
        if (!res.ok) throw new Error(`master returned HTTP ${res.status}`);
        announced = true;
        const ann = (await res.json().catch(() => ({}))) as { status?: string; reason?: string };
        const wasTaken = idTaken;
        idTaken = ann.status === "rejected" && ann.reason === "id_taken";
        if (idTaken) {
          rejection =
            `Rejected: id "${nodeId}" already exists. ` +
            `Update bot/.node-id with a unique id.`;
          if (!wasTaken || attempt % 12 === 0) log(rejection);
          await sleep(interval);
          continue;
        }
        rejection = null;
        if (wasTaken) log(`node id "${nodeId}" accepted — waiting for approval in the control panel`);
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

let refreshing: Promise<string | null> | null = null;
let lastRefreshAt = 0;
/** The master rate-limits /enroll* per address, shared by every process here. */
const REFRESH_MIN_MS = 30_000;

/**
 * The master answered 401 to `rejected`. Returns a token worth one retry, or
 * null: first the credentials file, in case another process on this machine
 * already refreshed; else a re-poll of enrollment with this machine's
 * identity. The master re-issues a token there when the one it holds no longer
 * verifies (approved before tokens were JWTs, or JWT_SECRET changed).
 */
export async function refreshApiToken(
  masterUrl: string,
  rejected: string,
  log: (msg: string) => void = (m) => console.log(`[enroll] ${m}`),
): Promise<string | null> {
  const onFile = loadCredentials();
  if (onFile && onFile.api_token !== rejected) return onFile.api_token;
  if (refreshing) return refreshing;
  if (Date.now() - lastRefreshAt < REFRESH_MIN_MS) return null;
  lastRefreshAt = Date.now();
  refreshing = (async () => {
    try {
      const identity = loadIdentity();
      const res = await fetch(`${masterUrl.replace(/\/+$/, "")}/enroll/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ short_id: identity.short_id, secret: identity.secret }),
      });
      if (!res.ok) {
        log(`token refresh: master returned HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as PollResponse;
      if (body.status !== "approved") {
        log(`token refresh: this machine is ${body.status} on the master — approve it in the control panel`);
        return null;
      }
      if (body.api_token === rejected) return null;
      saveCredentials({
        bot_id: body.bot_id,
        api_token: body.api_token,
        nats_url: body.nats_url,
        ...(body.nats_token ? { nats_token: body.nats_token } : {}),
      });
      log(`the master re-issued this bot's token — saved`);
      return body.api_token;
    } catch (err) {
      log(`token refresh failed: ${(err as Error).message}`);
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
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
