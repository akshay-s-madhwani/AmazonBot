import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaymentCode } from "./config.js";
import { dismissCheckoutModal, ensureAtCheckout, waitForCheckoutPipeline, waitForFirstVisible } from "./checkout.js";
import { pause, shortPause } from "./human.js";
import type { Page } from "./pw.js";

/**
 * ADD VOUCHERS — after Proceed to Buy, before the delivery address. The
 * account's vouchers are the Vouchers-tab rows sharing its batch_id. Every
 * code, whatever its type, is added on Amazon's claim-code page ("Add to
 * Amazon Pay Balance") — never in checkout's promo-code field — one at a
 * time, each submitted once on a freshly opened form (never a reload: that
 * re-sends the code). The checkout is reloaded afterwards so it shows the
 * new balance.
 *
 * Every code added (or that Amazon says is already added) is marked Used on
 * its Vouchers row, and remembered in this run's artifacts so a retry of the
 * step never submits it again. Rows already Used are left alone. A code
 * Amazon rejects does not stop the others; the step fails at the end naming
 * every one that did not go through.
 */
export const CLAIM_CODE_URL = "https://www.amazon.in/apay-products/gc/claimCode";

const NAV_TIMEOUT_MS = 45_000;
const VERDICT_TIMEOUT_MS = 20_000;

/**
 * The claim form, as seen live on 2026-10-07: Amazon "tux" web components,
 * whose real <input>/<button> sit in open shadow roots (Playwright's CSS
 * pierces them). The tux-input carries error="true" + errormessage on a
 * rejected code.
 */
const CLAIM_BOX = "#claim-Code-input-box";
const CLAIM_INPUT = [`${CLAIM_BOX} input`, 'tux-input[name="claimCode"] input', 'input[name="claimCode"]'];
const CLAIM_BUTTON = "tux-button.add-gift-card-button";

export type VoucherOutcome =
  | { status: "done"; detail: string }
  | { status: "skipped"; detail: string }
  | { status: "failed"; reason: string };

const ALREADY_USED = /already (been )?(redeemed|claimed|used|applied|added)/i;
/** Seen live: "₹1.0 Your Shopping Voucher has been added successfully." */
const CLAIM_SUCCESS =
  /(has been|was|been) (added|applied|credited)( to your| successfully)|added to your (amazon pay )?balance|successfully (added|redeemed|claimed)/i;

/** Short label for logs and notes; never the whole code. */
function label(v: PaymentCode): string {
  const row = v.row ? `Vouchers row ${v.row}` : "voucher";
  return `${row} (${v.code.slice(0, 4)}…${v.amount !== undefined ? ` ₹${v.amount}` : ""})`;
}

function usedPath(artifactsDir: string): string {
  return join(artifactsDir, "vouchers-used.json");
}

