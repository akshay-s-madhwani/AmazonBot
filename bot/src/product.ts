import type { ProductSpec } from "./config.js";
import { pause, shortPause } from "./human.js";
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

async function readBuyBox(page: Page): Promise<BuyBox> {
  return page.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    const clean = (t: string | null | undefined) =>
      (t ?? "").trim().replace(/\s+/g, " ");

    const rows = [...document.querySelectorAll("[data-a-accordion-row-name]")].map((el) => ({
      id: el.id,
      name: el.getAttribute("data-a-accordion-row-name") ?? "",
      active: el.classList.contains("a-accordion-active"),
      label: clean((el as HTMLElement).innerText).slice(0, 60),
    }));

    const couponBox = q("#promoPriceBlockMessage_feature_div");
    const couponInput = couponBox?.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement | null;

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
      hasCoupon: !!couponInput,
      couponChecked: couponInput?.checked ?? false,
      // "5% off coupon applied" (span#done<id>), shown once Amazon took it.
      couponApplied: [...(couponBox?.querySelectorAll('[id^="done"]') ?? [])].some(
        (e) => (e as HTMLElement).getClientRects().length > 0 && /applied/i.test((e as HTMLElement).innerText),
      ),
      couponLabel: clean((couponBox as HTMLElement | null)?.innerText).slice(0, 80),
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

async function selectRow(page: Page, rowId: string): Promise<boolean> {
  const header = page.locator(`#${rowId} .a-accordion-row`).first();
  if ((await header.count()) === 0) return false;
  await header.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { });
  await shortPause();
  await header.dispatchEvent("click");
  await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  await pause("purchase option selected");
  const after = await readBuyBox(page);
  return after.rows.some((r) => r.id === rowId && r.active);
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
  console.log(`[bot] coupon found: ${box.couponLabel}`);
  // The real checkbox is invisible (opacity 0) under a drawn white box; a
  // scripted click on it did not reach Amazon's handler (B078T4KPBQ,
  // 2026-10-08). Click the visible box the way a person does.
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
  await pause("coupon toggled");

  if (/\/ap\/signin/.test(page.url())) {
    return { ok: false, reason: "applying the coupon asked to sign in again" };
  }
  const after = await readBuyBox(page);
  if (!after.couponChecked && !after.couponApplied) {
    return { ok: false, reason: `coupon did not apply (${box.couponLabel})` };
  }
  return { ok: true, detail: `coupon applied: ${box.couponLabel}` };
}
