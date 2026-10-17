import type { CancelOrderResult, CancelOutcome } from "@app/contracts";
import { pause, rand, shortPause, sleep } from "./human.js";
import type { Locator, Page } from "./pw.js";

/**
 * CANCEL ONE ORDER (the cancel flow, cancel-run.ts). Your Orders, search the
 * order id, open it, "Cancel items", tick every item, reason "Order Created by
 * Mistake", "Request cancellation" — then the order page again to see that it
 * took. Safe to repeat: an order already cancelled is read as such and left.
 *
 * Read against amazon.in 2026-10-13:
 *   order page   /your-orders/order-details?orderID=<id>; each shipment's
 *                status in [data-component=shipmentStatus] .od-status-message;
 *                "Cancel items" links to /progress-tracker/package/preship/cancel-items
 *   unknown id   order page "We are unable to load your order details";
 *                search "No results found"; the cancel page sends you to Your Orders
 *   cancel page  #cancel-items-form: #select-toggle-link "Select all", item
 *                checkboxes, reason a-dropdown over select#cancel-reasons-dropdown
 *                (ORDER_WAS_CREATED_BY_MISTAKE), button
 *                #preship-cancel-submit-button-announce, disabled until both are set
 */

const BASE = "https://www.amazon.in";
const ORDERS_URL = `${BASE}/gp/css/order-history`;
const detailsUrl = (id: string): string => `${BASE}/your-orders/order-details?orderID=${encodeURIComponent(id)}`;
const NAV_TIMEOUT_MS = 60_000;
const REASON_VALUE = "ORDER_WAS_CREATED_BY_MISTAKE";
const REASON_TEXT = /order (created|placed) by mistake|ordered by mistake/i;

const SEL = {
  search: "#searchOrdersInput",
  status: "[data-component=shipmentStatus] .od-status-message",
  cancelLink: 'a[href*="/cancel-items"]',
  form: "#cancel-items-form",
  selectAll: "#select-toggle-link",
  itemBoxes: '#cancel-items-form input[type="checkbox"]',
  reasonButton: "span.cancel-items-reasons-dropdown",
  reasonSelect: "#cancel-reasons-dropdown",
  reasonOption: ".a-popover:visible a.a-dropdown-link",
  submit: "#preship-cancel-submit-button-announce",
} as const;

export type CancelOneResult = CancelOrderResult & { outcome: CancelOutcome };

/** Called when Amazon asks to sign in again (Your Orders sometimes does). true = signed in. */
export type Reauth = (page: Page) => Promise<boolean>;

const onSignIn = (page: Page): boolean => /\/ap\/(signin|mfa|cvf)|\/ax\/claim/.test(page.url());

async function goto(page: Page, url: string, reauth: Reauth): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await sleep(rand(1500, 2500));
  if (onSignIn(page)) {
    console.log("[cancel] Amazon asked to sign in again");
    if (!(await reauth(page))) throw new Error("signed out and could not sign in again");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await sleep(rand(1500, 2500));
  }
}

async function bodyText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
}

/** A real mouse click, scrolled into view first. */
async function click(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  await shortPause();
  await target.click({ timeout: 15_000 });
}

/** Types like a person: one key at a time. */
async function typeSlowly(field: Locator, text: string): Promise<void> {
  await click(field);
  await field.fill("");
  for (const ch of text) {
    await field.pressSequentially(ch, { delay: rand(40, 120) });
  }
}

/**
 * Your Orders, then its search box with the order id. true = the search lists
 * it. A search that finds nothing is not the last word (a fresh order can be
 * missing from it), so the caller opens the order page either way.
 */
async function searchOrders(page: Page, orderId: string, reauth: Reauth): Promise<boolean> {
  await goto(page, ORDERS_URL, reauth);
  const box = page.locator(SEL.search).first();
  if (!(await box.isVisible().catch(() => false))) {
    console.log("[cancel] no search box on Your Orders");
    return false;
  }
  await pause("searching Your Orders");
  await typeSlowly(box, orderId);
  await shortPause();
  await Promise.all([
    page.waitForURL(/\/your-orders\/search/, { timeout: NAV_TIMEOUT_MS }).catch(() => undefined),
    box.press("Enter"),
  ]);
  await sleep(rand(1500, 2500));
  const text = await bodyText(page);
  if (/no results found/i.test(text)) return false;
  return text.includes(orderId) || /\b1 order matching\b/i.test(text);
}

