import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "./pw.js";
import { loadAddress, loadConfig, loadDotEnv, loadProduct, parseRewardType, reloadDotEnv } from "./config.js";
import { postEvent, type RunnerConfig, type StepResult } from "./protocol.js";
import { LAST_STEP, LAST_STEP_INDEX, STEPS, UNBLOCKABLE_FROM, UNBLOCKABLE_UNTIL, stepAt, type StepContext } from "./steps.js";
import { openRewardTab } from "./reward.js";
import { describeForOperator } from "./failures.js";
import type { SheetJob } from "./job-client.js";
import { parseAccountProxy } from "./proxy.js";
import { STALL_EXIT_CODE, recoverFromStall, watchForStall } from "./stall.js";


const STEP_SETTLE_MS = 350;
const HEARTBEAT_MS = 5_000;

function startHeartbeat(cfg: RunnerConfig, state: { index: number; key: string }): NodeJS.Timeout {
  const send = async () => {
    const url = (process.env.MANAGER_URL ?? "").trim();
    if (!url) return;
    try {
      await fetch(`${url}/runner/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: cfg.token,
          runId: cfg.run_id,
          pid: process.pid,
          stepIndex: state.index,
          stepKey: state.key,
          ts: new Date().toISOString(),
        }),
      });
    } catch {
    }
  };
  // A runner outlives a slot that was killed hard (its control port keeps it
  // up forever, parked or not): when the slot stops answering, leave too.
  let slotMisses = 0;
  const checkSlot = async () => {
    const ok = await fetch(`${cfg.slot_url}/status?token=${cfg.token}`, { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.ok)
      .catch(() => false);
    slotMisses = ok ? 0 : slotMisses + 1;
    if (slotMisses >= SLOT_MISSES_TO_EXIT) {
      console.error(`[runner] slot ${cfg.slot_url} has not answered ${slotMisses} times — it is gone; exiting`);
      process.exit(1);
    }
  };
  void send();
  const timer = setInterval(() => {
    void send();
    void checkSlot();
  }, HEARTBEAT_MS);
  timer.unref?.();
  return timer;
}

/** Consecutive unanswered slot checks (one per heartbeat) before a runner gives up. */
const SLOT_MISSES_TO_EXIT = 6;

async function reportBlocked(
  jobId: string,
  runId: string,
  note: string,
): Promise<void> {
  if (!jobId) return;
  const { JobClient } = await import("./job-client.js");
  const client = JobClient.fromEnv((m) => console.error(m));
  if (!client) return;
  const ok = await client.reportResult(jobId, {
    status: "BLOCKED",
    notes: note,
    run_id: runId,
  });
  if (ok) console.log(`[runner] reported BLOCKED + reason for job ${jobId}`);
}

async function reportRunning(jobId: string, runId: string): Promise<void> {
  if (!jobId) return;
  const { JobClient } = await import("./job-client.js");
  const client = JobClient.fromEnv();
  if (!client) return;
  await client.reportResult(jobId, { status: "RUNNING", notes: "", run_id: runId });
}

let controlServer: Server | null = null;
let controlPort = 0;
let pendingContinue: ((from: number | null) => void) | null = null;

function closeControlServer(): void {
  controlServer?.close();
  controlServer = null;
  pendingContinue = null;
}

let pauseRequested = false;

/**
 * Takes a screenshot of the run's page right now. Set once the page exists;
 * the control server's /capture uses it so the panel's Capture button shows
 * the browser as it is, not the last step's screenshot.
 */
let captureNow: (() => Promise<string | null>) | null = null;

const COMMIT_STEP_INDEX = STEPS.findIndex((s) => s.key === "note_order_id");

function ensureControlServer(cfg: RunnerConfig, live: { index: number }): Promise<number> {
  if (controlServer) return Promise.resolve(controlPort);
  return new Promise<number>((resolve) => {
    controlServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${controlPort}`);
      const reply = (code: number, body: unknown): void => {
        res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
      };
      if (url.searchParams.get("token") !== cfg.token) {
        res.writeHead(401).end("bad token");
        return;
      }

      if (url.pathname === "/pause") {
        if (COMMIT_STEP_INDEX >= 0 && live.index >= COMMIT_STEP_INDEX) {
          reply(409, {
            error:
              `this run has reached "${STEPS[COMMIT_STEP_INDEX]?.key}" and is committed — ` +
              `pause is refused. Cancel it, or let it finish and restart from a step.`,
          });
          return;
        }
        pauseRequested = true;
        console.log(`[runner] pause requested — will park after step ${live.index}`);
        reply(202, { ok: true, after_step: live.index });
        return;
      }

      if (url.pathname === "/capture") {
        if (!captureNow) {
          reply(409, { error: "the runner has no page yet" });
          return;
        }
        void captureNow().then((file) =>
          file
            ? reply(200, { ok: true, file, step_index: live.index })
            : reply(500, { error: "screenshot failed" }),
        );
        return;
      }

      if (url.pathname !== "/continue" && url.pathname !== "/stop") {
        res.writeHead(404).end("{}");
        return;
      }
      const resume = pendingContinue;
      if (!resume) {
        reply(409, { error: "this runner is not waiting for a continue" });
        return;
      }
      if (url.pathname === "/stop") {
        res.writeHead(202).end("{}");
        resume(null);
        return;
      }
      const from = Number(url.searchParams.get("from") ?? "");
      // The continue restates the checkpoint: blank or absent means run to the
      // end, a number means park again after that step.
      const untilRaw = (url.searchParams.get("stop_after") ?? "").trim();
      const until = untilRaw === "" ? undefined : Number(untilRaw);
      if (until !== undefined && (!Number.isInteger(until) || until < 0)) {
        reply(400, { error: `bad 'stop_after': ${untilRaw}` });
        return;
      }
      if (until === undefined) delete cfg.stop_after;
      else cfg.stop_after = until;
      // Restated on every continue, like the checkpoint: only Remove blocks sets it.
      cfg.unblocked = url.searchParams.get("unblocked") === "1";
      reply(202, { ok: true });
      resume(Number.isInteger(from) && from >= 0 ? from : 0);
    });

    controlServer.listen(0, "127.0.0.1", () => {
      const addr = controlServer?.address();
      controlPort = typeof addr === "object" && addr ? addr.port : 0;
      console.log(`[runner] control port ${controlPort} open for pause / continue`);
      resolve(controlPort);
    });
  });
}

