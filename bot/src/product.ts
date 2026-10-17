import type { ProductSpec } from "./config.js";
import { pause, shortPause, sleep } from "./human.js";
import type { Page } from "./pw.js";


const NAV_TIMEOUT_MS = 30_000;

/**
 * The visible product title. Some pages also carry a hidden
 * <input id="productTitle">, so a bare #productTitle matches twice and
 * Playwright's strict mode throws.
 */
export const PRODUCT_TITLE = "#productTitle:not(input)";

export type PurchaseOption = "auto" | "one_time" | "subscribe_save" | "fresh";

export type ProductResult = { ok: true; detail: string } | { ok: false; reason: string };

interface BuyBox {
  title: string | null;
  asin: string | null;
  inStock: boolean;
  explicitlyOutOfStock: boolean;
  availability: string;
  rows: Array<{ id: string; name: string; active: boolean; label: string }>;
  /** How the page offers its coupon (see readCouponInPage); null = no control to press. */
  couponKind: "checkbox" | "card" | "button" | null;
  hasCoupon: boolean;
  couponChecked: boolean;
  couponApplied: boolean;
  couponLabel: string;
  hasBuyNow: boolean;
  hasAddToCart: boolean;
  quantityValue: string | null;
  price: number | null;
  priceText: string;
}

/** Set on the coupon control readCoupon picked, so it is clicked without a second search. */
const COUPON_MARK = "data-fleet-coupon";

/**
 * The product page's coupon, whichever way Amazon draws it:
 *   checkbox  "Apply 5% coupon" tick box in #promoPriceBlockMessage_feature_div
 *   card      "Coupon Discount · Save 5% now · [Apply Coupon]" (#couponsCard_feature_div,
 *             seen on B078T4KPBQ 2026-10-08); turns "Coupon Applied · ₹4.50 discount."
 *   button    anything else on the buy area reading "Apply … coupon"
 * Runs in the page (passed to evaluate), so it is self-contained. Marks the
 * control to press with COUPON_MARK.
 */
