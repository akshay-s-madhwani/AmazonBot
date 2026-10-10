import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAddress, loadConfig, loadDotEnv, loadHeadless, loadProduct, type BotConfig } from "./config.js";
import type { RunnerConfig, RunnerEvent } from "./protocol.js";
import { STEPS } from "./steps.js";
import { requireJobClient, type SheetJob } from "./job-client.js";
import { appendEvent, makeEvent, openLog, tee } from "./logs.js";
import { launchForRun, touchProfile, type LaunchedBrowser } from "./shardx.js";
import { inputsChanged, resumeStep } from "./resume-inputs.js";
import { parseAccountProxy, type Proxy } from "./proxy.js";
import { STALL_EXIT_CODE, STALL_RESTARTS, STUCK_RERUNS } from "./stall.js";
import { FINAL_FAILURES } from "./failures.js";


const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(HERE, "runner.js");
const PORT = Number(process.env.SLOT_PORT ?? 7801);
const ARTIFACTS = join(HERE, "..", "artifacts");
const STEP_DEADLINE_MS = Math.max(...STEPS.map(step => step.timeoutMs)) + 30_000;
const CONTINUE_ACK_MS = 30_000;

const SLOT_INDEX = Number(process.env.SLOT_INDEX ?? 0);
const JOB_ID = (process.env.JOB_ID ?? "").trim();
const MANAGER_URL = (process.env.MANAGER_URL ?? "").trim();

type SlotStatus = "IDLE" | "BUSY" | "STUCK" | "DONE" | "PAUSED";
type StepStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

interface StepRecord {
  index: number;
  key: string;
  status: StepStatus;
  failure_code?: string;
  detail?: string;
  screenshot?: string | null;
  url?: string | null;
}

const token = process.env.SLOT_TOKEN?.trim() || randomUUID();
const runId = process.env.RUN_ID?.trim() || `run-${Date.now()}-${SLOT_INDEX}`;
const storageStatePath = join(ARTIFACTS, runId, "storage-state.json");
const artifactsDir = join(ARTIFACTS, runId);

let session: LaunchedBrowser["session"] | undefined;
let cdpUrl = "";
let status: SlotStatus = "IDLE";
let runner: ChildProcess | undefined;
let runnerPid: number | null = null;
let browserPid: number | null = null;
let deadline: NodeJS.Timeout | undefined;
let continueAck: NodeJS.Timeout | undefined;
let actualPort = PORT;
let runnerWaitingPort: number | null = null;
/** A runner asked for its step to be restarted (a stuck page, stall.ts), or a rerun from rewindTo. */
let restartRequest: { index: number; reason: string; rerun?: boolean; rewindTo?: number } | null = null;
/** Times this run went back to clear_cart for a stuck step (stall.ts STUCK_RERUNS); reset on Resume. */
let stuckReruns = 0;
/** Stuck-page restarts per step index, reset when the step finishes or on Resume. */
const stallRestarts = new Map<number, number>();
/** A step failed with a code that ends the run (blocked account, bad proxy). */
let finalFailure: string | null = null;
let runnerControlPort: number | null = null;

/**
 * The checkpoint this run is working towards, if any. Kept here rather than
 * only in the runner so that a runner respawned after a crash still stops
 * where the operator asked, instead of running on into checkout.
 */
let stopAfter: number | undefined = parseStopAfter(process.env.SLOT_STOP_AFTER ?? null);
/** Remove blocks (RunnerConfig.unblocked). Restated by every resume, like stopAfter. */
let unblocked = process.env.SLOT_UNBLOCKED === "true";