async function awaitContinue(
  cfg: RunnerConfig,
  reason: "failed" | "paused" = "failed",
  afterStep?: number,
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    pendingContinue = (from) => {
      pendingContinue = null;
      resolve(from);
    };
    console.log(
      `[runner] holding the tab open on control port ${controlPort} — ${reason}, waiting to continue`,
    );
    void postEvent(cfg.slot_url, cfg.token, {
      type: "runner.waiting",
      run_id: cfg.run_id,
      port: controlPort,
      reason,
      ...(afterStep !== undefined ? { after_step: afterStep } : {}),
    });
  });
}

type JobData = Pick<StepContext, "creds" | "address" | "addresses" | "products" | "payment" | "rewards" | "proxy">;

async function loadJob(
  jobId: string,
  artifactsDir: string,
  fresh = false,
): Promise<JobData> {
  if (jobId) {
    const file = join(artifactsDir, "job.json");
    let job: SheetJob;
    if (!fresh && existsSync(file)) {
      job = JSON.parse(readFileSync(file, "utf8")) as SheetJob;
    } else {
      const { requireJobClient } = await import("./job-client.js");
      job = await requireJobClient().getJob(jobId, { secrets: true });
      try {
        writeFileSync(file, JSON.stringify(job), { mode: 0o600 });
      } catch {
      }
    }
    if (!job.credentials.email || !job.credentials.password) {
      throw new Error(`job ${jobId} is missing account_email/account_password`);
    }
    if (job.items.length === 0) {
      console.warn(
        `[runner] user_id ${job.userId} has no rows in the Items tab — every step up to add_items will run, add_items will fail`,
      );
    }
    console.log(
      `[runner] job ${jobId} (sheet row ${job.rowNumber}): user_id=${job.userId} ` +
        `${job.credentials.email} — ${job.items.length} item(s)`,
    );
    return {
      creds: job.credentials,
      address: job.address,
      addresses: job.addresses ?? [],
      products: job.items,
      payment: job.payment,
      rewards: job.rewards ?? [],
      proxy: parseAccountProxy(job.proxy ?? ""),
    };
  }

  const { credentials } = loadConfig();
  const rewardUrl = (process.env.REWARD_URL ?? "").trim();
  const rewardType = parseRewardType(process.env.REWARD_TYPE ?? "", rewardUrl);
  return {
    creds: credentials,
    address: loadAddress(),
    addresses: [],
    products: [loadProduct()],
    payment: { method: "none", codes: [] },
    proxy: parseAccountProxy(process.env.BOT_PROXY ?? ""),
    rewards: rewardType
      ? [{
          row: 0,
          type: rewardType,
          url: rewardUrl,
          status: "",
          answer: (process.env.REWARD_ANSWER ?? "").trim(),
          // One per line in the sheet; ";" between them in .env.
          coupons: (process.env.REWARD_COUPONS ?? "").trim(),
        }]
      : [],
  };
}

