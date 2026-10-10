import type { Locator, Page } from "./pw.js";

export const SEL = {
  email: ["#ap_email_login", "#ap_email"],

  password: ["#ap_password", 'input[type="password"]:not([class*="hide"])'],

  otp: [
    "#auth-mfa-otpcode",
    'input[name="otpCode"]',
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[type="tel"]',
  ],
  /** Each sign-in screen's own button, old /ap and new /ax/claim pages alike. */
  submit: ["#signInSubmit", "#continue", "#auth-signin-button", "#cvf-submit-otp-button"],

  cvfCode: ["#cvf-input-code"],
  cvfSubmit: ["#cvf-submit-otp-button", 'input[type="submit"]'],

  passkeySkip: [
    '[data-action="skip"]',
    "#ap-passkey-nudge-skip",
    'a[id*="skip"]',
    'button[id*="skip"]',
  ],

  // Errors only: a bare .a-alert-content also matches the info and warning
  // boxes the OTP page shows, which used to read as "the code was rejected".
  error: ["#auth-error-message-box .a-alert-content", ".a-alert-error .a-alert-content", ".a-alert-inline-error .a-alert-content"],

  continueShopping: [
    'button:has-text("Continue shopping")',
    'input[type="submit"][value*="Continue shopping" i]',
    'a:has-text("Continue shopping")',
    ".a-button-input",
  ],
} as const;

export async function firstLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0) return loc;
  }
  return null;
}

export async function anyPresent(page: Page, selectors: readonly string[]): Promise<boolean> {
  return (await firstLocator(page, selectors)) !== null;
}