function parseStopAfter(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const steps: StepRecord[] = STEPS.map((s, index) => ({
  index,
  key: s.key,
  status: "PENDING",
}));

const log = (m: string) => console.log(`[slot${SLOT_INDEX}] ${m}`);

function record(type: string, extra: Record<string, unknown> = {}): void {
  void recordAndFlush(type, extra);
}

async function recordAndFlush(
  type: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  appendEvent(artifactsDir, makeEvent(runId, SLOT_INDEX, type, extra));
  if (!MANAGER_URL) return;
  await fetch(`${MANAGER_URL}/slots/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, runId, slotIndex: SLOT_INDEX, type, ...extra }),
  }).catch(() => {
  });
}

function updateRegistry(): void {
  const file = join(artifactsDir, "slot.json");
  let entry: Record<string, unknown> = {};
  try {
    if (existsSync(file)) entry = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    entry = {};
  }
  entry.runId = runId;
  entry.slotIndex = SLOT_INDEX;
  entry.token = token;
  entry.port = actualPort;
  entry.pid = process.pid;
  entry.startedAt = entry.startedAt ?? Date.now();
  entry.jobId = entry.jobId ?? (JOB_ID || null);
  try {
    writeFileSync(file, JSON.stringify(entry, null, 2), "utf8");
  } catch (err) {
    log(`could not write slot.json: ${(err as Error).message}`);
  }
}

function clearRegistry(): void {
  try {
    rmSync(join(artifactsDir, "slot.json"), { force: true });
  } catch {
  }
}

function resumeIndex(): number {
  const i = steps.findIndex((s) => s.status !== "SUCCEEDED");
  return i === -1 ? STEPS.length : i;
}

function clearDeadline(): void {
  if (deadline) clearTimeout(deadline);
  deadline = undefined;
}

function clearContinueAck(): void {
  if (continueAck) clearTimeout(continueAck);
  continueAck = undefined;
}

function armContinueAck(from: number): void {
  clearContinueAck();
  continueAck = setTimeout(() => {
    if (status !== "BUSY") return;
    if (steps.some((s) => s.status === "RUNNING")) return;
    markStuck(
      `the runner accepted the resume from step ${from} but never started it — ` +
        `resume again and the slot will use a fresh runner`,
    );
  }, CONTINUE_ACK_MS);
}

function armDeadline(stepIndex: number): void {
  clearDeadline();
  deadline = setTimeout(() => {
    const step = steps[stepIndex];
    if (!step || step.status !== "RUNNING") return;
    step.status = "FAILED";
    step.failure_code = "step_timeout";
    step.detail = `no result within ${STEP_DEADLINE_MS}ms — runner presumed dead`;
    markStuck(`step ${stepIndex} (${step.key}) exceeded the deadline`);
    void terminateRunner().catch(err => log(`timed-out runner could not be stopped: ${(err as Error).message}`));
  }, STEP_DEADLINE_MS);
}

const STUCK_TTL_MS = Number(process.env.SLOT_STUCK_TTL_MS ?? 2 * 60 * 60 * 1000);
let stuckTtl: NodeJS.Timeout | undefined;
let stuckWarns: NodeJS.Timeout[] = [];

function clearStuckTtl(): void {
  if (stuckTtl) clearTimeout(stuckTtl);
  stuckTtl = undefined;
  for (const t of stuckWarns) clearTimeout(t);
  stuckWarns = [];
}

function armStuckTtl(reason: string): void {
  if (STUCK_TTL_MS <= 0) return;
  clearStuckTtl();
  const mins = Math.round(STUCK_TTL_MS / 60_000);
  log(`browser will be reaped in ${mins} min unless resumed (SLOT_STUCK_TTL_MS)`);

  for (const frac of [0.5, 0.8]) {
    const t = setTimeout(() => {
      const left = Math.round((STUCK_TTL_MS * (1 - frac)) / 60_000);
      log(`STUCK for ${Math.round((STUCK_TTL_MS * frac) / 60_000)} min — ${left} min before reap`);
      record("slot.ttl_warning", { reason, remainingMs: STUCK_TTL_MS * (1 - frac) });
    }, STUCK_TTL_MS * frac);
    t.unref();
    stuckWarns.push(t);
  }

  stuckTtl = setTimeout(() => {
    void (async () => {
      log(`━━━ TTL EXPIRED after ${mins} min — closing the browser and releasing the slot ━━━`);
      await recordAndFlush("slot.reaped", {
        reason: "session_ttl",
        stuckReason: reason,
        ttlMs: STUCK_TTL_MS,
        by: "slot",
      });
      await shutdown(1);
    })();
  }, STUCK_TTL_MS);
  stuckTtl.unref();
}

function markStuck(reason: string): void {
  clearDeadline();
  clearContinueAck();
  status = "STUCK";
  armStuckTtl(reason);
  record("slot.stuck", { reason });
  log("");
  log(`━━━ STUCK: ${reason} ━━━`);
  log("Browser is STILL ALIVE and the slot stays locked. Options:");
  log(`  continue      curl -X POST "http://127.0.0.1:${actualPort}/resume?token=${token}"`);
  log(`  from step k   curl -X POST "http://127.0.0.1:${actualPort}/resume?token=${token}&from=K"`);
  log(`  restart all   curl -X POST "http://127.0.0.1:${actualPort}/resume?token=${token}&from=0"`);
  log(`  cancel        curl -X POST "http://127.0.0.1:${actualPort}/cancel?token=${token}"`);
  log(`  (browser stays up until you cancel or the run completes)`);
  log("");
}

async function terminateRunner(): Promise<void> {
  const pid = runnerPid;
  if (!pid) return;
  try { process.kill(pid); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  const until = Date.now() + 5_000;
  for (;;) {
    try { process.kill(pid, 0); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      if (runnerPid === pid) runnerPid = null;
      runnerWaitingPort = null;
      return;
    }
    if (Date.now() >= until) throw new Error("previous runner is still alive; resume refused");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function spawnRunner(startIndex: number): void {
  clearContinueAck();
  const cfg: RunnerConfig = {
    run_id: runId,
    cdp_url: cdpUrl,
    slot_url: `http://127.0.0.1:${actualPort}`,
    token,
    start_index: startIndex,
    storage_state_path: storageStatePath,
    artifacts_dir: artifactsDir,
    ...(stopAfter !== undefined ? { stop_after: stopAfter } : {}),
    ...(unblocked ? { unblocked: true } : {}),
  };

  status = "BUSY";
  runnerWaitingPort = null;
  runner = spawn(process.execPath, [RUNNER_PATH, JSON.stringify(cfg)], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, RUN_ID: runId, SLOT_INDEX: String(SLOT_INDEX) },
  });
  const runnerLog = openLog(artifactsDir, "runner");
  tee(runner.stdout, runnerLog, `[runner${SLOT_INDEX}]`);
  tee(runner.stderr, runnerLog, `[runner${SLOT_INDEX}!]`);
  runnerPid = runner.pid ?? null;
  runner.unref();
  log(
    `spawned runner pid=${runnerPid} from step ${startIndex}` +
      (stopAfter === undefined ? "" : `, parking after step ${stopAfter}`) +
      ` → reports to ${cfg.slot_url}`,
  );
  record("runner.spawned", { pid: runnerPid, startIndex, stopAfter: stopAfter ?? null, slotUrl: cfg.slot_url });

  runner.on("exit", (code, signal) => {
    log(`runner pid=${runnerPid} exited (code=${code} signal=${signal})`);
    runnerWaitingPort = null;
    runnerPid = null;
    const ask = restartRequest;
    restartRequest = null;
    if (ask?.rerun && ask.rewindTo !== undefined && code === STALL_EXIT_CODE && status === "BUSY" && !shuttingDown) {
      rerunOrPause(ask.index, ask.rewindTo, ask.reason);
      return;
    }
    if (ask && code === STALL_EXIT_CODE && status === "BUSY" && !shuttingDown) {
      const done = stallRestarts.get(ask.index) ?? 0;
      if (done < STALL_RESTARTS) {
        stallRestarts.set(ask.index, done + 1);
        log(`step ${ask.index}: ${ask.reason} — restart ${done + 1}/${STALL_RESTARTS}`);
        record("step.restarted", { stepIndex: ask.index, attempt: done + 1, reason: ask.reason });
        const s = steps[ask.index];
        if (s) s.status = "PENDING";
        spawnRunner(ask.index);
        return;
      }
      const s = steps[ask.index];
      if (s) {
        s.status = "FAILED";
        s.failure_code = "page_stuck";
        s.detail = `${ask.reason} — still stuck after ${STALL_RESTARTS} restarts`;
      }
      markStuck(`step ${ask.index} page stuck after ${STALL_RESTARTS} restarts`);
      return;
    }
    if (status === "BUSY") {
      const running = steps.find((s) => s.status === "RUNNING");
      if (running) {
        running.status = "FAILED";
        running.failure_code = "browser_crashed";
        running.detail = `runner exited during step (code=${code} signal=${signal})`;
        markStuck(`runner died during step ${running.index} (${running.key})`);
      } else {
        markStuck(`runner exited between steps (code=${code} signal=${signal})`);
      }
    }
  });
}

