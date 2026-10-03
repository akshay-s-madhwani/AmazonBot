import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaymentSpec, TargetAddress } from "./config.js";
import { checkoutAddressKey, sheetAddressKey } from "./address.js";
export { checkoutAddressKey, sheetAddressKey } from "./address.js";
import { pause, shortPause, sleep } from "./human.js";
import { requireJobClient } from "./job-client.js";
import { newOrdersFor, readOrderCards, readReviewShipments, reviewError, type BasketItem } from "./purchase-evidence.js";
import type { Locator, Page } from "./pw.js";


const CART_URL = "https://www.amazon.in/gp/cart/view.html?ref_=nav_cart";
const ORDERS_URL = "https://www.amazon.in/gp/css/order-history?ref_=nav_orders_first";
const NAV_TIMEOUT_MS = 45_000;

export type CheckoutResult = { ok: true; detail: string } | { ok: false; reason: string };

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
  }
  return null;
}

async function waitForFirstVisible(
  page: Page,
  selectors: string[],
  timeoutMs = 20_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    const found = await firstVisible(page, selectors);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(500);
  }
}

async function clickAndSettle(loc: Locator, page: Page, why: string): Promise<void> {
  await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { });
  await shortPause();
  await loc.dispatchEvent("click");
  await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause(why);
}


async function readCart(
  page: Page,
): Promise<{ navCount: number; activeItems: number; emptyText: boolean }> {
  return page.evaluate(() => {
    const badge = (document.querySelector("#nav-cart-count") as HTMLElement | null)?.textContent;
    const navCount = Number((badge ?? "").trim()) || 0;

    const activeItems = [...document.querySelectorAll("[data-asin]")].filter((el) => {
      const asin = (el.getAttribute("data-asin") ?? "").trim();
      if (!asin) return false;
      const h = el as HTMLElement;
      if (h.offsetParent === null) return false;
      return !!h.closest('#sc-active-cart, [data-name="Active Items"]');
    }).length;

    const emptyText = /your amazon (cart|basket) is empty/i.test(document.body.innerText);
    return { navCount, activeItems, emptyText };
  });
}

export async function runClearCart(page: Page): Promise<CheckoutResult> {
  await pause("opening cart to clear it");
  await page.goto(CART_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

  for (let round = 1; round <= 15; round++) {
    const cart = await readCart(page);

    if (cart.navCount === 0) {
      return {
        ok: true,
        detail: `cart empty (badge 0, after ${round - 1} deletions)`,
      };
    }

    const deleted = await page.evaluate(() => {
      const el = document.querySelector(
        'input[name^="submit.delete-active"], input[value="Delete"]',
      ) as HTMLInputElement | null;
      const form = el?.closest("form") as HTMLFormElement | null;
      if (!el || !form) return null;
      try {
        form.requestSubmit(el);
      } catch {
        el.click();
      }
      return el.name || "delete";
    });

    if (!deleted) {
      if (cart.activeItems === 0) {
        return { ok: true, detail: `cart clear (no active items; nav badge ${cart.navCount})` };
      }
      return {
        ok: false,
        reason:
          `cart still has ${cart.activeItems} active item(s) ` +
          `(nav badge ${cart.navCount}) but no Delete control found`,
      };
    }

    console.log(
      `[bot] deleting cart item (round ${round}; ${cart.activeItems} active, badge ${cart.navCount})`,
    );
    await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
    await pause("cart item deleted");
  }
  return { ok: false, reason: "cart still not empty after 15 deletions" };
}

export async function runAddToCart(page: Page): Promise<CheckoutResult> {
  await pause("adding to cart");
  const btn = await waitForFirstVisible(page, [
    "#add-to-cart-button",
    'input[name="submit.add-to-cart"]',
    'input[title="Add to Shopping Cart"]',
  ]);
  if (!btn) {
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("[data-a-accordion-row-name]")]
        .filter((e) => e.classList.contains("a-accordion-active"))
        .map((e) => e.getAttribute("data-a-accordion-row-name"))
        .join(","),
    );
    return {
      ok: false,
      reason: `Add to Cart button not found after 20s (active buy-box row: ${rows || "none"})`,
    };
  }
  const label = (await btn.getAttribute("value").catch(() => null)) ?? "";
  console.log(`[bot] add-to-cart control: "${label.trim() || "(unlabelled)"}"`);

  const before = await navCartCount(page);

  const asin = await page.evaluate(
    () =>
      (document.querySelector("#ASIN") as HTMLInputElement | null)?.value ||
      (location.pathname.match(/\/dp\/([A-Z0-9]{10})/) || [])[1] ||
      "",
  );
  const qty = await page.evaluate(
    () => (document.querySelector("#quantity") as HTMLSelectElement | null)?.value || "1",
  );

  const attempts: Array<[string, () => Promise<unknown>]> = [
    [
      "requestSubmit",
      () =>
        page.evaluate(() => {
          const el = document.querySelector(
            '#add-to-cart-button, input[name="submit.add-to-cart"]',
          ) as HTMLInputElement | null;
          const form = el?.closest("form") as HTMLFormElement | null;
          if (!el || !form) return false;
          if (el.type !== "submit") el.type = "submit";
          form.requestSubmit(el);
          return true;
        }),
    ],
    ["synthetic click", () => btn.dispatchEvent("click")],
    [
      "legacy add url",
      async () => {
        if (!asin) return false;
        console.log(`[bot] WARNING: falling back to the legacy add URL for ${asin} —` +
          ` buy-box selections (coupon / purchase option) are NOT carried over`);
        await page.goto(
          `https://www.amazon.in/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=${qty}`,
          { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS },
        );
        return true;
      },
    ],
  ];

  for (const [how, run] of attempts) {
    await run().catch((err: unknown) => {
      console.log(`[bot] add-to-cart FAILED via ${how}: ${(err as Error).message.slice(0, 70)}`);
    });
    await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
    await pause(`add to cart (${how})`);
    await declineUpsell(page);
    if (await cartCountRose(page, before)) {
      const now = await navCartCount(page);
      console.log(`[bot] added via ${how}`);
      return { ok: true, detail: `in cart via ${how} (nav count ${now})` };
    }
    console.log(`[bot] ${how} did not change the cart (badge still ${before})`);
  }

  return {
    ok: false,
    reason:
      `item was not added — cart badge stayed at ${before} after ` +
      attempts.map(([h]) => h).join(", "),
  };
}

