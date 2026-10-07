import type { Page } from "./pw.js";
import type { ProductSpec, TargetAddress } from "./config.js";
import { PRODUCT_TITLE } from "./product.js";
import { checkoutAddressKey, sheetAddressKey } from "./address.js";

export interface BasketItem {
  sku: string;
  /** Units over every address. */
  quantity: number;
  title: string;
  /** Multi-address: units per delivery address, in address order. Absent = an even split. */
  shares?: number[];
}
export interface CheckoutEvidence { items: BasketItem[]; address: string }
export interface OrderEvidence { id: string; placedAt: string | null; items: BasketItem[]; cancelled: boolean }
const normalized = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

export function basketError(expected: BasketItem[], actual: BasketItem[]): string | null {
  if (!expected.length || expected.some(i => !i.sku || !i.title || !Number.isInteger(i.quantity) || i.quantity < 1)) return "expected basket identity is incomplete";
  const totals = (items: BasketItem[]) => {
    const map = new Map<string, number>();
    for (const i of items) map.set(i.sku.toUpperCase(), (map.get(i.sku.toUpperCase()) ?? 0) + i.quantity);
    return map;
  };
  const want = totals(expected), got = totals(actual);
  if (actual.some(i => !i.sku || !Number.isInteger(i.quantity) || i.quantity < 1) || want.size !== got.size ||
      [...want].some(([sku, qty]) => got.get(sku) !== qty)) return "checkout SKUs or quantities do not match the requested basket";
  return null;
}

export function checkoutError(expected: BasketItem[], address: TargetAddress, seen: CheckoutEvidence): string | null {
  const error = basketError(expected, seen.items);
  if (error) return error;
  const words = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const contains = (value: string) => (` ${words(seen.address)} `).includes(` ${words(value)} `);
  if (!address.pincode || !address.line1 || !contains(address.pincode) ||
      !contains(address.line1)) return "checkout delivery PIN or address line does not match";
  return null;
}

export function matchingOrder(orders: OrderEvidence[], expected: BasketItem[], attemptedAt: string): OrderEvidence | null {
  const start = Date.parse(attemptedAt);
  if (!Number.isFinite(start)) return null;
  const matches = orders.filter(o => {
    const placed = o.placedAt ? Date.parse(o.placedAt) : NaN;
    return !o.cancelled && Number.isFinite(placed) && placed >= start && placed <= Date.now() + 60_000 &&
      basketError(expected, o.items) === null &&
      normalized(o.items[0]?.title ?? "") === normalized(expected[0]?.title ?? "");
  });
  return matches.length === 1 ? matches[0]! : null;
}

export async function productIdentity(page: Page, item: ProductSpec): Promise<BasketItem> {
  const sku = new URL(page.url()).pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1] ?? "";
  const title = (await page.locator(PRODUCT_TITLE).first().innerText()).trim();
  if (!sku || !title) throw new Error("cannot identify the product SKU and title; refusing to build an unverified basket");
  return { sku: sku.toUpperCase(), title, quantity: item.quantity };
}

export async function readCheckoutEvidence(page: Page): Promise<CheckoutEvidence> {
  return page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
    const rows = [...document.querySelectorAll('[data-asin]')].filter(e => visible(e) &&
      !e.parentElement?.closest('[data-asin]'));
    const items = rows.map(e => {
      const qty = e.querySelector('select[name*="quantity" i], input[name*="quantity" i]') as HTMLInputElement | null;
      const text = (e as HTMLElement).innerText;
      return { sku: e.getAttribute('data-asin') ?? '',
        quantity: Number(qty?.value ?? text.match(/(?:qty|quantity)\s*:?\s*(\d+)/i)?.[1] ?? NaN),
        title: (e.querySelector('.item-title, .a-text-bold, a[href*="/dp/"]')?.textContent ?? '').trim() };
    });
    const address = [...document.querySelectorAll('#shipping-address, #delivery-address, .shipping-address, [data-testid="shipping-address"]')]
      .filter(visible).map(e => (e as HTMLElement).innerText).join(' ');
    return { items, address };
  });
}

export async function readOrderEvidence(page: Page): Promise<OrderEvidence[]> {
  return page.evaluate(() => [...document.querySelectorAll('.order-card, .js-order-card')].map(card => {
    const text = (card as HTMLElement).innerText;
    const stamp = card.querySelector('time[datetime], [data-order-date]');
    const raw = stamp?.getAttribute('datetime') ?? stamp?.getAttribute('data-order-date') ?? '';
    const placedAt = /T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : null;
    const items = [...card.querySelectorAll('[data-asin]')].filter(e => !e.parentElement?.closest('[data-asin]')).map(e => ({
      sku: e.getAttribute('data-asin') ?? '',
      quantity: Number((e as HTMLElement).innerText.match(/(?:qty|quantity)\s*:?\s*(\d+)/i)?.[1] ?? NaN),
      title: (e.querySelector('.item-title, a[href*="/dp/"]')?.textContent ?? '').trim(),
    }));
    return { id: text.match(/\b\d{3}-\d{7}-\d{7}\b/)?.[0] ?? '', placedAt, items, cancelled: /cancell?ed/i.test(text) };
  }).filter(o => o.id !== ''));
}

/**
 * THE REVIEW PAGE (/checkout/p/.../spc), verified 2026-10-02: one block per
 * address — "Delivering to <name>", the address line, then its items, each
 * followed by "Change quantity of <title>" and the quantity. A multi-address
 * order also has a summary "Delivering to multiple addresses", skipped. One
 * address can span several blocks (different delivery dates).
 */
export interface Shipment { key: string | null; name: string; items: Array<{ title: string; quantity: number }> }