/**
 * A step after proceed_to_buy made no progress (runner.ts, stall.ts). The
 * first time: back to clear_cart in the same browser, a fresh runner. Again:
 * the step fails "Reran N time(s)" and the run PAUSES with its browser open —
 * the master frees its batch place so the next row starts (user, 2026-10-10).
 */
function rerunOrPause(index: number, rewindTo: number, reason: string): void {
  if (stuckReruns < STUCK_RERUNS) {
    stuckReruns++;
    log(`step ${index}: ${reason} — going back to step ${rewindTo} (rerun ${stuckReruns}/${STUCK_RERUNS})`);
    record("step.rerun", { stepIndex: index, rewindTo, attempt: stuckReruns, reason });
    for (const s of steps) if (s.index >= rewindTo) s.status = "PENDING";
    spawnRunner(rewindTo);
    return;
  }
  const detail = `Reran ${stuckReruns} time${stuckReruns === 1 ? "" : "s"}`;
  const s = steps[index];
  if (s) {
    s.status = "FAILED";
    s.failure_code = "stuck_rerun";
    s.detail = detail;
  }
  clearDeadline();
  clearContinueAck();
  record("step.finished", {
    stepIndex: index,
    stepKey: s?.key ?? STEPS[index]?.key ?? String(index),
    result: "failed",
    failure_code: "stuck_rerun",
    detail,
    screenshot: null,
    url: null,
  });
  status = "PAUSED";
  log(`step ${index}: ${reason} again after ${detail.toLowerCase()} — PAUSED, browser kept; Resume continues`);
  armStuckTtl(`paused: ${reason}`);
  // The manager reports this as the run PAUSED (rerun_exhausted frees its batch place).
  record("runner.waiting", { port: null, reason: "paused", after_step: Math.max(0, index - 1), rerun_exhausted: true });
}