async function navCartCount(page: Page): Promise<number> {
  return page
    .locator("#nav-cart-count")
    .first()
    .textContent()
    .then((t) => Number((t ?? "0").trim()) || 0)
    .catch(() => 0);
}

async function cartCountRose(page: Page, before: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    if ((await navCartCount(page)) > before) return true;
    const added = await page
      .evaluate(() => /added to (your )?cart|added to basket/i.test(document.body.innerText))
      .catch(() => false);
    if (added) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(500);
  }
}

async function declineUpsell(page: Page): Promise<void> {
  const decline = await firstVisible(page, [
    "#attachSiNoCoverage input",
    "#attachSiNoCoverage-announce",
    'input[aria-labelledby="attachSiNoCoverage-announce"]',
    "#siNoCoverage",
  ]);
  if (decline) {
    console.log("[bot] declining protection-plan upsell");
    await clickAndSettle(decline, page, "upsell declined");
  }
}


export async function runProceedToBuy(page: Page): Promise<CheckoutResult> {
  await pause("opening cart");
  await page.goto(CART_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

  const subtotal = await page
    .locator("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox")
    .first()
    .innerText()
    .catch(() => "");
  console.log(`[bot] cart subtotal: ${subtotal.trim() || "unknown"}`);

  const ptc = await firstVisible(page, [
    'input[name="proceedToRetailCheckout"]',
    "#sc-buy-box-ptc-button input",
    "#hlb-ptc-btn-native",
    'input[data-feature-id="proceed-to-checkout-action"]',
  ]);
  if (!ptc) return { ok: false, reason: "Proceed to Buy button not found in the cart" };

  await clickAndSettle(ptc, page, "proceeded to checkout");

  if (/\/gp\/cart\/view/.test(page.url())) {
    return { ok: false, reason: `still on the cart page after Proceed to Buy (${page.url()})` };
  }
  return { ok: true, detail: `at checkout: ${page.url().slice(0, 80)}` };
}


const ITEMSELECT_ROW = 'span[id^="line-item-address-"]';
const SPLIT_LINK = "#stmaLink";

async function openAddressPicker(page: Page): Promise<CheckoutResult> {
  if (/\/checkout\/p\/[^/]+\/address/.test(page.url())) return { ok: true, detail: "address list open" };
  const change = page.locator('a[aria-label="Change delivery address"]').filter({ visible: true }).first();
  if (!(await change.count())) return { ok: false, reason: `no Change link for the delivery address at ${page.url()}` };
  await shortPause();
  await change.click({ timeout: NAV_TIMEOUT_MS });
  await page.waitForURL(/\/address/, { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("address list open");
  return /\/address/.test(page.url())
    ? { ok: true, detail: "address list open" }
    : { ok: false, reason: `the address list did not open (at ${page.url()})` };
}

/** Rows on the multi-address page, in page order, with the product each belongs to. */
async function readItemRows(page: Page): Promise<Array<{ item: string; qty: number; key: string | null }>> {
  return page.evaluate((rowSel) => {
    return [...document.querySelectorAll(rowSel)].map((dd) => {
      let card: Element | null = dd;
      for (let i = 0; i < 12 && card && !card.querySelector('[data-a-selector="value"]'); i++) card = card.parentElement;
      let product: Element | null = dd;
      for (let i = 0; i < 14 && product && !/₹/.test((product as HTMLElement).innerText); i++) product = product.parentElement;
      const select = card?.querySelector('select[name="line-item-address"]') as HTMLSelectElement | null;
      const chosen = select ? select.options[select.selectedIndex]?.text ?? "" : (dd as HTMLElement).innerText;
      return {
        item: ((product as HTMLElement | null)?.innerText ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 15) ?? "",
        qty: Number(card?.querySelector('[data-a-selector="value"]')?.textContent?.trim() ?? "1"),
        chosen,
      };
    });
  }, ITEMSELECT_ROW).then((rows) => rows.map((r) => ({ item: r.item, qty: r.qty, key: checkoutAddressKey(r.chosen) })));
}

/**
 * The next row to move so that every item gives each address the same number
 * of units: null when already balanced, a reason when it never can be.
 */
export function planRowMoves(
  rows: Array<{ item: string; key: string | null }>,
  wantKeys: string[],
): { row: number; key: string } | null | string {
  const byItem = new Map<string, number[]>();
  rows.forEach((r, i) => byItem.set(r.item, [...(byItem.get(r.item) ?? []), i]));
  for (const [item, idx] of byItem) {
    if (idx.length % wantKeys.length !== 0) {
      return `"${item.slice(0, 40)}" has ${idx.length} unit(s), not a multiple of ${wantKeys.length} addresses`;
    }
    const each = idx.length / wantKeys.length;
    const count = new Map(wantKeys.map((k) => [k, 0]));
    for (const i of idx) {
      const k = rows[i]!.key;
      if (k !== null && count.has(k)) count.set(k, count.get(k)! + 1);
    }
    const short = wantKeys.find((k) => count.get(k)! < each);
    if (!short) continue;
    // A row on a non-sheet address first, else one from an address with too many.
    const spare =
      idx.find((i) => rows[i]!.key === null || !count.has(rows[i]!.key!)) ??
      idx.find((i) => count.get(rows[i]!.key!)! > each);
    if (spare === undefined) return `could not find a row of "${item.slice(0, 40)}" to move`;
    return { row: spare, key: short };
  }
  return null;
}

/** Picks one address for one row through its dropdown list, the way a person does. */
async function pickRowAddress(page: Page, row: number, want: string, label: string): Promise<boolean> {
  const dd = page.locator(ITEMSELECT_ROW).nth(row);
  await dd.scrollIntoViewIfNeeded().catch(() => { });
  await shortPause();
  await dd.click({ timeout: NAV_TIMEOUT_MS });
  const entries = page.locator(".a-popover:not(.a-popover-hidden) li a").filter({ visible: true });
  await entries.first().waitFor({ timeout: 8_000 }).catch(() => { });
  const n = await entries.count();
  for (let i = 0; i < n; i++) {
    const text = (await entries.nth(i).innerText().catch(() => "")).trim();
    // The list prints "name line1, line2, ..." — same shape as the dropdown.
    if (checkoutAddressKey(text) === want) {
      await entries.nth(i).click({ timeout: NAV_TIMEOUT_MS });
      await sleep(2500);
      return true;
    }
  }
  await page.keyboard.press("Escape").catch(() => { });
  console.log(`[bot] row ${row + 1}: "${label}" is not in its address list`);
  return false;
}

/**
 * MULTI-ADDRESS CHECKOUT. Change -> "Deliver to multiple addresses" -> split
 * every line until each row is one unit ("Deliver this item to additional
 * addresses" peels one unit off) -> each item's rows go to the addresses in
 * order, the item's sheet quantity to each -> Continue, back to payment.
 * Verified 2026-10-02; it precedes the payment method.
 */
async function selectMultipleAddresses(page: Page, targets: TargetAddress[]): Promise<CheckoutResult> {
  const open = await openAddressPicker(page);
  if (!open.ok) return open;
  const multi = page.getByText("Deliver to multiple addresses", { exact: true }).filter({ visible: true }).first();
  if (!(await multi.count())) return { ok: false, reason: "Multiple address button not found" };
  await shortPause();
  await multi.click({ timeout: NAV_TIMEOUT_MS });
  await page.waitForURL(/itemselect/, { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await page.locator(ITEMSELECT_ROW).first().waitFor({ timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("multi-address page open");

  // Split until every row is one unit. The page redraws after each split and
  // the next row's link appears only then, so wait for it rather than stop.
  for (let guard = 0; guard < 200; guard++) {
    const before = await readItemRows(page);
    if (!before.some((r) => r.qty > 1)) break;
    const split = page.locator(SPLIT_LINK).filter({ visible: true }).first();
    const shown = await split.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    if (!shown) break;
    await split.scrollIntoViewIfNeeded().catch(() => { });
    await shortPause();
    await split.click({ timeout: NAV_TIMEOUT_MS });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await readItemRows(page)).length <= before.length) await sleep(500);
  }
  let rows = await readItemRows(page);
  if (rows.some((r) => r.qty !== 1)) {
    return { ok: false, reason: `could not split every item into single units (${rows.map((r) => r.qty).join("/")})` };
  }

  const wantKeys = targets.map(sheetAddressKey);
  const plan = planRowMoves(rows, wantKeys);
  if (typeof plan === "string") return { ok: false, reason: plan };

  // Picking an address redraws the page and REORDERS the rows, so nothing is
  // assigned by position: after every pick the rows are read again and the
  // next move is planned from what the page shows now.
  for (let guard = 0; guard < rows.length * 3; guard++) {
    const move = planRowMoves(rows, wantKeys);
    if (typeof move === "string") return { ok: false, reason: move };
    if (!move) break;
    const target = targets[wantKeys.indexOf(move.key)]!;
    if (!(await pickRowAddress(page, move.row, move.key, target.fullName))) {
      return { ok: false, reason: `address "${target.fullName}" is not offered at checkout` };
    }
    rows = await readItemRows(page);
  }
  if (planRowMoves(rows, wantKeys) !== null) {
    return { ok: false, reason: "the items could not be spread evenly over the addresses" };
  }
  console.log(`[bot] ${rows.length} unit(s) spread over ${targets.length} addresses`);

  await pause("before continuing to payment");
  await page.locator("#checkout-primary-continue-button-id input").first().click({ timeout: NAV_TIMEOUT_MS });
  await page.waitForURL(/\/pay/, { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("back at payment");
  const confirmed = await page
    .evaluate(() => /delivering to multiple addresses/i.test(document.body.innerText.slice(0, 8000)))
    .catch(() => false);
  return confirmed
    ? { ok: true, detail: `delivering to ${targets.length} addresses` }
    : { ok: false, reason: `checkout does not show "Delivering to multiple addresses" (at ${page.url()})` };
}

/** One address: the payment page must already be delivering to it, else it is chosen from the list. */
async function selectSingleAddress(page: Page, target: TargetAddress): Promise<CheckoutResult> {
  const want = sheetAddressKey(target);
  const current = await page
    .evaluate(() => {
      const t = document.body.innerText;
      const m = t.match(/Delivering to\s+([^\n]+(?:\n[^\n]+)?)/i);
      return m ? m[1]!.replace(/\s+/g, " ") : "";
    })
    .catch(() => "");
  if (current && checkoutAddressKey(current) === want) {
    return { ok: true, detail: `delivering to ${target.fullName}` };
  }
  const open = await openAddressPicker(page);
  if (!open.ok) return open;
  const picked = await page.evaluate((key) => {
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const radios = [...document.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    for (const r of radios) {
      const box = r.closest("label, .a-radio, li, .a-box, div");
      const text = (box as HTMLElement | null)?.innerText.replace(/\s+/g, " ") ?? "";
      const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
      const pinAt = parts.findIndex((p) => /^\d{6}$/.test(p));
      if (pinAt < 3) continue;
      const k = `${norm(parts.slice(0, pinAt - 2).join(" "))}|${parts[pinAt]}`;
      if (k === key) { r.click(); return true; }
    }
    return false;
  }, want);
  if (!picked) return { ok: false, reason: `delivery address "${target.fullName}" (${target.pincode}) is not in the checkout address list` };
  await shortPause();
  const use = page.getByText("Deliver to this address", { exact: true }).filter({ visible: true }).first();
  await use.click({ timeout: NAV_TIMEOUT_MS });
  await page.waitForURL(/\/pay/, { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("address selected");
  return { ok: true, detail: `delivering to ${target.fullName}` };
}

export async function runSelectAddresses(page: Page, targets: TargetAddress[]): Promise<CheckoutResult> {
  await pause("selecting delivery address");
  const at = await ensureAtCheckout(page);
  if (!at.ok) return at;
  const usable = targets.filter((t) => t.pincode && t.line1);
  if (usable.length === 0) return { ok: false, reason: "no delivery address for this account" };
  return usable.length > 1 ? selectMultipleAddresses(page, usable) : selectSingleAddress(page, usable[0]!);
}


async function readBalanceRow(page: Page): Promise<{ present: boolean; usable: boolean; text: string }> {
  return page.evaluate(() => {
    const matches = [...document.querySelectorAll("div, li, label, span")].filter((e) =>
      /amazon pay balance/i.test((e as HTMLElement).innerText ?? ""),
    ) as HTMLElement[];
    if (matches.length === 0) return { present: false, usable: false, text: "" };

    const row = matches.reduce((best, e) => (best.contains(e) ? e : best), matches[0]!);

    const full = (row.innerText ?? "").replace(/\s+/g, " ").trim();
    const unusable = /unavailable|insufficient|add money/i.test(full);
    return { present: true, usable: !unusable, text: full.slice(0, 160) };
  });
}

async function selectPaymentRadio(page: Page, want: string): Promise<boolean> {
  return page.evaluate((needle) => {
    const radios = [...document.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    for (const r of radios) {
      if ((r as HTMLElement).offsetParent === null && !r.closest("label")) continue;
      const row = r.closest("label, li, .a-row, .a-section, div");
      const text = (row?.textContent ?? "").toLowerCase().replace(/\s+/g, " ");
      if (text.includes(needle)) {
        r.click();
        return true;
      }
    }
    return false;
  }, want.toLowerCase());
}

export async function clickAmazonButton(page: Page, pattern: RegExp): Promise<boolean> {
  const how = await page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;

    const candidates = [...document.querySelectorAll("span, a, button, input")].filter((e) => {
      if (!vis(e)) return false;
      const t = ((e as HTMLElement).innerText || (e as HTMLInputElement).value || "").trim();
      if (!(t.length > 0 && t.length < 60 && re.test(t))) return false;
      if (e.closest(".a-button-disabled, [aria-disabled='true'], [disabled]")) return false;
      return true;
    }) as HTMLElement[];
    if (candidates.length === 0) return null;

    const withControl = candidates.find(
      (c) =>
        c.closest("form") ||
        c.closest(".a-button")?.querySelector("input, button") ||
        (c as HTMLInputElement).type === "submit",
    );
    const label = withControl ?? candidates[candidates.length - 1]!;

    const widget = label.closest(".a-button, .a-button-inner, span, div") ?? label;
    const input =
      (widget.querySelector("input.a-button-input, input[type=submit], button") as
        | HTMLInputElement
        | null) ??
      (label.closest(".a-button")?.querySelector("input") as HTMLInputElement | null);

    const target = input ?? (label as unknown as HTMLInputElement);
    const form = target.closest("form") as HTMLFormElement | null;
    if (form && "type" in target) {
      try {
        if ((target as HTMLInputElement).type !== "submit") (target as HTMLInputElement).type = "submit";
        form.requestSubmit(target as HTMLInputElement);
        return "requestSubmit";
      } catch {
      }
    }
    target.click();
    return "click";
  }, pattern.source);

  if (how) {
    console.log(`[bot] pressed "${pattern.source}" via ${how}`);
    await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  }
  return how !== null;
}

async function clickByText(page: Page, pattern: RegExp): Promise<boolean> {
  const clicked = await page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const controls = [
      ...document.querySelectorAll('input[type="submit"], button, a.a-button-text, span.a-button-inner input'),
    ];
    const hit = controls.find((n) => {
      const el = n as HTMLElement;
      if (el.offsetParent === null) return false;
      const t = (el.innerText || (el as unknown as HTMLInputElement).value || "").trim();
      return re.test(t);
    }) as HTMLElement | null;
    if (!hit) return false;
    hit.click();
    return true;
  }, pattern.source);
  if (clicked) {
    await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  }
  return clicked;
}

const METHOD_TEXT: Record<string, string> = {
  balance: "amazon pay balance",
  cod: "cash on delivery",
  card: "credit or debit card",
  netbanking: "net banking",
  upi: "scan and pay",
  emi: "emi",
};

async function ensureAtCheckout(page: Page): Promise<CheckoutResult> {
  if (!(await atCheckoutPipeline(page))) {
    console.log(`[bot] not at checkout (${page.url().slice(0, 60)}) — going via the cart`);
    const proceeded = await runProceedToBuy(page);
    if (!proceeded.ok) return proceeded;
  }
  const settled = await waitForCheckoutPipeline(page);
  if (!settled) {
    return {
      ok: false,
      reason: `checkout did not settle out of the entry/redirect page (${page.url().slice(0, 90)})`,
    };
  }
  await dismissCheckoutModal(page);
  return { ok: true, detail: `at checkout: ${page.url().slice(0, 60)}` };
}

async function atCheckoutPipeline(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      if (/\/checkout\/(entry|)\/?$/.test(location.pathname)) return false;
      if (/\/checkout\/entry\//.test(location.href)) return false;
      const onPipelineUrl = /\/checkout\/p\/|\/gp\/buy\//.test(location.href);
      const hasCheckoutUi =
        /payment method|place your order|use this address|order total|delivering to/i.test(
          document.body.innerText,
        );
      return onPipelineUrl || hasCheckoutUi;
    })
    .catch(() => false);
}

async function waitForCheckoutPipeline(page: Page, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    if (await atCheckoutPipeline(page)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(1000);
  }
}

async function dismissCheckoutModal(page: Page): Promise<void> {
  const closed = await page
    .evaluate(() => {
      const modals = [...document.querySelectorAll('.a-popover, [role="dialog"], .a-modal-scroller')]
        .filter((m) => (m as HTMLElement).offsetParent !== null);
      if (modals.length === 0) return null;
      for (const m of modals) {
        const label = (m as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 60);
        const btn = [
          ...m.querySelectorAll('button, input[type="submit"], a, [role="button"]'),
        ].find((n) => {
          const el = n as HTMLElement;
          if (el.offsetParent === null) return false;
          const t = (el.innerText || (el as HTMLInputElement).value || "").trim();
          return /^(close|cancel|no thanks|not now|skip|continue|got it|ok|dismiss)\b/i.test(t);
        }) as HTMLElement | null;
        const closer = (btn ??
          m.querySelector('.a-button-close, [data-action="a-popover-close"]')) as HTMLElement | null;
        if (closer) {
          closer.click();
          return label;
        }
      }
      return null;
    })
    .catch(() => null);
  if (closed) {
    console.log(`[bot] dismissed checkout modal: "${closed}"`);
    await pause("modal dismissed");
  }
}

const PLACE_ORDER_SELECTOR =
  '#placeYourOrder, #placeYourOrder input, input[name="placeYourOrder1"], ' +
  "#submitOrderButtonId, #submitOrderButtonId input, #turbo-checkout-place-order-button";

async function whatCoversPlaceOrder(page: Page): Promise<string | null> {
  return page
    .evaluate((sel) => {
      const btn = document.querySelector(sel) as HTMLElement | null;
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!at || at === btn || btn.contains(at) || at.contains(btn)) return null;
      const owner = (at.closest('[role="dialog"], .a-popover, .a-modal-scroller') ??
        at) as HTMLElement;
      return (owner.innerText || owner.tagName).replace(/\s+/g, " ").trim().slice(0, 80);
    }, PLACE_ORDER_SELECTOR)
    .catch(() => null);
}

async function dismissBlockingOverlay(page: Page): Promise<boolean> {
  let dismissed = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    const overlay = await page
      .evaluate(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const covering = [
          ...document.querySelectorAll('[role="dialog"], .a-popover-modal, .a-modal-scroller, div'),
        ].filter((el) => {
          const e = el as HTMLElement;
          const cs = getComputedStyle(e);
          if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
            return false;
          }
          if (cs.position !== "fixed" && cs.position !== "absolute") return false;
          const r = e.getBoundingClientRect();
          return r.width >= vw * 0.6 && r.height >= vh * 0.4 && r.top < vh && r.bottom > 0;
        }) as HTMLElement[];
        if (covering.length === 0) return null;
        const el = covering[covering.length - 1] as HTMLElement;
        const r = el.getBoundingClientRect();
        return {
          label: (el.innerText || el.tagName).replace(/\s+/g, " ").trim().slice(0, 60),
          rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        };
      })
      .catch(() => null);

    if (!overlay) return dismissed;

    await page.keyboard.press("Escape").catch(() => undefined);
    await shortPause();
    if ((await whatCoversPlaceOrder(page)) === null && !(await stillOverlaid(page))) {
      console.log(`[bot] dismissed overlay with Escape: "${overlay.label}"`);
      return true;
    }

    const clickedClose = await page
      .evaluate(() => {
        const closers = [
          ...document.querySelectorAll(
            '[data-action="a-popover-close"], .a-button-close, button[aria-label*="close" i], ' +
            '[role="button"][aria-label*="close" i], [aria-label*="dismiss" i], i.a-icon-close, ' +
            '[data-testid*="close" i], [class*="close-button" i]',
          ),
        ].filter((el) => {
          const e = el as HTMLElement;
          const r = e.getBoundingClientRect();
          return e.offsetParent !== null && r.width > 0 && r.height > 0;
        }) as HTMLElement[];
        const glyphs = [...document.querySelectorAll("button, span, a")].filter((el) => {
          const e = el as HTMLElement;
          if (e.offsetParent === null) return false;
          return /^[\u00d7\u2715\u2716\u274c x]$/i.test((e.innerText || "").trim());
        }) as HTMLElement[];
        const target = closers[0] ?? glyphs[0];
        if (!target) return false;
        target.click();
        return true;
      })
      .catch(() => false);
    if (clickedClose) {
      await shortPause();
      if (!(await stillOverlaid(page))) {
        console.log(`[bot] closed overlay via its × : "${overlay.label}"`);
        return true;
      }
    }

    const point = await page
      .evaluate(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const tries: Array<[number, number]> = [
          [8, Math.round(vh / 2)],
          [vw - 8, Math.round(vh / 2)],
          [Math.round(vw / 2), vh - 8],
          [8, vh - 8],
        ];
        for (const [x, y] of tries) {
          const el = document.elementFromPoint(x, y) as HTMLElement | null;
          if (!el) continue;
          if (el.closest("a, button, input, select, textarea, [role='button']")) continue;
          const cs = getComputedStyle(el);
          if (cs.position !== "fixed" && cs.position !== "absolute") continue;
          return { x, y };
        }
        return null;
      })
      .catch(() => null);

    if (point) {
      await page.mouse.click(point.x, point.y).catch(() => undefined);
      await shortPause();
      if (!(await stillOverlaid(page))) {
        console.log(`[bot] dismissed overlay by clicking outside it: "${overlay.label}"`);
        return true;
      }
    }

    dismissed = true;
    console.log(`[bot] overlay "${overlay.label}" is stubborn — retrying`);
    await pause("overlay retry");
  }
  return dismissed;
}

async function stillOverlaid(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      return [...document.querySelectorAll('[role="dialog"], .a-popover-modal, .a-modal-scroller')]
        .some((el) => {
          const e = el as HTMLElement;
          const cs = getComputedStyle(e);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          const r = e.getBoundingClientRect();
          return r.width >= vw * 0.5 && r.height >= vh * 0.3;
        });
    })
    .catch(() => false);
}

