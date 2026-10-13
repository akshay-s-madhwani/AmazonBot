import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANCEL_DONE_OUTCOMES,
  CancelJobSchema,
  type CancelJob,
  type CancelOrderResult,
  type CancelProgress,
  type CancelResult,
  type CancelStepKey,
} from "@app/contracts";
import { cancelOrder } from "./cancel-order.js";
import { loadDotEnv, loadHeadless } from "./config.js";
import { pause } from "./human.js";
import { JobClient } from "./job-client.js";
import { runLogin } from "./login.js";
import { parseAccountProxy, type Proxy } from "./proxy.js";
import { chromium, type Page } from "./pw.js";
import { launchForRun, touchProfile, type LaunchedBrowser } from "./shardx.js";
import { runLoginStep } from "./steps.js";

/**
 * ONE CANCEL RUN, start to finish, in one process: its own ShardX browser
 * (through the row's proxy), login, cancel every order id, report, close.
 * The cancel flow's counterpart of slot.js + runner.js — kept apart from them
 * on purpose: the order flow's resume/park/Pay Now machinery has no business
 * here, and nothing here can reach it. It shares only the login step.
 *
 * Spawned detached by the manager, which counts it as a slot. Nothing to
 * resume: a failed cancel closes its browser and the operator runs the row
 * again (cancelling is safe to repeat).
 *
 * In:  CANCEL_RUN_ID, artifacts/<run>/cancel-job.json (0600, deleted once
 *      read), SLOT_INDEX, SLOT_HEADLESS, MANAGER_URL, CANCEL_TOKEN.
 * Out: progress + result to the master (/node/cancels/…), steps to the
 *      manager, screenshots + logs in artifacts/<run>/.
 * Stop: the manager writes artifacts/<run>/stop; the browser is closed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(HERE, "..", "artifacts");
const RUN_ID = (process.env.CANCEL_RUN_ID ?? "").trim();
const SLOT_INDEX = Number(process.env.SLOT_INDEX ?? 0);
const MANAGER_URL = (process.env.MANAGER_URL ?? "").trim();
const TOKEN = (process.env.CANCEL_TOKEN ?? "").trim();
const DIR = join(ARTIFACTS, RUN_ID || "cancel-standalone");
/** The whole run, login included. */
const TIMEOUT_MS = Number(process.env.CANCEL_TIMEOUT_MS ?? 20 * 60_000);
/** The master fails a run it has not heard from in 5 min; say something every minute. */
const BEAT_MS = 60_000;

const log = (m: string): void => console.log(`[cancel${SLOT_INDEX}] ${m}`);

let session: LaunchedBrowser["session"] | undefined;
let client: JobClient | null = null;
let step: CancelStepKey = "login";
let finished = false;