async function finish(outcome: "SUCCEEDED" | "FAILED"): Promise<void> {
  clearDeadline();
  await recordAndFlush("run.finished", { outcome });
  if (outcome === "SUCCEEDED") {
    status = "DONE";
    log("all steps complete — closing the browser and releasing the slot");
    await shutdown(0);
  } else if (finalFailure) {
    // Nothing to resume: the master cancels the run when it reads the code.
    status = "DONE";
    log(`run ended (${finalFailure}) — closing the browser and releasing the slot`);
    await shutdown(1);
  } else {
    markStuck("run finished with a failed step");
  }
}

function handleEvent(event: RunnerEvent): void {
  switch (event.type) {
    case "runner.ready":
      runnerControlPort = event.control_port;
      log(`runner ready (pid=${event.pid}) starting at step ${event.start_index}`);
      break;

    case "step.started": {
      clearContinueAck();
      const s = steps[event.step_index];
      if (s) s.status = "RUNNING";
      armDeadline(event.step_index);
      log(`step ${event.step_index} ${event.step_key} → RUNNING`);
      record("step.started", { stepIndex: event.step_index, stepKey: event.step_key });
      break;
    }

    case "step.restart":
      restartRequest = {
        index: event.step_index,
        reason: event.reason,
        ...(event.rerun && event.rewind_to !== undefined ? { rerun: true, rewindTo: event.rewind_to } : {}),
      };
      break;

    case "step.finished": {
      stallRestarts.delete(event.step_index);
      clearDeadline();
      const s = steps[event.step_index];
      if (s) {
        s.status = event.result.status === "failed" ? "FAILED" : "SUCCEEDED";
        s.screenshot = event.screenshot;
        s.url = event.url;
        if (event.result.status === "failed") {
          s.failure_code = event.result.failure_code;
          s.detail = event.result.detail;
        }
      }
      if (event.result.status === "failed" && FINAL_FAILURES.has(event.result.failure_code)) {
        finalFailure = event.result.failure_code;
      }
      log(
        `step ${event.step_index} ${event.step_key} → ${event.result.status.toUpperCase()}` +
          (event.result.status === "failed" ? ` (${event.result.failure_code})` : ""),
      );
      if (event.screenshot) log(`   artifact: ${event.screenshot}`);
      record("step.finished", {
        stepIndex: event.step_index,
        stepKey: event.step_key,
        result: event.result.status,
        failure_code: event.result.status === "failed" ? event.result.failure_code : null,
        detail: event.result.status === "failed" ? event.result.detail : null,
        screenshot: event.screenshot,
        url: event.url,
      });
      break;
    }

    case "runner.waiting":
      runnerWaitingPort = event.port;
      if (event.reason === "paused") {
        status = "PAUSED";
        log(`runner PAUSED and holding its tab on port ${event.port} — resume continues in it`);
        // A parked browser still holds its Amazon account. Reap it on the same
        // clock as a STUCK one, so a checkpoint nobody comes back to cannot
        // lock the account forever. Resume clears this.
        armStuckTtl(`parked after step ${event.after_step ?? "?"}`);
      } else {
        log(
          `runner is HOLDING its tab open on port ${event.port} — resume continues in the same tab`,
        );
      }
      record("runner.waiting", {
        port: event.port,
        reason: event.reason ?? "failed",
        after_step: event.after_step ?? null,
      });
      break;

    case "run.finished":
      void finish(event.outcome);
      break;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

let controlInFlight = false;
const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
  const auth = req.headers.authorization?.replace("Bearer ", "") ?? url.searchParams.get("token");
  if (auth !== token) return json(res, 401, { error: "bad token" });
  const control = req.method === "POST" && url.pathname !== "/events";
  if (control && (controlInFlight || shuttingDown)) return json(res, 409, { error: "another slot control is in progress" });
  if (control) controlInFlight = true;
  try {

  if (req.method === "POST" && url.pathname === "/events") {
    try {
      handleEvent(JSON.parse(await readBody(req)) as RunnerEvent);
    } catch (err) {
      log(`bad event: ${(err as Error).message}`);
    }
    return json(res, 202, { ok: true });
  }

  /**
   * A FRESH screenshot of the page as it is now — the panel's Capture button.
   * Through the runner when one holds the page; otherwise attach over CDP for
   * the one shot and detach (the browser survives a CDP client leaving, which
   * is the same property the runner relies on).
   */
  if (req.method === "POST" && url.pathname === "/capture") {
    if (runnerControlPort !== null && runnerPid !== null) {
      const r = await fetch(`http://127.0.0.1:${runnerControlPort}/capture?token=${token}`, {
        method: "POST",
      }).catch(() => null);
      const body = r ? ((await r.json().catch(() => ({}))) as { file?: string; step_index?: number }) : {};
      if (r?.ok && body.file) {
        return json(res, 200, { ok: true, file: body.file, step_index: body.step_index ?? null });
      }
    }
    if (!cdpUrl) return json(res, 409, { error: "no browser to capture" });
    try {
      const { chromium } = await import("./pw.js");
      const browser = await chromium.connectOverCDP(cdpUrl);
      try {
        const page = browser.contexts()[0]?.pages()[0];
        if (!page) return json(res, 409, { error: "the browser has no open page" });
        const file = join(artifactsDir, `capture-${Date.now()}.jpg`);
        await page.screenshot({ path: file, type: "jpeg", quality: 60 });
        return json(res, 200, { ok: true, file, step_index: resumeIndex() });
      } finally {
        await browser.close().catch(() => undefined);
      }
    } catch (err) {
      return json(res, 500, { error: `capture failed: ${(err as Error).message}` });
    }
  }

  if (url.pathname === "/status") {
    return json(res, 200, {
      run_id: runId,
      status,
      runner_pid: runnerPid,
      browser_pid: browserPid,
      slot_pid: process.pid,
      slot_index: SLOT_INDEX,
      cdp_url: cdpUrl,
      resume_index: resumeIndex(),
      runner_waiting_port: runnerWaitingPort,
      steps,
    });
  }

  if (req.method === "POST" && url.pathname === "/pause") {
    if (status === "PAUSED") return json(res, 200, { ok: true, already: true });
    if (status !== "BUSY" || runnerControlPort === null) {
      return json(res, 409, { error: `no live runner to pause (slot is ${status})` });
    }
    const r = await fetch(`http://127.0.0.1:${runnerControlPort}/pause?token=${token}`, {
      method: "POST",
    }).catch(() => null);
    if (!r) {
      return json(res, 502, { error: "the runner did not answer the pause request" });
    }
    const body = (await r.json().catch(() => ({}))) as { error?: string; after_step?: number };
    if (!r.ok) {
      return json(res, r.status, { error: body.error ?? `runner refused (${r.status})` });
    }
    log(`pause requested — the runner will park after step ${body.after_step ?? "?"}`);
    return json(res, 202, { ok: true, after_step: body.after_step ?? null });
  }

  if (req.method === "POST" && url.pathname === "/resume") {
    if (status === "BUSY" && runnerPid !== null) {
      return json(res, 409, { error: "a runner is already active" });
    }
    clearStuckTtl();
    const fromRaw = url.searchParams.get("from");
    let from = fromRaw === null ? resumeIndex() : Number(fromRaw);
    if (!Number.isInteger(from) || from < 0 || from > STEPS.length) {
      return json(res, 400, { error: `bad 'from': ${fromRaw}` });
    }
    // Every resume states its checkpoint afresh: absent means run to the end.
    // Carrying an old checkpoint over would make "Run to end" stop short, and
    // carrying none over would make a column click run into checkout.
    const untilRaw = url.searchParams.get("stop_after");
    const until = parseStopAfter(untilRaw);
    if (untilRaw !== null && until === undefined) {
      return json(res, 400, { error: `bad 'stop_after': ${untilRaw}` });
    }
    stopAfter = until;
    unblocked = url.searchParams.get("unblocked") === "1";
    // The operator's Resume gives every step its stuck-page restarts back,
    // and the run its rerun from clear_cart.
    stallRestarts.clear();
    stuckReruns = 0;
    if (JOB_ID) {
      const fresh = await requireJobClient().resumeInputs(runId);
      if (fresh.fresh_attempt) {
        json(res, 202, { ok: true, mode: "fresh-attempt", detail: "identity changed; new attempt queued, closing the previous browser" });
        await shutdown(0);
        return;
      }
      if (!fresh.job) return json(res, 409, { error: "latest sheet row is unavailable" });
      const file = join(artifactsDir, "job.json");
      const previous = JSON.parse(readFileSync(file, "utf8")) as SheetJob;
      // The browser was launched through the old proxy and cannot switch:
      // a new proxy is a new attempt in a new browser, like a new account.
      if ((previous.proxy ?? "") !== (fresh.job.proxy ?? "")) {
        await requireJobClient().requestRetry(runId);
        json(res, 202, { ok: true, mode: "fresh-attempt", detail: "proxy changed; new attempt queued, closing the previous browser" });
        await shutdown(0);
        return;
      }
      const asked = from;
      // An order placed by this run is final: a sheet edit cannot send it back
      // to rebuild the cart. Only a New attempt buys again.
      const placed = existsSync(join(artifactsDir, "orders-placed.json")) &&
        readFileSync(join(artifactsDir, "orders-placed.json"), "utf8").trim().length > 2;
      // Remove blocks starts where the operator said (proceed_to_buy): the cart
      // they aligned by hand is not rebuilt, whatever the sheet says now.
      if (!placed && !unblocked) from = resumeStep(previous, fresh.job, from);
      // Says what the master answered, so "the sheet edit was not picked up" can be told
      // apart from "the master had not seen the edit yet".
      log(
        inputsChanged(previous, fresh.job)
          ? `sheet inputs changed since this browser started — resuming from step ${from} (asked ${asked})`
          : `sheet inputs unchanged (revision ${fresh.job.revision})`,
      );
      if (inputsChanged(previous, fresh.job)) {
        await terminateRunner();
        writeFileSync(file, JSON.stringify(fresh.job));
        if (from <= 4 && !placed) rmSync(join(artifactsDir, "expected-basket.json"), { force: true });
      }
    }
    for (const s of steps) {
      if (s.index >= from) {
        s.status = "PENDING";
        delete s.failure_code;
        delete s.detail;
      }
    }
    if (runnerWaitingPort) {
      const ok = await fetch(
        `http://127.0.0.1:${runnerWaitingPort}/continue?token=${token}&from=${from}` +
          `&stop_after=${stopAfter ?? ""}&unblocked=${unblocked ? 1 : ""}`,
        { method: "POST" },
      )
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) {
        status = "BUSY";
        runnerWaitingPort = null;
        armContinueAck(from);
        log(`resuming from step ${from} — continuing in the SAME TAB`);
        return json(res, 202, { ok: true, from, mode: "same-tab" });
      }
      log("waiting runner did not answer; falling back to a fresh runner");
      runnerWaitingPort = null;
    }
    try { await terminateRunner(); } catch (err) { return json(res, 409, { error: (err as Error).message }); }
    log(`resuming from step ${from} — new runner against the SAME browser`);
    spawnRunner(from);
    return json(res, 202, { ok: true, from, mode: "new-runner" });
  }

  if (req.method === "POST" && url.pathname === "/stuck") {
    const reason = url.searchParams.get("reason") ?? "inactivity";
    if (status === "BUSY") {
      status = "STUCK";
      log(`marked STUCK by watchdog: ${reason}`);
      record("watchdog.stuck", { reason });
    }
    return json(res, 202, { ok: true, status });
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    markStuck("stopped by operator; browser preserved");
    try { await terminateRunner(); } catch (err) { return json(res, 409, { error: (err as Error).message }); }
    return json(res, 202, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/reload") {
    if (status === "BUSY" || !JOB_ID) return json(res, 409, { error: "stop or pause this fleet run before reloading its row" });
    try {
      const file = join(artifactsDir, "job.json");
      const result = await requireJobClient().resumeInputs(runId, false);
      if (result.fresh_attempt) {
        json(res, 202, { ok: true, mode: "fresh-attempt" });
        await shutdown(0); return;
      }
      const fresh = result.job;
      if (!fresh) throw new Error("latest sheet row unavailable");
      await terminateRunner();
      writeFileSync(file, JSON.stringify(fresh), { mode: 0o600 });
      rmSync(join(artifactsDir, "expected-basket.json"), { force: true });
      for (const step of steps) step.status = "PENDING";
      markStuck("row explicitly reloaded; Resume will rebuild the basket from step 0");
      return json(res, 200, { ok: true });
    } catch (err) { return json(res, 409, { error: (err as Error).message }); }
  }

  if (req.method === "POST" && url.pathname === "/cancel") {
    log("cancelled by operator");
    json(res, 202, { ok: true });
    await shutdown(1);
    return;
  }

  return json(res, 404, { error: "not found" });
  } catch (err) {
    log(`slot request failed: ${(err as Error).message}`);
    if (!res.headersSent) json(res, 500, { error: (err as Error).message });
  } finally {
    if (control) controlInFlight = false;
  }
});

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearDeadline();
  clearStuckTtl();
  stopBrowserWatch();
  clearRegistry();
  if (runnerPid) {
    try {
      process.kill(runnerPid);
    } catch {
    }
  }
  http.close();
  try {
    await session?.stop();
    await recordAndFlush("browser.closed", { reason: "closed", code });
    log("browser closed");
  } catch (err) {
    log(`error closing browser: ${(err as Error).message}`);
  }
  process.exit(code);
}

