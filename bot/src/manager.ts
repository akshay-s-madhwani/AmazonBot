import { acceptRun, wasRunAccepted, StartOutcomeUnknownError } from "./start-registry.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { freemem, hostname } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { loadDotEnv } from "./config.js";
import {
  discardForeignIdentity,
  enrollmentRejection,
  ensureEnrolled,
  formatShortId,
  loadCredentials,
  loadIdentity,
} from "./enroll.js";
import {
  AGENT_VERSION,
  fleetConfigFromCredentials,
  fleetConfigFromEnv,
  jobSpecSummary,
  FleetLink,
  NoSlotError,
  type FleetHooks,
} from "./fleet.js";
import { appendEvent, logsDir, makeEvent, openLog, tee } from "./logs.js";
import { describeNodeId, resolveNodeId } from "./node-id.js";
import { JobClient, requireJobClient, type SheetJob } from "./job-client.js";
import { sheetDirectMode } from "./sheet-direct.js";
import { STEPS } from "./steps.js";
import { describe as describeProc, fleetProcesses, fleetRoots, killAll, listProcesses, orphans, type FleetProc } from "./procs.js";
import { profileIdForRun } from "./shardx.js";


loadDotEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const SLOT_PATH = join(HERE, "slot.js");
const UI_DIR = join(HERE, "..", "ui");
const ARTIFACTS = join(HERE, "..", "artifacts");
const DEPLOY_STATE = join(HERE, "..", "..", ".deploy");
const deploymentMaintenance = (): boolean => existsSync(join(DEPLOY_STATE, "maintenance"));
const DEPLOY_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(DEPLOY_STATE, "version.json"), "utf8")).sha as string; }
  catch { return "development"; }
})();
let managerReady = false;
let pendingStarts = 0;
let deploymentClosing = false;
const PORT = Number(process.env.MANAGER_PORT ?? 7800);
const MANAGER_URL = process.env.MANAGER_URL ?? `http://127.0.0.1:${PORT}`;
const WATCHDOG_TICK_MS = 5_000;
const LOCAL_ARTIFACTS = /^(1|true|yes|on)$/i.test((process.env.LOCAL_ARTIFACTS ?? "").trim());
const SHOT_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

let NODE = resolveNodeId();

interface SlotState {
  slotIndex: number;
  runId: string;
  token: string;
  jobId: string | null;
  sheetRow: number | null;
  account: string;
  job: SheetJob | null;
  proc: ChildProcess | null;
  pid: number | null;
  reattached: boolean;
  port: number | null;
  status: string;
  startedAt: number;
  stepIndex: number | null;
  stepKey: string | null;
  lastBrowserActivityAt: number | null;
  lastRunnerHeartbeatAt: number | null;
  lastWatchdogAt: number | null;
  browserIdleMs: number | null;
  stuckFlagged: boolean;
  lastArtifact: { file: string; stepIndex: number | null; stepKey: string | null } | null;
  events: Array<Record<string, unknown>>;
  tabCount: number | null;
  stuckSince: number | null;
  /** The slot reported its browser closing (browser.closed -> session.closed). */
  browserClosedSent: boolean;
}

const slots = new Map<number, SlotState>();

let fleet: FleetLink | null = null;
let draining = false;
let advertisedWorkerCount = Number(process.env.WORKER_COUNT ?? 1);
const MAX_SLOT_EVENTS = 200;

const log = (m: string) => console.log(`[manager] ${m}`);

const slotByRun = (runId: string): SlotState | undefined =>
  [...slots.values()].find((s) => s.runId === runId);

function fleetSlotStatus(status: string): "idle" | "busy" | "crashed" | "stuck" | "offline" {
  switch (status) {
    case "BUSY":
    case "STARTING":
      return "busy";
    case "STUCK":
      return "stuck";
    case "PAUSED":
      return "busy";
    case "EXITED":
      return "crashed";
    case "DONE":
      return "idle";
    default:
      return "idle";
  }
}

function emit(
  s: SlotState,
  event: Parameters<FleetLink["emit"]>[0]["event"],
  extra: Partial<Parameters<FleetLink["emit"]>[0]> = {},
): void {
  if (!fleet) return;
  try {
    fleet.emit({
      run_id: s.runId,
      worker_id: s.slotIndex,
      event,
      step_index: s.stepIndex,
      step_key: s.stepKey,
      ...extra,
    });
  } catch (err) {
    log(`telemetry emit failed (${event}): ${(err as Error).message}`);
  }
}

function stepThreshold(stepIndex: number | null): number | undefined {
  if (stepIndex === null) return undefined;
  return STEPS[stepIndex]?.inactivityMs;
}

function slotAlive(s: SlotState): boolean {
  if (s.proc) return s.proc.exitCode === null;
  return s.status !== "EXITED" && s.status !== "DONE";
}

const BROWSER_SILENT_MS = 20_000;

function browserAlive(s: SlotState): boolean | null {
  if (s.lastWatchdogAt === null) return null;
  return Date.now() - s.lastWatchdogAt < BROWSER_SILENT_MS;
}


interface SlotRegistryFile {
  runId: string;
  slotIndex: number;
  token: string;
  jobId: string | null;
  sheetRow: number | null;
  account: string;
  pid: number | null;
  port: number | null;
  startedAt: number;
}

const registryPath = (runId: string): string => join(ARTIFACTS, runId, "slot.json");

function readOrderId(runId: string): string | null {
  try {
    const id = readFileSync(join(ARTIFACTS, runId, "order-id.txt"), "utf8").trim();
    return id || null;
  } catch {
    return null;
  }
}

function saveRegistry(s: SlotState): void {
  const entry: SlotRegistryFile = {
    runId: s.runId,
    slotIndex: s.slotIndex,
    token: s.token,
    jobId: s.jobId,
    sheetRow: s.sheetRow,
    account: s.account,
    pid: s.pid,
    port: s.port,
    startedAt: s.startedAt,
  };
  try {
    writeFileSync(registryPath(s.runId), JSON.stringify(entry, null, 2), "utf8");
  } catch (err) {
    log(`could not write the slot registry for ${s.runId}: ${(err as Error).message}`);
  }
}

function dropRegistry(runId: string): void {
  try {
    rmSync(registryPath(runId), { force: true });
  } catch {
  }
}

function registryFromEvents(dir: string): SlotRegistryFile | null {
  const file = join(ARTIFACTS, dir, "logs", "events.ndjson");
  if (!existsSync(file)) return null;
  let ready: Record<string, unknown> | null = null;
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.includes('"slot.ready"')) continue;
      try {
        ready = JSON.parse(line) as Record<string, unknown>;
      } catch {
      }
    }
  } catch {
    return null;
  }
  if (!ready || typeof ready.port !== "number" || typeof ready.token !== "string") return null;
  const sheetRow = Number(ready.sheetRow);
  return {
    runId: String(ready.run_id ?? dir),
    slotIndex: Number(ready.slot_index ?? 0),
    token: ready.token,
    jobId: typeof ready.jobId === "string" && ready.jobId ? ready.jobId : null,
    sheetRow: Number.isInteger(sheetRow) ? sheetRow : null,
    account: "(unknown)",
    pid: null,
    port: ready.port,
    startedAt: Date.parse(String(ready.ts ?? "")) || 0,
  };
}