/** Codes this run already used, so a retried step does not submit them again. */
function readUsed(artifactsDir: string): Set<string> {
  const path = usedPath(artifactsDir);
  if (!existsSync(path)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(path, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

/** Which of an account's vouchers add_vouchers still has to add. */
export function planVouchers(
  codes: PaymentCode[],
  usedThisRun: Set<string>,
): { todo: PaymentCode[]; alreadyUsed: number } {
  const open = codes.filter((v) => v.code.trim());
  const todo = open.filter((v) => (v.status ?? "").toUpperCase() !== "USED" && !usedThisRun.has(v.code.trim()));
  return { todo, alreadyUsed: open.length - todo.length };
}

export async function runAddVouchers(
  page: Page,
  codes: PaymentCode[],
  artifactsDir: string,
  markUsed?: (v: PaymentCode) => Promise<void>,
): Promise<VoucherOutcome> {
  if (codes.filter((v) => v.code.trim()).length === 0) {
    return { status: "skipped", detail: "no vouchers for this account's batch" };
  }
  const used = readUsed(artifactsDir);
  const plan = planVouchers(codes, used);
  if (plan.todo.length === 0) {
    return { status: "skipped", detail: `all ${plan.alreadyUsed} voucher(s) already Used` };
  }
  console.log(
    `[bot] vouchers: ${plan.todo.length} to add` + (plan.alreadyUsed ? `, ${plan.alreadyUsed} already Used` : ""),
  );

  const at = await ensureAtCheckout(page);
  if (!at.ok) return { status: "failed", reason: at.reason };

  const record = async (v: PaymentCode): Promise<void> => {
    used.add(v.code.trim());
    writeFileSync(usedPath(artifactsDir), JSON.stringify([...used]), { mode: 0o600 });
    await markUsed?.(v);
  };
  const { applied, failed } = await claimVouchers(page, plan.todo, record);

  // The checkout was opened before the balance changed.
  if (applied.length > 0) {
    // A GET of the same URL, not reload(): a reload re-sends a page that came from a form POST.
    await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => { });
    await waitForCheckoutPipeline(page);
    await dismissCheckoutModal(page);
    await pause("checkout reloaded with the new balance");
  }

  if (failed.length > 0) {
    return {
      status: "failed",
      reason:
        `${failed.length} voucher(s) did not go through — ${failed.join("; ")}` +
        ` (added: ${applied.join(", ") || "none"})`,
    };
  }
  return { status: "done", detail: `vouchers added: ${applied.join(", ")}` };
}

/**
 * Each code, once, on the claim-code page in a side tab. `record` runs for
 * every code that went in (or Amazon says was already in).
 */
export async function claimVouchers(
  page: Page,
  todo: PaymentCode[],
  record: (v: PaymentCode) => Promise<void>,
): Promise<{ applied: string[]; failed: string[] }> {
  const applied: string[] = [];
  const failed: string[] = [];
  // A side tab, so the checkout stays where it is. In front: a new tab can
  // open behind the checkout, where clicks never land ("element is outside of
  // the viewport" until the step times out — seen 2026-10-08).
  const tab = await page.context().newPage();
  await tab.bringToFront().catch(() => { });
  try {
    for (const v of todo) {
      const r = await claimToBalance(tab, v.code);
      if (r.ok) {
        applied.push(label(v));
        console.log(`[bot] ✓ ${label(v)}: ${r.detail}`);
        await record(v);
      } else if (r.alreadyUsed) {
        console.warn(`[bot] ${label(v)} was already added — marking it Used: ${r.reason}`);
        await record(v);
      } else {
        console.warn(`[bot] ✗ ${label(v)}: ${r.reason}`);
        failed.push(`${label(v)}: ${r.reason}`);
        if (r.fatal) break;
      }
    }
  } finally {
    await tab.close().catch(() => { });
    await page.bringToFront().catch(() => { });
  }
  return { applied, failed };
}

type CodeResult =
  | { ok: true; detail: string }
  /** fatal: the page cannot take any code now (captcha, sign-in) — stop trying the rest. */
  | { ok: false; reason: string; alreadyUsed?: boolean; fatal?: boolean };

interface ClaimState {
  /** The tux-input's error message when it is showing one. */
  error: string | null;
  captcha: boolean;
  /** Visible tux-alert texts, e.g. a success or error banner. */
  alerts: string[];
  /** The balance amounts under "Transaction history": a change means a code went in. */
  balances: string;
  text: string;
}

async function readClaimState(tab: Page): Promise<ClaimState> {
  return tab
    .evaluate((boxSel) => {
      const vis = (e: Element) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const squash = (s: string) => s.replace(/\s+/g, " ").trim();
      const box = document.querySelector(boxSel);
      const area = (document.querySelector(".gc-claim-page") as HTMLElement | null) ?? document.body;
      const text = squash(area.innerText ?? "");
      const captchaFlag = (document.querySelector("#gc-claim-page-captcha-required") as HTMLInputElement | null)?.value;
      const captchaShown = [...document.querySelectorAll('img[src*="captcha" i], [id*="captcha" i] img')].some(vis);
      return {
        error: box?.getAttribute("error") === "true" ? box.getAttribute("errormessage") || "code rejected" : null,
        captcha: captchaFlag === "true" || captchaShown,
        alerts: [...area.querySelectorAll("tux-alert")]
          .filter(vis)
          .map((a) => squash(`${a.getAttribute("messagetype") ?? ""}: ${(a as HTMLElement).innerText ?? ""}`)),
        balances: ((text.split(/transaction history/i)[1] ?? "").match(/₹\s?[\d,]+(\.\d+)?/g) ?? []).join("|"),
        text: text.slice(0, 2000),
      };
    }, CLAIM_BOX)
    .catch(() => ({ error: null, captcha: false, alerts: [], balances: "", text: "" }));
}

/**
 * One code into the Amazon Pay balance, on the claim-code page, submitted
 * exactly once.
 *
 * The form is a plain POST to the claim-code URL, so after Add the tab shows
 * the POST's answer. Reloading that page sends the form again — the same code
 * a second time, which Amazon answers "already used" and which brought up a
 * captcha (operators saw it, 2026-10-08). So the page is never reloaded: each
 * code opens the form fresh with a GET.
 */
async function claimToBalance(tab: Page, code: string): Promise<CodeResult> {
  await tab.goto(CLAIM_CODE_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await pause("claim-code page loaded");
  if (/\/ap\/(signin|mfa|cvf)/.test(tab.url())) {
    return { ok: false, reason: "the claim-code page asked to sign in again", fatal: true };
  }
  const input = await waitForFirstVisible(tab, CLAIM_INPUT, 20_000);
  if (!input) return { ok: false, reason: `no claim-code field on ${tab.url().slice(0, 80)}`, fatal: true };

  const before = await readClaimState(tab);
  if (before.captcha) return { ok: false, reason: "the claim-code page wants a captcha", fatal: true };

  await input.click().catch(() => { });
  await input.fill("");
  await input.pressSequentially(code, { delay: 90 });
  await shortPause();
  const button = tab.locator(CLAIM_BUTTON).first();
  if (!(await button.isVisible().catch(() => false))) {
    return { ok: false, reason: '"Add to Amazon Pay Balance" button not found', fatal: true };
  }
  // One press only. A click that errors may still have submitted the form, so
  // it is never repeated: the page's answer below decides.
  const clickError = await button
    .click({ timeout: 15_000 })
    .then(() => null)
    .catch((err: Error) => err.message.split("\n")[0]!);
  if (clickError) console.warn(`[bot] vouchers: Add press reported "${clickError}" — reading the page, not pressing again`);
  await tab.waitForLoadState("domcontentloaded").catch(() => { });

  let result: CodeResult | null = null;
  const deadline = Date.now() + VERDICT_TIMEOUT_MS;
  while (!result) {
    await tab.waitForTimeout(1000);
    const now = await readClaimState(tab);
    // Between the form page and the POST's answer: nothing to read yet.
    if (!now.text) {
      if (Date.now() >= deadline) result = { ok: false, reason: "the claim-code page did not come back after Add" };
      continue;
    }
    const said = [now.error ?? "", ...now.alerts.filter((a) => !before.alerts.includes(a))].join(" ").trim();
    if (now.captcha) result = { ok: false, reason: "the claim-code page wants a captcha", fatal: true };
    else if (ALREADY_USED.test(said)) result = { ok: false, reason: said, alreadyUsed: true };
    else if (now.error) result = { ok: false, reason: now.error };
    else if (/^error|^warning/i.test(said)) result = { ok: false, reason: said };
    else if (now.balances !== before.balances) result = { ok: true, detail: `balance now ${now.balances}` };
    else if (CLAIM_SUCCESS.test(said) || (CLAIM_SUCCESS.test(now.text) && !CLAIM_SUCCESS.test(before.text))) {
      result = { ok: true, detail: said || "added to balance" };
    } else if (Date.now() >= deadline) {
      result = { ok: false, reason: `no confirmation from the claim-code page${said ? ` — page says: ${said}` : ""}` };
    }
  }

  // Never tab.reload() here: it re-sends the POST (see above). The next code
  // opens the form with a fresh GET.
  await pause("claim-code page answered");
  return result;
}