/** The run's proxy from its job snapshot; null = direct. Throws on one that does not read. */
function resolveProxy(): Proxy | null {
  if (!JOB_ID) return parseAccountProxy(process.env.BOT_PROXY ?? "");
  const job = JSON.parse(readFileSync(join(artifactsDir, "job.json"), "utf8")) as { proxy?: string };
  return parseAccountProxy(job.proxy ?? "");
}

function resolveAccount(cfg: { credentials: { email: string } }): string {
  if (JOB_ID) {
    try {
      const raw = readFileSync(join(artifactsDir, "job.json"), "utf8");
      const job = JSON.parse(raw) as { credentials?: { email?: string } };
      const email = (job.credentials?.email ?? "").trim();
      if (email) return email;
    } catch (err) {
      throw new Error(`cannot restore the fleet account snapshot: ${(err as Error).message}`);
    }
    throw new Error("fleet account snapshot has no email; refusing an environment fallback");
  }
  const fallback = (cfg.credentials?.email ?? "").trim();
  if (fallback) return fallback;
  throw new Error(
    "cannot determine which account this run is for — refusing to launch a browser " +
      "that would sign in with nobody's credentials",
  );
}

const WATCH_TICK_MS = 5_000;
let watchTimer: NodeJS.Timeout | undefined;
let lastSeenUrl = "";
/** This run's ShardX profile, touched while the browser is up so pruning skips it. */
let profileId = "";
let profileTouchedAt = 0;
const PROFILE_TOUCH_MS = 10 * 60_000;
let lastUrlChangeAt = Date.now();

