import type { Credentials } from "./config.js";
import { pause, shortPause, sleep } from "./human.js";
import type { Locator, Page } from "./pw.js";
import { SEL, anyPresent, firstLocator } from "./selectors.js";
import { generate as totp } from "./totp.js";


const AMAZON_SIGNIN_URL =
  "https://www.amazon.in/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.in%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0";

const AMAZON_DOMAIN = "amazon.in";
const AP_PATHS = ["/ap/signin", "/ap/mfa", "/ap/cvf", "/ax/claim"];

const MAX_TRANSITIONS = 12;
const OVERALL_TIMEOUT_MS = 120_000;
const NAV_TIMEOUT_MS = 20_000;
const STEP_WAIT_MS = 25_000;
const POLL_MS = 300;

export type LoginStep =
  | "email"
  | "password"
  | "otp"
  | "cvf"
  | "passkey_nudge"
  | "continue_shopping"
  | "logged_in"
  | "unknown";

const SIDE_EFFECT_STEPS: readonly LoginStep[] = ["passkey_nudge", "continue_shopping"];
const MAX_REPEATS = (step: LoginStep): number =>
  SIDE_EFFECT_STEPS.includes(step) ? 3 : 1;

export type LoginResult = { ok: true } | { ok: false; reason: string };

function isLoggedIn(rawUrl: string): boolean {
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

export async function detectStep(page: Page): Promise<LoginStep> {
  const url = page.url();

  if (url.includes("/webauthn/nudge") || url.includes("passkeyNudgeArb")) return "passkey_nudge";

  if (url.includes("/ap/cvf") || (await anyPresent(page, SEL.cvfCode))) return "cvf";

  if (await hasContinueShopping(page)) return "continue_shopping";

  const title = await page.title().catch(() => "");
  if (url.includes("/ap/mfa") || title.includes("Two-Step") || (await anyPresent(page, ["#auth-mfa-otpcode"]))) {
    return "otp";
  }

  if (await anyPresent(page, ["#ap_password"])) return "password";
  if (await anyPresent(page, SEL.email)) return "email";

  if (isLoggedIn(url)) return "logged_in";
  return "unknown";
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

async function readError(page: Page): Promise<string | null> {
  const loc = await firstLocator(page, SEL.error);
  if (!loc) return null;
  if (!(await loc.isVisible().catch(() => false))) return null;
  const text = (await loc.textContent().catch(() => ""))?.trim() ?? "";
  return text.length > 0 ? text : null;
}

async function submitEnclosingForm(input: Locator): Promise<void> {
  await input.evaluate((el) => {
    const form = (el as HTMLElement).closest("form") ?? document.querySelector("form");
    if (!form) throw new Error("Sign-in form not found");
    (form as HTMLFormElement).submit();
  });
}

async function handleEmail(page: Page, email: string): Promise<void> {
  await pause("email step");
  const input = await firstLocator(page, SEL.email);
  if (!input) throw new Error("email field not found");
  await input.fill(email);
  await shortPause();
  await submitEnclosingForm(input);
}

async function handlePassword(page: Page, password: string): Promise<void> {
  await pause("password step");
  const input = await firstLocator(page, SEL.password);
  if (!input) throw new Error("password field not found");
  await input.fill(password);
  await shortPause();
  await submitEnclosingForm(input);
}

async function handleOtp(page: Page, secret: string): Promise<void> {
  if (!secret) throw new Error("TOTP secret not configured (AMAZON_TOTP_SECRET)");
  await pause("otp step");
  const input = await firstLocator(page, SEL.otp);
  if (!input) throw new Error("OTP field not found");
  await input.fill(totp(secret));
  await shortPause();
  const btn = await firstLocator(page, SEL.otpSubmit);
  if (!btn) throw new Error("OTP submit button not found");
  await btn.dispatchEvent("click");
}

async function handleCvf(page: Page, secret: string): Promise<void> {
  if (!secret) throw new Error("TOTP secret not configured for CVF step");
  await pause("cvf step");
  const input = await firstLocator(page, SEL.cvfCode);
  if (!input) throw new Error("CVF code field not found");
  await input.fill(totp(secret));
  await shortPause();
  await submitEnclosingForm(input);
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

async function waitForActionableStep(page: Page, previous: LoginStep | null): Promise<LoginStep> {
  const deadline = Date.now() + STEP_WAIT_MS;
  let last: LoginStep = "unknown";
  while (Date.now() < deadline) {
    const step = await detectStep(page);
    last = step;
    if (step === "logged_in") return step;
    if (step !== previous && step !== "unknown") return step;
    if (step === previous && step === "email") {
    } else if (step === previous && (await readError(page))) {
      return step;
    }
    await sleep(POLL_MS);
  }
  return last;
}

export async function runLogin(page: Page, creds: Credentials): Promise<LoginResult> {
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  await page.goto(AMAZON_SIGNIN_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await pause("signin page loaded");

  const startedAt = Date.now();
  const handled: Partial<Record<LoginStep, number>> = {};
  let previous: LoginStep | null = null;

  for (let i = 0; i < MAX_TRANSITIONS; i++) {
    if (Date.now() - startedAt > OVERALL_TIMEOUT_MS) {
      return { ok: false, reason: `login timed out after ${OVERALL_TIMEOUT_MS}ms on ${page.url()}` };
    }

    const step = await waitForActionableStep(page, previous);
    console.log(`[bot] step: ${step}  (${page.url()})`);

    if (step === "logged_in") {
      await pause("login complete");
      return { ok: true };
    }
    if (step === "unknown") {
      const err = await readError(page);
      return { ok: false, reason: err ?? `unrecognised page: ${page.url()}` };
    }

    handled[step] = (handled[step] ?? 0) + 1;
    if (handled[step]! > MAX_REPEATS(step)) {
      const err = await readError(page);
      return { ok: false, reason: err ?? `stuck on step "${step}" at ${page.url()}` };
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
          await handleOtp(page, creds.totpSecret);
          break;
        case "cvf":
          await handleCvf(page, creds.totpSecret);
          break;
        case "passkey_nudge":
          await handlePasskeyNudge(page);
          break;
        case "continue_shopping":
          await handleContinueShopping(page);
          break;
      }
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }

    previous = step;
  }

  return { ok: false, reason: `login did not complete within ${MAX_TRANSITIONS} steps (last: ${page.url()})` };
}
