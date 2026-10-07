import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaymentSpec, TargetAddress } from "./config.js";
import { checkoutAddressKey, sheetAddressKey } from "./address.js";
export { checkoutAddressKey, sheetAddressKey } from "./address.js";
import { pause, shortPause, sleep } from "./human.js";
import { requireJobClient } from "./job-client.js";
import { newOrdersFor, readOrderCards, readReviewShipments, reviewError, shipsTo, type BasketItem, type OrderCard } from "./purchase-evidence.js";
import type { Locator, Page } from "./pw.js";


const CART_URL = "https://www.amazon.in/gp/cart/view.html?ref_=nav_cart";
const ORDERS_URL = "https://www.amazon.in/gp/css/order-history?ref_=nav_orders_first";
const NAV_TIMEOUT_MS = 45_000;

export type CheckoutResult = { ok: true; detail: string } | { ok: false; reason: string };

export async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
  }
  return null;
}

export async function waitForFirstVisible(
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


const CART_SETTLE_MS = 20_000;

type CartState = { navCount: number; activeItems: number; emptyText: boolean };

/**
 * Opens the cart. Amazon can redirect the cart URL (e.g. to /cart/ref=...)
 * while it loads, which aborts the goto even though the cart then shows.
 */
async function openCart(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(CART_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      return;
    } catch (err) {
      await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
      if (/amazon\.[a-z.]+\/(gp\/)?cart/.test(page.url())) return;
      if (attempt >= 2) throw err;
      console.log(`[bot] cart navigation interrupted (${(err as Error).message.slice(0, 70)}) — retrying`);
    }
  }
}

/** Null while the page is still parsing: the badge renders before the cart rows. */
async function readCart(page: Page): Promise<CartState | null> {
  return page.evaluate(() => {
    if (document.readyState === "loading") return null;
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

/**
 * readCart that waits out a reload. A Delete submits the cart form as a real
 * navigation, so a read right after it threw "execution context was destroyed".
 */
async function readCartSettled(page: Page): Promise<CartState | null> {
  const deadline = Date.now() + CART_SETTLE_MS;
  for (; ;) {
    const cart = await readCart(page).catch(() => null);
    if (cart) return cart;
    if (Date.now() >= deadline) return null;
    await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
    await page.waitForTimeout(500);
  }
}

/** True once the cart shows fewer items than `before`. */
async function waitForDeletion(page: Page, before: CartState): Promise<boolean> {
  const deadline = Date.now() + CART_SETTLE_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const now = await readCart(page).catch(() => null);
    if (now && (now.navCount < before.navCount || now.activeItems < before.activeItems)) return true;
  }
  return false;
}

/**
 * What the product page offers free ("Free with this product worth ₹99",
 * #freebies_feature_div, seen 2026-10-08): the free product's ASIN, title and
 * the seller the offer is tied to. This is the bot's only check for a free
 * item — the cart does not list it; Amazon adds it at checkout. Null = none.
 */
export async function readOfferedFreebie(
  page: Page,
  waitMs = 0,
): Promise<{ sku: string; title: string; seller: string } | null> {
  // Signed-in only, and drawn after the rest of the page: give it time, and
  // bring it into view in case it loads as it scrolls in.
  const deadline = Date.now() + waitMs;
  for (let tries = 0; ; tries++) {
    const found = await readFreebieBox(page);
    if (found || Date.now() >= deadline) return found;
    if (tries === 0) {
      await page.locator("#freebies_feature_div, #promoPriceBlockMessage_feature_div, #corePrice_feature_div")
        .first().scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => { });
    }
    await sleep(1000);
  }
}

async function readFreebieBox(page: Page): Promise<{ sku: string; title: string; seller: string } | null> {
  return page
    .evaluate(() => {
      // The feature div by id, else whatever block says "Free with this product".
      let box: Element | null = document.querySelector("#freebies_feature_div");
      if (!box || !/free with this product/i.test((box as HTMLElement).innerText ?? "")) {
        const head = [...document.querySelectorAll("span, div, h2, h3")].find(
          (e) => e.childElementCount < 4 && /^\s*free with this product/i.test(e.textContent ?? ""),
        );
        box = head ?? null;
        for (let i = 0; box && i < 6 && !box.querySelector("[data-asin]"); i++) box = box.parentElement;
      }
      if (!box || !/free with this product/i.test((box as HTMLElement).innerText ?? "")) return null;
      const sku = box.querySelector("[data-asin]")?.getAttribute("data-asin") ?? "";
      // A leaf's own text, not cut short with "…": containers join the full
      // and the truncated title into one string.
      const title = [...box.querySelectorAll("a, span, div")]
        .filter((e) => e.childElementCount === 0)
        .map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 15 && !/…$|\.\.\.$/.test(t) && !/free with this product|offer applicable|see all eligible/i.test(t))
        .sort((a, b) => b.length - a.length)[0] ?? "";
      const seller = (box.querySelector('a[href*="redirectMerchantId="]')?.getAttribute("href") ?? "").match(/redirectMerchantId=([A-Z0-9]+)/)?.[1] ?? "";
      return sku || title ? { sku, title, seller } : null;
    })
    .catch(() => null);
}

