import type { Credentials } from "./config.js";
import { pause, rand, shortPause, sleep } from "./human.js";
import type { Locator, Page } from "./pw.js";
import { SEL, anyPresent, firstLocator } from "./selectors.js";
import { generate as totp } from "./totp.js";


const AMAZON_SIGNIN_URL =
  "https://www.amazon.in/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.in%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0";

const AMAZON_DOMAIN = "amazon.in";
const AP_PATHS = ["/ap/signin", "/ap/mfa", "/ap/cvf", "/ax/claim"];

/**
 * WAITS. A loaded machine (10 browsers, a slow proxy) can take well over 20s
 * to move from the OTP page to the home page. The old 25s step wait then read
 * "still on the OTP page" as stuck and failed a login that went on to succeed
 * — the failure screenshot showed the account signed in. So:
 *   - every wait is long and overridable from .env;
 *   - a page is acted on only once it reads the same twice in a row;
 *   - "still on the same page" counts as a failure only with a real, visible
 *     error on a page that has finished loading;
 *   - and EVERY failure first re-checks, for up to FINAL_CHECK_MS, whether the
 *     browser is in fact signed in.
 */
const envMs = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const MAX_TRANSITIONS = 16;
const OVERALL_TIMEOUT_MS = envMs("LOGIN_TIMEOUT_MS", 200_000);
const NAV_TIMEOUT_MS = envMs("LOGIN_NAV_TIMEOUT_MS", 45_000);
const STEP_WAIT_MS = envMs("LOGIN_STEP_WAIT_MS", 45_000);
const FINAL_CHECK_MS = envMs("LOGIN_FINAL_CHECK_MS", 30_000);
const POLL_MS = 500;
/** After submitting, give the navigation a moment to start before reading the page again. */
const AFTER_SUBMIT_MS = 1_500;
/** A TOTP code is only typed with at least this long left in its 30s window. */
const OTP_MIN_REMAINING_S = 8;

export type LoginStep =
  | "email"
  | "password"
  | "otp"
  | "cvf"
  | "passkey_nudge"
  | "continue_shopping"
  | "logged_in"
  /** An Amazon page whose nav reads "Hello, sign in". */
  | "signed_out"
  /** Amazon's "Account locked temporarily" page (locked for misuse): blocked. */
  | "locked"
  | "unknown";

const SIDE_EFFECT_STEPS: readonly LoginStep[] = ["passkey_nudge", "continue_shopping"];
/**
 * A step may come back once when the first submit did not take (no error,
 * the page just never moved). OTP/CVF may also come back after an error: on a
 * slow machine the code can expire between typing and Amazon checking it, and
 * the retry always uses a code from a later window.
 */
const MAX_REPEATS = (step: LoginStep): number => (SIDE_EFFECT_STEPS.includes(step) ? 3 : 2);
const CODE_STEPS: readonly LoginStep[] = ["otp", "cvf"];

export type LoginResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      /** Amazon showed a sign-in screen (or any page it recognises): the proxy works. */
      reachedSignIn: boolean;
      /** Signed out right after the password went in: the account is blocked. */
      blocked?: boolean;
      /** Amazon sent the sign-in to a signed-out page (e.g. its 503 link) before the password. */
      refused?: boolean;
      /** Signed in, but to an Amazon Business account: never ordered from. */
      business?: boolean;
    };

const HOME_URL = "https://www.amazon.in/";
/** How long the signed-in nav ("Hello, <name>") gets to show. */
const GREETING_WAIT_MS = envMs("LOGIN_GREETING_WAIT_MS", 30_000);
const BLOCKED_REASON = 'account blocked: Amazon shows "Hello, sign in" after sign-in';
const LOCKED_REASON = 'account blocked: Amazon shows "Account locked temporarily" (locked for misuse)';

const BUSINESS_REASON = 'business account: Amazon shows "Account for Your Business" after sign-in';

/**
 * An Amazon Business account (user, 2026-10-09): the nav's account link reads
 * "Account for Your Business" (not "Account & Lists") and the logo is
 * "amazon business". The run is cancelled, never ordered from.
 */
async function isBusinessAccount(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const read = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        return el ? `${el.innerText ?? ""} ${el.getAttribute("aria-label") ?? ""}` : "";
      };
      return /for your business/i.test(read("#nav-link-accountList")) || /amazon business/i.test(read("#nav-logo"));
    })
    .catch(() => false);
}