export async function runApplyPayment(page: Page, payment: PaymentSpec): Promise<CheckoutResult> {
  await pause("reviewing payment");
  const at = await ensureAtCheckout(page);
  if (!at.ok) return at;

  const total = await readOrderTotal(page);
  const bal = await readBalanceRow(page);
  const declared = payment.codes.reduce((sum, c) => sum + (c.amount ?? 0), 0);

  console.log(`[bot] order total: ${total ?? "unknown"}`);
  console.log(`[bot] balance row: ${bal.text || "(none)"}`);
  console.log(
    `[bot] payment: ${payment.method} with ${payment.codes.length} code(s)` +
    (declared > 0 ? ` declaring ₹${declared}` : ""),
  );

  if (payment.method === "none") {
    return { ok: false, reason: "no payment_method set on the user row (voucher | amazon_pay)" };
  }

  if (!/^(1|true|yes)$/i.test((process.env.PAYMENT_APPLY_CODES ?? "").trim())) {
    return {
      ok: false,
      reason:
        `DRY RUN — no codes redeemed. Order total ${total ?? "unknown"}; ` +
        `${payment.method} has ${payment.codes.length} code(s)` +
        (declared > 0 ? ` worth ₹${declared}` : "") +
        `. Set PAYMENT_APPLY_CODES=true in bot/.env and resume to actually redeem.`,
    };
  }

  const totalUpfront = parseRupees(total);
  const balUpfront = parseRupees(bal.text);
  const applied: string[] = [];
  if (totalUpfront !== null && balUpfront !== null && balUpfront >= totalUpfront) {
    console.log(
      `[bot] balance ₹${balUpfront} already covers ₹${totalUpfront} — not redeeming any codes`,
    );
    applied.push(`existing balance ₹${balUpfront}`);
  } else {
    for (const { code, amount } of payment.codes) {
      const label = `${code.slice(0, 6)}…${amount !== undefined ? ` (₹${amount})` : ""}`;
      const res = await redeemCode(page, code);
      if (!res.ok) {
        if (/already (been )?(redeemed|used|applied)|expired/i.test(res.reason)) {
          console.warn(`[bot] code ${label} already used — continuing: ${res.reason}`);
          continue;
        }
        return {
          ok: false,
          reason: `${payment.method} code ${label} rejected: ${res.reason} (already-applied codes: ${applied.join(", ") || "none"})`,
        };
      }
      applied.push(label);
      console.log(`[bot] redeemed ${label}`);
      await pause("code redeemed");
    }
  }

  const after = await readBalanceRow(page);

  const totalNum = parseRupees(total);
  const balNum = parseRupees(after.text);

  if (totalNum === null || balNum === null) {
    return {
      ok: false,
      reason:
        `cannot verify the payment covers the order: ` +
        `total ${total ?? "unreadable"}, balance row "${after.text || "not found"}". ` +
        `Refusing to continue to Place Order without both numbers — resume once the ` +
        `page shows them, or check the screenshot for what changed.`,
    };
  }
  if (balNum < totalNum) {
    const short = (totalNum - balNum).toFixed(2);
    return {
      ok: false,
      reason:
        `balance insufficient: credit ₹${balNum} does not cover the order total ₹${totalNum} ` +
        `(short ₹${short}). Applied: ${applied.join(", ")}. NOTE: the order total includes ` +
        `delivery/fees, so it exceeds the item price. Add another code worth ≥₹${short}.`,
    };
  }
  if (!after.usable) {
    return {
      ok: false,
      reason:
        `credit applied (${applied.join(", ")}) but the balance still cannot cover the order — ` +
        `"${after.text}". Order total ${total ?? "unknown"}.`,
    };
  }
  if (!(await selectPaymentRadio(page, "amazon pay balance"))) {
    return { ok: false, reason: "balance is usable but its radio could not be selected" };
  }
  await pause("balance selected");

  if (
    !(await clickAmazonButton(page, /use this payment method/)) &&
    !(await clickByText(page, /use this payment method|continue/))
  ) {
    return { ok: false, reason: '"Use this payment method" button not found' };
  }
  await pause("advanced to order review");
  return { ok: true, detail: `paid with ${payment.method}: ${applied.join(", ")}` };
}