function readRegistry(): SlotRegistryFile[] {
  if (!existsSync(ARTIFACTS)) return [];
  const out: SlotRegistryFile[] = [];
  for (const dir of readdirSync(ARTIFACTS)) {
    const file = join(ARTIFACTS, dir, "slot.json");
    let entry: SlotRegistryFile | null = null;
    if (existsSync(file)) {
      try {
        entry = JSON.parse(readFileSync(file, "utf8")) as SlotRegistryFile;
      } catch {
        entry = null;
      }
    }
    if (!entry || typeof entry.runId !== "string" || typeof entry.token !== "string") {
      entry = registryFromEvents(dir);
    }
    if (entry) out.push(entry);
  }
  return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

const ARTIFACT_RETENTION_DAYS = Number(process.env.ARTIFACT_RETENTION_DAYS ?? 7);
const ARTIFACT_MAX_RUNS = Number(process.env.ARTIFACT_MAX_RUNS ?? 50);
const ARTIFACT_PRUNE_TICK_MS = 6 * 60 * 60 * 1000;
const ARTIFACT_MIN_AGE_MS = 60 * 60 * 1000;

function pruneArtifacts(): void {
  if (!existsSync(ARTIFACTS)) return;
  if (ARTIFACT_RETENTION_DAYS <= 0 && ARTIFACT_MAX_RUNS <= 0) return;
  try {
    const live = new Set([...slots.values()].map((s) => s.runId));
    const now = Date.now();
    const candidates: Array<{ dir: string; path: string; mtime: number }> = [];

    for (const dir of readdirSync(ARTIFACTS)) {
      if (!dir.startsWith("run-")) continue;
      const path = join(ARTIFACTS, dir);
      if (live.has(dir)) continue;
      if (existsSync(join(path, "slot.json"))) continue;
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime < ARTIFACT_MIN_AGE_MS) continue;
      candidates.push({ dir, path, mtime });
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    const cutoff = now - ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const doomed = candidates.filter(
      (c, i) => (ARTIFACT_MAX_RUNS > 0 && i >= ARTIFACT_MAX_RUNS) || c.mtime < cutoff,
    );

    let removed = 0;
    for (const c of doomed) {
      try {
        rmSync(c.path, { recursive: true, force: true });
        removed++;
      } catch (err) {
        log(`could not prune ${c.dir}: ${(err as Error).message}`);
      }
    }
    if (removed > 0) {
      log(
        `pruned ${removed} old run dir(s) — keeping the newest ${ARTIFACT_MAX_RUNS}` +
          ` and anything newer than ${ARTIFACT_RETENTION_DAYS}d`,
      );
    }
  } catch (err) {
    log(`artifact prune failed: ${(err as Error).message}`);
  }
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isOurSlot(pid: number | null): Promise<boolean> {
  if (!pid) return false;
  try {
    return fleetProcesses(await listProcesses(), fleetRoots()).some((p) => p.pid === pid && p.kind === "slot");
  } catch {
    return false;
  }
}

async function reattachSlots(): Promise<void> {
  const entries = readRegistry();
  if (entries.length === 0) return;

  let adopted = 0;
  let dropped = 0;
  for (const entry of entries) {
    if (slotByRun(entry.runId)) continue;
    if (slots.has(entry.slotIndex)) {
      log(`registry: slot index ${entry.slotIndex} already taken — NOT adopting ${entry.runId}`);
      continue;
    }

    const status = entry.port ? await probeSlot(entry) : null;
    if (!status) {
      // After a reboot pids are reused: a live pid is only this slot if it
      // still runs this folder's slot.js.
      const starting = !entry.port && pidAlive(entry.pid) && (await isOurSlot(entry.pid));
      if (!starting) {
        dropRegistry(entry.runId);
        dropped++;
        // The slot died while no manager was watching, so nobody told the
        // master its browser is gone — and until it hears that, the run keeps
        // its Amazon account locked. Say it now.
        fleet?.emit({
          run_id: entry.runId,
          worker_id: entry.slotIndex,
          event: "session.closed",
          payload: { reason: "slot_gone_on_manager_start" },
        });
        continue;
      }
    }

    const state: SlotState = {
      slotIndex: entry.slotIndex,
      runId: entry.runId,
      token: entry.token,
      jobId: entry.jobId ?? null,
      sheetRow: entry.sheetRow ?? null,
      account: entry.account ?? "(unknown)",
      job: null,
      proc: null,
      pid: entry.pid ?? null,
      reattached: true,
      port: entry.port ?? null,
      status: status?.status ?? "STARTING",
      startedAt: entry.startedAt ?? Date.now(),
      stepIndex: status?.stepIndex ?? null,
      stepKey: status?.stepKey ?? null,
      lastBrowserActivityAt: Date.now(),
      lastWatchdogAt: null,
      lastRunnerHeartbeatAt: Date.now(),
      browserIdleMs: null,
      stuckFlagged: status?.status === "STUCK",
      lastArtifact: null,
      events: [],
      tabCount: null,
      stuckSince: status?.status === "STUCK" ? Date.now() : null,
      browserClosedSent: false,
    };
    slots.set(state.slotIndex, state);
    saveRegistry(state);
    adopted++;
    log(
      `reattached slot ${state.slotIndex} run=${state.runId} row=${state.sheetRow ?? "-"} ` +
        `status=${state.status} port=${state.port ?? "?"} step=${state.stepKey ?? "-"}`,
    );
    if (state.port) {
      log(`  resume it:  curl -X POST "http://127.0.0.1:${state.port}/resume?token=${state.token}"`);
    }
  }

  if (adopted > 0 || dropped > 0) {
    log(`slot registry: ${adopted} reattached, ${dropped} stale entr(ies) cleared`);
  }
}

async function probeSlot(
  entry: SlotRegistryFile,
): Promise<{ status: string; stepIndex: number | null; stepKey: string | null } | null> {
  const url = `http://127.0.0.1:${entry.port}/status?token=${entry.token}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      run_id?: string;
      status?: string;
      steps?: Array<{ index: number; key: string; status: string }>;
    };
    if (body.run_id !== entry.runId) return null;

    const steps = body.steps ?? [];
    const live = steps.find((x) => x.status === "RUNNING") ?? steps.find((x) => x.status !== "SUCCEEDED");
    return {
      status: body.status ?? "BUSY",
      stepIndex: live ? live.index : null,
      stepKey: live ? live.key : null,
    };
  } catch {
    return null;
  }
}

function freeSlotIndex(): number {
  const held = new Set([...slots.values()].filter(slotAlive).map((s) => s.slotIndex));
  let i = 0;
  while (held.has(i)) i += 1;
  return i;
}

const MIN_FREE_MB_FLOOR = Number(process.env.MIN_FREE_MB_FLOOR ?? 1500);
const MIN_FREE_MB_PER_SLOT = Number(process.env.MIN_FREE_MB_PER_SLOT ?? 600);
const START_JITTER_MS = Number(process.env.START_JITTER_MS ?? 20_000);

function liveSlotCount(): number {
  return [...slots.values()].filter((s) => slotAlive(s) && s.status !== "DONE").length;
}

function admit(requested: number): { granted: number; reason: string | null } {
  if ((process.env.MASTER_URL || process.env.MASTER_NATS_URL) && !fleet)
    return { granted: 0, reason: "fleet enrollment and durable telemetry must be ready before starting jobs" };
  if (draining || deploymentClosing || deploymentMaintenance()) return { granted: 0, reason: "node is draining — not accepting new jobs" };
  if (requested <= 0) return { granted: 0, reason: "no instances requested" };

  let reason: string | null = null;
  const cap = Math.max(0, advertisedWorkerCount);
  const live = liveSlotCount();
  let granted = Math.min(requested, Math.max(0, cap - live));
  if (granted < requested) {
    reason = `WORKER_COUNT cap is ${cap} and ${live} slot(s) are already running`;
  }

  const freeMb = Math.round(freemem() / 1024 / 1024);
  const headroom = Math.max(0, Math.floor((freeMb - MIN_FREE_MB_FLOOR) / MIN_FREE_MB_PER_SLOT));
  if (headroom < granted) {
    reason =
      `only ${freeMb}MB RAM free — reserving ${MIN_FREE_MB_FLOOR}MB and budgeting ` +
      `${MIN_FREE_MB_PER_SLOT}MB per slot leaves room for ${headroom}`;
    granted = headroom;
  }
  return { granted, reason };
}

function admitOneOrThrow(what: string): void {
  const { granted, reason } = admit(1);
  if (granted < 1) throw new Error(`${what} refused: ${reason ?? "no capacity"}`);
  if (reason) log(`${what}: ${reason}`);
}

function spawnSlot(
  job: SheetJob | null,
  masterRunId?: string,
  startDelayMs = 0,
  restoreOnly = false,
  stopAfter?: number,
  /** A restored browser that runs on at once from this step (Remove blocks). */
  restore?: { from?: number; unblocked?: boolean },
): SlotState {
  const slotIndex = freeSlotIndex();
  const runId = masterRunId ?? `run-${Date.now()}-${slotIndex}`;
  const token = randomUUID();
  const artifactsDir = join(ARTIFACTS, runId);
  mkdirSync(logsDir(artifactsDir), { recursive: true });
  if (job) writeFileSync(join(artifactsDir, "job.json"), JSON.stringify(job), { mode: 0o600 });

  const proc = spawn(process.execPath, [SLOT_PATH], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      RUN_ID: runId,
      SLOT_INDEX: String(slotIndex),
      SLOT_TOKEN: token,
      SLOT_PORT: "0",
      SLOT_RESTORE_ONLY: String(restoreOnly),
      MANAGER_URL,
      ...(startDelayMs > 0 ? { SLOT_START_DELAY_MS: String(startDelayMs) } : {}),
      SLOT_HEADLESS: /^(0|false|no|off)$/i.test((process.env.FLEET_HEADLESS ?? "").trim())
        ? "false"
        : "true",
      ...(job ? { JOB_ID: job.id } : {}),
      // A checkpoint: the runner parks after this step instead of running on
      // to checkout. Absent means run to the end.
      ...(stopAfter !== undefined ? { SLOT_STOP_AFTER: String(stopAfter) } : {}),
      ...(restore?.from !== undefined ? { SLOT_START_FROM: String(restore.from) } : {}),
      ...(restore?.unblocked ? { SLOT_UNBLOCKED: "true" } : {}),
    },
  });

  const slotLog = openLog(artifactsDir, "slot");
  tee(proc.stdout, slotLog, `[slot${slotIndex}]`);
  tee(proc.stderr, slotLog, `[slot${slotIndex}!]`);

  const state: SlotState = {
    slotIndex,
    runId,
    token,
    jobId: job?.id ?? null,
    sheetRow: job?.rowNumber ?? null,
    account: job?.credentials.email ?? "(env)",
    job,
    proc,
    pid: proc.pid ?? null,
    reattached: false,
    port: null,
    status: "STARTING",
    startedAt: Date.now(),
    stepIndex: null,
    stepKey: null,
    lastBrowserActivityAt: null,
    lastRunnerHeartbeatAt: null,
    lastWatchdogAt: null,
    browserIdleMs: null,
    stuckFlagged: false,
    lastArtifact: null,
    events: [],
    tabCount: null,
    stuckSince: null,
    browserClosedSent: false,
  };

  proc.on("exit", (code, signal) => {
    state.status = code === 0 ? "DONE" : "EXITED";
    dropRegistry(runId);
    log(`slot ${slotIndex} exited (code=${code} signal=${signal})`);
    appendEvent(artifactsDir, makeEvent(runId, slotIndex, "slot.exited", { code, signal }));
    // A slot that dies without closing its browser cleanly never sends
    // browser.closed, and the master keeps the account locked until it hears
    // session.closed. Send it on the slot's behalf.
    if (!state.browserClosedSent) {
      state.browserClosedSent = true;
      emit(state, "session.closed", { payload: { reason: "slot_exited", code, signal } });
    }
  });

  proc.unref();
  slots.set(slotIndex, state);
  saveRegistry(state);
  log(`spawned slot ${slotIndex} run=${runId} row=${job?.rowNumber ?? "-"} pid=${proc.pid}`);

  emit(state, "job.started", {
    step_index: null,
    step_key: null,
    payload: job
      ? {
          job_id: job.id,
          ...jobSpecSummary({
            sheetId: job.sheetId,
            rowNumber: job.rowNumber,
            revision: job.revision,
            userId: job.userId,
            email: job.credentials.email,
            items: job.items,
            paymentMethod: job.payment.method,
          }),
        }
      : {},
  });
  return state;
}

interface StartedSlot {
  slotIndex: number;
  runId: string;
  jobId: string | null;
  sheetRow: number | null;
  account: string;
}

async function startInstances(instances: number): Promise<StartedSlot[]> {
  pendingStarts++;
  try { return await startInstancesImpl(instances); }
  finally { pendingStarts--; }
}

async function startInstancesImpl(instances: number): Promise<StartedSlot[]> {
  const { granted, reason } = admit(instances);
  if (granted < 1) throw new Error(reason ?? "no capacity for a new slot");
  if (granted < instances) log(`admitting ${granted} of ${instances} instance(s): ${reason}`);
  const claimed = await requireJobClient(log).claim(granted);
  if (claimed.length === 0) {
    throw new Error(
      `no runnable PENDING rows for this bot (node_id ${NODE.id || "unset — blank node_id rows only"})`,
    );
  }
  if (claimed.length < granted) {
    log(`got ${claimed.length} row(s) for ${granted} instance(s)`);
  }
  const queued = claimed.filter((c) => !c.dispatch);
  if (queued.length) log(`${queued.length} row(s) QUEUED on the master; waiting for their account`);
  return claimed.filter((c) => c.dispatch).map(({ run_id, job }, i) => {
    const delay = i === 0 || START_JITTER_MS <= 0 ? 0 : Math.floor(Math.random() * START_JITTER_MS);
    if (!acceptRun(join(ARTIFACTS, ".fleet", "accepted"), run_id, job.id)) throw new Error("run already accepted; inspect its existing session");
    const s = spawnSlot(job, run_id, delay);
    return {
      slotIndex: s.slotIndex,
      runId: s.runId,
      jobId: s.jobId,
      sheetRow: s.sheetRow,
      account: s.account,
    };
  });
}

function startPushedJob(runId: string, job: SheetJob, stopAfter?: number): StartedSlot {
  const existing = slotByRun(runId);
  if (existing) return { slotIndex: existing.slotIndex, runId, jobId: existing.jobId,
    sheetRow: existing.sheetRow, account: existing.account };
  if (wasRunAccepted(join(ARTIFACTS, ".fleet", "accepted"), runId, job.id) || existsSync(join(ARTIFACTS, runId, "job.json"))) {
    return { slotIndex: -1, runId, jobId: job.id, sheetRow: job.rowNumber, account: job.credentials.email };
  }
  admitOneOrThrow(`start of ${runId}`);
  if (!acceptRun(join(ARTIFACTS, ".fleet", "accepted"), runId, job.id))
    return { slotIndex: -1, runId, jobId: job.id, sheetRow: job.rowNumber, account: job.credentials.email };
  let s: SlotState;
  try { s = spawnSlot(job, runId, 0, false, stopAfter); }
  catch (err) { throw new StartOutcomeUnknownError(`run ${runId} was accepted but launch outcome is unknown: ${(err as Error).message}`); }
  return {
    slotIndex: s.slotIndex,
    runId: s.runId,
    jobId: s.jobId,
    sheetRow: s.sheetRow,
    account: s.account,
  };
}

async function slotCall(s: SlotState, path: string, query = "", timeoutMs?: number): Promise<void> {
  if (!s.port) throw new Error(`slot ${s.slotIndex} has no control port yet`);
  const sep = query ? "&" : "";
  const res = await fetch(`http://127.0.0.1:${s.port}${path}?token=${s.token}${sep}${query}`, {
    method: "POST",
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`slot ${s.slotIndex} rejected ${path}: ${res.status} ${body.slice(0, 200)}`);
  }
}


