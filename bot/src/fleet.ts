import { hostname } from "node:os";
import { StartOutcomeUnknownError } from "./start-registry.js";
import { basename } from "node:path";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandSubject,
  heartbeatSubject,
  registerSubject,
  telemetrySubject,
  CommandEnvelopeSchema,
  StartJobPayloadSchema,
  type CommandAck,
  type CommandEnvelope,
  type EventType,
  type Heartbeat,
  type JobSpecSummary,
  type SlotSnapshot,
  type TelemetryEvent,
} from "@app/contracts";
import { connect, ensureStream, type Conn, type Logger } from "@app/transport";
import { refreshApiToken, type FleetCredentials } from "./enroll.js";
import { fromWire, type SheetJob } from "./job-client.js";


const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "..", "artifacts", ".fleet");

function artifactContentType(file: string): string {
  const f = file.toLowerCase();
  if (f.endsWith(".png")) return "image/png";
  if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "image/jpeg";
  if (f.endsWith(".webp")) return "image/webp";
  if (f.endsWith(".json")) return "application/json";
  if (f.endsWith(".html") || f.endsWith(".htm")) return "text/html";
  if (f.endsWith(".log") || f.endsWith(".txt") || f.endsWith(".ndjson")) return "text/plain";
  return "application/octet-stream";
}

export const AGENT_VERSION = "0.2.0";

/**
 * Thrown by a hook when this node holds no slot for the run it was asked
 * about. Not a failure: it is the answer the master needs to release the
 * run's account and row, so it is acked ok with outcome "no_slot".
 */
export class NoSlotError extends Error {}

export interface FleetHooks {
  /** stopAfter: park after this step index (a checkpoint); absent = run to the end. */
  startPushedJob(run_id: string, job: SheetJob, stopAfter?: number): Promise<string>;
  startJobs(instances: number): Promise<string[]>;
  /** unblocked: Remove blocks (RunnerConfig.unblocked) for this resume. */
  resumeRun(run_id: string, from?: number, stopAfter?: number, unblocked?: boolean): Promise<void>;
  reloadRow?(run_id: string): Promise<void>;
  cancelRun(run_id: string): Promise<void>;
  closeSession(run_id: string): Promise<void>;
  captureArtifacts(run_id: string): Promise<void>;
  pauseRun(run_id: string): Promise<void>;
  /** Stop one run's runner, keeping its browser — the run goes STUCK. */
  stopRun(run_id: string): Promise<void>;
  /** What this node knows about a run, for settling an unconfirmed start. */
  probeRun(run_id: string): Promise<Record<string, unknown>>;
  stopAll(): Promise<number>;
  reset(): Promise<number>;
  /** opts.from: run on from that step at once (Remove blocks) instead of waiting for Resume. */
  openBrowser(run_id: string, job_id: string | null, opts?: { from?: number; unblocked?: boolean }): Promise<void>;
  drain(): Promise<void>;
  updateConfig(patch: Record<string, unknown>): Promise<void>;
  slots(): SlotSnapshot[];
  workerCount(): number;
}

export interface FleetConfig {
  stateDir?: string;
  node_id: string;
  nats_url: string;
  nats_token?: string;
  master_url?: string;
  api_token?: string;
  heartbeatMs?: number;
  drainMs?: number;
  logger?: Logger;
}

export interface EmitInput {
  run_id: string;
  worker_id: number;
  event: EventType;
  step_index?: number | null;
  step_key?: string | null;
  attempt?: number;
  failure_code?: string | null;
  failure_detail?: string | null;
  artifacts?: Array<{ kind: string; ref: string }>;
  payload?: Record<string, unknown>;
}

export function fleetConfigFromCredentials(
  creds: FleetCredentials,
  masterUrl: string,
): FleetConfig {
  return {
    node_id: creds.bot_id,
    nats_url: creds.nats_url,
    ...(creds.nats_token ? { nats_token: creds.nats_token } : {}),
    master_url: masterUrl.replace(/\/+$/, ""),
    api_token: creds.api_token,
  };
}