async function readPageErrors(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const out: string[] = [];
      const seen = new Set<string>();
      const nodes = [
        ...document.querySelectorAll(
          ".a-alert-content, .a-alert-error, .a-color-error, [class*='error-message']",
        ),
      ] as HTMLElement[];
      for (const n of nodes) {
        if (n.offsetParent === null && n.getClientRects().length === 0) continue;
        const t = (n.innerText ?? "").replace(/\s+/g, " ").trim();
        if (t.length < 8 || t.length > 240 || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
      }
      return out.slice(0, 3);
    })
    .catch(() => []);
}

async function waitForOrderReview(page: Page, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let loggedWait = false;
  for (; ;) {
    const state = await page
      .evaluate(() => {
        const applying = /setting your payment method/i.test(document.body.innerText);
        const hasPlace =
          !!document.querySelector(
            '#placeYourOrder, input[name="placeYourOrder1"], #submitOrderButtonId, #turbo-checkout-place-order-button',
          ) ||
          [...document.querySelectorAll('input[type="submit"], button, span')].some((n) => {
            const el = n as HTMLElement;
            return (
              el.offsetParent !== null &&
              /place your order|place order/i.test(
                (el.innerText || (el as HTMLInputElement).value || "").trim(),
              )
            );
          });
        return { applying, hasPlace };
      })
      .catch(() => ({ applying: false, hasPlace: false }));

    if (!state.applying && state.hasPlace) {
      const covering = await whatCoversPlaceOrder(page);
      if (covering === null) return true;
      console.log(`[bot] Place Your Order is covered by: "${covering}"`);
      await dismissBlockingOverlay(page);
      if ((await whatCoversPlaceOrder(page)) === null) return true;
    }
    if (state.applying && !loggedWait) {
      console.log('[bot] waiting out "Setting your payment method..."');
      loggedWait = true;
    }
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(1000);
  }
}