const STUCK_TTL_MS = Number(process.env.SLOT_STUCK_TTL_MS ?? 2 * 60 * 60 * 1000);
const STUCK_TTL_GRACE_MS = 5 * 60 * 1000;
const reapedSlots = new Set<number>();

function reapExpiredSlots(now: number): void {
  if (STUCK_TTL_MS <= 0) return;
  for (const s of slots.values()) {
    if (s.stuckSince === null || !slotAlive(s)) continue;
    if (s.status !== "STUCK") continue;
    const stuckFor = now - s.stuckSince;
    if (stuckFor < STUCK_TTL_MS + STUCK_TTL_GRACE_MS) continue;
    if (reapedSlots.has(s.slotIndex)) continue;
    reapedSlots.add(s.slotIndex);

    const mins = Math.round(stuckFor / 60_000);
    log(
      `TTL REAP: slot ${s.slotIndex} (run ${s.runId}) has been ${s.status} for ${mins} min ` +
        `— closing its browser. Raise SLOT_STUCK_TTL_MS ` +
        `if operators need longer to take a run over.`,
    );
    appendEvent(
      join(ARTIFACTS, s.runId),
      makeEvent(s.runId, s.slotIndex, "slot.reaped", {
        reason: "session_ttl",
        stuckForMs: stuckFor,
        ttlMs: STUCK_TTL_MS,
        by: "manager",
      }),
    );

    if (s.port) {
      void fetch(`http://127.0.0.1:${s.port}/cancel?token=${s.token}`, { method: "POST" }).catch(
        () => {
          if (s.pid) killPid(s.pid);
        },
      );
    } else if (s.pid) {
      killPid(s.pid);
    }
  }
}

