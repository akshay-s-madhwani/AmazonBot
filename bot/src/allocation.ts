import type { ProductSpec, TargetAddress } from "./config.js";

/**
 * WHO GETS WHAT. Every item goes into the cart at its Items-tab quantity, set
 * on the product page. One address takes it all. Several: each Address row's
 * ItemsQuantity cell lists what that address receives, "item_id_quantity" per
 * line ("1_3\n2_2" = 3 of item 1 and 2 of item 2), and for every item the
 * addresses must add up to exactly its Items quantity (5 = 3 + 1 + 1, any
 * split) — checked before anything goes into the cart. The multi-address page
 * then spreads each item's units over the addresses.
 */
export interface Allocation {
  multi: boolean;
  /** shares[i][a]: units of products[i] that go to addresses[a]. */
  shares: number[][];
  /** Units of each product over every address. */
  totals: number[];
}

/** "1_3\n2_2" -> [{1,3},{2,2}]; a string is the line that did not read. */
export function parseItemsQuantity(raw: string): Array<{ itemId: string; quantity: number }> | string {
  const out: Array<{ itemId: string; quantity: number }> = [];
  for (const line of raw.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean)) {
    // The last "_" splits, so an item_id may itself contain one (or a dash).
    const m = line.match(/^(.+?)\s*_\s*(\d+)$/);
    const quantity = Number(m?.[2]);
    if (!m || !Number.isInteger(quantity) || quantity < 1) return `bad line "${line}"`;
    out.push({ itemId: m[1]!.trim(), quantity });
  }
  return out;
}

/** The plan for this account, or why it has none (a sheet problem, not a page one). */
export function allocate(products: ProductSpec[], addresses: TargetAddress[]): Allocation | string {
  if (addresses.length <= 1) {
    return { multi: false, shares: products.map((p) => [p.quantity]), totals: products.map((p) => p.quantity) };
  }
  const byId = new Map<string, number>();
  for (const [i, p] of products.entries()) {
    const id = (p.itemId ?? "").trim();
    if (!id) continue;
    if (byId.has(id)) return `item_id ${id} is on two Items rows`;
    byId.set(id, i);
  }
  const shares = products.map(() => addresses.map(() => 0));
  for (const [a, t] of addresses.entries()) {
    const raw = (t.itemsQuantity ?? "").trim();
    if (!raw) return `${t.fullName}: no ItemsQuantity`;
    const lines = parseItemsQuantity(raw);
    if (typeof lines === "string") return `${t.fullName}: ItemsQuantity ${lines}`;
    for (const { itemId, quantity } of lines) {
      const i = byId.get(itemId);
      if (i === undefined) return `${t.fullName}: item_id ${itemId} is not in this account's items`;
      shares[i]![a]! += quantity;
    }
  }
  for (const [i, p] of products.entries()) {
    const split = shares[i]!;
    const sum = split.reduce((n, q) => n + q, 0);
    const name = `item ${p.itemId || i + 1}`;
    if (sum === 0) return `${name} is in no ItemsQuantity`;
    if (sum !== p.quantity) {
      return `${name}: Items quantity ${p.quantity}, but the addresses add up to ${sum} (${split.join("/")})`;
    }
  }
  return { multi: true, shares, totals: products.map((p) => p.quantity) };
}