/** Opens the order from the search results, else straight by its URL. */
async function openOrder(page: Page, orderId: string, fromSearch: boolean, reauth: Reauth): Promise<void> {
  if (fromSearch) {
    const link = page.locator(`a[href*="order-details"][href*="${orderId}"]`).first();
    const anyLink = page.locator('a[href*="order-details"]').filter({ hasText: /view order details/i }).first();
    const target = (await link.isVisible().catch(() => false)) ? link : anyLink;
    if (await target.isVisible().catch(() => false)) {
      await pause("opening the order");
      await Promise.all([page.waitForLoadState("domcontentloaded").catch(() => undefined), click(target)]);
      await sleep(rand(1500, 2500));
      if (page.url().includes(orderId)) return;
    }
  }
  await goto(page, detailsUrl(orderId), reauth);
}

interface OrderPage {
  found: boolean;
  statuses: string[];
  canCancel: boolean;
}

async function readOrderPage(page: Page, orderId: string): Promise<OrderPage> {
  const text = await bodyText(page);
  if (/unable to load your order details/i.test(text) || !text.includes(orderId)) {
    return { found: false, statuses: [], canCancel: false };
  }
  const statuses = (await page.locator(SEL.status).allInnerTexts().catch(() => [] as string[]))
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const canCancel = await page.locator(SEL.cancelLink).first().isVisible().catch(() => false);
  return { found: true, statuses, canCancel };
}

const allCancelled = (statuses: string[]): boolean =>
  statuses.length > 0 && statuses.every((s) => /\bcancell?ed\b/i.test(s) && !/request/i.test(s));
const anyRequested = (statuses: string[]): boolean => statuses.some((s) => /cancell?ation request|cancel requested/i.test(s));

/** What a page with no Cancel items button says about the order. */
function withoutCancelButton(orderId: string, o: OrderPage): CancelOneResult {
  if (allCancelled(o.statuses)) return { order_id: orderId, outcome: "already_cancelled", detail: o.statuses.join(" | ") };
  if (anyRequested(o.statuses)) return { order_id: orderId, outcome: "requested", detail: o.statuses.join(" | ") };
  return {
    order_id: orderId,
    outcome: "not_cancellable",
    detail: `no Cancel items button${o.statuses.length ? ` (${o.statuses.join(" | ")})` : ""}`,
  };
}

/** Every item ticked: "Select all", then any box still empty by hand. */
async function tickAllItems(page: Page): Promise<number> {
  const toggle = page.locator(SEL.selectAll).first();
  if (await toggle.isVisible().catch(() => false)) {
    if (/select all/i.test(await toggle.innerText().catch(() => ""))) await click(toggle);
    await shortPause();
  }
  const boxes = page.locator(SEL.itemBoxes);
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i);
    if (await box.isChecked().catch(() => true)) continue;
    // The input is hidden under Amazon's fancy checkbox: click its label.
    await click(page.locator("#cancel-items-form .a-checkbox label").nth(i));
  }
  const checked = await boxes.evaluateAll((xs) => xs.filter((x) => (x as HTMLInputElement).checked).length);
  return checked;
}

/** Reason "Order Created by Mistake": Amazon's dropdown, else the native select. */
async function pickReason(page: Page): Promise<boolean> {
  const select = page.locator(SEL.reasonSelect).first();
  const button = page.locator(SEL.reasonButton).first();
  if (await button.isVisible().catch(() => false)) {
    await click(button);
    await sleep(rand(600, 1100));
    const option = page.locator(SEL.reasonOption).filter({ hasText: REASON_TEXT }).first();
    if (await option.isVisible().catch(() => false)) await click(option);
    await shortPause();
  }
  if ((await select.inputValue().catch(() => "")) !== REASON_VALUE) {
    await select.selectOption(REASON_VALUE).catch(() => undefined);
    await shortPause();
  }
  return (await select.inputValue().catch(() => "")) === REASON_VALUE;
}

/**
 * Cancels one order on the signed-in account. Never throws: anything that
 * goes wrong comes back as outcome "failed" with what was seen.
 */