// ---------------------------------------------------------------------------
// ORPHAN SWEEP (2026-10-08). Slots, runners and browsers are detached so a
// manager restart can reattach to them, which also means nothing collected
// one whose owner died: runners parked on their control port forever,
// browsers left open, machines unusable after a few runs. Right after boot
// (once reattach has claimed what is still live) and every ORPHAN_SWEEP_MS
// after, every process of this folder that no live slot owns is killed — on
// the second sweep that sees it, so nothing caught mid-launch is touched.
// ---------------------------------------------------------------------------
const ORPHAN_SWEEP_MS = Number(process.env.ORPHAN_SWEEP_MS ?? 60_000);
/** pid -> when a sweep first saw it orphaned. */
const suspects = new Map<number, number>();
let sweeping = false;

function liveSet(): { slotPids: Set<number>; runIds: Set<string>; profileIds: Set<string> } {
  const live = [...slots.values()].filter(slotAlive);
  return {
    slotPids: new Set(live.flatMap((s) => (s.pid ? [s.pid] : []))),
    runIds: new Set(live.map((s) => s.runId)),
    profileIds: new Set(live.map((s) => profileIdForRun(s.runId))),
  };
}

/**
 * Kills this folder's processes no live slot owns. `now`: no second look
 * (boot, Reset, the cleanup button). `everything`: live slots' too.
 */
async function sweepOrphans(opts: { now?: boolean; everything?: boolean; dryRun?: boolean } = {}): Promise<FleetProc[]> {
  if (sweeping) return [];
  sweeping = true;
  try {
    const all = await listProcesses();
    const fleetNow = fleetProcesses(all, fleetRoots());
    const found = opts.everything ? fleetNow : orphans(fleetNow, liveSet());
    const seen = new Set(found.map((p) => p.pid));
    for (const pid of [...suspects.keys()]) if (!seen.has(pid)) suspects.delete(pid);
    const doomed = found.filter((p) => {
      if (opts.now) return true;
      if (!suspects.has(p.pid)) {
        suspects.set(p.pid, Date.now());
        return false;
      }
      return true;
    });
    if (doomed.length === 0) return [];
    if (opts.dryRun) return doomed;
    const killed = await killAll(doomed, all);
    for (const p of killed) suspects.delete(p.pid);
    if (killed.length) log(`cleanup: killed ${killed.length} orphaned process(es): ${killed.map(describeProc).join(", ")}`);
    return killed;
  } catch (err) {
    log(`cleanup sweep failed: ${(err as Error).message}`);
    return [];
  } finally {
    sweeping = false;
  }
}

function watchdogTick(): void {
  const now = Date.now();
  reapExpiredSlots(now);
  for (const s of slots.values()) {
    if (s.reattached && slotAlive(s) && s.pid !== null && !pidAlive(s.pid)) {
      s.status = "DONE";
      dropRegistry(s.runId);
      log(`adopted slot ${s.slotIndex} (run ${s.runId}) is gone — releasing it`);
      continue;
    }
    if (s.status !== "BUSY" && s.status !== "STARTING") continue;
    if (s.stuckFlagged) continue;

    const threshold = stepThreshold(s.stepIndex);
    if (threshold === undefined) continue;

    const lastBrowser = s.lastBrowserActivityAt ?? s.startedAt;
    const lastRunner = s.lastRunnerHeartbeatAt ?? s.startedAt;
    const quietFor = now - Math.max(lastBrowser, lastRunner);
    if (quietFor <= threshold) continue;

    s.stuckFlagged = true;
    s.status = "STUCK";
    s.stuckSince ??= now;
    const detail = {
      stepIndex: s.stepIndex,
      stepKey: s.stepKey,
      quietMs: quietFor,
      thresholdMs: threshold,
      browserIdleMs: s.browserIdleMs,
      lastRunnerHeartbeatAgoMs: s.lastRunnerHeartbeatAt ? now - s.lastRunnerHeartbeatAt : null,
    };
    emit(s, "run.stuck", {
      failure_code: "stuck_inactive",
      failure_detail:
        `no browser navigation and no runner heartbeat for ${Math.round(quietFor / 1000)}s ` +
        `(threshold ${Math.round(threshold / 1000)}s)`,
      payload: { reason: "inactivity", quiet_ms: quietFor, threshold_ms: threshold },
    });
    log(
      `WATCHDOG: run ${s.runId} inactive ${Math.round(quietFor / 1000)}s on step ` +
        `${s.stepIndex} ${s.stepKey} (threshold ${Math.round(threshold / 1000)}s) — marking STUCK`,
    );
    appendEvent(
      join(ARTIFACTS, s.runId),
      makeEvent(s.runId, s.slotIndex, "watchdog.inactive", detail),
    );
    s.events.push({ type: "watchdog.inactive", ts: new Date().toISOString(), ...detail });

    if (s.port) {
      void fetch(`http://127.0.0.1:${s.port}/stuck?token=${s.token}&reason=inactivity`, {
        method: "POST",
      }).catch(() => {});
    }
  }
}


const app = express();
app.use(express.json({ limit: "1mb" }));

app.post("/fleet/start", async (req: Request, res: Response) => {
  try {
    const client = requireJobClient(log);
    const cfg = await client.config();
    const requested = Number(req.body?.instances ?? cfg.instances);
    const instances = Number.isInteger(requested) && requested > 0 ? requested : cfg.instances;

    const started = await startInstances(instances);
    return res
      .status(202)
      .json({ ok: true, nodeId: NODE.id, instances: started.length, started });
  } catch (err) {
    const message = (err as Error).message;
    log(`fleet/start failed: ${message}`);
    return res
      .status(/no runnable|draining|no master/.test(message) ? 409 : 500)
      .json({ error: message });
  }
});

app.post("/fleet/stop", async (_req: Request, res: Response) => {
  try {
    let stopped = 0;
    for (const s of slots.values()) {
      if (!slotAlive(s)) continue;
      await slotCall(s, "/stop");
      s.status = "STUCK";
      stopped++;
    }
    res.json({ ok: true, stopped });
  } catch (err) { res.status(409).json({ error: (err as Error).message }); }
});