function parseRupees(text: string | null): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, "").match(/₹\s?([\d]+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

async function readOrderTotal(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const money = /₹\s?[\d,]+(?:\.\d+)?/g;

      const lastAmount = (s: string): string | null => {
        const all = s.match(money);
        return all && all.length > 0 ? (all[all.length - 1] as string) : null;
      };

      const labels = [...document.querySelectorAll("*")].filter((e) => {
        const el = e as HTMLElement;
        if (el.children.length > 3) return false;
        return /order total/i.test(el.innerText ?? "");
      }) as HTMLElement[];

      for (const label of labels.reverse()) {
        let node: HTMLElement | null = label;
        for (let up = 0; node && up < 4; up++, node = node.parentElement) {
          const amount = lastAmount(node.innerText ?? "");
          if (amount) return amount;
        }
      }

      for (const sel of ["#subtotals-marketplace-table", ".grand-total-price", "#orderTotal"]) {
        const el = document.querySelector(sel) as HTMLElement | null;
        const amount = el ? lastAmount(el.innerText ?? "") : null;
        if (amount) return amount;
      }
      return null;
    })
    .catch(() => null);
}

async function redeemCode(page: Page, code: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const input = await waitForFirstVisible(page, [
    "#spendingLimitBypassGiftCardInput",
    "#gcpromoinput",
    'input[name="claimCode"]',
    'input[placeholder="Enter Code" i]',
  ], 15_000);
  if (!input) return { ok: false, reason: "no gift-card / voucher code field on this checkout" };

  await input.fill("");
  await input.pressSequentially(code, { delay: 90 });
  await shortPause();
  if (!(await clickByText(page, /^apply$/))) {
    return { ok: false, reason: "Apply button not found next to the code field" };
  }
  await pause("code applied");

  const verdict = await page
    .evaluate(() => {
      const t = document.body.innerText;
      const err = t.match(
        /[^.\n]{0,60}(not valid|not a valid|isn'?t valid|invalid|expired|already (been )?(redeemed|used|applied)|cannot be applied|couldn'?t be applied|enter a valid)[^.\n]{0,60}/i,
      );
      const balRow = [...document.querySelectorAll("div, li, label")].find((e) =>
        /amazon pay balance/i.test((e as HTMLElement).innerText ?? ""),
      ) as HTMLElement | undefined;
      const balText = (balRow?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      return {
        error: err ? err[0].trim() : null,
        balanceUsable: balText ? !/unavailable|insufficient/i.test(balText) : false,
        balText,
      };
    })
    .catch(() => ({ error: null, balanceUsable: false, balText: "" }));

  if (verdict.error) return { ok: false, reason: verdict.error };
  if (!verdict.balanceUsable) {
    return {
      ok: false,
      reason:
        `code applied but the balance did not become usable — "${verdict.balText || "no balance row"}". ` +
        `Treating as NOT redeemed rather than continuing to an unpayable checkout.`,
    };
  }
  return { ok: true };
}


interface LedgerEntry {
  key: string;
  /** Every order this purchase made, comma-separated (one per address). */
  order_id: string | null;
  placed_at: string;
  token?: string;
  basket?: BasketItem[];
  /** Order ids already on Your Orders just before placing: the new ones are ours. */
  known_orders?: string[];
}

/** Ids on Your Orders right now, read in a separate tab so checkout stays put. */
async function knownOrderIds(page: Page): Promise<string[]> {
  const tab = await page.context().newPage();
  try {
    await tab.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await pause("reading Your Orders before placing");
    return (await readOrderCards(tab)).map((c) => c.id);
  } finally {
    await tab.close().catch(() => { });
    await page.bringToFront().catch(() => { });
  }
}

/** The new orders, polled: Your Orders can take a little while to list them. */
async function findNewOrders(
  page: Page,
  known: string[],
  targets: TargetAddress[],
): Promise<{ ok: true; ids: string[]; detail: string } | { ok: false; reason: string }> {
  let last = "no new order on Your Orders";
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await pause("reading Your Orders");
    const found = newOrdersFor(await readOrderCards(page), known, targets);
    if (found.ok) {
      const ids = found.orders.map((o) => o.id);
      return { ok: true, ids, detail: found.orders.map((o) => `${o.id} -> ${o.shipTo}`).join(", ") };
    }
    last = found.reason;
    await sleep(5000);
  }
  return { ok: false, reason: last };
}