export async function runClearCart(page: Page): Promise<CheckoutResult> {
  await pause("opening cart to clear it");
  await openCart(page);

  for (let round = 1; round <= 15; round++) {
    const cart = await readCartSettled(page);
    if (!cart) return { ok: false, reason: `cart page did not finish loading (${page.url()})` };

    if (cart.navCount === 0) {
      return {
        ok: true,
        detail: `cart empty (badge 0, after ${round - 1} deletions)`,
      };
    }

    // Scoped to the active cart: a bare value="Delete" also matches Saved for later rows.
    const deleted = await page.evaluate(() => {
      const el = document.querySelector(
        'input[name^="submit.delete-active"], #sc-active-cart input[value="Delete"], ' +
          '[data-name="Active Items"] input[value="Delete"]',
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
    if (!(await waitForDeletion(page, cart))) {
      console.log("[bot] cart did not change after Delete — reopening the cart");
      await openCart(page);
    }
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


/** Polls until the page is off the cart; false if it is still there after timeoutMs. */
async function leftCart(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    if (!/\/gp\/cart\/view/.test(page.url())) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(500);
  }
}

export async function runProceedToBuy(page: Page): Promise<CheckoutResult> {
  await pause("opening cart");
  await openCart(page);

  const subtotal = await page
    .locator("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox")
    .first()
    .innerText()
    .catch(() => "");
  console.log(`[bot] cart subtotal: ${subtotal.trim() || "unknown"}`);

  const PTC = [
    'input[name="proceedToRetailCheckout"]',
    "#sc-buy-box-ptc-button input",
    "#hlb-ptc-btn-native",
    'input[data-feature-id="proceed-to-checkout-action"]',
  ];
  const ptc = await firstVisible(page, PTC);
  if (!ptc) return { ok: false, reason: "Proceed to Buy button not found in the cart" };

  await clickAndSettle(ptc, page, "proceeded to checkout");

  // The click navigates some time after it lands: wait for the cart to go,
  // never read the URL once. A press that did not take is pressed once more.
  if (!(await leftCart(page, 12_000))) {
    const again = await firstVisible(page, PTC);
    if (again) {
      console.log("[bot] still on the cart after Proceed to Buy — pressing it once more");
      await clickAndSettle(again, page, "proceeded to checkout (again)");
    }
    if (!(await leftCart(page, 20_000))) {
      return { ok: false, reason: `still on the cart page after Proceed to Buy (${page.url()})` };
    }
  }
  await pause("checkout loading");
  // Leaving the cart is not arriving: /checkout/entry/... is a redirect page
  // that is blank for a while. The next step starts on the real checkout.
  if (!(await waitForCheckoutPipeline(page))) {
    return {
      ok: false,
      reason: `checkout did not settle out of the entry/redirect page (${page.url().slice(0, 90)})`,
    };
  }
  await dismissCheckoutModal(page);
  return { ok: true, detail: `at checkout: ${page.url().slice(0, 80)}` };
}


const ITEMSELECT_ROW = 'span[id^="line-item-address-"]';

async function openAddressPicker(page: Page): Promise<CheckoutResult> {
  if (/\/checkout\/p\/[^/]+\/address/.test(page.url())) return { ok: true, detail: "address list open" };
  const change = page.locator('a[aria-label="Change delivery address"]').filter({ visible: true }).first();
  const shown = await change.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  if (!shown) return { ok: false, reason: `no Change link for the delivery address at ${page.url()}` };
  await shortPause();
  await change.click({ timeout: NAV_TIMEOUT_MS });
  await page.waitForURL(/\/address/, { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("address list open");
  return /\/address/.test(page.url())
    ? { ok: true, detail: "address list open" }
    : { ok: false, reason: `the address list did not open (at ${page.url()})` };
}

/** Rows on the multi-address page, in page order, with the product each belongs to. */
async function readItemRows(page: Page): Promise<Array<{ item: string; asin: string | null; qty: number; key: string | null }>> {
  return page.evaluate((rowSel) => {
    return [...document.querySelectorAll(rowSel)].map((dd) => {
      let card: Element | null = dd;
      for (let i = 0; i < 12 && card && !card.querySelector('[data-a-selector="value"]'); i++) card = card.parentElement;
      let product: Element | null = dd;
      for (let i = 0; i < 14 && product && !/₹/.test((product as HTMLElement).innerText); i++) product = product.parentElement;
      const select = card?.querySelector('select[name="line-item-address"]') as HTMLSelectElement | null;
      const chosen = select ? select.options[select.selectedIndex]?.text ?? "" : (dd as HTMLElement).innerText;
      const link = product?.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]')?.getAttribute("href") ?? "";
      return {
        item: ((product as HTMLElement | null)?.innerText ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 15) ?? "",
        asin: product?.querySelector("[data-asin]")?.getAttribute("data-asin") ||
          link.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null,
        qty: Number(card?.querySelector('[data-a-selector="value"]')?.textContent?.trim() ?? "1"),
        chosen,
      };
    });
  }, ITEMSELECT_ROW).then((rows) =>
    rows.map((r) => ({ item: r.item, asin: r.asin, qty: r.qty, key: checkoutAddressKey(r.chosen) })),
  );
}

/** Which basket item a multi-address row is: by ASIN, else by title prefix. -1 = none, or more than one. */
export function matchBasketItem(row: { item: string; asin: string | null }, basket: BasketItem[]): number {
  if (row.asin) {
    const i = basket.findIndex((b) => b.sku.toUpperCase() === row.asin!.toUpperCase());
    if (i >= 0) return i;
  }
  const norm = (v: string) => v.toLowerCase().replace(/\.{3}|…/g, "").replace(/[^a-z0-9]/g, "");
  const t = norm(row.item);
  const hits = basket.flatMap((b, i) => {
    const bt = norm(b.title);
    const n = Math.min(t.length, bt.length, 40);
    return n >= 10 && t.slice(0, n) === bt.slice(0, n) ? [i] : [];
  });
  return hits.length === 1 ? hits[0]! : -1;
}

type ItemRow = { item: number; qty: number; key: string | null };

/** readItemRows with each row as its basket index; a string names a row that matches no basket item. */
async function readBasketRows(page: Page, basket: BasketItem[]): Promise<ItemRow[] | string> {
  const out: ItemRow[] = [];
  for (const r of await readItemRows(page)) {
    const item = matchBasketItem(r, basket);
    if (item < 0) return `"${r.item.slice(0, 40)}" on the multi-address page is not a basket item`;
    out.push({ item, qty: r.qty, key: r.key });
  }
  return out;
}

/** One change to the multi-address page. */
export type RowAction =
  /** "Deliver this item to additional addresses" on this row's item: one more row. */
  | { kind: "split"; row: number }
  /** A row this item does not need (more rows than addresses). */
  | { kind: "delete"; row: number }
  | { kind: "assign"; row: number; key: string }
  | { kind: "step"; row: number; dir: "increment" | "decrement" };

/**
 * The next change so that every item has ONE row per address it goes to,
 * with that address's share as the row's quantity (shares[item][address]).
 * Null when the page is right; a string when it never can be. Rows are not
 * split into single units: an item with a minimum quantity (2) cannot be,
 * and a row of 8 to one address is one row, not eight.
 */
export function planRowAction(
  rows: Array<{ item: number; qty: number; key: string | null }>,
  wantKeys: string[],
  shares: number[][],
): RowAction | null | string {
  for (const [item, share] of shares.entries()) {
    const want = wantKeys.filter((_, a) => share[a]! > 0);
    if (want.length === 0) continue;
    const idx = rows.flatMap((r, i) => (r.item === item ? [i] : []));
    if (idx.length === 0) return `item ${item + 1} is not on the multi-address page`;
    if (idx.length < want.length) {
      // Peel the new row off the row with the most units.
      const from = idx.reduce((b, i) => (rows[i]!.qty > rows[b]!.qty ? i : b), idx[0]!);
      return { kind: "split", row: from };
    }
    // The row that already serves each wanted address (the first, if several).
    const served = new Map<string, number>();
    for (const i of idx) {
      const k = rows[i]!.key;
      if (k !== null && want.includes(k) && !served.has(k)) served.set(k, i);
    }
    const spare = idx.filter((i) => ![...served.values()].includes(i));
    if (idx.length > want.length) return { kind: "delete", row: spare[0]! };
    const missing = want.find((k) => !served.has(k));
    if (missing) return { kind: "assign", row: spare[0]!, key: missing };
    for (const [k, i] of served) {
      const need = share[wantKeys.indexOf(k)]!;
      const have = rows[i]!.qty;
      if (have !== need) return { kind: "step", row: i, dir: have < need ? "increment" : "decrement" };
    }
  }
  return null;
}

/** Clicks one row's quantity stepper (+ or -). False when the row has none. */
async function stepRowQuantity(page: Page, row: number, dir: "increment" | "decrement"): Promise<boolean> {
  const marked = await page.evaluate(([rowSel, n]) => {
    document.querySelectorAll("[data-bot-qty]").forEach((e) => e.removeAttribute("data-bot-qty"));
    let card: Element | null = document.querySelectorAll(rowSel)[n] ?? null;
    for (let i = 0; i < 12 && card && !card.querySelector('[data-a-selector="value"]'); i++) card = card.parentElement;
    card?.setAttribute("data-bot-qty", "1");
    return !!card;
  }, [ITEMSELECT_ROW, row] as [string, number]);
  if (!marked) return false;
  const label = dir === "increment" ? "Increase" : "Decrease";
  const button = page
    .locator(`[data-bot-qty] [data-a-selector="${dir}"], [data-bot-qty] button[aria-label^="${label}" i]`)
    .filter({ visible: true })
    .first();
  if (!(await button.count())) return false;
  await button.scrollIntoViewIfNeeded().catch(() => { });
  await shortPause();
  await button.click({ timeout: NAV_TIMEOUT_MS });
  return true;
}

/**
 * Marks (data-bot-ctl) one control for row `row`, walking up from the row:
 * the split link of its item card, or its own remove control. False = none.
 */
async function markRowControl(page: Page, row: number, what: "split" | "delete"): Promise<boolean> {
  return page.evaluate(([rowSel, n, kind]) => {
    document.querySelectorAll("[data-bot-ctl]").forEach((e) => e.removeAttribute("data-bot-ctl"));
    const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0;
    const start = document.querySelectorAll(rowSel)[n as number];
    if (!start) return false;
    if (kind === "split") {
      // The nearest card up from the row that holds a split link is its item's.
      for (let el: Element | null = start; el && el !== document.body; el = el.parentElement) {
        const link = [...el.querySelectorAll("#stmaLink, a, span[role=button]")].find(
          (a) => shown(a) && (a.id === "stmaLink" || /additional address/i.test((a as HTMLElement).innerText ?? "")),
        );
        if (link) { link.setAttribute("data-bot-ctl", "1"); return true; }
      }
      return false;
    }
    // Delete: the row's own remove control (the "x" beside its address), not
    // anything in the quantity stepper, and not in a neighbouring row.
    const rows = [...document.querySelectorAll(rowSel)];
    for (let el: Element | null = start.parentElement; el && el !== document.body; el = el.parentElement) {
      if (rows.some((r) => r !== start && el!.contains(r))) break;
      const del = [...el.querySelectorAll("a, button, span[role=button], i, input[type=image]")].find((c) => {
        if (!shown(c) || c.closest("[data-a-selector]")) return false;
        const label = `${c.getAttribute("aria-label") ?? ""} ${c.getAttribute("title") ?? ""} ${(c as HTMLElement).innerText ?? ""} ${c.className}`;
        return /remove|delete|close|×|✕|✖/i.test(label);
      });
      if (del) { del.setAttribute("data-bot-ctl", "1"); return true; }
    }
    return false;
  }, [ITEMSELECT_ROW, row, what] as [string, number, string]);
}

async function clickMarked(page: Page): Promise<void> {
  const el = page.locator("[data-bot-ctl]").first();
  await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { });
  await shortPause();
  await el.click({ timeout: NAV_TIMEOUT_MS });
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
 * MULTI-ADDRESS CHECKOUT. Change -> "Deliver to multiple addresses" -> every
 * item gets ONE row per address it goes to ("Deliver this item to additional
 * addresses" adds a row) -> each row gets its address and, with its own
 * stepper, that address's share (the basket's `shares`, from ItemsQuantity)
 * -> Continue, back to payment. 2026-10-08: rows are no longer split into
 * single units — an item with a minimum quantity of 2 cannot be, and 8 to
 * one address is one row of 8.
 */
async function selectMultipleAddresses(page: Page, targets: TargetAddress[], basket: BasketItem[]): Promise<CheckoutResult> {
  const open = await openAddressPicker(page);
  if (!open.ok) return open;
  const multi = page.getByText("Deliver to multiple addresses", { exact: true }).filter({ visible: true }).first();
  // The URL flips to /address before the list finishes drawing; wait, don't peek.
  const shown = await multi.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  if (!shown) return { ok: false, reason: "Multiple address button not found" };
  await shortPause();
  await multi.click({ timeout: NAV_TIMEOUT_MS });
  await page.waitForURL(/itemselect/, { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await page.locator(ITEMSELECT_ROW).first().waitFor({ timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("multi-address page open");

  let read = await readBasketRows(page, basket);
  if (typeof read === "string") return { ok: false, reason: read };
  let rows = read;

  // The product page promised it; Amazon adds it only here. Say so by name.
  const missingFree = basket.find((b, i) => b.free && !rows.some((r) => r.item === i));
  if (missingFree) {
    return { ok: false, reason: `free item "${missingFree.title.slice(0, 40)}" (offered on the product page) is not at checkout` };
  }

  // One change at a time, re-reading the page after each: picking an address
  // redraws the page and REORDERS the rows, so nothing is done by position.
  const wantKeys = targets.map(sheetAddressKey);
  const shares = basket.map((b) => b.shares!);
  const sig = (r: ItemRow[]) => JSON.stringify(r);
  const totalUnits = shares.flat().reduce((n, q) => n + q, 0);
  for (let guard = 0; guard < totalUnits * 2 + rows.length * 3 + 20; guard++) {
    const act = planRowAction(rows, wantKeys, shares);
    if (typeof act === "string") return { ok: false, reason: act };
    if (!act) break;
    const r = rows[act.row]!;
    const name = `"${basket[r.item]!.title.slice(0, 40)}"`;
    const before = sig(rows);
    if (act.kind === "assign") {
      const target = targets[wantKeys.indexOf(act.key)]!;
      console.log(`[bot] ${name}: a row -> ${target.fullName}`);
      if (!(await pickRowAddress(page, act.row, act.key, target.fullName))) {
        return { ok: false, reason: `address "${target.fullName}" is not offered at checkout` };
      }
    } else if (act.kind === "step") {
      if (!(await stepRowQuantity(page, act.row, act.dir))) {
        return { ok: false, reason: `no quantity control for ${name} on the multi-address page` };
      }
    } else {
      console.log(`[bot] ${name}: ${act.kind === "split" ? "one more row for another address" : "removing a row no address needs"}`);
      if (!(await markRowControl(page, act.row, act.kind))) {
        return {
          ok: false,
          reason: act.kind === "split"
            ? `no "Deliver this item to additional addresses" link for ${name}`
            : `no remove control on a spare row of ${name}`,
        };
      }
      await clickMarked(page);
    }
    // The page redraws after every change; wait for it to show.
    let now: ItemRow[] | string = rows;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
      await sleep(600);
      const got = await readBasketRows(page, basket).catch(() => null);
      if (got !== null) now = got;
      if (typeof now === "string" || sig(now) !== before) break;
    }
    if (typeof now === "string") return { ok: false, reason: now };
    if (sig(now) === before) return { ok: false, reason: `${name}: the page did not change after ${act.kind}` };
    if (act.kind === "step" && act.dir === "decrement" &&
        now.filter((x) => x.item === r.item).length < rows.filter((x) => x.item === r.item).length) {
      // At the item's minimum quantity the "-" is a bin: it deleted the row.
      const want = shares[r.item]![wantKeys.indexOf(r.key!)]!;
      return { ok: false, reason: `${name}: ${want} for one address is below Amazon's minimum quantity (${r.qty})` };
    }
    rows = now;
  }
  if (planRowAction(rows, wantKeys, shares) !== null) {
    return { ok: false, reason: "the items could not be given their ItemsQuantity per address" };
  }
  console.log(`[bot] ${rows.length} row(s), ${totalUnits} unit(s) over ${targets.length} addresses`);

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

/** `basket` (with per-address shares) is needed only for several addresses. */
export async function runSelectAddresses(page: Page, targets: TargetAddress[], basket: BasketItem[]): Promise<CheckoutResult> {
  await pause("selecting delivery address");
  const at = await ensureAtCheckout(page);
  if (!at.ok) return at;
  if (targets.length > 1) {
    // Shares are per address: dropping one would send its units nowhere.
    const bad = targets.find((t) => !t.pincode || !t.line1);
    if (bad) return { ok: false, reason: `address ${bad.fullName || "(no name)"} has no PIN or line 1` };
    return selectMultipleAddresses(page, targets, basket);
  }
  const usable = targets.filter((t) => t.pincode && t.line1);
  if (usable.length === 0) return { ok: false, reason: "no delivery address for this account" };
  return selectSingleAddress(page, usable[0]!);
}


/**
 * The Amazon Pay balance row: "Use your ₹617.00 Amazon Pay Balance" /
 * "Amazon Pay Balance ₹0.00 Unavailable". Only a row with an amount counts —
 * a banner above it, "View all Amazon vouchers in your Amazon Pay Balance",
 * was read instead and left the balance unknown (2026-10-08). The ₹ sign is
 * drawn by CSS there ("Use your 617.00 Amazon Pay Balance"), so the amount is
 * read with or without it. Usable is judged on the block around the row,
 * where "Insufficient balance" sits.
 */
export async function readBalanceRow(
  page: Page,
): Promise<{ present: boolean; usable: boolean; text: string; amount: number | null }> {
  return page.evaluate(() => {
    const squash = (e: Element) => ((e as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
    const AMOUNT = /(?:₹\s*)?(\d[\d,]*\.\d{2})\b/;
    const matches = [...document.querySelectorAll("div, li, label, span")].filter((e) => {
      const t = squash(e);
      return /amazon pay balance/i.test(t) && AMOUNT.test(t) && t.length < 400;
    }) as HTMLElement[];
    if (matches.length === 0) return { present: false, usable: false, text: "", amount: null };

    const row = matches.reduce((best, e) => (best.contains(e) ? e : best), matches[0]!);
    let block: HTMLElement = row;
    while (block.parentElement && !/another payment method/i.test(squash(block.parentElement)) && squash(block.parentElement).length < 400) {
      block = block.parentElement;
    }
    const unusable = /unavailable|insufficient|add money/i.test(squash(block));
    const text = squash(row);
    const amount = Number((text.match(AMOUNT)?.[1] ?? "").replace(/,/g, ""));
    return { present: true, usable: !unusable, text: text.slice(0, 160), amount: Number.isFinite(amount) && text.match(AMOUNT) ? amount : null };
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

export async function clickByText(page: Page, pattern: RegExp): Promise<boolean> {
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

/**
 * The steps after Proceed to Buy work on the checkout already open and never
 * go back to the cart: only add_items and proceed_to_buy touch it. A page
 * still on Amazon's redirect is waited out; a page that is not checkout at
 * all fails, and the run goes again from Proceed to Buy.
 */
export async function ensureAtCheckout(page: Page): Promise<CheckoutResult> {
  const settled = await waitForCheckoutPipeline(page);
  if (!settled) {
    return {
      ok: false,
      reason: /\/checkout\//.test(page.url())
        ? `checkout did not settle out of the entry/redirect page (${page.url().slice(0, 90)})`
        : `not at checkout (${page.url().slice(0, 90)}) — run from Proceed to buy`,
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

export async function waitForCheckoutPipeline(page: Page, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (; ;) {
    if (await atCheckoutPipeline(page)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(1000);
  }
}

export async function dismissCheckoutModal(page: Page): Promise<void> {
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
    .catch(() => null)
    // Prime upsells are not always an a-popover: any visible "No Thanks".
    .then(async (hit) => hit ?? page.evaluate(() => {
      const no = [...document.querySelectorAll('button, input[type="submit"], a, [role="button"], span')].find((n) => {
        const el = n as HTMLElement;
        if (el.offsetParent === null) return false;
        return /^no,? thanks$/i.test((el.innerText || (el as HTMLInputElement).value || "").trim());
      }) as HTMLElement | null;
      if (!no) return null;
      no.click();
      return "No Thanks";
    }))
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

/**
 * Pays with the Amazon Pay balance. Vouchers are redeemed before this, by
 * add_vouchers (Apay codes into the balance, blank-type codes as coupons), so
 * this step only checks the balance covers the order and selects it.
 */
export async function runApplyPayment(page: Page, payment: PaymentSpec): Promise<CheckoutResult> {
  await pause("reviewing payment");
  const at = await ensureAtCheckout(page);
  if (!at.ok) return at;

  // The page redraws after a modal is dismissed: wait for the summary, don't peek.
  let total = await readOrderTotal(page);
  for (const deadline = Date.now() + 20_000; total === null && Date.now() < deadline; ) {
    await sleep(1000);
    total = await readOrderTotal(page);
  }
  console.log(`[bot] order total: ${total ?? "unknown"}`);
  console.log(`[bot] payment: ${payment.method} with ${payment.codes.length} voucher(s), via add_vouchers`);

  const totalNum = parseRupees(total);
  // Vouchers and balance can cover everything: Amazon then shows ₹0.00 and
  // "Pay Now", with no payment method left to choose.
  if (totalNum === 0) {
    return { ok: true, detail: "order total ₹0 — nothing left to pay" };
  }

  const after = await readBalanceRow(page);
  console.log(`[bot] balance row: ${after.text || "(none)"}`);
  const balNum = after.amount;

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
        `(short ₹${short}). NOTE: the order total includes delivery/fees, so it exceeds ` +
        `the item price. Add an Apay voucher worth ≥₹${short} to the batch and rerun add_vouchers.`,
    };
  }
  if (!after.usable) {
    return {
      ok: false,
      reason:
        `the balance still cannot cover the order — ` +
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
  return { ok: true, detail: `paid with the Amazon Pay balance (₹${balNum} for ₹${totalNum})` };
}

export async function readPageErrors(page: Page): Promise<string[]> {
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
              /place your order|place order|^pay now$/i.test(
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

export function parseRupees(text: string | null): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, "").match(/₹\s?([\d]+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

export async function readOrderTotal(page: Page): Promise<string | null> {
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
): Promise<{ ok: true; ids: string[]; orders: OrderCard[]; detail: string } | { ok: false; reason: string }> {
  let last = "no new order on Your Orders";
  // A multi-address purchase can take a minute to list every order.
  for (let attempt = 1; attempt <= 8; attempt++) {
    await page.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await pause("reading Your Orders");
    const found = newOrdersFor(await readOrderCards(page), known, targets);
    if (found.ok) {
      const ids = found.orders.map((o) => o.id);
      return { ok: true, ids, orders: found.orders, detail: found.orders.map((o) => `${o.id} -> ${o.shipTo}`).join(", ") };
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
  // Never clicks twice. A resume after the click moves on: note_order_id finds
  // the orders. A second purchase is PENDING / New attempt in the panel.
  if (prior) {
    return { ok: true, detail: `already submitted at ${prior.placed_at}; order ids are read next` };
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
          /place your order|place order|^pay now$/i.test(
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

  const PLACE_TEXT = /place your order|place order|^pay now$/;
  const clickPlace = async (): Promise<void> => {
    // A Prime upsell can pop up at any moment on checkout and swallow the click.
    await dismissCheckoutModal(page);
    await dismissBlockingOverlay(page);
    if (place && (await place.isVisible().catch(() => false))) {
      await clickAndSettle(place, page, "order submitted");
    } else {
      if (!(await clickAmazonButton(page, PLACE_TEXT))) await clickByText(page, PLACE_TEXT);
      await pause("order submitted");
    }
  };
  // The thank-you page is not read: note_order_id takes the ids from Your
  // Orders. All this waits for is checkout letting go of the order.
  // The thank-you page lives under /gp/buy/ too (/gp/buy/thankyou/...).
  const leftCheckout = (timeout: number): Promise<boolean> =>
    page
      .waitForURL((u) => /thankyou/i.test(u.toString()) || !/\/checkout\/p\/|\/gp\/buy\//.test(u.toString()), { timeout })
      .then(() => true)
      .catch(() => false);

  console.log("[bot] *** PLACING ORDER — irreversible ***");
  await clickPlace();
  let left = await leftCheckout(30_000);
  if (!left && (await readPageErrors(page)).length === 0) {
    // Still on checkout, no error: a popup most likely ate the click. Amazon
    // places one order per checkout, so pressing again cannot buy twice.
    console.log("[bot] still on checkout after Pay Now — closing any popup and pressing it again");
    await clickPlace();
    left = await leftCheckout(60_000);
  }
  if (!left) {
    const said = await readPageErrors(page);
    return {
      ok: false,
      reason:
        (said.length > 0 ? `Amazon says: ${said.join(" | ")} — ` : "") +
        `still at checkout after Pay Now. ` +
        `The attempt IS recorded in the ledger — verify in Your Orders before retrying.`,
    };
  }
  await pause("order submitted");
  return { ok: true, detail: "order submitted" };
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
  // One order per delivery address, one per line in the sheet's order_id cell.
  const orderIds = found.ids.join("\n");
  const jobId = process.env.JOB_ID ?? "";
  const runId = process.env.RUN_ID ?? "";
  const client = requireJobClient();
  // Each Address row gets the order(s) shipping to it. First, while the run
  // still owns the row: a failure here leaves the purchase open to resume.
  const perAddress = addresses.flatMap((t) => {
    const ids = found.orders.filter((o) => shipsTo(o, t)).map((o) => o.id);
    return t.row !== undefined && ids.length ? [{ row_number: t.row, order_id: ids.join("\n") }] : [];
  });
  if (perAddress.length) await client.markAddressOrders(jobId, runId, perAddress);
  // Re-run after the ids were reported: the addresses are written again, the
  // purchase is already complete on the master.
  if (entry.order_id) return { ok: true, detail: `order id(s) ${found.detail}` };
  await client.completePurchase(runId, jobId, entry.token, orderIds, { orders: found.detail, basket: entry.basket });
  entry.order_id = orderIds;
  writeLedger(artifactsDir, ledger);
  writeFileSync(join(artifactsDir, "order-id.txt"), orderIds, "utf8");
  await client.reportResult(jobId, { status: "DONE", order_id: orderIds, run_id: runId });
  return { ok: true, detail: `order id(s) ${found.detail}` };
}
