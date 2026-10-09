export type FailureCategory = "ACCOUNT" | "ADDRESS" | "PRODUCT" | "PAYMENT" | "SITE" | "UNKNOWN";

export interface FailureRule {
  code: string;
  category: FailureCategory;
  match: RegExp;
  fix: string;
  adminFixable: boolean;
}

/**
 * Failures that end the run for good (user, 2026-10-09): the browser is
 * closed, the run and its row are CANCELLED and the Accounts notes say why.
 * The master keeps the same list (ingest.ts FINAL_FAILURES). Only login sets
 * them: a proxy error after the first sign-in page stays proxy_unreachable.
 */
export const FINAL_FAILURES: ReadonlySet<string> = new Set([
  "account_blocked", "business_account", "password_incorrect", "proxy_bad", "sign_in_refused",
]);

export const FAILURE_RULES: FailureRule[] = [
  {
    code: "proxy_bad",
    category: "ACCOUNT",
    match: /^proxy .*before the sign-in page/i,
    fix: "The run never reached Amazon's sign-in page through the account's proxy. Fix or replace it in the Accounts tab's Proxy column.",
    adminFixable: true,
  },
  {
    code: "proxy_unreachable",
    category: "ACCOUNT",
    match: /^proxy .*(unreachable|not https?:\/\/host:port)|ERR_PROXY|ERR_TUNNEL_CONNECTION_FAILED|ERR_INVALID_AUTH_CREDENTIALS/i,
    fix: "The account's proxy did not answer. Fix or replace it in the Accounts tab's Proxy column; a changed proxy starts a new attempt in a new browser.",
    adminFixable: true,
  },
  {
    code: "sign_in_refused",
    category: "ACCOUNT",
    match: /^signed out on .* before the password step/i,
    fix: "Amazon sent the sign-in back to a signed-out page (its 503 link) before the password was asked for.",
    adminFixable: true,
  },
  {
    code: "account_blocked",
    category: "ACCOUNT",
    match: /^account blocked/i,
    fix: "Amazon signed the account out right after sign-in (nav reads \"Hello, sign in\"): the account is blocked.",
    adminFixable: true,
  },
  {
    code: "business_account",
    category: "ACCOUNT",
    match: /^business account/i,
    fix: "The account signed in to Amazon Business (\"Account for Your Business\"). Use a personal account.",
    adminFixable: true,
  },
  {
    code: "account_not_found",
    category: "ACCOUNT",
    match: /cannot find an account|no account found|not registered/i,
    fix: "The email is not a registered Amazon account. Correct `account_email` (Sheet1 col C).",
    adminFixable: true,
  },
  {
    code: "password_incorrect",
    category: "ACCOUNT",
    match: /your password is incorrect|password is incorrect|wrong password/i,
    fix: "Wrong password. Correct `account_password` (Sheet1 col D).",
    adminFixable: true,
  },
  {
    code: "password_reset_required",
    category: "ACCOUNT",
    match: /password (reset|change) (is )?required|reset your password|update your password/i,
    fix: "Amazon is forcing a password reset. Reset it manually, then update `account_password` (Sheet1 col D).",
    adminFixable: true,
  },
  {
    code: "account_locked",
    category: "ACCOUNT",
    match: /account (has been )?locked|temporarily locked|too many (failed )?attempts/i,
    fix: "Account is temporarily locked. Wait for the lockout to expire and resume, or swap to another account.",
    adminFixable: true,
  },
  {
    code: "otp_invalid",
    category: "ACCOUNT",
    match: /otp|two[- ]step|2fa|verification code|auth.*code.*invalid|mfa/i,
    fix: "The 2FA code was rejected. Check `account_totp_secret` (Sheet1 col E) is the CURRENT base32 secret for this account.",
    adminFixable: true,
  },
  {
    code: "return_policy_prompt",
    category: "ACCOUNT",
    match: /return policy|acknowledge.*terms|accept.*conditions/i,
    fix: "Amazon is showing a return-policy acknowledgement. Log in manually once, accept it, then resume.",
    adminFixable: true,
  },
  {
    code: "captcha_required",
    category: "ACCOUNT",
    match: /captcha|robot check|puzzle|verify you'?re human/i,
    fix: "Amazon served a bot check. Solve it in the open browser, then resume. Frequent hits mean this account is flagged.",
    adminFixable: true,
  },
  {
    code: "login_failed",
    category: "ACCOUNT",
    match: /login (failed|did not complete)|there was a problem|sign[- ]?in/i,
    fix: "Login did not complete. Verify `account_email`/`account_password`/`account_totp_secret` (Sheet1 C–E); check the screenshot for Amazon's message.",
    adminFixable: true,
  },

  {
    code: "address_unverifiable",
    category: "ADDRESS",
    match: /unable to verify the street address|review before saving/i,
    fix: "Amazon can't verify the address. Make `address_line1`/`address_line2` (Sheet1 I/J) a real, deliverable address — line2 is effectively required.",
    adminFixable: true,
  },
  {
    code: "address_invalid_field",
    category: "ADDRESS",
    match: /enter a valid city|valid pin ?code|please enter a name|mandatory|required field/i,
    fix: "A required address field was rejected. Check `address_name`, `address_pincode`, `address_city` (Sheet1 F/H/L).",
    adminFixable: true,
  },
  {
    code: "address_not_settable",
    category: "ADDRESS",
    match: /could not set .*address|address .*not saved|no \"?use this address\"?/i,
    fix: "The delivery address could not be selected. Confirm the Sheet1 address_* cells match a saved address on the account.",
    adminFixable: true,
  },

  {
    code: "price_mismatch",
    category: "PRODUCT",
    match: /price mismatch|expected price/i,
    fix: "The live price differs from the expected one. Update `price` in the Items row, or drop the item, then resume.",
    adminFixable: true,
  },
  {
    code: "out_of_stock",
    category: "PRODUCT",
    match: /out of stock|currently unavailable/i,
    fix: "The item is out of stock. Wait and resume, or point `product_url` (Items col B) at another item.",
    adminFixable: true,
  },
  {
    code: "quantity_unavailable",
    category: "PRODUCT",
    match: /quantity \d+ not offered|quantity .*not available|max \d+/i,
    fix: "The listing cannot supply that many. Lower `quantity` in the Items row to the stated maximum, then resume.",
    adminFixable: true,
  },
  {
    code: "product_not_found",
    category: "PRODUCT",
    match: /not a product page|no buy control|product .*not found/i,
    fix: "That URL is not a usable product page. Fix `product_url` (Items col B).",
    adminFixable: true,
  },
  {
    code: "purchase_option_unavailable",
    category: "PRODUCT",
    match: /purchase option .*not offered|could not select purchase option/i,
    fix: "The requested purchase option isn't offered. Set `purchase_option` (Items col D) to `auto`, then resume.",
    adminFixable: true,
  },
  {
    code: "coupon_failed",
    category: "PRODUCT",
    match: /coupon .*(did not|not stay|failed)/i,
    fix: "The coupon would not apply. Set `apply_coupon` FALSE in the Items row to proceed without it.",
    adminFixable: true,
  },
  {
    code: "cart_not_cleared",
    category: "PRODUCT",
    match: /cart still (has|not empty)/i,
    fix: "The cart could not be emptied. Clear it manually in the open browser, then resume.",
    adminFixable: true,
  },
  {
    code: "add_to_cart_failed",
    category: "PRODUCT",
    match: /was not added|add to cart button not found/i,
    fix: "The item could not be added to the cart. Check the item is still buyable; if the page looks fine this is site drift — see the screenshot.",
    adminFixable: true,
  },

  {
    code: "voucher_invalid",
    category: "PAYMENT",
    match: /promotional code .*not valid|not a valid|isn'?t valid|invalid code|invalid gift card/i,
    fix: "Amazon rejected the voucher. Fix its code in the Vouchers tab, then rerun add_vouchers.",
    adminFixable: true,
  },
  {
    code: "voucher_expired",
    category: "PAYMENT",
    match: /expired|already (been )?(redeemed|used)/i,
    fix: "The voucher is expired. Add a fresh one to the account's batch in the Vouchers tab, then rerun add_vouchers.",
    adminFixable: true,
  },
  {
    code: "balance_insufficient",
    category: "PAYMENT",
    match: /balance .*(cannot cover|did not become usable|insufficient)|still cannot cover/i,
    fix: "The balance does not cover the order total. Add an Apay voucher to the account's batch in the Vouchers tab — the failure line shows the shortfall — then rerun add_vouchers.",
    adminFixable: true,
  },
  {
    code: "payment_method_missing",
    category: "PAYMENT",
    match: /no payment_method set|payment_method .*(not supported|needs at least)/i,
    fix: "Set `payment_method` (Sheet1 col N) to `voucher` or `amazon_pay` and give at least one code in col O.",
    adminFixable: true,
  },
  {
    code: "payment_not_offered",
    category: "PAYMENT",
    match: /payment method .*not offered|use this payment method .*not found/i,
    fix: "Amazon would not accept the chosen method for this order (COD is often blocked). Try the other `payment_method` (Sheet1 col N).",
    adminFixable: true,
  },
  {
    code: "order_not_confirmed",
    category: "PAYMENT",
    match: /no order confirmation|place your order button not found/i,
    fix: "Checkout did not confirm. Open the browser and check Your Orders BEFORE retrying — the attempt is recorded in orders-placed.json.",
    adminFixable: true,
  },

  {
    code: "step_timeout",
    category: "SITE",
    match: /timeout|timed out|exceeded \d+ms/i,
    fix: "The step ran out of time. Resume to retry; if it repeats, Amazon may be slow or the page changed.",
    adminFixable: true,
  },
  {
    code: "payment_not_applied_in_session",
    category: "SITE",
    match: /never finished applying the payment method|setting your payment method/i,
    fix: "The payment method was not applied in THIS browser session. Resume from the select_payment step, not from note_order_id — a resumed runner starts with a fresh page.",
    adminFixable: true,
  },
  {
    code: "checkout_stalled",
    category: "SITE",
    match: /did not settle|still on the cart page|checkout did not|not at checkout/i,
    fix: "Checkout stalled or was left. Run from Proceed to buy.",
    adminFixable: true,
  },
  {
    code: "selector_missing",
    category: "SITE",
    // Playwright's own locator errors count too: a strict-mode violation means
    // the page now has two elements where the step expected one.
    match: /not found|no .*control|selector|strict mode violation|resolved to \d+ elements/i,
    fix: "An expected control was missing — usually Amazon changing its markup. Needs a developer; the screenshot shows the page.",
    adminFixable: false,
  },
];

export const UNKNOWN_FAILURE: FailureRule = {
  code: "unknown_error",
  category: "UNKNOWN",
  match: /.^/,
  fix: "Unclassified failure. See the step screenshot.",
  adminFixable: false,
};

export function classify(reason: string): FailureRule {
  return FAILURE_RULES.find((r) => r.match.test(reason)) ?? UNKNOWN_FAILURE;
}

export function describeForOperator(step: string, reason: string): string {
  const rule = classify(reason);
  const who = rule.adminFixable ? "" : " [needs a developer]";
  return `[${rule.category}/${rule.code}] step "${step}": ${reason.replace(/\s+/g, " ").slice(0, 300)} — FIX: ${rule.fix}${who}`;
}