function ledgerPath(artifactsDir: string): string {
  return join(artifactsDir, "orders-placed.json");
}

function readLedger(artifactsDir: string): LedgerEntry[] {
  const p = ledgerPath(artifactsDir);
  if (!existsSync(p)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("invalid ledger");
    return parsed as LedgerEntry[];
  } catch {
    throw new Error("purchase cache is unreadable; reconcile with the master ledger before continuing");
  }
}

function writeLedger(artifactsDir: string, entries: LedgerEntry[]): void {
  mkdirSync(artifactsDir, { recursive: true });
  const path = ledgerPath(artifactsDir);
  writeFileSync(path + ".tmp", JSON.stringify(entries, null, 2), { mode: 0o600 });
  renameSync(path + ".tmp", path);
}

export async function runPlaceOrder(
  page: Page,
  idempotencyKey: string,
  artifactsDir: string,
  addresses: TargetAddress[],
): Promise<CheckoutResult> {
  const ledger = readLedger(artifactsDir);
  const prior = ledger.find((e) => e.key === idempotencyKey);
  if (prior) {
    return {
      ok: false,
      reason:
        `This attempt submitted a purchase at ${prior.placed_at} ` +
        `(order id ${prior.order_id ?? "unknown"}). ` +
        `To purchase again, set PENDING or choose New attempt in either control panel.`,
    };
  }

  const atOrder = await ensureAtCheckout(page);
  if (!atOrder.ok) return atOrder;

  const ready = await waitForOrderReview(page);
  if (!ready) {
    const said = await readPageErrors(page);
    return {
      ok: false,
      reason:
        (said.length > 0 ? `Amazon says: ${said.join(" | ")} — ` : "") +
        `checkout never finished applying the payment method (still showing ` +
        `"Setting your payment method...") at ${page.url().slice(0, 80)}`,
    };
  }

  await pause("reviewing order before placing");
  const total = await page
    .locator("#subtotals-marketplace-table, .grand-total-price, #orderTotal")
    .first()
    .innerText()
    .catch(() => "");
  console.log(`[bot] order total: ${total.replace(/\s+/g, " ").trim().slice(0, 80) || "unknown"}`);

  const place = await firstVisible(page, [
    "#placeYourOrder input",
    'input[name="placeYourOrder1"]',
    "#submitOrderButtonId input",
    "#turbo-checkout-place-order-button",
    'input[aria-labelledby="submitOrderButtonId-announce"]',
  ]);
  const haveTextButton =
    !place &&
    (await page.evaluate(() =>
      [...document.querySelectorAll('input[type="submit"], button')].some((n) => {
        const el = n as HTMLElement;
        return (
          el.offsetParent !== null &&
          /place your order|place order/i.test(
            (el.innerText || (el as unknown as HTMLInputElement).value || "").trim(),
          )
        );
      }),
    ));
  if (!place && !haveTextButton) {
    return {
      ok: false,
      reason:
        `Place Your Order button not found at ${page.url()}. ` +
        `If this is the /pay page, the payment method still needs selecting first.`,
    };
  }

  await dismissBlockingOverlay(page);
  const basket = JSON.parse(readFileSync(join(artifactsDir, "expected-basket.json"), "utf8")) as BasketItem[];
  const mismatch = reviewError(basket, addresses, await readReviewShipments(page));
  if (mismatch) return { ok: false, reason: `PRE-PURCHASE STOP: ${mismatch}` };
  const jobId = process.env.JOB_ID ?? "";
  const runId = process.env.RUN_ID ?? "";
  if (!jobId || !runId) return { ok: false, reason: "a master-owned row and purchase ledger are required to place an order" };
  const known = await knownOrderIds(page);
  const intent = await requireJobClient().beginPurchase(runId, jobId);
  ledger.push({ key: idempotencyKey, order_id: null, placed_at: intent.attempted_at, token: intent.token, basket, known_orders: known });
  writeLedger(artifactsDir, ledger);

  const finalMismatch = reviewError(basket, addresses, await readReviewShipments(page));
  if (finalMismatch) return { ok: false, reason: `purchase intent reserved but checkout changed: ${finalMismatch}; reconcile before retrying` };

  console.log("[bot] *** PLACING ORDER — irreversible ***");
  if (place) {
    await clickAndSettle(place, page, "order submitted");
  } else {
    if (!(await clickAmazonButton(page, /place your order|place order/))) {
      await clickByText(page, /place your order|place order/);
    }
    await pause("order submitted");
  }

  await dismissBlockingOverlay(page);

  const isConfirmed = (): Promise<boolean> =>
    page.evaluate(() =>
      /order placed[,!]? thank you|thank you.*your order|order confirmed/i.test(
        document.body.innerText.slice(0, 5000),
      ),
    );

  let confirmed = await isConfirmed();
  if (!confirmed) {
    await dismissBlockingOverlay(page);
    await pause("waiting for the confirmation page");
    confirmed = await isConfirmed();
  }

  {
    const seen = await findNewOrders(page, known, addresses);
    if (seen.ok) return { ok: true, detail: `order(s) placed: ${seen.detail}` };
    const err = await page
      .locator(".a-alert-error .a-alert-content, #payment-error-message")
      .first()
      .innerText()
      .catch(() => "");
    return {
      ok: false,
      reason:
        `no order confirmation after placing${err.trim() ? `: ${err.trim()}` : ""}, ` +
        `and Your Orders shows no matching order (${seen.reason}). ` +
        `The attempt IS recorded in the ledger — verify in Your Orders before retrying.`,
    };
  }
}