export async function readReviewShipments(page: Page): Promise<Shipment[]> {
  const raw = await page.evaluate(() => {
    const lines = document.body.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    const out: Array<{ name: string; address: string; items: Array<{ title: string; quantity: number }> }> = [];
    let cur: (typeof out)[number] | null = null;
    for (let i = 0; i < lines.length; i++) {
      const to = lines[i]!.match(/^Delivering to (.+)$/i);
      if (to && !/^multiple addresses/i.test(to[1]!)) {
        cur = { name: to[1]!.trim(), address: lines[i + 1] ?? "", items: [] };
        out.push(cur);
        continue;
      }
      const qty = lines[i]!.match(/^Change quantity of (.+)$/i);
      if (qty && cur) {
        const title = qty[1]!.replace(/&amp;(?:amp;)*/g, "&").trim();
        cur.items.push({ title, quantity: Number(lines[i + 1] ?? NaN) });
      }
    }
    return out;
  });
  return raw.map((s) => ({ key: checkoutAddressKey(`${s.name} ${s.address}`), name: s.name, items: s.items }));
}

const sameTitle = (a: string, b: string) => normalized(a).slice(0, 40) === normalized(b).slice(0, 40);

/**
 * Before buying: every sheet address gets each basket item at its share (the
 * item's `shares`, else an even split of the quantity), and nothing ships
 * anywhere else.
 */
export function reviewError(expected: BasketItem[], targets: TargetAddress[], shipments: Shipment[]): string | null {
  if (!expected.length || expected.some((i) => !i.title || !Number.isInteger(i.quantity) || i.quantity < 1)) {
    return "expected basket identity is incomplete";
  }
  if (!targets.length) return "no delivery address to check against";
  if (!shipments.length) return "the review page shows no delivery address";
  const want = new Map(targets.map((t) => [sheetAddressKey(t), t]));
  const stray = shipments.find((s) => !s.key || !want.has(s.key));
  if (stray) return `checkout ships to an address that is not in the sheet: ${stray.name}`;
  for (const [a, t] of targets.entries()) {
    const key = sheetAddressKey(t);
    const here = shipments.filter((s) => s.key === key).flatMap((s) => s.items);
    if (!here.length) return `nothing ships to ${t.fullName}`;
    const extra = here.find((it) => !expected.some((e) => sameTitle(e.title, it.title)));
    if (extra) return `${t.fullName} gets an item that was not requested: ${extra.title.slice(0, 50)}`;
    for (const e of expected) {
      let per: number;
      if (e.shares) {
        if (e.shares.length !== targets.length) return "expected basket does not match the delivery addresses";
        per = e.shares[a]!;
      } else {
        if (e.quantity % targets.length !== 0) return `${e.title.slice(0, 40)}: quantity ${e.quantity} does not split over ${targets.length} addresses`;
        per = e.quantity / targets.length;
      }
      const got = here.filter((it) => sameTitle(e.title, it.title)).reduce((n, it) => n + it.quantity, 0);
      if (got !== per) return `${t.fullName}: ${e.title.slice(0, 40)} x${got}, expected x${per}`;
    }
  }
  return null;
}

/** One card on Your Orders: its id, who it ships to and its item titles. */
export interface OrderCard { id: string; shipTo: string; titles: string[]; cancelled: boolean }

export async function readOrderCards(page: Page): Promise<OrderCard[]> {
  return page.evaluate(() => [...document.querySelectorAll(".order-card, .js-order-card")].map((card) => {
    const text = (card as HTMLElement).innerText;
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => /^ship to$/i.test(l));
    return {
      id: text.match(/\b\d{3}-\d{7}-\d{7}\b/)?.[0] ?? "",
      shipTo: at >= 0 ? lines[at + 1] ?? "" : "",
      titles: [...card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')]
        .map((a) => (a as HTMLElement).innerText.trim()).filter(Boolean),
      cancelled: /\bcancelled\b/i.test(text),
    };
  }).filter((c) => c.id));
}

/**
 * Does this Your Orders card ship to this address? By Ship to name: exact, so
 * "suresh 1" is not "suresh 10"; a prefix only when Amazon cut the name with "…".
 */
export function shipsTo(c: Pick<OrderCard, "shipTo">, t: Pick<TargetAddress, "fullName">): boolean {
  const nameOf = (v: string) => normalized(v.replace(/\.{3}|…/g, ""));
  const ship = nameOf(c.shipTo);
  if (!ship) return false;
  return /\.{3}|…/.test(c.shipTo) ? nameOf(t.fullName).startsWith(ship) : nameOf(t.fullName) === ship;
}

/**
 * The orders this purchase made: the ones on Your Orders that were not there
 * just before it was placed. Each must ship to a sheet address, and every
 * sheet address must have one (Amazon makes one order per address, sometimes
 * more). Needs no timestamps — Your Orders cards carry none.
 */
export function newOrdersFor(
  cards: OrderCard[],
  knownIds: string[],
  targets: TargetAddress[],
): { ok: true; orders: OrderCard[] } | { ok: false; reason: string } {
  const known = new Set(knownIds);
  const fresh = cards.filter((c) => !known.has(c.id) && !c.cancelled);
  if (!fresh.length) return { ok: false, reason: "no new order on Your Orders" };
  const stray = fresh.find((c) => !targets.some((t) => shipsTo(c, t)));
  if (stray) return { ok: false, reason: `new order ${stray.id} ships to "${stray.shipTo}", not a sheet address` };
  const missing = targets.filter((t) => !fresh.some((c) => shipsTo(c, t)));
  if (missing.length) return { ok: false, reason: `no new order for ${missing.map((t) => t.fullName).join(", ")}` };
  return { ok: true, orders: fresh };
}