/**
 * Amazon's lock page (2026-10-09): title and alert heading "Account locked
 * temporarily", "Your account has been locked for misuse of Amazon's
 * services." No nav, so it is read by its text, whatever its URL.
 */
async function onLockedPage(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const text = (sel: string) =>
        [...document.querySelectorAll(sel)].map((n) => (n as HTMLElement).innerText ?? "").join(" ");
      return (
        /account locked/i.test(document.title) ||
        /account locked/i.test(text(".a-alert-heading")) ||
        /locked for misuse/i.test(text(".a-alert-content"))
      );
    })
    .catch(() => false);
}

function isLoggedInUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (!u.hostname.endsWith(AMAZON_DOMAIN)) return false;
    if (AP_PATHS.some((p) => u.pathname.startsWith(p))) return false;
    if (u.pathname.startsWith("/404") || u.pathname.startsWith("/error")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The nav greeting: "name" for "Hello, <name>", "signed_out" for "Hello,
 * sign in", "missing" when the page has none (yet).
 */
async function readGreeting(page: Page): Promise<"name" | "signed_out" | "missing"> {
  return page
    .evaluate(() => {
      const read = (sel: string) =>
        ((document.querySelector(sel) as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim();
      const line = read("#nav-link-accountList-nav-line-1") || read("#nav-link-accountList .nav-line-1");
      if (/sign in/i.test(line) || /sign in/i.test(read("#glow-ingress-line1"))) return "signed_out" as const;
      return /^hello\b/i.test(line) ? ("name" as const) : ("missing" as const);
    })
    .catch(() => "missing" as const);
}

/**
 * Which sign-in screen is showing. Never throws: a read that fails mid-
 * navigation ("execution context was destroyed") is "unknown", i.e. still moving.
 */
export async function detectStep(page: Page): Promise<LoginStep> {
  try {
    const url = page.url();

    if (await onLockedPage(page)) return "locked";

    if (url.includes("/webauthn/nudge") || url.includes("passkeyNudgeArb")) return "passkey_nudge";

    if (url.includes("/ap/cvf") || (await anyPresent(page, SEL.cvfCode))) return "cvf";

    if (await hasContinueShopping(page)) return "continue_shopping";

    if (url.includes("/ap/mfa") || (await onOtpScreen(page))) return "otp";

    if (await anyVisible(page, SEL.password)) return "password";
    if (await anyPresent(page, SEL.email)) return "email";

    if (isLoggedInUrl(url)) return (await readGreeting(page)) === "signed_out" ? "signed_out" : "logged_in";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** A visible match for any of the selectors (a hidden password input is not a password page). */
async function anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const sel of selectors) {
    if ((await page.locator(sel).filter({ visible: true }).count().catch(() => 0)) > 0) return true;
  }
  return false;
}

/**
 * The 2-Step Verification screen. The new /ax/claim/auth one has its own
 * URL and field, so it is also known by its heading.
 */
async function onOtpScreen(page: Page): Promise<boolean> {
  const title = await page.title().catch(() => "");
  if (/two-step|2-step/i.test(title)) return true;
  if (await anyVisible(page, ["#auth-mfa-otpcode", 'input[name="otpCode"]', 'input[autocomplete="one-time-code"]'])) {
    return true;
  }
  return page
    .evaluate(() => /(2|two)-step verification/i.test((document.querySelector("h1") as HTMLElement | null)?.innerText ?? ""))
    .catch(() => false);
}

/** The OTP field: a known one, else the only text-like box on the 2-Step screen. */
async function otpField(page: Page): Promise<Locator | null> {
  for (const sel of [...SEL.otp, 'input[type="text"]', 'input[type="number"]', "input:not([type])"]) {
    const loc = page.locator(sel).filter({ visible: true }).first();
    if ((await loc.count()) > 0) return loc;
  }
  return null;
}

/** Types like a person: Amazon's sign-in pages watch the key presses. */
async function typeInto(input: Locator, text: string): Promise<void> {
  await input.click();
  await input.fill("");
  await input.pressSequentially(text, { delay: rand(60, 120) });
}

/**
 * Submits a sign-in screen the way a person does: a real click on its own
 * button, else Enter in the field. Never form.submit(): that skips the page's
 * submit handler, and the new /ax/claim pages then just show the same step
 * again with the field empty (2026-10-09).
 */
async function submitStep(page: Page, input: Locator): Promise<void> {
  const form = input.locator("xpath=ancestor::form[1]");
  const scope = (await form.count()) > 0 ? form : page.locator("body");
  for (const sel of [...SEL.submit, 'input[type="submit"]', 'button[type="submit"]']) {
    const btn = scope.locator(sel).filter({ visible: true }).first();
    if ((await btn.count()) === 0) continue;
    try {
      await btn.click({ timeout: 10_000 });
      return;
    } catch {
      break;
    }
  }
  await input.press("Enter");
}

async function hasContinueShopping(page: Page): Promise<boolean> {
  if (await anyPresent(page, ["#ap_password", ...SEL.email])) return false;
  return page
    .evaluate(() =>
      [...document.querySelectorAll("button, input[type=submit], a")].some((n) => {
        const el = n as HTMLElement;
        if (el.offsetParent === null) return false;
        const label = (el.innerText || (el as HTMLInputElement).value || "").trim();
        return /continue shopping/i.test(label);
      }),
    )
    .catch(() => false);
}

async function handleContinueShopping(page: Page): Promise<void> {
  await pause("continue-shopping wall");
  const clicked = await page
    .evaluate(() => {
      const el = [...document.querySelectorAll("button, input[type=submit], a")].find((n) => {
        const e = n as HTMLElement;
        if (e.offsetParent === null) return false;
        const label = (e.innerText || (e as HTMLInputElement).value || "").trim();
        return /continue shopping/i.test(label);
      }) as HTMLElement | undefined;
      if (!el) return false;
      el.click();
      return true;
    })
    .catch(() => false);
  if (!clicked) {
    throw new Error('the "Continue shopping" button vanished before it could be clicked');
  }
  await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("through the wall");
}

/** A visible sign-in error — never an informational alert. */
async function readError(page: Page): Promise<string | null> {
  try {
    for (const sel of SEL.error) {
      const loc = page.locator(sel).filter({ visible: true }).first();
      if ((await loc.count()) === 0) continue;
      const text = ((await loc.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  } catch {
    // The page navigated mid-read: no error to report.
  }
  return null;
}

/** The document has finished loading — a mid-navigation page does not count as "stuck". */
async function settled(page: Page): Promise<boolean> {
  return page.evaluate(() => document.readyState === "complete").catch(() => false);
}

/**
 * A TOTP code with time left to be typed, submitted and checked on a slow
 * machine, and never `avoid` (the code already tried: Amazon refuses a reuse).
 */
async function freshCode(secret: string, avoid: string | null): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const remaining = 30 - ((Date.now() / 1000) % 30);
    const code = totp(secret);
    if (remaining >= OTP_MIN_REMAINING_S && code !== avoid) return code;
    console.log(`[bot] waiting ${Math.ceil(remaining)}s for the next authenticator code`);
    await sleep(remaining * 1000 + 500);
  }
  return totp(secret);
}

async function handleEmail(page: Page, email: string): Promise<void> {
  await pause("email step");
  const input = await firstLocator(page, SEL.email);
  if (!input) throw new Error("email field not found");
  await typeInto(input, email);
  await shortPause();
  await submitStep(page, input);
}

/** Fixed, not scaled by BOT_PACE: a password typed the instant the page appears gets bounced. */
const PASSWORD_WAIT_MS = 3_000;

async function handlePassword(page: Page, password: string): Promise<void> {
  console.log(`[bot] waiting ${PASSWORD_WAIT_MS / 1000}s (password step)`);
  await sleep(PASSWORD_WAIT_MS);
  const input = page.locator(SEL.password.join(", ")).filter({ visible: true }).first();
  if ((await input.count()) === 0) throw new Error("password field not found");
  await typeInto(input, password);
  await shortPause();
  await submitStep(page, input);
}

async function handleOtp(page: Page, secret: string, lastCode: string | null): Promise<string> {
  if (!secret) throw new Error("TOTP secret not configured (AMAZON_TOTP_SECRET)");
  await pause("otp step");
  const input = await otpField(page);
  if (!input) throw new Error("OTP field not found");
  const code = await freshCode(secret, lastCode);
  await typeInto(input, code);
  await shortPause();
  await submitStep(page, input);
  return code;
}

async function handleCvf(page: Page, secret: string, lastCode: string | null): Promise<string> {
  if (!secret) throw new Error("TOTP secret not configured for CVF step");
  await pause("cvf step");
  const input = await firstLocator(page, SEL.cvfCode);
  if (!input) throw new Error("CVF code field not found");
  const code = await freshCode(secret, lastCode);
  await typeInto(input, code);
  await shortPause();
  await submitStep(page, input);
  return code;
}

async function handlePasskeyNudge(page: Page): Promise<void> {
  await pause("passkey nudge");
  const skip = await firstLocator(page, SEL.passkeySkip);
  if (skip) {
    await skip.dispatchEvent("click");
    return;
  }
  const returnTo = new URL(page.url()).searchParams.get("openid.return_to") ?? "https://www.amazon.in/";
  await page.goto(returnTo, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
}

/**
 * Polls until the page is a NEW actionable step (read twice in a row), is
 * signed in, or is the same step showing an error once fully loaded. On
 * timeout returns what it last saw.
 */
async function waitForActionableStep(
  page: Page,
  previous: LoginStep | null,
): Promise<{ step: LoginStep; error: string | null }> {
  const deadline = Date.now() + STEP_WAIT_MS;
  let last: LoginStep = "unknown";
  let candidate: LoginStep | null = null;
  while (Date.now() < deadline) {
    const step = await detectStep(page);
    last = step;
    if (step === "logged_in" || step === "locked") return { step, error: null };
    if (step !== previous && step !== "unknown") {
      if (candidate === step) return { step, error: null };
      candidate = step;
    } else {
      candidate = null;
      if (step === previous && step !== "email" && (await settled(page))) {
        const error = await readError(page);
        if (error) return { step, error };
      }
    }
    await sleep(POLL_MS);
  }
  return { step: last, error: last === previous ? await readError(page) : null };
}

/**
 * Before reporting a failure: is the browser signed in after all? A slow
 * machine can still be loading the home page when a wait gives up.
 */
async function signedInAfterAll(page: Page): Promise<boolean> {
  const deadline = Date.now() + FINAL_CHECK_MS;
  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => { });
    if ((await detectStep(page)) === "logged_in") return true;
    await sleep(1_000);
  }
  return false;
}

async function gotoSignIn(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(AMAZON_SIGNIN_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      return;
    } catch (err) {
      // A slow load that still landed on Amazon is good enough: the step poll takes over.
      if (page.url().includes(AMAZON_DOMAIN)) return;
      if (attempt >= 2) throw err;
      console.log(`[bot] sign-in page did not load (${(err as Error).message.split("\n")[0]}) — retrying`);
      await sleep(3_000);
    }
  }
}

/**
 * SIGNED IN = the nav reads "Hello, <name>" (user, 2026-10-09). A blocked
 * account lands on Amazon after the OTP but reads "Hello, sign in". Read on
 * the page login ended on, else on the home page.
 */
async function confirmGreeting(page: Page): Promise<LoginResult> {
  for (const where of ["here", "home"] as const) {
    if (where === "home") {
      console.log("[bot] no nav greeting on this page — reading it on the home page");
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => { });
    }
    const deadline = Date.now() + GREETING_WAIT_MS;
    let signedOutReads = 0;
    while (Date.now() < deadline) {
      if (await onLockedPage(page)) return { ok: false, reason: LOCKED_REASON, reachedSignIn: true, blocked: true };
      const greeting = await readGreeting(page);
      if (greeting === "name") {
        if (await isBusinessAccount(page)) {
          return { ok: false, reason: BUSINESS_REASON, reachedSignIn: true, business: true };
        }
        console.log("[bot] nav reads \"Hello, <name>\" — signed in");
        return { ok: true };
      }
      signedOutReads = greeting === "signed_out" ? signedOutReads + 1 : 0;
      if (signedOutReads >= 2) return { ok: false, reason: BLOCKED_REASON, reachedSignIn: true, blocked: true };
      await sleep(1_000);
    }
  }
  return { ok: false, reason: `login: no "Hello, <name>" in the nav at ${page.url()}`, reachedSignIn: true };
}

export async function runLogin(page: Page, creds: Credentials): Promise<LoginResult> {
  const r = await signIn(page, creds);
  return r.ok ? confirmGreeting(page) : r;
}

async function signIn(page: Page, creds: Credentials): Promise<LoginResult> {
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  try {
    await gotoSignIn(page);
  } catch (err) {
    return { ok: false, reason: (err as Error).message.split("\n")[0] ?? "sign-in page did not load", reachedSignIn: false };
  }
  await pause("signin page loaded");

  const startedAt = Date.now();
  const handled: Partial<Record<LoginStep, number>> = {};
  let previous: LoginStep | null = null;
  let lastCode: string | null = null;
  /** Any page Amazon serves that login recognises — the proxy got through. */
  let reachedSignIn = false;

  const fail = async (reason: string): Promise<LoginResult> => {
    console.log(`[bot] login looks failed (${reason}) — checking whether it signed in anyway`);
    if (await signedInAfterAll(page)) {
      console.log("[bot] signed in after all — the page was just slow");
      await pause("login complete");
      return { ok: true };
    }
    const now = await detectStep(page);
    if (now === "locked") return { ok: false, reason: LOCKED_REASON, reachedSignIn: true, blocked: true };
    // Password in, then an Amazon page that says "Hello, sign in": blocked.
    if (handled.password && now === "signed_out") {
      return { ok: false, reason: BLOCKED_REASON, reachedSignIn: true, blocked: true };
    }
    return { ok: false, reason, reachedSignIn };
  };

  for (let i = 0; i < MAX_TRANSITIONS; i++) {
    if (Date.now() - startedAt > OVERALL_TIMEOUT_MS) {
      return fail(`login timed out after ${Math.round(OVERALL_TIMEOUT_MS / 1000)}s on ${page.url()}`);
    }

    const { step, error } = await waitForActionableStep(page, previous);
    console.log(`[bot] step: ${step}  (${page.url()})${error ? ` — error: ${error}` : ""}`);
    if (step !== "unknown") reachedSignIn = true;

    if (step === "logged_in") {
      await pause("login complete");
      return { ok: true };
    }
    if (step === "locked") {
      return { ok: false, reason: LOCKED_REASON, reachedSignIn: true, blocked: true };
    }
    if (step === "signed_out") {
      if (handled.password) return fail(BLOCKED_REASON);
      const r = await fail(`signed out on ${page.url()} before the password step`);
      return r.ok ? r : { ...r, refused: true };
    }
    if (step === "unknown") {
      return fail((await readError(page)) ?? `unrecognised page: ${page.url()}`);
    }

    if (step === previous) {
      // A wrong password will not get better by typing it again; a code might.
      if (error && !CODE_STEPS.includes(step)) return fail(error);
      console.log(`[bot] still on "${step}" — ${error ? "retrying with a new code" : "the submit did not take, retrying"}`);
    }

    handled[step] = (handled[step] ?? 0) + 1;
    if (handled[step]! > MAX_REPEATS(step)) {
      return fail(error ?? (await readError(page)) ?? `stuck on step "${step}" at ${page.url()}`);
    }

    try {
      switch (step) {
        case "email":
          await handleEmail(page, creds.email);
          break;
        case "password":
          await handlePassword(page, creds.password);
          break;
        case "otp":
          lastCode = await handleOtp(page, creds.totpSecret, lastCode);
          break;
        case "cvf":
          lastCode = await handleCvf(page, creds.totpSecret, lastCode);
          break;
        case "passkey_nudge":
          await handlePasskeyNudge(page);
          break;
        case "continue_shopping":
          await handleContinueShopping(page);
          break;
      }
    } catch (err) {
      // The page often moved on by itself while the handler was reading it.
      const message = (err as Error).message.split("\n")[0] ?? "login step failed";
      await sleep(AFTER_SUBMIT_MS);
      if ((await detectStep(page)) === step) return fail(message);
      console.log(`[bot] "${step}" handler gave up (${message}) but the page has moved on — continuing`);
    }

    previous = step;
    await sleep(AFTER_SUBMIT_MS);
  }

  return fail(`login did not complete within ${MAX_TRANSITIONS} steps (last: ${page.url()})`);
}