export async function cancelOrder(page: Page, orderId: string, reauth: Reauth): Promise<CancelOneResult> {
  const fail = (detail: string): CancelOneResult => ({ order_id: orderId, outcome: "failed", detail });
  try {
    console.log(`[cancel] -- order ${orderId} --`);
    const listed = await searchOrders(page, orderId, reauth);
    console.log(`[cancel] Your Orders search ${listed ? "lists" : "does not list"} ${orderId}`);
    await openOrder(page, orderId, listed, reauth);

    const before = await readOrderPage(page, orderId);
    if (!before.found) {
      return { order_id: orderId, outcome: "not_found", detail: "not on this account's Your Orders" };
    }
    console.log(`[cancel] order page: ${before.statuses.join(" | ") || "(no status)"}${before.canCancel ? ", Cancel items shown" : ""}`);
    if (!before.canCancel) return withoutCancelButton(orderId, before);

    await pause("opening Cancel items");
    await Promise.all([
      page.waitForURL(/cancel-items|order-history|your-orders/, { timeout: NAV_TIMEOUT_MS }).catch(() => undefined),
      click(page.locator(SEL.cancelLink).first()),
    ]);
    const form = page.locator(SEL.form).first();
    if (!(await form.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false))) {
      // Amazon sends an order it will not cancel back to Your Orders.
      return { order_id: orderId, outcome: "not_cancellable", detail: `Cancel items did not open (${page.url().slice(0, 120)})` };
    }
    await pause("on the cancel page");

    const ticked = await tickAllItems(page);
    if (ticked === 0) return fail("no item could be ticked on the cancel page");
    console.log(`[cancel] ${ticked} item(s) ticked`);
    if (!(await pickReason(page))) return fail('could not choose the reason "Order Created by Mistake"');
    console.log("[cancel] reason: Order Created by Mistake");

    const submit = page.locator(SEL.submit).first();
    const enabled = await submit
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(async () => {
        for (let i = 0; i < 20; i++) {
          if (await submit.isEnabled().catch(() => false)) return true;
          await sleep(250);
        }
        return false;
      }, () => false);
    if (!enabled) return fail("Request cancellation stayed disabled");

    // Testing on live orders: everything up to the button, never the press.
    if (/^(1|true|yes|on)$/i.test((process.env.CANCEL_DRY_RUN ?? "").trim())) {
      return fail("dry run: ready, Request cancellation not pressed");
    }
    await pause("requesting cancellation");
    const formUrl = page.url();
    await click(submit);
    // The page moves on, or redraws in place with Amazon's answer.
    await Promise.race([
      page.waitForURL((u) => u.toString() !== formUrl, { timeout: 45_000 }),
      form.waitFor({ state: "detached", timeout: 45_000 }),
      page.locator(".a-alert-content, .a-box-inner h4, h1").filter({ hasText: /cancel/i }).first().waitFor({ timeout: 45_000 }),
    ]).catch(() => undefined);
    await sleep(rand(2000, 3000));
    const answer = (await bodyText(page)).replace(/\s+/g, " ");
    const said = answer.match(/[^.]*\bcancel[^.]*\./i)?.[0]?.trim().slice(0, 200) ?? "";
    console.log(`[cancel] after Request cancellation: ${page.url().slice(0, 120)}${said ? ` — "${said}"` : ""}`);
    if (/something went wrong|unable to cancel|could not be cancelled|cannot be cancelled/i.test(answer)) {
      return fail(`Amazon refused: ${said || page.url().slice(0, 120)}`);
    }

    // The order page decides.
    await pause("checking the order");
    await goto(page, detailsUrl(orderId), reauth);
    const after = await readOrderPage(page, orderId);
    console.log(`[cancel] order page now: ${after.statuses.join(" | ") || "(no status)"}${after.canCancel ? ", Cancel items still shown" : ""}`);
    if (allCancelled(after.statuses)) return { order_id: orderId, outcome: "cancelled", detail: after.statuses.join(" | ") };
    if (!after.canCancel || anyRequested(after.statuses)) {
      return { order_id: orderId, outcome: "requested", detail: said || after.statuses.join(" | ") };
    }
    return fail(`still shows Cancel items after the request${said ? ` (${said})` : ""}`);
  } catch (err) {
    return fail((err as Error).message.split("\n")[0]!.slice(0, 300));
  }
}
