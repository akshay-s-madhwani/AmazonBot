import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaymentSpec, TargetAddress } from "./config.js";
import { checkoutAddressKey, sheetAddressKey } from "./address.js";
export { checkoutAddressKey, sheetAddressKey } from "./address.js";
// Checkout keeps full-length pauses whatever BOT_PACE says (see steadyPause).
import { steadyPause as pause, steadyShortPause as shortPause, sleep } from "./human.js";
import { requireJobClient } from "./job-client.js";
import { ordersByName, readOrderCards, readReviewShipments, reviewBasket, shipsTo, type BasketItem, type OrderCard } from "./purchase-evidence.js";
import type { Locator, Page } from "./pw.js";
import type { FreeItem } from "./allocation.js";


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
export async function openCart(page: Page): Promise<void> {
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

/**
 * The free products the WHOLE CART brings, from Amazon's "N FREE item(s) will
 * be added to your order" box: on the "Added to cart" page right after an add
 * (smart-wagon) and on the cart page (data-feature-id="imb-message-container",
 * each free product an li with input[name=imb-type][value=freebieMessage]).
 * Empty when the page has no such box.
 */
export async function readFreebieMessages(page: Page): Promise<FreeItem[]> {
  return page
    .evaluate(() => {
      const out: Array<{ sku: string; title: string; quantity: number }> = [];
      for (const box of document.querySelectorAll('[data-feature-id="imb-message-container"]')) {
        const msgs = [...box.querySelectorAll('input[name="imb-type"][value="freebieMessage"]')]
          .map((i): Element | null => i.closest("li") ?? i.parentElement)
          .filter((li): li is Element => li !== null);
        if (msgs.length === 0) continue;
        const header = (box.querySelector('[data-feature-id="grouped-imb-header"]')?.textContent ?? "").replace(/\s+/g, " ");
        const count = Number(header.match(/(\d+)\s+FREE item/i)?.[1] ?? "1");
        for (const li of msgs) {
          const href = li.querySelector('a[href*="/gp/product/"], a[href*="/dp/"]')?.getAttribute("href") ?? "";
          const sku = href.match(/\/(?:gp\/product|dp)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? "";
          const title = (li.querySelector(".sc-product-title")?.textContent ?? li.querySelector("a")?.textContent ?? "")
            .replace(/\s+/g, " ").trim();
          if (!sku && !title) continue;
          // One message naming one product carries the header's count; several share it one each.
          out.push({ sku: sku || title.slice(0, 40), title: title || sku, quantity: msgs.length === 1 ? Math.max(1, count) : 1 });
        }
      }
      return out;
    })
    .catch(() => []);
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

/** The rows still showing, in page order — the same ones readItemRows indexes. */
function shownRows(page: Page): Locator {
  return page.locator(ITEMSELECT_ROW).filter({ visible: true });
}

/**
 * The "Delivering to multiple addresses" section's Change link: aria-label
 * just "Change", leading to /itemselect — not "Change delivery address",
 * which a checkout set to several addresses no longer shows (2026-10-08).
 */
async function multiAddressChange(page: Page): Promise<Locator | null> {
  const link = page
    .locator('a[data-topage="itemselect"], #checkout-javaItemSelectPanel a[aria-label="Change"]')
    .filter({ visible: true })
    .first();
  return (await link.count().catch(() => 0)) > 0 ? link : null;
}

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

/**
 * Waits for the multi-address list to finish drawing: no "Updating your
 * order" spinner, and the same rows (count and text) on two reads a second
 * apart. Checkout's "Make updates to your items" box draws its rows one by one
 * while it updates; a read in the middle saw only some of them and failed
 * "item 1 is not on the multi-address page" (2026-10-08).
 */
export async function waitForRowsSettled(page: Page, budgetMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let last = "";
  while (Date.now() < deadline) {
    const now = await page
      .evaluate((rowSel) => {
        const busy = /updating your order/i.test(document.body.innerText);
        const rows = [...document.querySelectorAll(rowSel)].filter((r) => r.getBoundingClientRect().width > 0);
        return { busy, sig: `${rows.length}|${rows.map((r) => (r as HTMLElement).innerText.slice(0, 40)).join("|")}` };
      }, ITEMSELECT_ROW)
      .catch(() => ({ busy: true, sig: "" }));
    if (!now.busy && now.sig !== "0|" && now.sig === last) return true;
    last = now.busy ? "" : now.sig;
    await sleep(1000);
  }
  return false;
}

/**
 * waitForRowsSettled, and when the list never settles, the page reloaded
 * (twice at most): "Updating your order" can spin with no rows until the page
 * is loaded again, while the change itself has gone through (2026-10-09).
 * Amazon keeps the multi-address state server-side, so a reload loses nothing.
 */
async function settleRows(page: Page, budgetMs = 45_000): Promise<void> {
  for (let reload = 1; !(await waitForRowsSettled(page, budgetMs)); reload++) {
    if (reload > 2) {
      console.log("[bot] the multi-address list did not settle — reading it as it is");
      return;
    }
    console.log(`[bot] the multi-address list is stuck updating — reloading the page (${reload}/2)`);
    await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => { });
    // A reload that lands back on payment: its Change reopens the list.
    if (!/\/itemselect/.test(page.url())) {
      await pause("checkout reloaded");
      const change = await multiAddressChange(page);
      if (change) {
        await shortPause();
        await change.click({ timeout: NAV_TIMEOUT_MS }).catch(() => { });
        await page.waitForURL(/itemselect/, { timeout: NAV_TIMEOUT_MS }).catch(() => { });
      }
    }
    await page.locator(ITEMSELECT_ROW).first().waitFor({ timeout: NAV_TIMEOUT_MS }).catch(() => { });
    await pause("multi-address page reloaded");
  }
}

type RawRow = { item: string; asins: string[]; qty: number; key: string | null };

/**
 * Rows on the multi-address page, in page order, with the product each belongs to.
 *
 * A row's product is the item card holding its own "Remove item" — the widest
 * box around that link with no other item's in it. It used to be the first
 * box up from the row whose text had a "₹", which after Amazon redrew the list
 * (a split, an address picked) could be a box around BOTH products: the
 * Santoor rows then read the free shampoo's ASIN and title, and the step
 * failed "item 1 is not on the multi-address page" on a settled page that a
 * fresh read matched fine (2026-10-08/09).
 */
async function readItemRows(page: Page): Promise<RawRow[]> {
  return page.evaluate(([rowSel, del]) => {
    const shown = (e: Element) => e.getBoundingClientRect().width > 0;
    const squash = (s: string) => s.replace(/\s+/g, " ").trim();
    // Each item's "Remove item": Amazon's line-group delete, else a control labelled so; innermost only.
    const all = [...document.querySelectorAll(`${del}, a, button, span[role=button]`)].filter(
      (e) => shown(e) && (e.matches(del!) || /^remove item$/i.test(squash((e as HTMLElement).innerText ?? ""))),
    );
    const removes = all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
    const cards = removes.map((r) => {
      let c: Element = r;
      while (c.parentElement && c.parentElement !== document.body &&
        !removes.some((o) => o !== r && c.parentElement!.contains(o))) c = c.parentElement;
      return c;
    });
    const mid = (e: Element) => { const b = e.getBoundingClientRect(); return (b.top + b.bottom) / 2; };
    /** The item card a row belongs to: the one card around it, else the one beside it on the page. */
    const cardFor = (row: Element): Element | null => {
      const around = cards.filter((c) => c.contains(row));
      if (around.length > 0) return around[0]!;
      let box: Element | null = row.parentElement;
      while (box && box !== document.body && !removes.some((r) => box!.contains(r))) box = box.parentElement;
      const inBox = box && box !== document.body ? cards.filter((c) => box!.contains(c)) : [];
      if (inBox.length === 1) return inBox[0]!;
      const pool = inBox.length ? inBox : cards;
      if (pool.length === 0) return null;
      // Rows sit to the right of their card: the card level with the row.
      const y = mid(row);
      const dist = (c: Element) => { const b = c.getBoundingClientRect(); return y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0; };
      return pool.reduce((best, c) => (dist(c) < dist(best) ? c : best));
    };

    // Shown rows only: Remove item hides its group; the page drops it on Continue.
    return [...document.querySelectorAll(rowSel!)].filter(shown).map((dd) => {
      let stepper: Element | null = dd;
      for (let i = 0; i < 12 && stepper && !stepper.querySelector('[data-a-selector="value"]'); i++) stepper = stepper.parentElement;
      let product: Element | null = cardFor(dd);
      if (!product) {
        // No "Remove item" on the page at all: the old way, up to the first price.
        product = dd;
        for (let i = 0; i < 14 && product && !/₹/.test((product as HTMLElement).innerText); i++) product = product.parentElement;
      }
      const select = stepper?.querySelector('select[name="line-item-address"]') as HTMLSelectElement | null;
      const chosen = select ? select.options[select.selectedIndex]?.text ?? "" : (dd as HTMLElement).innerText;
      const links = [...(product?.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]') ?? [])];
      const asins = new Set<string>();
      for (const e of product?.querySelectorAll("[data-asin]") ?? []) {
        const a = e.getAttribute("data-asin") ?? "";
        if (/^[A-Z0-9]{10}$/i.test(a)) asins.add(a.toUpperCase());
      }
      for (const l of links) {
        const a = l.getAttribute("href")?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
        if (a) asins.add(a.toUpperCase());
      }
      const titled = links.map((l) => squash((l as HTMLElement).innerText ?? "")).find((t) => t.length > 15);
      return {
        item: titled ?? ((product as HTMLElement | null)?.innerText ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 15) ?? "",
        asins: [...asins],
        qty: Number(stepper?.querySelector('[data-a-selector="value"]')?.textContent?.trim() ?? "1"),
        chosen,
      };
    });
  }, [ITEMSELECT_ROW, LINE_GROUP_DELETE] as [string, string]).then((rows) =>
    rows.map((r) => ({ item: r.item, asins: r.asins, qty: r.qty, key: checkoutAddressKey(r.chosen) })),
  );
}

/**
 * Which basket item a multi-address row is: by the title its card shows,
 * then — when no title or several match — by an ASIN in its card. Title
 * first: a card can carry another product's ASIN (a free item drawn inside
 * it), never another product's title. -1 = none, or more than one.
 */
export function matchBasketItem(row: { item: string; asins: string[] }, basket: BasketItem[]): number {
  const norm = (v: string) => v.toLowerCase().replace(/\.{3}|…/g, "").replace(/[^a-z0-9]/g, "");
  const t = norm(row.item);
  const byTitle = basket.flatMap((b, i) => {
    const bt = norm(b.title);
    const n = Math.min(t.length, bt.length, 40);
    return n >= 10 && t.slice(0, n) === bt.slice(0, n) ? [i] : [];
  });
  if (byTitle.length === 1) return byTitle[0]!;
  const pool = byTitle.length > 1 ? byTitle : basket.map((_, i) => i);
  const want = new Set(row.asins.map((a) => a.toUpperCase()));
  const byAsin = pool.filter((i) => want.has(basket[i]!.sku.toUpperCase()));
  return byAsin.length === 1 ? byAsin[0]! : -1;
}

type ItemRow = { item: number; qty: number; key: string | null };

/** The last raw read, printed when an item cannot be found on the page. */
let lastRawRows: RawRow[] = [];

/** readItemRows with each row as its basket index; a string names a row that matches no basket item. */
async function readBasketRows(page: Page, basket: BasketItem[]): Promise<ItemRow[] | string> {
  const out: ItemRow[] = [];
  lastRawRows = await readItemRows(page);
  for (const r of lastRawRows) {
    const item = matchBasketItem(r, basket);
    if (item < 0) {
      console.log(`[bot] multi-address rows read: ${JSON.stringify(lastRawRows)}`);
      return `"${r.item.slice(0, 40)}" on the multi-address page is not a basket item`;
    }
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
/**
 * Shares cut down to what the multi-address page shows per item: an item
 * with no row gets none; one with fewer units than its shares keeps them in
 * address order until they run out. Never more than asked.
 */
export function fitSharesToCart(shares: number[][], rows: Array<{ item: number; qty: number }>): number[][] {
  return shares.map((share, item) => {
    let left = rows.filter((r) => r.item === item).reduce((n, r) => n + r.qty, 0);
    return share.map((q) => {
      const take = Math.min(q, left);
      left -= take;
      return take;
    });
  });
}

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
    let card: Element | null = [...document.querySelectorAll(rowSel)].filter((r) => r.getBoundingClientRect().width > 0)[n] ?? null;
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
    const start = [...document.querySelectorAll(rowSel)].filter((r) => r.getBoundingClientRect().width > 0)[n as number];
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
    const rows = [...document.querySelectorAll(rowSel)].filter((r) => r.getBoundingClientRect().width > 0);
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

/** Each item group's own "Remove item" on the multi-address page. */
const LINE_GROUP_DELETE = '[data-action="item-select-delete-linegroup-and-children"]';

/**
 * What marks one item as unbuyable on the multi-address page: its red line
 * ("Sorry, the quantity you requested is no longer available…") or a
 * "Quantity: 0" left in place of its stepper.
 */
const ITEM_PROBLEM =
  /no longer available|quantity you requested|currently unavailable|out of stock|cannot be (?:shipped|delivered)|(?:isn't|is not) available|quantity:\s*0\b/i;

/**
 * Removes every item the multi-address page flags with that item's own
 * "Remove item" — the nearest box around the flag holding exactly one. The
 * flag is found by its text as well as Amazon's error classes: the classes
 * alone missed a "no longer available" row (2026-10-09), which then blocked
 * Continue. A flag not inside one item (the page-wide "There was a problem
 * with some of the items" alert) is left alone. Returns what was removed.
 */
async function removeFlaggedItems(page: Page): Promise<string[]> {
  const removed: string[] = [];
  for (let round = 0; round < 6; round++) {
    const hit = await page
      .evaluate(([del, problemSrc]) => {
        const problem = new RegExp(problemSrc, "i");
        const squash = (t: string) => t.replace(/\s+/g, " ").trim();
        document.querySelectorAll("[data-bot-ctl]").forEach((e) => e.removeAttribute("data-bot-ctl"));
        const shown = (e: Element) => e.getBoundingClientRect().width > 0;
        const textOf = (e: Element) => squash((e as HTMLElement).innerText ?? "");
        // Each item's "Remove item": Amazon's line-group delete, else a control labelled so.
        const removeControls = (box: Element): Element[] => {
          const all = [...box.querySelectorAll(`${del}, a, button, span[role=button], input[type=submit]`)].filter(
            (e) => shown(e) && (e.matches(del) || /^remove item$/i.test(textOf(e) || (e as HTMLInputElement).value || "")),
          );
          return all.filter((e) => !all.some((o) => o !== e && o.contains(e)));
        };
        // Red alerts, plus the smallest elements whose own text names a problem.
        const flags = [...document.querySelectorAll(".a-alert-inline-error, .a-alert-error, span, div, p")]
          .filter(shown)
          .filter((e) => {
            const t = textOf(e);
            if (!t || t.length > 300) return false;
            if (e.matches(".a-alert-inline-error, .a-alert-error")) return true;
            return problem.test(t) && ![...e.children].some((c) => problem.test(textOf(c)));
          });
        for (const flag of flags) {
          let box: Element | null = flag.parentElement;
          while (box && box !== document.body && removeControls(box).length === 0) box = box.parentElement;
          if (!box || box === document.body) continue;
          const controls = removeControls(box);
          if (controls.length !== 1) continue;
          const link = controls[0]!.querySelector("a") ?? controls[0]!;
          if (!shown(link)) continue;
          link.setAttribute("data-bot-ctl", "1");
          const title = (box as HTMLElement).innerText.split("\n").map((l) => l.trim()).find((l) => l.length > 3) ?? "item";
          return { title: title.slice(0, 60), error: textOf(flag).slice(0, 120) };
        }
        return null;
      }, [LINE_GROUP_DELETE, ITEM_PROBLEM.source] as [string, string])
      .catch(() => null);
    if (!hit) break;
    console.log(`[bot] "${hit.title}" flagged: "${hit.error}" — removing it`);
    const before = await shownRows(page).count().catch(() => -1);
    await clickMarked(page);
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
      await sleep(600);
      if ((await shownRows(page).count().catch(() => before)) !== before) break;
    }
    await pause("flagged item removed");
    removed.push(hit.title);
  }
  return removed;
}

async function clickMarked(page: Page): Promise<void> {
  const el = page.locator("[data-bot-ctl]").first();
  await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { });
  await shortPause();
  await el.click({ timeout: NAV_TIMEOUT_MS });
}

/** Picks one address for one row through its dropdown list, the way a person does. */
async function pickRowAddress(page: Page, row: number, want: string, label: string): Promise<boolean> {
  const dd = shownRows(page).nth(row);
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
async function selectMultipleAddresses(
  page: Page,
  targets: TargetAddress[],
  basket: BasketItem[],
  unblocked = false,
): Promise<CheckoutResult> {
  // Amazon can send checkout straight to the multi-address page itself (an
  // item's quantity changed under it, 2026-10-08): no picker to open then.
  if (/\/itemselect/.test(page.url())) {
    console.log("[bot] checkout is already on the multi-address page");
  } else if (await multiAddressChange(page)) {
    // Already delivering to several addresses (a rerun of this step): its
    // Change goes straight to the multi-address page.
    console.log("[bot] checkout already delivers to multiple addresses — reopening that page");
    await shortPause();
    await multiAddressChange(page).then((l) => l!.click({ timeout: NAV_TIMEOUT_MS }));
    await page.waitForURL(/itemselect/, { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  } else {
    const open = await openAddressPicker(page);
    if (!open.ok) return open;
    const multi = page.getByText("Deliver to multiple addresses", { exact: true }).filter({ visible: true }).first();
    // The URL flips to /address before the list finishes drawing; wait, don't peek.
    const shown = await multi.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
    if (!shown) return { ok: false, reason: "Multiple address button not found" };
    await shortPause();
    await multi.click({ timeout: NAV_TIMEOUT_MS });
    await page.waitForURL(/itemselect/, { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  }
  await page.locator(ITEMSELECT_ROW).first().waitFor({ timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("multi-address page open");
  await settleRows(page);

  // An item Amazon flags in red ("the quantity you requested is no longer
  // available", or anything else) is removed, whatever the message says.
  const flagged = await removeFlaggedItems(page);
  if (flagged.length) await settleRows(page);

  let read = await readBasketRows(page, basket);
  if (typeof read === "string") return { ok: false, reason: read };
  let rows = read;

  // The product page promised it; Amazon adds it only here. Say so by name.
  // Amazon decides the free items, not the sheet: one counted in the cart can
  // be missing (or fewer) here. Not a reason to stop — its shares are fitted
  // to what this page shows, below.
  const missingFree = basket.filter((b, i) => b.free && !rows.some((r) => r.item === i));
  if (missingFree.length) {
    console.log(`[bot] free item(s) not on the multi-address page, going without: ${missingFree.map((b) => b.title.slice(0, 40)).join(", ")}`);
  }

  // One change at a time, re-reading the page after each: picking an address
  // redraws the page and REORDERS the rows, so nothing is done by position.
  const wantKeys = targets.map(sheetAddressKey);
  // Remove blocks: what the cart holds now decides — an item gone (unavailable,
  // removed by hand) is dropped and a short one shrinks its shares, so the
  // page is never stepped back up to units the cart no longer has.
  const asked = basket.map((b) => b.shares!);
  const fitted = fitSharesToCart(asked, rows);
  // Free items always follow the page; everything else when an item was
  // removed for an error here, or with blocks removed.
  const shares = unblocked || flagged.length ? fitted : asked.map((share, i) => (basket[i]!.free ? fitted[i]! : share));
  if (flagged.length) console.log(`[bot] per-address units fitted to what is left: ${JSON.stringify(shares)}`);
  if (unblocked) console.log(`[bot] blocks removed — per-address units fitted to the cart: ${JSON.stringify(shares)}`);
  const sig = (r: ItemRow[]) => JSON.stringify(r);
  const totalUnits = shares.flat().reduce((n, q) => n + q, 0);
  // Every change redraws the page, so a half-drawn read can come after any of
  // them — not once per step: one look-again was spent on an early change and
  // a later one failed outright (2026-10-09).
  let rereads = 0;
  for (let guard = 0; guard < totalUnits * 2 + rows.length * 3 + 20; guard++) {
    const act = planRowAction(rows, wantKeys, shares);
    if (typeof act === "string" && rereads < 3) {
      // Most often the list was still drawing ("Updating your order"): look
      // again once it has settled before calling an item missing.
      rereads++;
      console.log(`[bot] ${act} — waiting for the page to settle and reading it again (${rereads}/3)`);
      await settleRows(page);
      const again = await readBasketRows(page, basket);
      if (typeof again === "string") return { ok: false, reason: again };
      rows = again;
      continue;
    }
    if (typeof act === "string") {
      console.log(`[bot] multi-address rows read: ${JSON.stringify(lastRawRows)}`);
      return { ok: false, reason: act };
    }
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
    // The page redraws after every change: read it only once the redraw is
    // over. A read under "Updating your order" saw no rows at all and failed
    // "item 1 is not on the multi-address page" mid-split (2026-10-09).
    let now: ItemRow[] | string = rows;
    // Give the redraw time to start before the first read.
    await pause("multi-address page updating");
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
      await sleep(600);
      await settleRows(page);
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
export async function runSelectAddresses(
  page: Page,
  targets: TargetAddress[],
  basket: BasketItem[],
  opts: { unblocked?: boolean } = {},
): Promise<CheckoutResult> {
  await pause("selecting delivery address");
  const at = await ensureAtCheckout(page);
  if (!at.ok) return at;
  // Remove blocks: the operator may have set the addresses by hand. Checkout
  // already delivering where the sheet says is left exactly as it is.
  if (opts.unblocked) {
    const shown = (await page.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => ""))
      .replace(/\s+/g, " ")
      .toLowerCase();
    const multi = shown.includes("delivering to multiple addresses");
    // "Delivering to suresh 1421", and not "suresh 14210".
    const name = `delivering to ${(targets[0]?.fullName ?? "").replace(/\s+/g, " ").trim().toLowerCase()}`;
    const pos = shown.indexOf(name);
    const single = targets.length === 1 && pos >= 0 && !/[a-z0-9]/.test(shown.charAt(pos + name.length));
    if ((targets.length > 1 && multi) || single) {
      console.log("[bot] blocks removed — checkout already delivers to the sheet's address(es); left as set");
      return { ok: true, detail: "addresses left as set by hand" };
    }
  }
  if (targets.length > 1) {
    // Shares are per address: dropping one would send its units nowhere.
    const bad = targets.find((t) => !t.pincode || !t.line1);
    if (bad) return { ok: false, reason: `address ${bad.fullName || "(no name)"} has no PIN or line 1` };
    return selectMultipleAddresses(page, targets, basket, opts.unblocked === true);
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

/** Set on the modal button dismissCheckoutModal picked, so Playwright clicks it for real. */
const MODAL_MARK = "data-fleet-modal-close";
/** Never pressed to close a popup: it would sign up, buy or pay. */
const MODAL_NEVER = /join|sign ?up|subscribe|start|try|buy|pay|place|order|upgrade|accept|yes/i;

/**
 * The Prime upsell ("Prime Shopping Edition at ₹399/year" — No Thanks / Join)
 * pops up over checkout. Its buttons carry data-class "a-button-popover"; the
 * first is No Thanks (user, 2026-10-08). It is a fixed-position a-popover, so
 * offsetParent is null for it — visibility is read from its box instead.
 * Pressed with a real Playwright click, then checked gone.
 */
async function closePopoverByButton(page: Page): Promise<string | null> {
  const hit = await page
    .evaluate(([mark, neverSrc]) => {
      const never = new RegExp(neverSrc, "i");
      const shown = (e: Element) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      };
      const squash = (s: string) => s.replace(/\s+/g, " ").trim();
      document.querySelectorAll(`[${mark}]`).forEach((e) => e.removeAttribute(mark));
      const modals = [...document.querySelectorAll('.a-popover, [role="dialog"], .a-modal-scroller')].filter(
        (m) => shown(m) && !m.closest("#navbar, #nav-main, header") && squash((m as HTMLElement).innerText ?? "").length > 0,
      );
      for (const m of modals) {
        const buttons = [
          ...m.querySelectorAll('[data-class~="a-button-popover"], [data-class*="a-button-popover"], .a-button-popover'),
        ].filter(shown);
        const text = (b: Element) =>
          squash((b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("aria-label") || "");
        // The first in the series, unless that one signs up / buys; else the
        // popover's own close (document.querySelectorAll('[data-action="a-popover-close"]')).
        const pick =
          buttons.find((b) => !never.test(text(b))) ??
          [...m.querySelectorAll('[data-action="a-popover-close"]')].find(shown) ??
          (m.closest(".a-popover")
            ? [...document.querySelectorAll(`[data-action="a-popover-close"]`)].find(
              (c) => shown(c) && m.closest(".a-popover")!.contains(c),
            )
            : undefined);
        if (!pick) continue;
        // On an a-button the transparent input on top takes the click.
        const target = pick.querySelector("input, button") ?? pick;
        target.setAttribute(mark, "1");
        return {
          label: squash((m as HTMLElement).innerText ?? "").slice(0, 60),
          button: text(pick) || "(no text)",
          all: buttons.map((b) => `${text(b) || "?"} [${b.getAttribute("data-class") ?? (b as HTMLElement).className}]`).join(" | "),
        };
      }
      return null;
    }, [MODAL_MARK, MODAL_NEVER.source] as const)
    .catch(() => null);
  if (!hit) return null;
  console.log(`[bot] checkout popup "${hit.label}" — pressing "${hit.button}" (buttons: ${hit.all})`);
  const target = page.locator(`[${MODAL_MARK}]`).first();
  await shortPause();
  const clicked = await target.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  if (!clicked) await target.dispatchEvent("click").catch(() => { });
  // Gone within a few seconds, or it did not take.
  for (const deadline = Date.now() + 4_000; Date.now() < deadline; ) {
    await sleep(400);
    if (!(await target.isVisible().catch(() => false))) return hit.label;
  }
  console.log(`[bot] checkout popup still showing after "${hit.button}"`);
  return null;
}

export async function dismissCheckoutModal(page: Page): Promise<void> {
  const quick = await closePopoverByButton(page);
  if (quick) {
    console.log(`[bot] dismissed checkout modal: "${quick}"`);
    await pause("modal dismissed");
    return;
  }
  const closed = await page
    .evaluate(() => {
      // Box-based: a fixed-position popover has a null offsetParent while showing.
      const modals = [...document.querySelectorAll('.a-popover, [role="dialog"], .a-modal-scroller')]
        .filter((m) => {
          const r = m.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(m).visibility !== "hidden";
        });
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
  '#placeOrder, #placeYourOrder, #placeYourOrder input, input[name="placeYourOrder1"], ' +
  "#submitOrderButtonId, #submitOrderButtonId input, #turbo-checkout-place-order-button";

async function whatCoversPlaceOrder(page: Page): Promise<string | null> {
  return page
    .evaluate((sel) => {
      // The ₹0 checkout's "Pay Now" may not carry the Place Order ids: its text finds it too.
      const shown = (e: Element) => e.getBoundingClientRect().width > 0;
      const btn = ([...document.querySelectorAll(sel)].find(shown) ??
        [...document.querySelectorAll('input[type="submit"], button, span.a-button-text, span.a-button-inner')].find(
          (e) => shown(e) && /^(pay now|place your order|place order)$/i.test(((e as HTMLElement).innerText || (e as HTMLInputElement).value || "").trim()),
        )) as HTMLElement | undefined;
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // Inside its own a-button (the transparent input on top) is not covered.
      const own = btn.closest(".a-button") ?? btn;
      if (!at || at === btn || btn.contains(at) || at.contains(btn) || own.contains(at)) return null;
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
    const cover = await clearOverPayNow(page);
    if (cover) return { ok: false, reason: `a popup is still over Pay Now: "${cover}"` };
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
  const cover = await clearOverPayNow(page);
  if (cover) return { ok: false, reason: `a popup is still over Place Order: "${cover}"` };
  return { ok: true, detail: `paid with the Amazon Pay balance (₹${balNum} for ₹${totalNum})` };
}

/**
 * select_payment only succeeds with Pay Now clear: a Prime upsell left over it
 * swallowed the next step's press (2026-10-08). Closes what covers it; the
 * label of whatever still does, else null.
 */
export async function clearOverPayNow(page: Page): Promise<string | null> {
  let cover = await whatCoversPlaceOrder(page);
  if (!cover) return null;
  console.log(`[bot] Pay Now is covered by "${cover}" — closing it`);
  await dismissCheckoutModal(page);
  cover = await whatCoversPlaceOrder(page);
  if (!cover) return null;
  await dismissBlockingOverlay(page);
  return whatCoversPlaceOrder(page);
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
            '#placeOrder, #placeYourOrder, input[name="placeYourOrder1"], #submitOrderButtonId, #bottomSubmitOrderButtonId, #turbo-checkout-place-order-button',
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
  /** Full names of the sheet addresses checkout still shipped to (the basket can shrink). */
  ship_to?: string[];
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

/**
 * Your Orders just before Pay Now could be pressed — taken by select_payment,
 * so a Pay Now pressed BY HAND while the run is parked still has a "before"
 * to count the new orders against. Written once per run: a later
 * select_payment (a resume) may already be past an order.
 */
function ordersBeforePath(artifactsDir: string): string {
  return join(artifactsDir, "orders-before.json");
}

export function readOrdersBefore(artifactsDir: string): string[] | null {
  try {
    const ids: unknown = JSON.parse(readFileSync(ordersBeforePath(artifactsDir), "utf8"));
    return Array.isArray(ids) ? (ids as string[]) : null;
  } catch {
    return null;
  }
}

export async function saveOrdersBefore(page: Page, artifactsDir: string): Promise<void> {
  if (existsSync(ordersBeforePath(artifactsDir)) || /thankyou/i.test(page.url())) return;
  const ids = await knownOrderIds(page);
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(ordersBeforePath(artifactsDir), JSON.stringify(ids), { mode: 0o600 });
  console.log(`[bot] Your Orders before Pay Now: ${ids.length} order(s) noted`);
}

/**
 * Your Orders as it was before this run's Pay Now: the ledger's (taken just
 * before the bot pressed), else select_payment's snapshot, else unknown.
 */
function ordersBefore(artifactsDir: string, idempotencyKey: string): string[] | null {
  return readLedger(artifactsDir).find((e) => e.key === idempotencyKey)?.known_orders ?? readOrdersBefore(artifactsDir);
}

export type FoundOrders = { ok: true; orders: OrderCard[]; shipping: TargetAddress[]; detail: string } | { ok: false; reason: string };

/**
 * The row's orders on Your Orders, by the sheet's address names (see
 * ordersByName), polled `attempts` times. In a side tab, so a checkout in the
 * main tab stays where it is.
 */
export async function lookUpOrders(
  page: Page,
  artifactsDir: string,
  idempotencyKey: string,
  targets: TargetAddress[],
  attempts = 1,
): Promise<FoundOrders> {
  const before = ordersBefore(artifactsDir, idempotencyKey);
  const tab = await page.context().newPage();
  await tab.bringToFront().catch(() => { });
  let last = "no order on Your Orders";
  try {
    for (let i = 1; i <= attempts; i++) {
      await tab.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await pause("reading Your Orders");
      const found = ordersByName(await readOrderCards(tab), targets, before);
      if (found.ok) {
        return { ...found, detail: found.orders.map((o) => `${o.id} -> ${o.shipTo}`).join(", ") };
      }
      last = found.reason;
      // A multi-address purchase can take a minute to list every order.
      if (i < attempts) await sleep(5000);
    }
    return { ok: false, reason: last };
  } finally {
    await tab.close().catch(() => { });
    await page.bringToFront().catch(() => { });
  }
}

/**
 * The orders found are this row's: each address row gets its order id(s),
 * the purchase is recorded on the master (opened here if the bot never
 * pressed Pay Now itself — placed by hand, or by an earlier attempt), and the
 * row is DONE.
 */
export async function recordOrders(
  page: Page,
  idempotencyKey: string,
  artifactsDir: string,
  targets: TargetAddress[],
  found: Extract<FoundOrders, { ok: true }>,
): Promise<CheckoutResult> {
  const jobId = process.env.JOB_ID ?? "";
  const runId = process.env.RUN_ID ?? "";
  if (!jobId || !runId) return { ok: false, reason: "a master-owned row is required to record the order" };
  const client = requireJobClient();
  const orderIds = found.orders.map((o) => o.id).join("\n");
  // One order (or more) per delivery address, one per line on its Address row.
  const perAddress = targets.flatMap((t) => {
    const ids = found.orders.filter((o) => shipsTo(o, t)).map((o) => o.id);
    return t.row !== undefined && ids.length ? [{ row_number: t.row, order_id: ids.join("\n") }] : [];
  });
  if (perAddress.length) await client.markAddressOrders(jobId, runId, perAddress);

  const ledger = readLedger(artifactsDir);
  let entry = ledger.find((e) => e.key === idempotencyKey);
  if (!entry?.token) {
    try {
      const intent = await client.beginPurchase(runId, jobId);
      entry = { key: idempotencyKey, order_id: null, placed_at: intent.attempted_at, token: intent.token, known_orders: ordersBefore(artifactsDir, idempotencyKey) ?? [] };
      ledger.push(entry);
    } catch (err) {
      console.log(`[bot] no purchase record opened for ${orderIds.replace(/\n/g, ", ")}: ${(err as Error).message}`);
    }
  }
  if (entry?.token && entry.order_id !== orderIds) {
    try {
      await client.completePurchase(runId, jobId, entry.token, orderIds, { orders: found.detail, basket: entry.basket ?? null });
      entry.order_id = orderIds;
    } catch (err) {
      console.log(`[bot] purchase record not completed: ${(err as Error).message}`);
    }
  }
  if (entry) writeLedger(artifactsDir, ledger);
  writeFileSync(join(artifactsDir, "order-id.txt"), orderIds, "utf8");
  await client.reportResult(jobId, { status: "DONE", order_id: orderIds, run_id: runId });
  return { ok: true, detail: `order id(s) ${found.detail}` };
}

/**
 * PAY NOW, BY ITS ID. The ₹0 checkout shows it twice (top and bottom); a
 * card checkout calls it Place Your Order. Ids first, its label second.
 */
const PAY_NOW_IDS = [
  "#placeOrder",
  'input[name="placeYourOrder1"]',
  "#submitOrderButtonId input",
  "#bottomSubmitOrderButtonId input",
  'input[aria-labelledby="submitOrderButtonId-announce"]',
  'input[aria-labelledby="bottomSubmitOrderButtonId-announce"]',
  "#placeYourOrder input",
  "#turbo-checkout-place-order-button",
];
const PAY_NOW_TEXT = /^(pay now|place your order|place order)$/i;
const PAY_NOW_MARK = "data-fleet-pay-now";

async function findPayNow(page: Page): Promise<Locator | null> {
  const byId = await firstVisible(page, PAY_NOW_IDS);
  if (byId) return byId;
  const marked = await page
    .evaluate(([src, mark]) => {
      const re = new RegExp(src, "i");
      document.querySelectorAll(`[${mark}]`).forEach((e) => e.removeAttribute(mark));
      const label = [...document.querySelectorAll("span.a-button-text, span, button, input[type='submit']")].find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && re.test(((e as HTMLElement).innerText || (e as HTMLInputElement).value || "").trim());
      });
      if (!label) return false;
      // On an a-button the transparent input on top is the control.
      const control = label.closest(".a-button")?.querySelector("input, button") ?? label;
      control.setAttribute(mark, "1");
      return true;
    }, [PAY_NOW_TEXT.source, PAY_NOW_MARK] as const)
    .catch(() => false);
  return marked ? page.locator(`[${PAY_NOW_MARK}]`).first() : null;
}

/**
 * One press of Pay Now. Popups first (the Prime upsell reappears at will);
 * then a real click. If a popup still intercepts it, close it and press the
 * button's own click(), which submits its form whatever lies on top — unless
 * the page already left checkout, so it is never pressed twice.
 */
export async function pressPayNow(page: Page): Promise<void> {
  await dismissCheckoutModal(page);
  const button = await findPayNow(page);
  if (!button) {
    console.log("[bot] Pay Now not found to press");
    return;
  }
  const what = await button
    .evaluate((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.getAttribute("name") ? `[name=${el.getAttribute("name")}]` : ""}`)
    .catch(() => "?");
  await button.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { });
  await shortPause();
  const clicked = await button.click({ timeout: 8_000 }).then(() => true).catch(() => false);
  if (!clicked) {
    const cover = await whatCoversPlaceOrder(page);
    console.log(`[bot] Pay Now (${what}) did not take a click${cover ? ` — covered by "${cover}"` : ""}`);
    await dismissCheckoutModal(page);
    if (/thankyou/i.test(page.url()) || !(await atCheckoutPipeline(page))) return;
    await button.evaluate((el) => (el as HTMLElement).click()).catch(() => { });
  }
  console.log(`[bot] pressed Pay Now (${what})${clicked ? "" : " directly"}`);
  await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("order submitted");
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

/**
 * PAY NOW. note_order_id has already looked on Your Orders by the sheet's
 * address names and found nothing, so this is the press.
 *
 * `unblocked` (Remove blocks): the operator aligned the checkout by hand.
 * The basket checks are logged, not obeyed; a press this run recorded before
 * that placed no order does not stop another; a review page still applying
 * its payment method is pressed anyway.
 */
export async function runPlaceOrder(
  page: Page,
  idempotencyKey: string,
  artifactsDir: string,
  addresses: TargetAddress[],
  opts: { unblocked?: boolean } = {},
): Promise<CheckoutResult> {
  const ledger = readLedger(artifactsDir);
  const prior = ledger.find((e) => e.key === idempotencyKey);
  // Never clicks twice. A resume after the click moves on: the order ids are
  // read next. Remove blocks presses again: Your Orders had nothing for it.
  if (prior && !opts.unblocked) {
    return { ok: true, detail: `already submitted at ${prior.placed_at}; order ids are read next` };
  }
  const basketFile = join(artifactsDir, "expected-basket.json");
  const basket = existsSync(basketFile) ? (JSON.parse(readFileSync(basketFile, "utf8")) as BasketItem[]) : [];
  const jobId = process.env.JOB_ID ?? "";
  const runId = process.env.RUN_ID ?? "";
  if (!jobId || !runId) return { ok: false, reason: "a master-owned row and purchase ledger are required to place an order" };

  // The thank-you page lives under /gp/buy/, so it passes for checkout. Pay
  // Now was pressed (by hand) and Your Orders does not list it yet.
  if (/thankyou/i.test(page.url())) {
    return { ok: false, reason: "on the thank-you page, but Your Orders has no order for the sheet's address names yet — run note_order_id again, or Mark completed" };
  }
  const atOrder = await ensureAtCheckout(page);
  if (!atOrder.ok) return atOrder;

  const ready = await waitForOrderReview(page);
  if (!ready) {
    const said = await readPageErrors(page);
    const why =
      (said.length > 0 ? `Amazon says: ${said.join(" | ")} — ` : "") +
      `checkout never finished applying the payment method (still showing ` +
      `"Setting your payment method...") at ${page.url().slice(0, 80)}`;
    if (!opts.unblocked) return { ok: false, reason: why };
    console.warn(`[bot] blocks removed — ${why}; pressing Pay Now anyway`);
  }

  await pause("reviewing order before placing");
  const total = await page
    .locator("#subtotals-marketplace-table, .grand-total-price, #orderTotal")
    .first()
    .innerText()
    .catch(() => "");
  console.log(`[bot] order total: ${total.replace(/\s+/g, " ").trim().slice(0, 80) || "unknown"}`);

  if (!(await findPayNow(page))) {
    return {
      ok: false,
      reason:
        `Pay Now / Place Your Order button not found at ${page.url()}. ` +
        `If this is the /pay page, the payment method still needs selecting first.`,
    };
  }

  // The review against the basket only reports now: it never stops Pay Now
  // (user, 2026-10-10 — it stopped a correct two-product order over a title
  // printed as "POND&#39;S"). What it found is logged for the operator.
  const review = basket.length
    ? reviewBasket(basket, addresses, await readReviewShipments(page))
    : ({ ok: false, error: "no basket from add_items to check against" } as const);
  if (!review.ok) {
    console.warn(`[bot] pre-purchase check (not stopping): ${review.error}`);
  } else if (review.changes.length) {
    console.log(`[bot] basket changed since add_items (allowed): ${review.changes.join("; ")}`);
  }
  const shipping = review.ok ? review.shipping : addresses;
  const known = await knownOrderIds(page);
  if (prior) {
    // Remove blocks, pressing again: the same purchase record, a fresh "before".
    prior.known_orders = known;
    prior.ship_to = shipping.map((t) => t.fullName);
  } else {
    const intent = await requireJobClient().beginPurchase(runId, jobId);
    ledger.push({
      key: idempotencyKey, order_id: null, placed_at: intent.attempted_at, token: intent.token, basket,
      known_orders: known, ship_to: shipping.map((t) => t.fullName),
    });
  }
  writeLedger(artifactsDir, ledger);

  if (!opts.unblocked && basket.length) {
    const final = reviewBasket(basket, addresses, await readReviewShipments(page));
    if (!final.ok) return { ok: false, reason: `purchase intent reserved but checkout changed: ${final.error}; reconcile before retrying` };
  }

  // The thank-you page is not read: note_order_id takes the ids from Your
  // Orders. All this waits for is checkout letting go of the order.
  // The thank-you page lives under /gp/buy/ too (/gp/buy/thankyou/...).
  const leftCheckout = (timeout: number): Promise<boolean> =>
    page
      .waitForURL((u) => /thankyou/i.test(u.toString()) || !/\/checkout\/p\/|\/gp\/buy\//.test(u.toString()), { timeout })
      .then(() => true)
      .catch(() => false);

  console.log("[bot] *** PLACING ORDER — irreversible ***");
  await pressPayNow(page);
  let left = await leftCheckout(30_000);
  if (!left && (await readPageErrors(page)).length === 0) {
    // Still on checkout, no error. Before pressing again, Your Orders: if the
    // press did go through, there is nothing to press.
    const placed = await lookUpOrders(page, artifactsDir, idempotencyKey, shipping, 1);
    if (placed.ok) {
      console.log(`[bot] still on checkout, but Your Orders has ${placed.detail} — not pressing again`);
      left = true;
    } else {
      console.log("[bot] still on checkout after Pay Now, no new order — closing any popup and pressing it again");
      await pressPayNow(page);
      left = await leftCheckout(60_000);
    }
  }
  if (!left) {
    const said = await readPageErrors(page);
    return {
      ok: false,
      reason:
        (said.length > 0 ? `Amazon says: ${said.join(" | ")} — ` : "") +
        `still at checkout after Pay Now. ` +
        `The attempt IS recorded — check Your Orders, then run note_order_id again (it takes any order it finds) or Mark completed.`,
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

/**
 * After Pay Now: the orders on Your Orders for the sheet's address names
 * (Your Orders can take a minute to list a multi-address purchase), recorded
 * and the row DONE. The basket may have shrunk: any address with an order is
 * enough; one without gets none.
 */
export async function runNoteOrderId(
  page: Page, idempotencyKey: string, artifactsDir: string, addresses: TargetAddress[],
): Promise<CheckoutResult> {
  const found = await lookUpOrders(page, artifactsDir, idempotencyKey, addresses, 8);
  if (!found.ok) return { ok: false, reason: `order outcome UNKNOWN: ${found.reason}; check Your Orders, then Mark completed` };
  return recordOrders(page, idempotencyKey, artifactsDir, addresses, found);
}