async function tellManager(status: string): Promise<void> {
  if (!MANAGER_URL) return;
  await fetch(`${MANAGER_URL}/cancels/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, runId: RUN_ID, stepKey: step, status }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}

/** false = the master says this run is over (stopped from the panel). */
async function report(p: CancelProgress): Promise<boolean> {
  void tellManager(p.status);
  if (!client) return true;
  return client.cancelProgress(RUN_ID, p);
}

async function capture(page: Page, label: string): Promise<void> {
  try {
    await page.screenshot({ path: join(DIR, `${label}.jpg`), type: "jpeg", quality: 60 });
  } catch {
    // A screenshot is a nice-to-have.
  }
}

async function closeBrowser(): Promise<void> {
  try {
    await session?.stop();
  } catch (err) {
    log(`browser did not close cleanly: ${(err as Error).message}`);
  }
  session = undefined;
}

/** Ends the run: report (unless stopped), close the browser, leave. */
async function end(result: CancelResult | null, code: number): Promise<never> {
  if (!finished) {
    finished = true;
    if (result) {
      log(`${result.outcome}${result.failure_code ? ` (${result.failure_code})` : ""}${result.detail ? `: ${result.detail}` : ""}`);
      for (const o of result.orders) log(`  ${o.order_id}: ${o.outcome}${o.detail ? ` — ${o.detail}` : ""}`);
      if (client) await client.cancelResult(RUN_ID, result);
    }
    await tellManager("finished");
  }
  await closeBrowser();
  rmSync(join(DIR, "cancel.json"), { force: true });
  process.exit(code);
}

function readJob(): CancelJob {
  const file = join(DIR, "cancel-job.json");
  const parsed = CancelJobSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  // The secrets have no reason to stay on disk once read.
  rmSync(file, { force: true });
  if (!parsed.success) throw new Error(`bad cancel job: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

function watchForStop(): void {
  const t = setInterval(() => {
    if (!existsSync(join(DIR, "stop"))) return;
    clearInterval(t);
    log("stopped — closing the browser");
    // Said to the master too: a Reset on the machine stops runs the master
    // still thinks are running. (A Stop from the panel already ended it there.)
    void end({ outcome: "FAILED", failure_code: "stopped", detail: "stopped on the machine", orders: [] }, 1);
  }, 1_000);
  t.unref();
}

async function main(): Promise<void> {
  loadDotEnv();
  if (!RUN_ID) throw new Error("CANCEL_RUN_ID is not set");
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    join(DIR, "cancel.json"),
    JSON.stringify({ runId: RUN_ID, slotIndex: SLOT_INDEX, pid: process.pid, token: TOKEN, startedAt: Date.now() }),
  );
  client = JobClient.fromEnv((m) => log(m));
  if (!client) log("no master to report to — results go to this log only");
  watchForStop();
  setTimeout(() => {
    void end(
      { outcome: "FAILED", failure_code: "cancel_timeout", detail: `not finished in ${Math.round(TIMEOUT_MS / 60_000)} min (step ${step})`, orders: [] },
      1,
    );
  }, TIMEOUT_MS).unref();

  const job = readJob();
  log(`row ${job.row_number} (${job.sno || "no S.no"}): ${job.credentials.email} — ${job.order_ids.join(", ")}`);

  let proxy: Proxy | null;
  try {
    proxy = parseAccountProxy(job.proxy);
  } catch (err) {
    return end({ outcome: "FAILED", failure_code: "proxy_bad", detail: (err as Error).message, orders: [] }, 1);
  }
  log(proxy ? `proxy ${proxy.label}` : "no proxy — the machine's own connection");

  const beat = setInterval(() => {
    void report({ step_key: step, status: "running" }).then((alive) => {
      if (!alive && !finished) {
        log("the master says this run is over — closing the browser");
        finished = true;
        void end(null, 1);
      }
    });
  }, BEAT_MS);
  beat.unref();

  if (!(await report({ step_key: "login", status: "running" }))) return end(null, 1);

  const slotHeadless = (process.env.SLOT_HEADLESS ?? "").trim();
  const headless = slotHeadless ? /^(1|true|yes|on)$/i.test(slotHeadless) : loadHeadless();
  let page: Page;
  try {
    // The proxy is set at launch, so not one request leaves without it.
    const launched = await launchForRun({ runId: RUN_ID, headless, ...(proxy ? { proxy: proxy.url } : {}) });
    session = launched.session;
    touchProfile(launched.profileId);
    log(`browser up (${launched.summary})`);
    writeFileSync(
      join(DIR, "cancel.json"),
      JSON.stringify({ runId: RUN_ID, slotIndex: SLOT_INDEX, pid: process.pid, token: TOKEN, startedAt: Date.now(), browserPid: launched.pid }),
    );
    const browser = await chromium.connectOverCDP(launched.cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    page = context.pages()[0] ?? (await context.newPage());
  } catch (err) {
    return end({ outcome: "FAILED", failure_code: "browser_crashed", detail: `browser did not start: ${(err as Error).message}`, orders: [] }, 1);
  }

  // ---- login --------------------------------------------------------------
  const login = await runLoginStep(page, job.credentials, proxy);
  await capture(page, `0-login-${login.status}`);
  if (login.status === "failed") {
    await report({ step_key: "login", status: "failed", detail: login.detail });
    return end({ outcome: "FAILED", failure_code: login.failure_code, detail: login.detail, orders: [] }, 1);
  }
  if (finished) return;
  log("signed in");
  await report({ step_key: "login", status: "succeeded" });

  // ---- cancel_order ---------------------------------------------------------
  step = "cancel_order";
  if (!(await report({ step_key: "cancel_order", status: "running" }))) return end(null, 1);
  const reauth = async (p: Page): Promise<boolean> => (await runLogin(p, job.credentials)).ok;
  const orders: CancelOrderResult[] = [];
  for (const [i, id] of job.order_ids.entries()) {
    if (finished) return;
    if (i > 0) await pause("next order");
    const r = await cancelOrder(page, id, reauth);
    orders.push(r);
    log(`${id}: ${r.outcome}${r.detail ? ` — ${r.detail}` : ""}`);
    await capture(page, `1-cancel-${id}-${r.outcome}`);
  }
  if (finished) return;

  const bad = orders.find((o) => !CANCEL_DONE_OUTCOMES.includes(o.outcome));
  if (bad) {
    const code = bad.outcome === "not_found" ? "cancel_not_found" : bad.outcome === "not_cancellable" ? "cancel_not_cancellable" : "cancel_failed";
    await report({ step_key: "cancel_order", status: "failed", detail: `${bad.order_id}: ${bad.detail}`.slice(0, 1000) });
    return end({ outcome: "FAILED", failure_code: code, detail: `${bad.order_id}: ${bad.detail}`.slice(0, 1000), orders }, 1);
  }
  await report({ step_key: "cancel_order", status: "succeeded" });
  return end({ outcome: "SUCCEEDED", orders }, 0);
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") console.error(`[cancel] stdio error: ${err.message}`);
  });
}
process.once("SIGINT", () => void end(null, 1));
process.once("SIGTERM", () => void end(null, 1));

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[cancel] fatal: ${detail}`);
  void end({ outcome: "FAILED", failure_code: "unknown_error", detail: detail.slice(0, 1000), orders: [] }, 1);
});