/**
 * The cleanup button / script: kills this folder's orphaned slots, runners
 * and browsers now. ?all=1 also takes the live ones (their runs are told
 * session.closed as their slots exit). ?dry=1 only lists.
 */
app.post("/fleet/cleanup", async (req: Request, res: Response) => {
  const everything = req.query.all === "1";
  const dryRun = req.query.dry === "1";
  if (everything && !dryRun) await hooks.reset().catch(() => 0);
  const hit = await sweepOrphans({ now: true, everything, dryRun });
  res.json({ ok: true, dry_run: dryRun, processes: hit.map((p) => ({ kind: p.kind, pid: p.pid, run_id: p.runId, profile: p.profileId })) });
});

function killPid(pid: number): void {
  try {
    process.kill(pid);
  } catch (err) {
    log(`could not kill pid ${pid}: ${(err as Error).message}`);
  }
}

app.get("/fleet/status", (_req: Request, res: Response) => {
  const now = Date.now();
  return res.json({
    managerUrl: MANAGER_URL,
    nodeId: NODE.id,
    nodeIdSource: NODE.source,
    slots: [...slots.values()].map((s) => ({
      slotIndex: s.slotIndex,
      runId: s.runId,
      sheetRow: s.sheetRow,
      account: s.account,
      status: s.status,
      port: s.port,
      pid: s.pid,
      token: s.token,
      step: s.stepIndex === null ? null : { index: s.stepIndex, key: s.stepKey },
      inactivityMs: stepThreshold(s.stepIndex) ?? null,
      browserIdleMs: s.browserIdleMs,
      lastRunnerHeartbeatAgoMs: s.lastRunnerHeartbeatAt ? now - s.lastRunnerHeartbeatAt : null,
      stuck: s.stuckFlagged,
      resume: s.port
        ? `curl -X POST "http://127.0.0.1:${s.port}/resume?token=${s.token}"`
        : null,
    })),
  });
});

const watchdogWarnedAt = new Map<number, number>();
const MAX_TABS = Number(process.env.MAX_TABS ?? 3);
const manyTabsWarnedAt = new Map<number, number>();

function warnManyTabs(slotIndex: number, tabCount: number): void {
  const last = manyTabsWarnedAt.get(slotIndex) ?? 0;
  if (Date.now() - last < 60_000) return;
  manyTabsWarnedAt.set(slotIndex, Date.now());
  log(
    `slot ${slotIndex} has ${tabCount} tabs open (expected 1) — something is ` +
      `opening pages nothing closes, which leaks memory for the rest of the run`,
  );
}

function warnRejectedWatchdog(slotIndex: number, why: string): void {
  const last = watchdogWarnedAt.get(slotIndex) ?? 0;
  if (Date.now() - last < 60_000) return;
  watchdogWarnedAt.set(slotIndex, Date.now());
  log(
    `REJECTED a watchdog heartbeat for slot ${slotIndex} (${why}) — that browser's ` +
      `liveness cannot be reported, and the panel will show it as unknown`,
  );
}

app.post("/watchdog/heartbeat", (req: Request, res: Response) => {
  const { token, slotIndex, idleMs, tabCount } = req.body ?? {};
  const s = slots.get(Number(slotIndex));
  if (!s || s.token !== token) {
    warnRejectedWatchdog(Number(slotIndex), s === undefined ? "no such slot" : "token mismatch");
    return res.status(401).json({ error: "unknown slot/token" });
  }
  if (s.lastWatchdogAt === null) {
    log(`watchdog extension is reporting for slot ${s.slotIndex} (run ${s.runId})`);
  }
  s.browserIdleMs = Number(idleMs) || 0;
  s.lastBrowserActivityAt = Date.now() - s.browserIdleMs;
  s.lastWatchdogAt = Date.now();

  if (typeof tabCount === "number") {
    s.tabCount = tabCount;
    if (tabCount > MAX_TABS) warnManyTabs(s.slotIndex, tabCount);
  }
  return res.json({ ok: true });
});

app.post("/runner/heartbeat", (req: Request, res: Response) => {
  const { token, runId, stepIndex, stepKey } = req.body ?? {};
  const s = [...slots.values()].find((x) => x.runId === runId);
  if (!s || s.token !== token) return res.status(401).json({ error: "unknown run/token" });
  s.lastRunnerHeartbeatAt = Date.now();
  if (typeof stepIndex === "number") s.stepIndex = stepIndex;
  if (typeof stepKey === "string") s.stepKey = stepKey;
  return res.json({ ok: true });
});

app.post("/slots/event", (req: Request, res: Response) => {
  const body = req.body ?? {};
  const s = slots.get(Number(body.slotIndex));
  if (!s || s.token !== body.token) return res.status(401).json({ error: "unknown slot/token" });

  s.events.push({ ...body, ts: new Date().toISOString() });
  if (s.events.length > MAX_SLOT_EVENTS) s.events.splice(0, s.events.length - MAX_SLOT_EVENTS);

  if (body.type === "slot.stuck") s.stuckSince ??= Date.now();
  if (body.type === "slot.ready" && typeof body.port === "number") {
    s.port = body.port;
    s.status = "BUSY";
    saveRegistry(s);
    log(`slot ${s.slotIndex} ready on port ${body.port}`);
  }
  if (body.type === "browser.closed" && !s.browserClosedSent) {
    s.browserClosedSent = true;
    emit(s, "session.closed", { payload: { reason: body.reason ?? "closed" } });
  }
  // The runner parked in its tab — a checkpoint or an operator pause. The
  // master mirrors this as PAUSED; without it a parked run looks RUNNING.
  if (body.type === "runner.waiting" && body.reason === "paused") {
    s.status = "PAUSED";
    const after = Number(body.after_step);
    emit(s, "run.paused", {
      payload: { after_step: Number.isInteger(after) ? after : s.stepIndex },
    });
  }
  if (body.type === "browser.started") {
    emit(s, "session.opened", {
      step_index: null,
      step_key: null,
      payload: {
        browser_pid: body.pid ?? null,
        ws_endpoint: body.wsEndpoint ?? null,
        slot_index: s.slotIndex,
      },
    });
  }
  if (body.type === "step.started") {
    s.stepIndex = Number(body.stepIndex);
    s.stepKey = String(body.stepKey);
    s.stuckFlagged = false;
    s.stuckSince = null;
    s.lastRunnerHeartbeatAt = Date.now();
    if (s.status === "STUCK") s.status = "BUSY";
    emit(s, "step.started");
  }
  if (body.type === "step.finished") {
    const stepIndex = Number(body.stepIndex);
    const stepKey = String(body.stepKey);
    const outcome = String(body.result);
    const screenshot = typeof body.screenshot === "string" ? body.screenshot : null;

    if (outcome === "failed") {
      emit(s, "step.failed", {
        step_index: stepIndex,
        step_key: stepKey,
        failure_code: typeof body.failure_code === "string" ? body.failure_code : "unknown_error",
        failure_detail: typeof body.detail === "string" ? body.detail : null,
        payload: { last_url: body.url ?? null },
      });
    } else {
      emit(s, outcome === "skipped" ? "step.skipped" : "step.succeeded", {
        step_index: stepIndex,
        step_key: stepKey,
        payload: {
          last_url: body.url ?? null,
          ...(stepKey === "note_order_id"
            ? { order_id: readOrderId(s.runId) }
            : {}),
        },
      });
    }

    if (screenshot) {
      void uploadArtifact(s, screenshot, stepIndex, stepKey);
    }
  }
  if (body.type === "run.finished") {
    emit(s, "job.finished", {
      step_index: null,
      step_key: null,
      payload: { outcome: body.outcome ?? null },
    });
  }
  if (body.type === "watchdog.stuck" || body.type === "slot.stuck") {
    s.status = "STUCK";
    s.stuckFlagged = true;
    emit(s, "run.stuck", {
      failure_code: "stuck_inactive",
      failure_detail: typeof body.reason === "string" ? body.reason : "flagged by the slot",
      payload: { reason: body.reason ?? null, source: "slot" },
    });
  }
  return res.json({ ok: true });
});