function cdpHttpBase(): string | null {
  try {
    const u = new URL(cdpUrl);
    return `http://${u.host}`;
  } catch {
    return null;
  }
}

async function watchTick(): Promise<void> {
  if (profileId && Date.now() - profileTouchedAt > PROFILE_TOUCH_MS) {
    profileTouchedAt = Date.now();
    touchProfile(profileId);
  }
  const base = cdpHttpBase();
  if (!base || !MANAGER_URL) return;
  try {
    const res = await fetch(`${base}/json/list`, {
      signal: AbortSignal.timeout(WATCH_TICK_MS - 500),
    });
    if (!res.ok) return;
    const targets = (await res.json()) as Array<{ type?: string; url?: string }>;
    const pages = targets.filter((t) => t.type === "page");
    const url = pages[0]?.url ?? "";
    if (url && url !== lastSeenUrl) {
      lastSeenUrl = url;
      lastUrlChangeAt = Date.now();
    }
    await fetch(`${MANAGER_URL}/watchdog/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        slotIndex: SLOT_INDEX,
        idleMs: Date.now() - lastUrlChangeAt,
        tabCount: pages.length,
        url,
      }),
    }).catch(() => {
    });
  } catch {
  }
}

function startBrowserWatch(): void {
  stopBrowserWatch();
  watchTimer = setInterval(() => void watchTick(), WATCH_TICK_MS);
  watchTimer.unref();
}

function stopBrowserWatch(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = undefined;
}

async function main(): Promise<void> {
  let cfg: BotConfig;
  if (JOB_ID) {
    loadDotEnv();
    cfg = { credentials: { email: "", password: "", totpSecret: "" }, headless: loadHeadless() };
    log(`job source: job ${JOB_ID}`);
    if (process.env.SLOT_RESTORE_ONLY !== "true") {
      const fresh = await requireJobClient().resumeInputs(runId);
      if (fresh.fresh_attempt) { await shutdown(0); return; }
      if (!fresh.job) throw new Error("latest sheet inputs are unavailable");
      writeFileSync(join(artifactsDir, "job.json"), JSON.stringify(fresh.job));
    }
  } else {
    cfg = loadConfig();
    loadAddress();
    const product = loadProduct();
    log(`product: ${product.url} x${product.quantity} (${product.purchaseOption})`);
  }


  const slotHeadless = (process.env.SLOT_HEADLESS ?? "").trim();
  const headless = slotHeadless ? /^(1|true|yes|on)$/i.test(slotHeadless) : cfg.headless;

  const startDelayMs = Number(process.env.SLOT_START_DELAY_MS ?? 0);
  if (startDelayMs > 0) {
    log(`staggering start by ${Math.round(startDelayMs / 1000)}s before launching the browser`);
    record("slot.start_delayed", { delayMs: startDelayMs });
    await new Promise((r) => setTimeout(r, startDelayMs));
  }

  const account = resolveAccount(cfg);
  // Set at launch, so not one request — the first Amazon page included — leaves without it.
  const proxy = resolveProxy();
  log(proxy ? `proxy ${proxy.label}` : "no proxy — the machine's own connection");
  // A fresh profile for every run; a relaunch for the same run gets that run's back.
  const launched = await launchForRun({ runId, headless, ...(proxy ? { proxy: proxy.url } : {}) });
  profileId = launched.profileId;
  profileTouchedAt = Date.now();
  log(`account ${account} on profile ${profileId}`);
  session = launched.session;
  cdpUrl = launched.cdpUrl;
  browserPid = launched.pid;
  log(`launching ShardX (${launched.summary})`);
  record("browser.profile", { headless, summary: launched.summary, profileId: launched.profileId });

  try {
    const browserLog = openLog(artifactsDir, "browser");
    tee(session.process.stdout, browserLog, `[browser${SLOT_INDEX}]`, false);
    tee(session.process.stderr, browserLog, `[browser${SLOT_INDEX}]`, false);
    record("browser.started", { pid: browserPid, cdpUrl, profileId: launched.profileId });
  } catch (err) {
    log(`could not attach to browser stdio: ${(err as Error).message}`);
  }
  log(`browser up — pid=${browserPid} cdp=${cdpUrl}`);

  startBrowserWatch();

  await new Promise<void>((resolve) => http.listen(PORT, "127.0.0.1", resolve));
  const addr = http.address();
  actualPort = typeof addr === "object" && addr ? addr.port : PORT;
  log(`control surface on http://127.0.0.1:${actualPort} (token ${token})`);
  log(`status: curl "http://127.0.0.1:${actualPort}/status?token=${token}"`);

  updateRegistry();
  record("slot.ready", { port: actualPort, token, jobId: JOB_ID || null });

  // A restored browser waits for Resume — unless it was restored to run on
  // from a given step (Remove blocks: from proceed_to_buy, the session from
  // storage-state.json).
  const startFrom = parseStopAfter(process.env.SLOT_START_FROM ?? null);
  if (process.env.SLOT_RESTORE_ONLY === "true" && startFrom === undefined) {
    markStuck("browser restored; press Resume to execute steps");
  } else if (startFrom !== undefined) {
    for (const s of steps) if (s.index >= startFrom) s.status = "PENDING";
    log(`restored browser runs on from step ${startFrom}${unblocked ? " with blocks removed" : ""}`);
    spawnRunner(startFrom);
  } else spawnRunner(resumeIndex());
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") console.error(`[slot] stdio error: ${err.message}`);
  });
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

main().catch((err: unknown) => {
  console.error("[slot] fatal:", err instanceof Error ? err.message : err);
  void shutdown(1);
});