/**
 * Reward-row status goes to the master, which writes it to the Reward tab.
 * Best effort: a lost mark must not cost the reward itself.
 */
function rewardMarker(jobId: string, runId: string): NonNullable<StepContext["markReward"]> {
  return async (r, status, extra) => {
    if (!r.row) return;
    try {
      const { requireJobClient } = await import("./job-client.js");
      await requireJobClient().markReward(jobId, runId, r.row, status, extra);
      console.log(`[runner] Reward row ${r.row} -> ${status}${extra?.notes ? ` (${extra.notes})` : ""}`);
    } catch (err) {
      console.warn(`[runner] could not mark Reward row ${r.row} ${status}: ${(err as Error).message}`);
    }
  };
}

function describeJob(job: JobData): string {
  const items = job.products
    .map(
      (p) =>
        `${p.url} x${p.quantity} (${p.purchaseOption})` +
        (p.expectedPrice === undefined ? "" : ` @${p.expectedPrice}`),
    )
    .join(" | ");
  const reward = job.rewards.length ? ` :: rewards=${job.rewards.map((r) => r.type).join(",")}` : "";
  return `${items} :: pay=${job.payment.method}(${job.payment.codes.length})${reward}`;
}

function parseConfig(): RunnerConfig {
  const raw = process.argv[2];
  if (!raw) throw new Error("runner: missing config argument");
  return JSON.parse(raw) as RunnerConfig;
}

async function withTimeout(p: Promise<StepResult>, ms: number, key: string): Promise<StepResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<StepResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              status: "failed",
              failure_code: "step_timeout",
              detail: `step "${key}" exceeded ${ms}ms`,
              retriable: true,
            }),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const SHOT_MODE = (process.env.BOT_SCREENSHOT_MODE ?? "jpeg").trim().toLowerCase();
const SHOT_QUALITY = Math.min(100, Math.max(20, Number(process.env.BOT_SCREENSHOT_QUALITY) || 60));
const SHOT_FULLPAGE_ON_FAILURE = !/^(0|false|no|off)$/i.test(
  (process.env.BOT_SCREENSHOT_FULLPAGE_ON_FAILURE ?? "1").trim(),
);