const ORDER_ID_RE = /\b(\d{3}-\d{7}-\d{7})\b/;

export function orderIdFromUrl(url: string): string | null {
  try {
    for (const [key, value] of new URL(url).searchParams) {
      if (!/^order_?id$/i.test(key)) continue;
      const m = value.match(ORDER_ID_RE);
      if (m?.[1]) return m[1];
    }
  } catch {
  }
  return url.match(ORDER_ID_RE)?.[1] ?? null;
}

export async function runNoteOrderId(
  page: Page, idempotencyKey: string, artifactsDir: string, addresses: TargetAddress[],
): Promise<CheckoutResult> {
  const ledger = readLedger(artifactsDir);
  const entry = ledger.find(e => e.key === idempotencyKey);
  if (!entry?.token || !entry.basket || !entry.known_orders) {
    return { ok: false, reason: "purchase intent cache missing; reconcile the master ledger manually" };
  }
  const found = await findNewOrders(page, entry.known_orders, addresses);
  if (!found.ok) return { ok: false, reason: `order outcome UNKNOWN: ${found.reason}; human reconciliation required` };
  const orderIds = found.ids.join(", ");
  const jobId = process.env.JOB_ID ?? "";
  const runId = process.env.RUN_ID ?? "";
  const client = requireJobClient();
  await client.completePurchase(runId, jobId, entry.token, orderIds, { orders: found.detail, basket: entry.basket });
  entry.order_id = orderIds;
  writeLedger(artifactsDir, ledger);
  writeFileSync(join(artifactsDir, "order-id.txt"), orderIds, "utf8");
  await client.reportResult(jobId, { status: "DONE", order_id: orderIds, run_id: runId });
  return { ok: true, detail: `order id(s) ${found.detail}` };
}