function readCouponInPage(mark: string): {
  kind: "checkbox" | "card" | "button" | null;
  checked: boolean;
  applied: boolean;
  label: string;
} {
  const clean = (t: string | null | undefined) => (t ?? "").trim().replace(/\s+/g, " ");
  const shown = (e: Element | null): e is HTMLElement =>
    !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && !e.closest(".aok-hidden");
  document.querySelectorAll(`[${mark}]`).forEach((e) => e.removeAttribute(mark));

  // The old tick box. "5% off coupon applied" (span#done<id>) once Amazon took it.
  const promo = document.querySelector("#promoPriceBlockMessage_feature_div");
  const box = promo?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  if (box) {
    const applied = [...promo!.querySelectorAll('[id^="done"]')].some(
      (e) => shown(e) && /applied/i.test((e as HTMLElement).innerText),
    );
    return { kind: "checkbox", checked: box.checked, applied, label: clean((promo as HTMLElement).innerText).slice(0, 80) };
  }

  // The coupon card: ids repeat when Amazon renders it twice (centre column
  // and buy box), so every copy is looked at and the visible one used.
  const cards = [...document.querySelectorAll('[id="coupons-card-feature"]')].filter(shown);
  const after = [...document.querySelectorAll('[id="coupons-card-heading-after-apply"]')].filter(shown);
  const clipped = !!document.querySelector('[data-couponclippedstatus="true"]');
  if (after.length > 0 || clipped) {
    const card = (after[0]?.closest('[id="coupons-card-feature"]') ?? cards[0]) as HTMLElement | undefined;
    return { kind: "card", checked: false, applied: true, label: clean(card?.innerText).slice(0, 80) };
  }
  const cardButton = [...document.querySelectorAll('[id="coupons-card-apply-button"]')].find(shown);
  if (cardButton) {
    cardButton.setAttribute(mark, "1");
    const card = (cardButton.closest('[id="coupons-card-feature"]') ?? cardButton) as HTMLElement;
    return { kind: "card", checked: false, applied: false, label: clean(card.innerText).slice(0, 80) };
  }

  // Any other "Apply coupon" control on the product's own area (not the
  // carousels, not a closed quick-view popover).
  const area = document.querySelectorAll("#centerCol, #rightCol, #desktop_buybox, #ppd");
  for (const root of area) {
    for (const el of root.querySelectorAll('button, input[type="submit"], input[type="button"], .a-button, label, a')) {
      const text = clean((el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label"));
      if (!/^apply\b.{0,20}\bcoupons?$/i.test(text) || !shown(el)) continue;
      el.setAttribute(mark, "1");
      const holder = (el.closest(".a-section") ?? el) as HTMLElement;
      return { kind: "button", checked: false, applied: false, label: clean(holder.innerText).slice(0, 80) };
    }
  }
  // Applied, with no control left to press.
  const appliedText = [...document.querySelectorAll("#centerCol *, #rightCol *")].some(
    (e) => e.children.length === 0 && /^coupon applied$/i.test(clean((e as HTMLElement).innerText)) && shown(e),
  );
  return { kind: null, checked: false, applied: appliedText, label: appliedText ? "Coupon Applied" : "" };
}

async function readBuyBox(page: Page): Promise<BuyBox> {
  const coupon = await page
    .evaluate(readCouponInPage, COUPON_MARK)
    .catch(() => ({ kind: null, checked: false, applied: false, label: "" }));
  const box = await page.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    const clean = (t: string | null | undefined) =>
      (t ?? "").trim().replace(/\s+/g, " ");

    const rows = [...document.querySelectorAll("[data-a-accordion-row-name]")].map((el) => ({
      id: el.id,
      name: el.getAttribute("data-a-accordion-row-name") ?? "",
      active: el.classList.contains("a-accordion-active"),
      label: clean((el as HTMLElement).innerText).slice(0, 60),
    }));

    const availability = clean((q("#availability") as HTMLElement | null)?.innerText).slice(0, 80);
    const outOfStock =
      /currently unavailable|out of stock|we don'?t know when or if this item will be back/i.test(
        availability || document.body.innerText.slice(0, 6000),
      );
    const qty = q("#quantity") as HTMLSelectElement | null;

    return {
      // Keep in sync with PRODUCT_TITLE (this runs in the page, not in Node).
      title: clean((q("#productTitle:not(input)") as HTMLElement | null)?.innerText) || null,
      asin:
        (q("#ASIN") as HTMLInputElement | null)?.value ||
        (location.pathname.match(/\/dp\/([A-Z0-9]{10})/) || [])[1] ||
        null,
      inStock: !outOfStock && (/in stock|only \d+ left|available/i.test(availability) || !!q("#add-to-cart-button") || !!q("#buy-now-button")),
      explicitlyOutOfStock: outOfStock,
      availability,
      rows,
      hasBuyNow: !!q("#buy-now-button"),
      hasAddToCart: !!q("#add-to-cart-button"),
      quantityValue: qty ? qty.value : null,
      price: (() => {
        const raw =
          (q(".a-price .a-offscreen") as HTMLElement | null)?.textContent ??
          (q("#corePrice_feature_div .a-offscreen") as HTMLElement | null)?.textContent ??
          "";
        const m = raw.replace(/[,\s]/g, "").match(/([\d.]+)/);
        return m ? Number(m[1]) : null;
      })(),
      priceText: clean(
        (q(".a-price .a-offscreen") as HTMLElement | null)?.textContent ??
        (q("#corePrice_feature_div") as HTMLElement | null)?.innerText,
      ).slice(0, 40),
    };
  });
  return {
    ...box,
    couponKind: coupon.kind,
    hasCoupon: coupon.kind !== null || coupon.applied,
    couponChecked: coupon.checked,
    couponApplied: coupon.applied,
    couponLabel: coupon.label,
  };
}

function chooseRow(box: BuyBox, pref: PurchaseOption): { id: string; why: string } | null {
  const byName = (n: string) => box.rows.find((r) => r.name === n);
  const sns = byName("snsAccordionRowMiddle");
  const fresh = byName("almAccordionRow");
  const oneTime = box.rows.find((r) => r.name === "newAccordionRow");

  if (pref === "subscribe_save") {
    return sns ? { id: sns.id, why: "Subscribe & Save (requested)" } : null;
  }
  if (pref === "fresh") {
    return fresh ? { id: fresh.id, why: "Amazon Fresh (requested)" } : null;
  }
  if (pref === "one_time") {
    return oneTime ? { id: oneTime.id, why: "One-time purchase (requested)" } : null;
  }
  if (sns) return { id: sns.id, why: "Subscribe & Save (auto)" };

  return null;
}

/**
 * Opens one buy-box row (One-time purchase, Subscribe & Save…) and waits for
 * it to be the active one. Checked by the row's NAME, polled: signed in,
 * Amazon redraws the buy box after the click, and a single read 0.4s later
 * (BOT_PACE 0.3) found it not yet active — "could not select purchase
 * option" on every one_time row (2026-10-10). A click that never took is
 * pressed once more as a real click.
 */