async function capture(
  page: Page,
  dir: string,
  label: string,
  failed = false,
): Promise<string | null> {
  if (SHOT_MODE === "off") return null;
  try {
    mkdirSync(dir, { recursive: true });
    const fullPage = SHOT_MODE === "fullpage" || (failed && SHOT_FULLPAGE_ON_FAILURE);
    const jpeg = SHOT_MODE === "jpeg" && !fullPage;
    const path = join(dir, `${label}.${jpeg ? "jpg" : "png"}`);
    await page.screenshot(
      jpeg ? { path, type: "jpeg", quality: SHOT_QUALITY, fullPage: false } : { path, fullPage },
    );
    return path;
  } catch (err) {
    console.error(`[runner] capture failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * A used voucher goes to the master, which writes "Used" to the Vouchers tab.
 * Best effort, like rewardMarker: add_vouchers also remembers it locally.
 */
function voucherMarker(jobId: string, runId: string): NonNullable<StepContext["markVoucher"]> {
  return async (v) => {
    if (!v.row) return;
    try {
      const { requireJobClient } = await import("./job-client.js");
      await requireJobClient().markVoucherUsed(jobId, runId, v.row);
      console.log(`[runner] Vouchers row ${v.row} -> Used`);
    } catch (err) {
      console.warn(`[runner] could not mark Vouchers row ${v.row} Used: ${(err as Error).message}`);
    }
  };
}

async function main(): Promise<number> {
  loadDotEnv();
  const cfg = parseConfig();

  const jobId = (process.env.JOB_ID ?? "").trim();
  await reportRunning(jobId, cfg.run_id);

  const ctx: StepContext = {
    ...(await loadJob(jobId, cfg.artifacts_dir)),
    runId: cfg.run_id,
    artifactsDir: cfg.artifacts_dir,
    ...(jobId ? { markReward: rewardMarker(jobId, cfg.run_id), markVoucher: voucherMarker(jobId, cfg.run_id) } : {}),
  };
  // Read live: a continue can switch Remove blocks on for the rest of the run.
  Object.defineProperty(ctx, "unblocked", { get: () => cfg.unblocked === true, enumerable: true });
  if (cfg.unblocked) console.log("[runner] blocks removed: checks from proceed_to_buy to Pay Now will not stop this run");

  console.log(`[runner ${process.pid}] connecting over CDP to ${cfg.cdp_url}`);
  const browser = await chromium.connectOverCDP(cfg.cdp_url);

  const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  if (existsSync(cfg.storage_state_path)) {
    try {
      const state = JSON.parse(readFileSync(cfg.storage_state_path, "utf8")) as {
        cookies?: Parameters<BrowserContext["addCookies"]>[0];
      };
      const cookies = await context.cookies();
      if (cookies.length === 0 && state.cookies?.length) {
        await context.addCookies(state.cookies);
        console.log(`[runner] seeded an empty profile from ${cfg.storage_state_path}`);
      }
    } catch (err) {
      console.error(`[runner] could not read storage state: ${(err as Error).message}`);
    }
  }

  const live = { index: cfg.start_index, key: "" };
  captureNow = () => capture(page, cfg.artifacts_dir, `capture-${Date.now()}`);
  const controlPortNow = await ensureControlServer(cfg, live);

  await postEvent(cfg.slot_url, cfg.token, {
    type: "runner.ready",
    run_id: cfg.run_id,
    pid: process.pid,
    start_index: cfg.start_index,
    control_port: controlPortNow,
  });

  const heartbeat = startHeartbeat(cfg, live);

  if (LAST_STEP_INDEX >= 0) {
    console.log(
      `[runner] ⚠ LAST_STEP="${LAST_STEP}" (step ${LAST_STEP_INDEX}) is set in steps.ts — ` +
        `this run will park there and go no further.`,
    );
  }

  async function runFrom(from: number): Promise<"SUCCEEDED" | "FAILED"> {
    for (let i = from; i < STEPS.length; i++) {
      const step = stepAt(i);
      if (!step) break;
      live.index = i;
      live.key = step.key;

      console.log(`[runner] ── step ${i} ${step.key} ──`);
      await postEvent(cfg.slot_url, cfg.token, {
        type: "step.started",
        run_id: cfg.run_id,
        step_index: i,
        step_key: step.key,
      });

      // A page stuck loading for 90 s: refresh it, and have the slot restart
      // this step in a fresh runner (at most 3 times, the slot counts).
      const stopWatch = watchForStall(context, (stall) => {
        void (async () => {
          const where = stall.url.slice(0, 100);
          const reason = `page stuck ${stall.state} for ${Math.round(stall.forMs / 1000)}s at ${where}`;
          console.error(`[runner] ${reason} — refreshing and restarting step ${i} ${step.key}`);
          await recoverFromStall(context, page);
          await postEvent(cfg.slot_url, cfg.token, {
            type: "step.restart",
            run_id: cfg.run_id,
            step_index: i,
            step_key: step.key,
            reason,
          });
          process.exit(STALL_EXIT_CODE);
        })();
      });

      let result: StepResult;
      try {
        result = await withTimeout(step.run(page, ctx), step.timeoutMs, step.key).finally(stopWatch);
      } catch (err) {
        result = {
          status: "failed",
          failure_code: "unknown_error",
          detail: (err as Error).message,
          retriable: false,
        };
      }

      // REMOVE BLOCKS: the operator aligned the checkout by hand. A check
      // between proceed_to_buy and Pay Now that would stop the run is said in
      // the log and passed over (skipped). A timeout still ends the runner: the
      // step may still be acting on the page.
      if (
        cfg.unblocked && result.status === "failed" && result.failure_code !== "step_timeout" &&
        i >= UNBLOCKABLE_FROM && i < UNBLOCKABLE_UNTIL
      ) {
        console.warn(`[runner] blocks removed — step ${i} ${step.key} would stop here, going on: ${result.detail}`);
        result = { status: "skipped" };
      }

      if (result.status === "failed" && result.failure_code === "step_timeout") {
        await postEvent(cfg.slot_url, cfg.token, { type: "step.finished", run_id: cfg.run_id,
          step_index: i, step_key: step.key, result, screenshot: null, url: page.url() });
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, STEP_SETTLE_MS));
      // check_reward works in its own mobile tab, left open when a row fails:
      // that tab is what the operator needs to see, not the untouched main one.
      const shotPage = (step.key === "check_reward" ? await openRewardTab(page) : null) ?? page;
      const shot = await capture(
        shotPage,
        cfg.artifacts_dir,
        `${i}-${step.key}-${result.status}`,
        result.status === "failed",
      );
      const url = shotPage.url();

      await postEvent(cfg.slot_url, cfg.token, {
        type: "step.finished",
        run_id: cfg.run_id,
        step_index: i,
        step_key: step.key,
        result,
        screenshot: shot,
        url,
      });

      if (result.status === "failed") {
        console.error(`[runner] step ${i} ${step.key} FAILED: ${result.detail}`);
        const note = describeForOperator(step.key, result.detail);
        console.error(`[runner] ${note}`);
        await reportBlocked(jobId, cfg.run_id, note);
        return "FAILED";
      }

      // A CHECKPOINT: the operator asked for this run to go no further than
      // this step. Parks exactly like an operator pause — same tab, same
      // browser — so the next column click continues from here.
      const checkpoint = cfg.stop_after !== undefined && i === cfg.stop_after;
      const parkedHere = pauseRequested || checkpoint;
      if (parkedHere) {
        pauseRequested = false;
        console.log(
          `[runner] ${checkpoint ? "checkpoint reached —" : ""} paused after step ${i} ${step.key}`,
        );
        const next = await awaitContinue(cfg, "paused", i);
        if (next === null) return "FAILED";
        if (next !== i + 1) {
          return await runFrom(next);
        }
        await reportRunning(jobId, cfg.run_id);
      }

      if (step.key === "login") {
        try {
          await context.storageState({ path: cfg.storage_state_path });
          console.log(`[runner] session checkpointed → ${cfg.storage_state_path}`);
        } catch (err) {
          console.error(`[runner] checkpoint failed: ${(err as Error).message}`);
        }
      }

      // Never park twice on one step: the operator already continued past it.
      if (i === LAST_STEP_INDEX && !parkedHere) {
        console.log(
          `[runner] LAST_STEP="${LAST_STEP}" reached — parked after step ${i}. ` +
            `Steps ${i + 1}-${STEPS.length - 1} will NOT run unless you resume.`,
        );
        const next = await awaitContinue(cfg, "paused", i);
        if (next === null) return "FAILED";
        return await runFrom(next);
      }
    }
    return "SUCCEEDED";
  }

  let start = cfg.start_index;
  let outcome: "SUCCEEDED" | "FAILED" = "SUCCEEDED";
  for (;;) {
    outcome = await runFrom(start);
    await postEvent(cfg.slot_url, cfg.token, {
      type: "run.finished",
      run_id: cfg.run_id,
      outcome,
    });
    if (outcome === "SUCCEEDED") break;

    const next = await awaitContinue(cfg);
    if (next === null) break;
    start = next;
    await reportRunning(jobId, cfg.run_id);
    console.log(`[runner] continuing in the SAME TAB from step ${start}`);
  }

  clearInterval(heartbeat);
  closeControlServer();
  await browser.close().catch(() => {});
  return outcome === "SUCCEEDED" ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("[runner] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