function uploadArtifact(
  s: SlotState,
  file: string,
  stepIndex: number | null,
  stepKey: string | null,
  attempt = 1,
): void {
  if (!fleet) return;
  void fleet
    .uploadArtifact({ run_id: s.runId, file, step_index: stepIndex, step_key: stepKey })
    .then((res) => {
      if (res.ok) {
        s.lastArtifact = { file, stepIndex, stepKey };
        return;
      }
      if (res.retriable && attempt < 5) {
        setTimeout(() => uploadArtifact(s, file, stepIndex, stepKey, attempt + 1), attempt * 2_000);
      }
    })
    .catch(() => {});
}


app.get("/api/overview", async (_req: Request, res: Response) => {
  const now = Date.now();
  const creds = loadCredentials();
  const masterUrl = (process.env.MASTER_URL ?? "").trim();

  return res.json({
    bot: {
      id: NODE.id,
      idSource: NODE.source,
      hostname: hostname(),
      managerUrl: MANAGER_URL,
      draining,
      workerCount: advertisedWorkerCount,
      agentVersion: AGENT_VERSION,
      masterUrl: masterUrl || null,
      enrollment: !masterUrl
        ? { state: "standalone" }
        : creds
          ? { state: "approved", botId: creds.bot_id, natsUrl: creds.nats_url }
          : {
            state: "pending",
            shortId: formatShortId(loadIdentity().short_id),
            rejection: enrollmentRejection(),
          },
      link: fleet ? "linked" : "offline",
      localArtifacts: LOCAL_ARTIFACTS,
    },
    steps: STEPS.map((step, index) => ({
      index,
      key: step.key,
      inactivityMs: step.inactivityMs ?? null,
    })),
    slots: [...slots.values()].map((s) => ({
      slotIndex: s.slotIndex,
      runId: s.runId,
      sheetRow: s.sheetRow,
      account: s.account,
      status: s.status,
      pid: s.pid,
      alive: slotAlive(s),
      reattached: s.reattached,
      step: s.stepIndex === null ? null : { index: s.stepIndex, key: s.stepKey },
      inactivityMs: stepThreshold(s.stepIndex) ?? null,
      browserIdleMs: s.browserIdleMs,
      quietMs: s.lastRunnerHeartbeatAt ? now - s.lastRunnerHeartbeatAt : null,
      stuck: s.stuckFlagged,
      resumable: s.port !== null && slotAlive(s),
    })),
  });
});

app.get("/api/jobs", async (_req: Request, res: Response) => {
  try {
    const client = requireJobClient(log);
    const [cfg, jobs] = await Promise.all([
      client.config(),
      client.listJobs({ status: "PENDING", runnable: true, limit: 200 }),
    ]);
    return res.json({
      instances: cfg.instances,
      jobs: jobs.map((j) => ({
        jobId: j.id,
        rowNumber: j.rowNumber,
        userId: j.userId,
        status: j.status,
        account: j.credentials.email,
        items: j.items.length,
        payment: j.payment.method,
      })),
    });
  } catch (err) {
    return res.status(502).json({ error: (err as Error).message });
  }
});

app.post("/api/slots/:index/resume", async (req: Request, res: Response) => {
  const s = slots.get(Number(req.params.index));
  if (!s) return res.status(404).json({ error: "no such slot" });
  if (s.port === null) {
    return res.status(409).json({
      error: "this slot has no live runner to resume — start a new job instead",
    });
  }
  const from = req.body?.from;
  const query = from === undefined || from === null ? "" : `&from=${encodeURIComponent(String(from))}`;
  return forwardToSlot(res, `http://127.0.0.1:${s.port}/resume?token=${s.token}${query}`);
});

app.post("/api/slots/:index/stop", async (req: Request, res: Response) => {
  const s = slots.get(Number(req.params.index));
  if (!s) return res.status(404).json({ error: "no such slot" });
  if (!s.port) return res.status(409).json({ error: "slot control unavailable; runner state is unknown" });
  return forwardToSlot(res, `http://127.0.0.1:${s.port}/stop?token=${s.token}`);
});

app.post("/api/slots/:index/retry", async (req: Request, res: Response) => {
  const s = slots.get(Number(req.params.index));
  if (!s) return res.status(404).json({ error: "no such slot" });
  try { return res.status(202).json(await requireJobClient().requestRetry(s.runId)); }
  catch (err) { return res.status(409).json({ error: (err as Error).message }); }
});

app.post("/api/slots/:index/cancel", async (req: Request, res: Response) => {
  const s = slots.get(Number(req.params.index));
  if (!s) return res.status(404).json({ error: "no such slot" });
  if (s.port === null) {
    return res.status(409).json({ error: "slot control unavailable; cannot confirm browser closure" });
  }
  const out = await forwardToSlot(res, `http://127.0.0.1:${s.port}/cancel?token=${s.token}`);
  return out;
});

async function forwardToSlot(res: Response, url: string): Promise<Response> {
  try {
    const upstream = await fetch(url, { method: "POST" });
    const text = await upstream.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
    return res.status(upstream.status).json(body);
  } catch (err) {
    return res.status(502).json({ error: `slot did not answer: ${(err as Error).message}` });
  }
}

app.use(express.static(UI_DIR, { index: "index.html", maxAge: 0 }));

function runArtifactsDir(runId: string): string | null {
  if (!runId || runId.includes("..") || runId.includes("/") || runId.includes("\\")) return null;
  return join(ARTIFACTS, runId);
}

app.get("/api/shots/:runId", (req: Request, res: Response) => {
  if (!LOCAL_ARTIFACTS) {
    return res.status(409).json({ error: "LOCAL_ARTIFACTS is off — set it in bot/.env and restart" });
  }
  const dir = runArtifactsDir(String(req.params.runId ?? ""));
  if (!dir) return res.status(400).json({ error: "bad runId" });
  if (!existsSync(dir)) return res.json({ shots: [] });

  const shots = readdirSync(dir)
    .filter((f) => SHOT_EXTENSIONS.has(extname(f).toLowerCase()))
    .map((file) => {
      const m = /^(\d+)-(.+)-(succeeded|failed|skipped)\.(?:jpe?g|png)$/i.exec(file);
      let size = 0;
      let mtime = 0;
      try {
        const st = statSync(join(dir, file));
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
      }
      return {
        file,
        stepIndex: m ? Number(m[1]) : null,
        stepKey: m ? m[2] : null,
        result: m ? m[3]?.toLowerCase() ?? null : null,
        sizeBytes: size,
        takenAt: mtime,
      };
    })
    .sort((a, b) => a.takenAt - b.takenAt);

  return res.json({ shots });
});

app.get("/shots/:runId/:file", (req: Request, res: Response) => {
  if (!LOCAL_ARTIFACTS) return res.status(409).end();
  const dir = runArtifactsDir(String(req.params.runId ?? ""));
  const file = String(req.params.file ?? "");
  if (!dir || !file || file.includes("..") || file.includes("/") || file.includes("\\")) {
    return res.status(400).end();
  }
  if (!SHOT_EXTENSIONS.has(extname(file).toLowerCase())) return res.status(415).end();
  const full = join(dir, file);
  if (!existsSync(full)) return res.status(404).end();
  return res.sendFile(full);
});