export function fleetConfigFromEnv(node_id: string): FleetConfig | null {
  const nats_url = (process.env.MASTER_NATS_URL ?? "").trim();
  if (!nats_url) return null;
  if (!node_id) {
    throw new Error(
      "MASTER_NATS_URL is set but this machine has no node_id. Every fleet subject is " +
        "addressed by node_id, and a blank one would collide with every other blank node. " +
        "Set NODE_ID (or write bot/.node-id) before connecting to the master.",
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(node_id)) {
    throw new Error(
      `node_id "${node_id}" is not usable as a NATS subject token — use letters, digits, "-" or "_" only.`,
    );
  }
  return {
    node_id,
    nats_url,
    ...(process.env.NATS_TOKEN ? { nats_token: process.env.NATS_TOKEN } : {}),
    ...(process.env.MASTER_URL ? { master_url: process.env.MASTER_URL.replace(/\/+$/, "") } : {}),
    ...(process.env.MASTER_API_TOKEN ? { api_token: process.env.MASTER_API_TOKEN } : {}),
  };
}

export type UploadResult = { ok: true; url: string } | { ok: false; retriable: boolean };

interface OutboxRow {
  id: number;
  event: TelemetryEvent;
  worker_id: number;
}

export class FleetLink {
  private connecting = false;
  private readonly stateDir: string;
  private readonly outboxFile: string;
  private readonly seqFile: string;
  private conn: Conn | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private closed = false;
  private nextRowId = 1;
  private queue: OutboxRow[] = [];
  private seqByRun: Record<string, number> = {};
  private readonly log: Logger;

  private constructor(
    private readonly cfg: FleetConfig,
    private readonly hooks: FleetHooks,
  ) {
    this.stateDir = cfg.stateDir ?? STATE_DIR;
    this.outboxFile = join(this.stateDir, "outbox.ndjson");
    this.seqFile = join(this.stateDir, "seq.json");
    this.log = cfg.logger ?? {
      info: (m) => console.log(`[fleet] ${m}`),
      warn: (m) => console.warn(`[fleet] ${m}`),
      error: (m) => console.error(`[fleet] ${m}`),
    };
  }

  static async start(cfg: FleetConfig, hooks: FleetHooks): Promise<FleetLink | null> {
    const link = FleetLink.buffer(cfg, hooks);
    link.connect();
    return link;
  }

  static buffer(cfg: FleetConfig, hooks: FleetHooks): FleetLink {
    const link = new FleetLink(cfg, hooks);
    link.loadState();
    return link;
  }

  connect(): void {
    if (this.connecting || this.closed) return;
    this.connecting = true;
    const link = this, cfg = this.cfg;
    link.heartbeatTimer = setInterval(() => link.beat(), cfg.heartbeatMs ?? 5_000);
    link.drainTimer = setInterval(() => void link.drain(), cfg.drainMs ?? 1_000);
    void link.connectInitially();
  }

  private async connectInitially(): Promise<void> {
    let attempt = 0;
    while (!this.closed) {
      try {
        const conn = await connect({ servers: [this.cfg.nats_url],
          ...(this.cfg.nats_token ? { token: this.cfg.nats_token } : {}),
          name: `node-${this.cfg.node_id}`, logger: this.log });
        if (this.closed) { await conn.close(); return; }
        this.conn = conn;
        await ensureStream(conn, { name: "TELEMETRY", subjects: ["fleet.telemetry.>"] });
        this.subscribeCommands();
        this.register();
        this.log.info(`linked to master as ${this.cfg.node_id}`);
        await this.drain();
        return;
      } catch (err) {
        await this.conn?.close().catch(() => {});
        this.conn = null;
        this.log.warn(`initial connection unavailable; telemetry remains buffered: ${(err as Error).message}`);
        if (this.closed) return;
        const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6));
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, delay + Math.random() * 250);
          timer.unref();
        });
      }
    }
  }


  register(): void {
    this.publish(registerSubject(this.cfg.node_id), {
      v: 1 as const,
      node_id: this.cfg.node_id,
      hostname: hostname(),
      os:
        process.platform === "win32"
          ? ("windows" as const)
          : process.platform === "darwin"
            ? ("macos" as const)
            : ("linux" as const),
      agent_version: AGENT_VERSION,
      worker_count: this.hooks.workerCount(),
    });
  }

  private beat(): void {
    const hb: Heartbeat = {
      node_id: this.cfg.node_id,
      ts: new Date().toISOString(),
      slots: this.hooks.slots(),
    };
    this.publish(heartbeatSubject(this.cfg.node_id), hb);
  }

  private publish(subject: string, obj: unknown): void {
    if (!this.conn) return;
    try {
      this.conn.publish(subject, obj);
    } catch (err) {
      this.log.warn(`publish to ${subject} failed: ${(err as Error).message}`);
    }
  }

  emit(input: EmitInput): TelemetryEvent {
    const seq = this.seqByRun[input.run_id] ?? 0;
    this.seqByRun[input.run_id] = seq + 1;

    const event: TelemetryEvent = {
      v: 1,
      node_id: this.cfg.node_id,
      worker_id: String(input.worker_id),
      run_id: input.run_id,
      seq,
      event: input.event,
      step_index: input.step_index ?? null,
      step_key: input.step_key ?? null,
      attempt: input.attempt ?? 1,
      ts: new Date().toISOString(),
      failure_code: input.failure_code ?? null,
      failure_detail: input.failure_detail ?? null,
      artifacts: input.artifacts ?? [],
      payload: input.payload ?? {},
    };

    const row: OutboxRow = { id: this.nextRowId++, event, worker_id: input.worker_id };
    this.queue.push(row);
    this.saveSeq();
    this.appendOutbox(row);
    return event;
  }

  async drain(): Promise<void> {
    if (this.draining || this.closed || !this.conn || this.queue.length === 0) return;
    this.draining = true;
    try {
      const batch = this.queue.slice(0, 100);
      let published = 0;
      for (const row of batch) {
        try {
          await this.conn.jsPublish(
            telemetrySubject(this.cfg.node_id, row.worker_id),
            row.event,
          );
          published += 1;
        } catch (err) {
          this.log.warn(
            `telemetry publish stalled at seq ${row.event.seq} of ${row.event.run_id}: ` +
              `${(err as Error).message} — retrying, nothing dropped`,
          );
          break;
        }
      }
      if (published > 0) {
        this.queue = this.queue.slice(published);
        this.rewriteOutbox();
      }
    } finally {
      this.draining = false;
    }
  }

  async uploadArtifact(input: {
    run_id: string;
    file: string;
    kind?: string;
    step_index?: number | null;
    step_key?: string | null;
  }): Promise<UploadResult> {
    const { master_url } = this.cfg;
    if (!master_url || !this.cfg.api_token) return { ok: false, retriable: false };
    let body: Buffer;
    try {
      body = await readFile(input.file);
    } catch (err) {
      this.log.warn(`artifact ${input.file} unreadable: ${(err as Error).message}`);
      return { ok: false, retriable: false };
    }
    const q = new URLSearchParams({
      run_id: input.run_id,
      kind: input.kind ?? "screenshot",
      node_id: this.cfg.node_id,
      filename: basename(input.file),
    });
    if (input.step_index !== null && input.step_index !== undefined) {
      q.set("step_index", String(input.step_index));
    }
    if (input.step_key) q.set("step_key", input.step_key);

    try {
      const send = (): Promise<Response> =>
        fetch(`${master_url}/artifacts?${q.toString()}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.cfg.api_token}`,
            "content-type": artifactContentType(input.file),
          },
          body: new Uint8Array(body),
        });
      let res = await send();
      // Token refused: pick up a re-issued one and retry once.
      if (res.status === 401) {
        const fresh = await refreshApiToken(master_url, this.cfg.api_token as string, (m) =>
          this.log.warn(m),
        );
        if (fresh) {
          this.cfg.api_token = fresh;
          res = await send();
        }
      }
      if (res.status === 401 || res.status === 403) {
        this.log.error(
          `the master REJECTED this bot's token (${res.status}) — no screenshots or ` +
            `artifacts will reach the panel for any run until this bot is re-approved. ` +
            `Its nodes row on the master has no matching api_token.`,
        );
        return { ok: false, retriable: false };
      }
      if (!res.ok) {
        this.log.warn(`artifact upload rejected (${res.status}) for run ${input.run_id}`);
        return { ok: false, retriable: true };
      }
      const json = (await res.json()) as { url?: string };
      return json.url ? { ok: true, url: json.url } : { ok: false, retriable: true };
    } catch (err) {
      this.log.warn(`artifact upload failed: ${(err as Error).message}`);
      return { ok: false, retriable: true };
    }
  }


  private subscribeCommands(): void {
    this.conn?.subscribe(commandSubject(this.cfg.node_id), async (data, ctx) => {
      const parsed = CommandEnvelopeSchema.safeParse(data);
      const reply = (
        ok: boolean,
        error: string | null,
        command_id: string,
        extra: Pick<CommandAck, "outcome" | "data"> = {},
      ): void => {
        const ack: CommandAck = {
          v: 1,
          command_id,
          node_id: this.cfg.node_id,
          ok,
          error,
          acked_at: new Date().toISOString(),
          ...extra,
        };
        ctx.respond?.(ack);
      };
      if (!parsed.success) {
        this.log.error(`unparseable command: ${parsed.error.message}`);
        reply(false, "malformed command envelope", "unknown");
        return;
      }
      const cmd = parsed.data;
      // The panel pings every few seconds; answering it must not flood the log.
      if (cmd.action === "ping") {
        reply(true, null, cmd.command_id);
        return;
      }
      try {
        const { note, data } = await this.dispatch(cmd);
        this.log.info(`command ${cmd.action} ok${note ? ` — ${note}` : ""}`);
        reply(true, null, cmd.command_id, data ? { data } : {});
      } catch (err) {
        const message = (err as Error).message;
        if (err instanceof NoSlotError) {
          // Nothing here holds this run. Say so explicitly: the master can only
          // free the run's account and row once it knows no browser has it.
          this.log.info(`command ${cmd.action}: ${message}`);
          reply(true, null, cmd.command_id, { outcome: "no_slot" });
          return;
        }
        if (err instanceof StartOutcomeUnknownError) {
          // Answer rather than stay silent: a timeout tells the master nothing,
          // while "unknown" lets it hold the account and ask the operator.
          this.log.error(message);
          reply(false, message, cmd.command_id, { outcome: "unknown" });
          return;
        }
        this.log.warn(`command ${cmd.action} rejected: ${message}`);
        reply(false, message, cmd.command_id);
      }
    });
  }

  private async dispatch(
    cmd: CommandEnvelope,
  ): Promise<{ note: string | null; data?: Record<string, unknown> }> {
    const runId = (): string => {
      const id = cmd.payload.run_id;
      if (typeof id !== "string" || !id) throw new Error("payload.run_id is required");
      return id;
    };
    const stopAfter = (): number | undefined => {
      const raw = cmd.payload.stop_after;
      if (raw === undefined || raw === null) return undefined;
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
        throw new Error("payload.stop_after must be a non-negative integer");
      }
      return raw;
    };
    const done = (note: string | null = null): { note: string | null } => ({ note });

    switch (cmd.action) {
      case "start_job": {
        const parsed = StartJobPayloadSchema.safeParse(cmd.payload);
        if (!parsed.success) {
          throw new Error(`bad start_job payload: ${parsed.error.issues[0]?.message}`);
        }
        const p = parsed.data;
        if (p.run_id && p.job_spec) {
          const job = fromWire(p.job_spec);
          const started = await this.hooks.startPushedJob(p.run_id, job, p.stop_after);
          return done(
            `started ${started} for sheet row ${job.rowNumber}` +
              (p.stop_after === undefined ? "" : `, parking after step ${p.stop_after}`),
          );
        }
        const started = await this.hooks.startJobs(p.instances ?? 1);
        if (started.length === 0) {
          throw new Error("the master has no runnable rows for this node");
        }
        return done(`started ${started.length}: ${started.join(", ")}`);
      }
      case "resume":
      case "resume_from_last_success":
        await this.hooks.resumeRun(runId(), undefined, stopAfter());
        return done();
      case "restart_from_step": {
        const raw = cmd.payload.step_index;
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
          throw new Error("payload.step_index must be a non-negative integer");
        }
        const until = stopAfter();
        const unblocked = cmd.payload.unblocked === true;
        await this.hooks.resumeRun(runId(), raw, until, unblocked);
        return done(`from step ${raw}${until === undefined ? "" : ` to ${until}`}${unblocked ? ", blocks removed" : ""}`);
      }
      case "stop_run":
        await this.hooks.stopRun(runId());
        return done("runner stopped, browser left open");
      case "probe_run":
        return { note: null, data: await this.hooks.probeRun(runId()) };
      case "ping":
        return done();
      case "reload_row":
        if (!this.hooks.reloadRow) throw new Error("row reload is unavailable on this bot");
        await this.hooks.reloadRow(runId());
        return done();
      case "cancel":
        await this.hooks.cancelRun(runId());
        return done();
      case "close_session":
        await this.hooks.closeSession(runId());
        return done();
      case "capture_artifacts":
        await this.hooks.captureArtifacts(runId());
        return done();
      case "stop_all": {
        const stopped = await this.hooks.stopAll();
        return done(`${stopped} slot(s) stopped, browsers left open`);
      }
      case "reset": {
        const freed = await this.hooks.reset();
        return done(`${freed} slot(s) freed, browsers closed`);
      }
      case "open_browser": {
        const job_id = typeof cmd.payload.job_id === "string" ? cmd.payload.job_id : null;
        const from = cmd.payload.resume_from;
        if (from !== undefined && (typeof from !== "number" || !Number.isInteger(from) || from < 0)) {
          throw new Error("payload.resume_from must be a non-negative integer");
        }
        await this.hooks.openBrowser(runId(), job_id, {
          ...(typeof from === "number" ? { from } : {}),
          unblocked: cmd.payload.unblocked === true,
        });
        return done(typeof from === "number" ? `browser re-opened, running from step ${from}` : null);
      }
      case "pause":
        await this.hooks.pauseRun(runId());
        return done();
      case "drain":
        await this.hooks.drain();
        return done();
      case "update_config": {
        const patch = (cmd.payload.patch as Record<string, unknown> | undefined) ?? cmd.payload;
        await this.hooks.updateConfig(patch);
        // Re-register ONLY when the slot count changed — registration is what
        // carries worker_count. Anything else is reported by the next
        // heartbeat, which does not disturb the master's view of busy slots.
        if (patch.worker_count !== undefined) this.register();
        this.beat();
        return done();
      }
      default: {
        const never: never = cmd.action;
        throw new Error(`unsupported action "${String(never)}"`);
      }
    }
  }


  private loadState(): void {
    mkdirSync(this.stateDir, { recursive: true });
    if (existsSync(this.seqFile)) {
      try {
        this.seqByRun = JSON.parse(readFileSync(this.seqFile, "utf8")) as Record<string, number>;
      } catch {
        throw new Error("telemetry sequence file is corrupt; refusing to reuse event sequence numbers");
      }
    }
    if (!existsSync(this.outboxFile)) return;
    for (const line of readFileSync(this.outboxFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as OutboxRow;
        this.queue.push(row);
        this.nextRowId = Math.max(this.nextRowId, row.id + 1);
        this.seqByRun[row.event.run_id] = Math.max(this.seqByRun[row.event.run_id] ?? 0, row.event.seq + 1);
      } catch {
      }
    }
    if (this.queue.length > 0) {
      this.log.info(`recovered ${this.queue.length} unsent event(s) from the outbox`);
    }
  }

  private appendOutbox(row: OutboxRow): void {
    try {
      appendFileSync(this.outboxFile, `${JSON.stringify(row)}\n`);
    } catch (err) {
      this.log.error(`outbox append failed: ${(err as Error).message}`);
    }
  }

  private rewriteOutbox(): void {
    try {
      writeFileSync(
        this.outboxFile + ".tmp",
        this.queue.map((r) => JSON.stringify(r)).join("\n") + (this.queue.length ? "\n" : ""),
      );
      renameSync(this.outboxFile + ".tmp", this.outboxFile);
    } catch (err) {
      this.log.error(`outbox rewrite failed: ${(err as Error).message}`);
    }
  }

  private saveSeq(): void {
    writeFileSync(this.seqFile + ".tmp", JSON.stringify(this.seqByRun));
    renameSync(this.seqFile + ".tmp", this.seqFile);
  }


  async close(): Promise<void> {
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.heartbeatTimer = null;
    this.drainTimer = null;
    this.closed = false;
    await this.drain().catch(() => {});
    this.closed = true;
    await this.conn?.close().catch(() => {});
    this.conn = null;
  }
}

export function jobSpecSummary(input: {
  sheetId: string;
  rowNumber: number;
  revision: string;
  userId: string;
  email: string;
  items: Array<{ url: string; quantity: number; purchaseOption?: string }>;
  paymentMethod: string;
}): JobSpecSummary {
  return {
    source_sheet_id: input.sheetId,
    source_row_id: String(input.rowNumber),
    source_revision: input.revision,
    customer_id: input.userId,
    account_label: redactEmail(input.email),
    product_list: input.items.map((i) => ({
      product_ref: i.url,
      quantity: i.quantity,
      ...(i.purchaseOption ? { purchase_option: i.purchaseOption } : {}),
    })),
    payment_method: input.paymentMethod,
  };
}

export function redactEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  if (!domain) return email ? "***" : "";
  const head = user.slice(0, 1);
  const tail = user.length > 1 ? user.slice(-1) : "";
  return `${head}${"*".repeat(Math.max(1, user.length - 2))}${tail}@${domain}`;
}
