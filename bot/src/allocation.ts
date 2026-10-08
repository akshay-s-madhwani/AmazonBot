import type { ProductSpec, TargetAddress } from "./config.js";

/**
 * WHO GETS WHAT. Every item goes into the cart at its Items-tab quantity, set
 * on the product page. One address takes it all. Several: each Address row's
 * ItemsQuantity cell lists what that address receives, "item_id_quantity" per
 * line ("1_3\n2_2" = 3 of item 1 and 2 of item 2), and for every item the
 * addresses must add up to exactly its Items quantity (5 = 3 + 1 + 1, any
 * split) — checked before anything goes into the cart. The multi-address page
 * then spreads each item's units over the addresses.
 *
 * FREE ITEMS (2026-10-08). Some products bring a free one that Amazon adds at
 * checkout (product page: "Free with this product"). "*_N" in an address's
 * ItemsQuantity sends N free units there; an address may carry only that. How
 * many free units come is known once add_items has seen the product pages (placeFreeItems).
 */
export interface Allocation {
  multi: boolean;
  /** shares[i][a]: units of products[i] that go to addresses[a]. */
  shares: number[][];
  /** Units of each product over every address. */
  totals: number[];
  /** Multi-address: free-item units per address, from the "*_N" lines. */
  free: number[];
}

/** The item_id that stands for "the free item(s)" in ItemsQuantity. */
export const FREE_ITEM_ID = "*";

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
    return { multi: false, shares: products.map((p) => [p.quantity]), totals: products.map((p) => p.quantity), free: [] };
  }
  const byId = new Map<string, number>();
  for (const [i, p] of products.entries()) {
    const id = (p.itemId ?? "").trim();
    if (!id) continue;
    if (byId.has(id)) return `item_id ${id} is on two Items rows`;
    byId.set(id, i);
  }
  const shares = products.map(() => addresses.map(() => 0));
  const free = addresses.map(() => 0);
  for (const [a, t] of addresses.entries()) {
    // The sheet row the master read, so a cell that looks filled can be checked
    // against the row the bot was actually given.
    const who = t.row !== undefined ? `${t.fullName} (Address row ${t.row})` : t.fullName;
    const raw = (t.itemsQuantity ?? "").trim();
    if (!raw) return `${who}: no ItemsQuantity`;
    const lines = parseItemsQuantity(raw);
    if (typeof lines === "string") return `${who}: ItemsQuantity ${lines}`;
    for (const { itemId, quantity } of lines) {
      if (itemId === FREE_ITEM_ID) {
        free[a]! += quantity;
        continue;
      }
      const i = byId.get(itemId);
      if (i === undefined) return `${who}: item_id ${itemId} is not in this account's items`;
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
  return { multi: true, shares, totals: products.map((p) => p.quantity), free };
}

/** A free product Amazon will add at checkout, as its product page offers it. */
export interface FreeItem {
  sku: string;
  title: string;
  quantity: number;
}

/**
 * Where the free units go. One address: there, with everything else (no
 * shares). Several: to the address(es) with "*_N".
 *
 * HOW MANY Amazon gives is not the sheet's to decide (2026-10-08: the cart
 * offered 2 free items where 1 was expected, and refusing that stopped the
 * run). Whatever count shows, the "*" addresses take it: each up to its N, in
 * address order, and whatever is left over goes to the first "*" address. Fewer
 * than expected is fine too. Still refused: a free item and no "*" address at
 * all (nowhere to send it), and a "*" with no free item anywhere.
 */
export function placeFreeItems(plan: Allocation, items: FreeItem[]): number[][] | null | string {
  const units = items.reduce((n, f) => n + f.quantity, 0);
  if (!plan.multi) return null;
  const wanted = plan.free.reduce((n, q) => n + q, 0);
  const names = items.map((f) => f.title.slice(0, 40)).join(", ");
  if (units === 0) {
    return wanted === 0 ? [] : `ItemsQuantity sends ${wanted} free item(s) (*_N) but neither the product page nor the cart shows a free item`;
  }
  if (wanted === 0) return `${units} free item(s) offered (${names}) but no address has *_1 in ItemsQuantity`;
  const first = plan.free.findIndex((q) => q > 0);
  const left = [...plan.free];
  return items.map((f) => {
    const share = left.map(() => 0);
    let need = f.quantity;
    for (let a = 0; a < left.length && need > 0; a++) {
      const take = Math.min(need, left[a]!);
      share[a] = take;
      left[a]! -= take;
      need -= take;
    }
    // More than the sheet expected: the rest to the first "*" address.
    share[first]! += need;
    return share;
  });
}