async function selectRow(page: Page, rowId: string): Promise<boolean> {
  const name = (await readBuyBox(page)).rows.find((r) => r.id === rowId)?.name ?? "";
  const isActive = async (): Promise<boolean> =>
    (await readBuyBox(page)).rows.some((r) => (name ? r.name === name : r.id === rowId) && r.active);
  for (let attempt = 1; attempt <= 2; attempt++) {
    // By name again: a redraw can renumber the row (newAccordionRow_0).
    const target = name ? `[data-a-accordion-row-name="${name}"]` : `#${rowId}`;
    const header = page.locator(`${target} .a-accordion-row`).filter({ visible: true }).first();
    if ((await header.count()) === 0) return false;
    await header.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { });
    await shortPause();
    if (attempt === 1) await header.dispatchEvent("click");
    else await header.click({ timeout: 10_000 }).catch(() => header.dispatchEvent("click"));
    await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
    await pause("purchase option selected");
    for (const deadline = Date.now() + 12_000; Date.now() < deadline; ) {
      if (await isActive()) return true;
      await sleep(1000);
    }
    console.log(`[bot] purchase option "${name || rowId}" not active yet — pressing it again`);
  }
  return isActive();
}

export async function runOpenProduct(page: Page, spec: ProductSpec): Promise<ProductResult> {
  await pause("starting product step");
  await page.goto(spec.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.locator(PRODUCT_TITLE).first().waitFor({ timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("product page loaded");

  let box = await readBuyBox(page);
  if (!box.title) {
    return { ok: false, reason: `not a product page: ${page.url()}` };
  }
  console.log(`[bot] product: ${box.title.slice(0, 70)} (${box.asin})`);
  console.log(
    `[bot] buy-box rows: ${box.rows.length ? box.rows.map((r) => `${r.name}${r.active ? "*" : ""}`).join(", ") : "none"}`,
  );
  if (box.explicitlyOutOfStock) {
    return { ok: false, reason: `out of stock: "${box.availability || "Amazon says unavailable"}"` };
  }
  if (!box.inStock) {
    return {
      ok: false,
      reason: `no buy control and no stock indication (availability: "${box.availability || "(blank)"}")`,
    };
  }

  const target = chooseRow(box, spec.purchaseOption);
  if (target) {
    const already = box.rows.find((r) => r.id === target.id)?.active;
    if (already) {
      console.log(`[bot] ${target.why} already selected`);
    } else {
      console.log(`[bot] selecting ${target.why}`);
      if (!(await selectRow(page, target.id))) {
        return { ok: false, reason: `could not select purchase option "${target.why}"` };
      }
      box = await readBuyBox(page);
    }
  } else if (spec.purchaseOption !== "auto") {
    return {
      ok: false,
      reason: `requested purchase option "${spec.purchaseOption}" is not offered on this product`,
    };
  }

  if (!box.hasBuyNow && !box.hasAddToCart) {
    return { ok: false, reason: "no Buy Now / Add to Cart button on the buy box" };
  }

  if (spec.expectedPrice !== undefined) {
    // The Items row's `buffer`, else ₹5 (PRICE_TOLERANCE overrides the default).
    const tolerance = spec.priceBuffer ?? Number(process.env.PRICE_TOLERANCE ?? "5");
    if (box.price === null) {
      return {
        ok: false,
        reason:
          `price mismatch: expected price ₹${spec.expectedPrice} but the live price could not be read ` +
          `(shown as "${box.priceText || "nothing"}")`,
      };
    }
    const diff = Math.abs(box.price - spec.expectedPrice);
    if (diff > tolerance) {
      return {
        ok: false,
        reason:
          `price mismatch: expected ₹${spec.expectedPrice}, live price is ₹${box.price} ` +
          `(difference ₹${diff.toFixed(2)}, tolerance ₹${tolerance})`,
      };
    }
    console.log(`[bot] price ok: ₹${box.price} matches expected ₹${spec.expectedPrice}`);
  }
  const active = box.rows.find((r) => r.active);
  return {
    ok: true,
    detail: `${box.asin} ready (${active ? active.name : "standard buy box"})`,
  };
}

export async function runSetQuantity(page: Page, spec: ProductSpec): Promise<ProductResult> {
  if (spec.quantity <= 1) return { ok: true, detail: "quantity 1" };
  await pause("setting quantity");

  const select = page.locator("#quantity");
  if ((await select.count()) === 0) {
    return { ok: false, reason: "quantity selector not present on this listing" };
  }

  const available = await page.evaluate(
    () =>
      [...((document.querySelector("#quantity") as HTMLSelectElement | null)?.options ?? [])].map(
        (o) => o.value,
      ),
  );
  const want = String(spec.quantity);
  if (!available.includes(want)) {
    const max = available[available.length - 1] ?? "?";
    console.warn(
      `[bot] QUANTITY UNAVAILABLE: wanted ${want}, this listing offers ${available.join("/") || "none"} (max ${max}).\n` +
      `[bot] Not ordering a different quantity. Set PRODUCT_QUANTITY in bot/.env, then resume — ` +
      `the run continues from THIS step with the new value.`,
    );
    return {
      ok: false,
      reason: `quantity ${want} not offered on this listing (max ${max}) — set PRODUCT_QUANTITY and resume`,
    };
  }

  let ok = await select
    .selectOption(want, { timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    ok = await page.evaluate((v) => {
      const el = document.querySelector("#quantity") as HTMLSelectElement | null;
      if (!el) return false;
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, want);
  }
  await pause("quantity applied");

  const box = await readBuyBox(page);
  if (box.quantityValue !== want) {
    return { ok: false, reason: `quantity did not stick (wanted ${want}, got ${box.quantityValue})` };
  }
  return { ok: true, detail: `quantity ${want}` };
}

export async function runApplyCoupon(page: Page): Promise<ProductResult> {
  const box = await readBuyBox(page);
  if (!box.hasCoupon) {
    console.log("[bot] no coupon on this listing — skipping");
    return { ok: true, detail: "no coupon offered" };
  }
  if (box.couponChecked || box.couponApplied) {
    return { ok: true, detail: "coupon already applied" };
  }

  await pause("applying coupon");
  console.log(`[bot] coupon found (${box.couponKind}): ${box.couponLabel}`);
  await pressCoupon(page, box.couponKind);

  // The card applies over ajax (POST /promotion/redeem/): give it a moment.
  let after = box;
  for (const deadline = Date.now() + 12_000; Date.now() < deadline; ) {
    await sleep(1000);
    if (/\/ap\/signin/.test(page.url())) {
      return { ok: false, reason: "applying the coupon asked to sign in again" };
    }
    after = await readBuyBox(page);
    if (after.couponChecked || after.couponApplied) break;
  }
  await pause("coupon toggled");
  if (!after.couponChecked && !after.couponApplied) {
    return { ok: false, reason: `coupon did not apply (${box.couponLabel})` };
  }
  console.log(`[bot] coupon applied: ${after.couponLabel || box.couponLabel}`);
  return { ok: true, detail: `coupon applied: ${after.couponLabel || box.couponLabel}` };
}

/** Clicks the coupon control readBuyBox found, the way a person does. */
async function pressCoupon(page: Page, kind: BuyBox["couponKind"]): Promise<void> {
  if (kind === "checkbox") {
    // The real checkbox is invisible (opacity 0) under a drawn white box; a
    // scripted click on it did not reach Amazon's handler (B078T4KPBQ,
    // 2026-10-08). Click the visible box.
    const visibleBox = page
      .locator('#promoPriceBlockMessage_feature_div label:has(input[type="checkbox"]) i.a-icon-checkbox')
      .first();
    const target = (await visibleBox.isVisible().catch(() => false))
      ? visibleBox
      : page.locator('#promoPriceBlockMessage_feature_div label:has(input[type="checkbox"])').first();
    await target.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { });
    await shortPause();
    const clicked = await target.click({ timeout: 10_000 }).then(() => true).catch(() => false);
    if (!clicked) {
      await page.locator('#promoPriceBlockMessage_feature_div input[type="checkbox"]').first()
        .click({ force: true, timeout: 10_000 }).catch(() => { });
    }
    return;
  }
  // The "Apply Coupon" button readBuyBox marked. On an a-button the
  // transparent input on top takes the click.
  const button = page.locator(`[${COUPON_MARK}]`).first();
  const input = button.locator("input.a-button-input");
  const target = (await input.count().catch(() => 0)) > 0 ? input.first() : button;
  await target.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { });
  await shortPause();
  const clicked = await target.click({ timeout: 10_000 }).then(() => true).catch(() => false);
  if (!clicked) await button.click({ force: true, timeout: 10_000 }).catch(() => { });
}