app.get("/logs/:runId", (req: Request, res: Response) => {
  const name = String(req.query.name ?? "events.ndjson");
  const runId = req.params.runId ?? "";
  if (!runId || runId.includes("..") || runId.includes("/")) {
    return res.status(400).json({ error: "bad runId" });
  }
  const file = join(ARTIFACTS, runId, "logs", name);
  if (!existsSync(file)) return res.status(404).json({ error: `no ${name} for this run` });
  res.type("text/plain").send(readFileSync(file, "utf8"));
});

app.get("/health", (_req: Request, res: Response) =>
  res.json({
    ok: true,
    ready: managerReady,
    version: DEPLOY_VERSION,
    deploymentMaintenance: deploymentMaintenance(),
    activeSlots: liveSlotCount() + pendingStarts,
    slots: slots.size,
    port: PORT,
    nodeId: NODE.id,
    draining,
    master: fleet ? "linked" : "standalone",
  }),
);

// This server binds only to loopback. These routes also require the receiver's
// on-disk maintenance marker; the public proxy must expose only the webhook.
app.post("/deployment/drain", (_req: Request, res: Response) => {
  if (!deploymentMaintenance()) return res.status(409).json({ error: "No deployment maintenance marker" });
  return res.json({ ok: true });
});
app.post("/deployment/resume", (_req: Request, res: Response) => {
  if (deploymentMaintenance() || deploymentClosing) return res.status(409).json({ error: "Deployment still in progress" });
  return res.json({ ok: true });
});
app.post("/deployment/close-idle", async (_req: Request, res: Response) => {
  if (!deploymentMaintenance() || deploymentClosing || !managerReady || liveSlotCount() !== 0 || pendingStarts !== 0)
    return res.status(409).json({ error: "Manager is not drained" });
  deploymentClosing = true;
  try {
    const previous = [...slots.values()];
    const wasDraining = draining;
    await hooks.reset();
    draining = wasDraining;
    await sweepOrphans({ now: true });
    if ((await Promise.all(previous.map((slot) => waitForExit(slot, 2000)))).some((gone) => !gone))
      throw new Error("Old slot processes are still running");
    return res.json({ ok: true });
  } catch (error) { return res.status(409).json({ error: (error as Error).message }); }
  finally { deploymentClosing = false; }
});


/** The live slot holding a run, or NoSlotError — the answer that lets the master release it. */
function liveSlotFor(run_id: string, what: string): SlotState {
  const s = slotByRun(run_id);
  if (!s || !slotAlive(s)) throw new NoSlotError(`${what}: no live slot on this node holds ${run_id}`);
  return s;
}

/**
 * How long Reset lets a cancelled slot close its browser before killing it.
 * Kept under the master's 10s command timeout: the reset is acked only after
 * this wait, and an ack that arrives late reads as "the machine did not
 * answer" — the master would then skip releasing the runs it just reset.
 */
const RESET_GRACE_MS = Math.min(8_000, Number(process.env.RESET_GRACE_MS ?? 8_000));

/** Waits for a slot process to exit on its own; true if it did. */
async function waitForExit(s: SlotState, ms: number): Promise<boolean> {
  const gone = (): boolean =>
    s.proc ? s.proc.exitCode !== null || s.proc.signalCode !== null : !pidAlive(s.pid);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (gone()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return gone();
}

const hooks: FleetHooks = {
  startPushedJob: async (run_id, job, stopAfter) => startPushedJob(run_id, job, stopAfter).runId,

  startJobs: async (instances) => {
    const started = await startInstances(instances);
    return started.map((s) => s.runId);
  },

  resumeRun: async (run_id, from, stopAfter, unblocked) => {
    if (deploymentClosing || deploymentMaintenance()) throw new Error("Deployment in progress; resume is disabled");
    const s = liveSlotFor(run_id, "resume");
    s.status = "BUSY"; // Account for the in-flight resume while deployment checks drain state.
    const query = [
      ...(from === undefined ? [] : [`from=${from}`]),
      ...(stopAfter === undefined ? [] : [`stop_after=${stopAfter}`]),
      ...(unblocked ? ["unblocked=1"] : []),
    ].join("&");
    await slotCall(s, "/resume", query);
    s.status = "BUSY";
    s.stuckFlagged = false;
  },

  stopRun: async (run_id) => {
    const s = liveSlotFor(run_id, "stop");
    await slotCall(s, "/stop");
    s.status = "STUCK";
    log(`stop: runner for ${run_id} stopped, browser deliberately left open`);
  },

  probeRun: async (run_id) => {
    const s = slotByRun(run_id);
    const accepted = (() => {
      try {
        return wasRunAccepted(join(ARTIFACTS, ".fleet", "accepted"), run_id, s?.jobId ?? "");
      } catch {
        // A different job id under this run id still means the run was accepted.
        return true;
      }
    })();
    return {
      has_slot: Boolean(s && slotAlive(s)),
      accepted,
      slot_status: s?.status ?? null,
      browser_alive: s ? browserAlive(s) : null,
      step_index: s?.stepIndex ?? null,
    };
  },
  reloadRow: async (run_id) => {
    const s = slotByRun(run_id);
    if (!s) throw new Error("no slot for this run");
    await slotCall(s, "/reload");
    s.status = "STUCK";
  },

  cancelRun: async (run_id) => {
    await slotCall(liveSlotFor(run_id, "cancel"), "/cancel");
  },

  closeSession: async (run_id) => {
    await slotCall(liveSlotFor(run_id, "close_session"), "/cancel");
  },

  captureArtifacts: async (run_id) => {
    const s = liveSlotFor(run_id, "capture");
    if (!s.port) throw new Error(`slot ${s.slotIndex} has no control port yet`);
    // A NEW screenshot of the page as it is now — re-sending the last step's
    // picture showed the operator a browser that may have moved on since.
    const res = await fetch(`http://127.0.0.1:${s.port}/capture?token=${s.token}`, {
      method: "POST",
    });
    const body = (await res.json().catch(() => ({}))) as {
      file?: string;
      step_index?: number | null;
      error?: string;
    };
    if (!res.ok || !body.file) {
      throw new Error(`capture failed: ${body.error ?? `slot answered ${res.status}`}`);
    }
    const stepIndex = typeof body.step_index === "number" ? body.step_index : s.stepIndex;
    uploadArtifact(s, body.file, stepIndex, stepIndex === null ? null : (STEPS[stepIndex]?.key ?? null));
  },

  pauseRun: async (run_id) => {
    const s = slotByRun(run_id);
    if (!s) throw new Error(`no slot on this node is running ${run_id}`);
    await slotCall(s, "/pause");
    s.status = "PAUSED";
  },

  stopAll: async () => {
    let stopped = 0;
    for (const s of slots.values()) {
      if (!slotAlive(s)) continue;
      await slotCall(s, "/stop");
      s.status = "STUCK";
      stopped++;
    }
    log(`stop: ${stopped} slot(s) stopped, browsers deliberately left open`);
    return stopped;
  },

  reset: async () => {
    let freed = 0;
    const live = [...slots.values()];
    // Ask every slot to close first, then wait for them together. A cancelled
    // slot runs session.stop() before exiting; killing it straight away cuts
    // that off, which loses the profile's cookie jar and never tells the
    // master the browser closed.
    await Promise.all(live.map((s) => slotCall(s, "/cancel", "", RESET_GRACE_MS).catch(() => undefined)));
    await Promise.all(
      live.map(async (s) => {
        if (!(await waitForExit(s, RESET_GRACE_MS))) {
          log(`reset: slot ${s.slotIndex} did not close within ${RESET_GRACE_MS}ms — killing it`);
          if (s.proc) s.proc.kill();
          else if (s.pid) killPid(s.pid);
        }
        if (!s.browserClosedSent) {
          s.browserClosedSent = true;
          emit(s, "session.closed", { payload: { reason: "reset" } });
        }
      }),
    );
    for (const s of live) {
      dropRegistry(s.runId);
      freed++;
    }
    slots.clear();
    draining = false;
    log(`reset: ${freed} slot(s) freed and their browsers closed`);
    // Whatever the slots left behind — and anything no slot was tracking any
    // more — goes too. After the ack: listing processes can take seconds.
    setTimeout(() => void sweepOrphans({ now: true }), 500);
    return freed;
  },

  openBrowser: async (run_id, job_id, opts) => {
    const existing = slotByRun(run_id);
    if (existing && slotAlive(existing)) {
      log(`open_browser: ${run_id} already has a live slot — nothing to do`);
      return;
    }
    if (!job_id) {
      throw new Error(
        `cannot re-open a browser for ${run_id}: the master sent no job_id, and this ` +
          `node cannot read the sheet to find the row itself`,
      );
    }
    const snapshot = join(ARTIFACTS, run_id, "job.json");
    if (!existsSync(snapshot)) throw new Error("original run snapshot is missing; cannot silently replace its identity");
    const job = JSON.parse(readFileSync(snapshot, "utf8")) as SheetJob;
    if (job.id !== job_id) throw new Error("run snapshot does not match the requested row");
    admitOneOrThrow(`restore of ${run_id}`);
    spawnSlot(job, run_id, 0, true, undefined, opts);
    log(
      `open_browser: respawned a slot for ${run_id} (sheet row ${job.rowNumber})` +
        (opts?.from !== undefined ? `, running from step ${opts.from}${opts.unblocked ? " with blocks removed" : ""}` : ""),
    );
  },

  drain: async () => {
    draining = true;
    log("draining: no new jobs will start; running slots finish normally");
  },

  updateConfig: async (patch) => {
    if (typeof patch.draining === "boolean") {
      draining = patch.draining;
      log(draining ? "draining: no new jobs will start" : "intake resumed: accepting new jobs");
    }
    const wc = patch.worker_count;
    if (typeof wc === "number" && Number.isInteger(wc) && wc >= 0) {
      advertisedWorkerCount = wc;
      log(`worker_count set to ${wc} by the master`);
    }
    if (typeof patch.headless === "boolean") {
      process.env.FLEET_HEADLESS = String(patch.headless);
      process.env.BROWSER_HEADLESS = String(patch.headless);
      log(`headless set to ${patch.headless} for future slots`);
    }
  },

  slots: () =>
    [...slots.values()].map((s) => ({
      slot_index: s.slotIndex,
      status: fleetSlotStatus(s.status),
      current_run_id: s.status === "DONE" ? null : s.runId,
      step_index: s.stepIndex,
      step_key: s.stepKey,
      browser_alive: browserAlive(s),
      browser_idle_ms: s.browserIdleMs,
      tab_count: s.tabCount,
      stuck_for_ms: s.stuckSince === null ? null : Date.now() - s.stuckSince,
    })),

  workerCount: () => Math.max(0, advertisedWorkerCount),
};

async function linkToMaster(): Promise<void> {
  if (fleet) { fleet.connect(); return; }
  const masterUrl = (process.env.MASTER_URL ?? "").trim();
  let cfg;

  if (masterUrl) {
    const creds = await ensureEnrolled({
      masterUrl,
      workerCount: advertisedWorkerCount,
      agentVersion: AGENT_VERSION,
      log: (m) => log(`[enroll] ${m}`),
    });
    if (!creds) {
      log("not approved — running standalone (no control panel, no telemetry)");
      return;
    }
    if (!adoptFleetIdentity(creds.bot_id)) return;
    cfg = fleetConfigFromCredentials(creds, masterUrl);
  } else {
    try {
      cfg = fleetConfigFromEnv(NODE.id);
    } catch (err) {
      log(`FATAL: ${(err as Error).message}`);
      process.exit(1);
    }
    if (!cfg) {
      log("no MASTER_URL — running standalone (no control panel, no telemetry)");
      return;
    }
  }

  fleet = await FleetLink.start(cfg, hooks);
  if (fleet) {
    log(`control plane: ${cfg.nats_url} (artifacts -> ${cfg.master_url ?? "not configured"})`);
  }
}

/**
 * The approval must be for this machine's .node-id — the id is never taken
 * from the approval. .node-id is re-read: it may have been fixed while the
 * master was refusing the old one.
 */
function adoptFleetIdentity(botId: string): boolean {
  NODE = resolveNodeId();
  if (NODE.id === botId) return true;
  log(
    `ERROR: approved as "${botId}" but .node-id is "${NODE.id}" — not joining. ` +
      `Restart the bot to ask again as "${NODE.id}".`,
  );
  return false;
}

// Refuse the MASTER_URL + SHEET_ID mix here, at boot, rather than letting every
// run die later when the runner first asks for its job client.
try {
  sheetDirectMode();
} catch (err) {
  log(`FATAL: ${(err as Error).message}`);
  process.exit(1);
}

const bootMasterUrl = (process.env.MASTER_URL ?? "").trim();
if (bootMasterUrl) {
  if (!NODE.id) {
    log("FATAL: this machine has no node id. Run setup again, or write one into bot/.node-id.");
    process.exit(1);
  }
  const reasons = discardForeignIdentity(NODE.id);
  if (reasons.length > 0) {
    log(`discarded this folder's fleet approval: ${reasons.join("; ")}`);
    log(`asking to join again as "${NODE.id}"`);
  }
}
const bootCredentials = bootMasterUrl ? loadCredentials() : null;
if (bootCredentials && adoptFleetIdentity(bootCredentials.bot_id)) {
  fleet = FleetLink.buffer(fleetConfigFromCredentials(bootCredentials, bootMasterUrl), hooks);
} else if (!bootMasterUrl) {
  const cfg = fleetConfigFromEnv(NODE.id);
  if (cfg) fleet = FleetLink.buffer(cfg, hooks);
}

app.listen(PORT, "127.0.0.1", () => {
  log(`bot manager on ${MANAGER_URL}`);
  log(`  bot id: ${describeNodeId(NODE)}`);
  if (process.env.MASTER_URL && !loadCredentials()) {
    log(`  short id: ${formatShortId(loadIdentity().short_id)} (not approved yet)`);
  }
  log(`  console: ${MANAGER_URL}  <- open this in a browser`);
  log(`  start:   curl -X POST ${MANAGER_URL}/fleet/start`);
  log(`  status:  curl ${MANAGER_URL}/fleet/status`);
  void reattachSlots()
    .then(() => { managerReady = true; })
    .catch((err: unknown) => log(`reattach failed: ${(err as Error).message}`))
    .finally(() => {
      pruneArtifacts();
      setInterval(pruneArtifacts, ARTIFACT_PRUNE_TICK_MS);
      setInterval(watchdogTick, WATCHDOG_TICK_MS);
      // Reattach has claimed every slot still live: the rest is nobody's.
      void sweepOrphans({ now: true });
      if (ORPHAN_SWEEP_MS > 0) setInterval(() => void sweepOrphans(), ORPHAN_SWEEP_MS);
      void linkToMaster();
    });
});

function shutdownManager(): void {
  void fleet?.close().catch(() => {});
  const live = [...slots.values()].filter(slotAlive);
  if (live.length > 0) {
    log(`manager stopping — ${live.length} slot(s) LEFT RUNNING with their browsers:`);
    for (const s of live) {
      log(`  slot ${s.slotIndex} pid=${s.pid} port=${s.port ?? "?"} run=${s.runId}`);
      if (s.port) log(`    close it:  curl -X POST "http://127.0.0.1:${s.port}/cancel?token=${s.token}"`);
    }
    log(`  or restart the manager — it reattaches to these slots — and cancel the intended slots`);
  }
  process.exit(0);
}
process.once("SIGINT", shutdownManager);
process.once("SIGTERM", shutdownManager);
process.on("message", (message) => { if (message === "shutdown") shutdownManager(); });
