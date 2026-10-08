import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basketError, checkoutError, matchingOrder, newOrdersFor, ordersByName, reviewBasket, reviewError, type OrderEvidence } from "./purchase-evidence.js";
import { acceptRun, wasRunAccepted } from "./start-registry.js";
import { FleetLink, type FleetHooks } from "./fleet.js";
import { resumeStep, inputsChanged } from "./resume-inputs.js";
import type { SheetJob } from "./job-client.js";
import { chooseAnswer, pageKey, planCoupons } from "./reward.js";
import { couponNumbers, matchCoupon, parseWantedCoupons } from "./coupons.js";
import { parseRewardType } from "./config.js";
import { addressKey, targetKey } from "./address.js";
import { checkoutAddressKey, fitSharesToCart, matchBasketItem, planRowAction, sheetAddressKey } from "./checkout.js";
import { allocate, parseItemsQuantity, placeFreeItems } from "./allocation.js";
import { planVouchers } from "./vouchers.js";
import { parseAccountProxy } from "./proxy.js";
import { fleetProcesses, orphans } from "./procs.js";

const basket = [{ sku: "B012345678", quantity: 2, title: "Test product" }];
test("Resume starts at the asked step; only a changed basket goes back to clear_cart", () => {
  const job = { credentials: { email: "a@example.com", password: "pw", totpSecret: "" },
    address: { line1: "12 Main Road" }, items: [{ url: "https://amazon.in/dp/B012345678", quantity: 1 }],
    payment: { method: "voucher", codes: [] } } as unknown as SheetJob;
  assert.equal(resumeStep(job, job, 8), 8);
  assert.equal(inputsChanged(job, { ...job, status: "PENDING", orderId: "old-order" }), false);
  assert.equal(resumeStep(job, { ...job, items: [{ ...job.items[0]!, quantity: 2 }] }, 8), 3);
  // Before clear_cart already: nothing to go back to.
  assert.equal(resumeStep(job, { ...job, items: [{ ...job.items[0]!, quantity: 2 }] }, 1), 1);
  // Other edits are handed to the runner but move nothing.
  const moved = { ...job, address: { ...job.address, line1: "34 Main Road" } } as SheetJob;
  assert.equal(resumeStep(job, moved, 8), 8);
  assert.equal(inputsChanged(job, moved), true);
  assert.equal(resumeStep(job, { ...job, payment: { method: "amazon_pay", codes: [] } }, 8), 8);
  assert.equal(resumeStep(job, { ...job, credentials: { ...job.credentials, password: "changed" } }, 8), 8);
  // A voucher the run itself marked USED is progress, not an edit.
  const withCode = { ...job, payment: { method: "voucher" as const, codes: [{ code: "A", row: 2, type: "apay" as const, status: "" }] } };
  assert.equal(inputsChanged(withCode, { ...withCode, payment: { ...withCode.payment, codes: [{ ...withCode.payment.codes[0]!, status: "USED" }] } }), false);
});
test("telemetry persists before connection and sequence survives process restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-outbox-test-"));
  const cfg = { node_id: "test-node", nats_url: "nats://127.0.0.1:1", stateDir };
  const hooks = { slots: () => [], workerCount: () => 1 } as unknown as FleetHooks;
  try {
    const first = FleetLink.buffer(cfg, hooks);
    assert.equal(first.emit({ run_id: "r1", worker_id: 0, event: "session.closed" }).seq, 0);
    await first.close();
    const next = FleetLink.buffer(cfg, hooks);
    assert.equal(next.emit({ run_id: "r1", worker_id: 0, event: "session.closed" }).seq, 1);
    await next.close();
    assert.equal(readFileSync(join(stateDir, "outbox.ndjson"), "utf8").trim().split("\n").length, 2);
    writeFileSync(join(stateDir, "seq.json"), "corrupt");
    assert.throws(() => FleetLink.buffer(cfg, hooks));
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
test("basket assertion rejects missing, additional and wrong-quantity items", () => {
  assert.equal(basketError(basket, basket), null);
  assert.ok(basketError(basket, []));
  assert.ok(basketError(basket, [{ ...basket[0]!, quantity: 1 }]));
  assert.ok(basketError(basket, [...basket, { ...basket[0]!, sku: "B098765432" }]));
  assert.ok(basketError(basket, [{ ...basket[0]!, quantity: NaN }]));
});
test("checkout requires both address line and delivery PIN", () => {
  const address = { fullName: "Buyer", phone: "9999999999", pincode: "560001", line1: "12 Main Road", line2: "", city: "Bengaluru", state: "Karnataka", landmark: "", country: "India" };
  assert.equal(checkoutError(basket, address, { items: basket, address: "12 Main Road, Bengaluru 560001" }), null);
  assert.ok(checkoutError(basket, address, { items: basket, address: "99 Other Road, 560001" }));
  assert.ok(checkoutError(basket, address, { items: basket, address: "12 Main Road, 560002" }));
  assert.ok(checkoutError(basket, address, { items: basket, address: "112 Main Road, 560001" }));
});
test("order matching requires unique, recent, uncancelled basket and title evidence", () => {
  const attempt = new Date(Date.now() - 60_000).toISOString();
  const order: OrderEvidence = { id: "123-1234567-1234567", placedAt: new Date().toISOString(), items: basket, cancelled: false };
  assert.equal(matchingOrder([order], basket, attempt), order);
  assert.equal(matchingOrder([{ ...order, placedAt: new Date(Date.now() - 120_000).toISOString() }], basket, attempt), null);
  assert.equal(matchingOrder([{ ...order, placedAt: null }], basket, attempt), null);
  assert.equal(matchingOrder([{ ...order, cancelled: true }], basket, attempt), null);
  assert.equal(matchingOrder([{ ...order, items: [{ ...basket[0]!, title: "Other product" }] }], basket, attempt), null);
  assert.equal(matchingOrder([order, { ...order, id: "321-1234567-1234567" }], basket, attempt), null);
});
test("start acceptance survives restart and rejects conflicting or corrupt identities", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-acceptance-test-"));
  try {
    assert.equal(wasRunAccepted(root, "run-1", "row-1"), false);
    assert.equal(acceptRun(root, "run-1", "row-1"), true);
    assert.equal(wasRunAccepted(root, "run-1", "row-1"), true);
    assert.equal(acceptRun(root, "run-1", "row-1"), false);
    assert.throws(() => acceptRun(root, "run-1", "row-2"));
    writeFileSync(join(root, readdirSync(root)[0]!), "corrupt");
    assert.throws(() => wasRunAccepted(root, "run-1", "row-1"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Reward edits are handed to the runner without moving the resume; one turning COMPLETED is not an edit", () => {
  const base = { credentials: {}, address: {}, items: [], payment: {}, rewards: [] } as unknown as SheetJob;
  const spin = { row: 4, type: "spin" as const, url: "", status: "PENDING", answer: "", coupons: "50-250" };
  const withSpin = { ...base, rewards: [spin] } as SheetJob;
  assert.equal(resumeStep(base, withSpin, 5), 5);
  assert.equal(inputsChanged(base, withSpin), true);
  assert.equal(inputsChanged(withSpin, { ...base, rewards: [{ ...spin, status: "COMPLETED" }] } as SheetJob), false);
  assert.equal(inputsChanged(withSpin, { ...base, rewards: [{ ...spin, answer: "False" }] } as SheetJob), true);
});

test("Spin quiz: the sheet's Answer, case-insensitive; blank takes the first option; a missing one is refused", () => {
  assert.equal(chooseAnswer(["True", "False"], "true"), "True");
  assert.equal(chooseAnswer(["False", "True"], " TRUE "), "True");
  assert.equal(chooseAnswer(["Delhi", "Mumbai", "Pune"], ""), "Delhi");
  assert.equal(chooseAnswer(["Option A: Delhi", "Option B: Mumbai"], "mumbai"), "Option B: Mumbai");
  assert.equal(chooseAnswer(["Delhi", "Mumbai"], "Chennai"), null);
  assert.equal(chooseAnswer([], ""), null);
});

test("Coupons: the two numbers of a description against the sheet's lines", () => {
  const wanted = parseWantedCoupons("50-250\n40-400\n 35 - 500 \n5%-100%\n60-\n-999");
  assert.deepEqual(wanted.map((w) => [w.text, w.first, w.second]), [
    ["50-250", "50", "250"], ["40-400", "40", "400"], ["35-500", "35", "500"],
    ["5%-100%", "5%", "100%"], ["60-", "60", ""], ["-999", "", "999"],
  ]);
  assert.deepEqual(couponNumbers("Get flat ₹50 off Min order: ₹250 Valid till 31 Oct"), ["50", "250"]);
  assert.deepEqual(couponNumbers("Get 5% off up to Rs. 1,000"), ["5%", "1000"]);
  assert.deepEqual(couponNumbers("50 off on 250 order"), ["50", "250"]);
  const hit = (desc: string) => matchCoupon(couponNumbers(desc), wanted)?.text ?? null;
  assert.equal(hit("Flat ₹50 off on orders above ₹250"), "50-250");
  assert.equal(hit("Flat ₹50 off on orders above ₹300"), null);
  assert.equal(hit("Flat ₹40 off on orders above ₹400"), "40-400");
  assert.equal(hit("5% off up to 100%"), "5%-100%");
  assert.equal(hit("5% off up to ₹100"), null);
  assert.equal(hit("Flat ₹60 off on ₹600"), "60-");
  assert.equal(hit("Flat ₹60 off"), "60-");
  assert.equal(hit("Free delivery on ₹999"), "-999");
  assert.equal(hit("Free delivery on ₹250"), null);
  assert.equal(hit("Surprise gift"), null);
});

test("Coupons: collect the wanted open ones, record the wanted claimed ones", () => {
  const wanted = parseWantedCoupons("50-250\n40-400");
  const cards = [
    { state: "open" as const, description: "₹35 off on ₹500" },
    { state: "open" as const, description: "₹50 off on ₹250" },
    { state: "claimed" as const, description: "₹40 off on ₹400" },
    { state: "claimed" as const, description: "₹10 off on ₹100" },
  ];
  assert.deepEqual(planCoupons(cards, null, wanted), {
    open: [1], found: ["40-400"], claimedOther: ["10-100"], offeredOther: ["35-500"], pickFull: false,
  });
  // A full pick page collects nothing more.
  assert.deepEqual(planCoupons(cards, { need: 1, picked: 1 }, wanted).open, []);
  // A blank Coupons cell takes any coupon.
  assert.deepEqual(planCoupons(cards, null, []).open, [0, 1]);
});

test("Reward type parsing", () => {
  assert.equal(parseRewardType("SPIN"), "spin");
  assert.equal(parseRewardType(" Spin wheel "), "spin");
  assert.equal(parseRewardType("Stickers"), "stickers");
  assert.equal(parseRewardType("Actions"), "stickers");
  assert.equal(parseRewardType("", "https://www.amazon.in/rewards/checkoutCoupons?uuid=X"), "url");
  assert.equal(parseRewardType("", ""), null);
  assert.equal(parseRewardType("lottery"), null);
});

test("Reward fallback: a link that is the type's own default page is not retried", () => {
  assert.equal(pageKey("https://amazon.in/game/gSUN0DE/"), pageKey("https://www.amazon.in/game/gSUN0DE"));
  assert.equal(pageKey("https://www.amazon.in/b?ref=x&node=221530152031"), pageKey("https://www.amazon.in/b?node=221530152031"));
  assert.notEqual(pageKey("https://www.amazon.in/game/gMHJQCC"), pageKey("https://www.amazon.in/game/gSUN0DE"));
  assert.notEqual(pageKey("https://www.amazon.in/b?node=1"), pageKey("https://www.amazon.in/b?node=221530152031"));
});

test("Address keys: a sheet address, its address-book card and its checkout entry all key the same", () => {
  const sheet = { fullName: "nhdi naman jain", phone: "9663805777", pincode: "521333", line1: "1-66/86",
    line2: "zz kaikaluru Shabalini colony Gopa Ji Ki Dhani Pratap Nager GH Mangai garden", landmark: "",
    city: "", state: "", country: "India" };
  // The card shows line 2 cut at 60 characters.
  const card = addressKey({ name: "nhdi naman jain", line1: "1-66/86",
    line2: "zz kaikaluru Shabalini colony Gopa Ji Ki Dhani Pratap Nager", pincode: "521333" });
  assert.equal(targetKey(sheet), card);
  const entry = "nhdi naman jain 1-66/86, zz kaikaluru Shabalini colony Gopa Ji Ki Dhani Pratap Nager, KAIKALUR, ANDHRA PRADESH, 521333, India";
  assert.equal(checkoutAddressKey(entry), sheetAddressKey(sheet));
  const other = "fhmi raghu sahu 47-8/31, zz kaikaluru Lakshmi nagar Bhagoji keer marg Chanban Sulaksh, KAIKALUR, ANDHRA PRADESH, 521333, India";
  assert.notEqual(checkoutAddressKey(other), sheetAddressKey(sheet));
  assert.equal(checkoutAddressKey("not an address"), null);
  // Double spaces in the sheet: Amazon collapses them before cutting at 60.
  const spaced = { ...sheet, fullName: "suresh 10", pincode: "521139", line1: "10 amazon ganguru gifa",
    line2: "ximv  Janaki ramayya estates" };
  assert.equal(checkoutAddressKey("suresh 10 10 amazon ganguru gifa, ximv Janaki ramayya estates, VIJAYAWADA, ANDHRA PRADESH, 521139, India"),
    sheetAddressKey(spaced));
  assert.equal(checkoutAddressKey("suresh 10, 10 amazon ganguru gifa, ximv Janaki ramayya estates, VIJAYAWADA, ANDHRA PRADESH, 521139, India"),
    sheetAddressKey(spaced));
});

test("ItemsQuantity: item_id_quantity per line", () => {
  assert.deepEqual(parseItemsQuantity("1_3\n2_2"), [{ itemId: "1", quantity: 3 }, { itemId: "2", quantity: 2 }]);
  assert.deepEqual(parseItemsQuantity(" A_1 _ 4 \r\n\n"), [{ itemId: "A_1", quantity: 4 }]);
  assert.deepEqual(parseItemsQuantity("A-1_4"), [{ itemId: "A-1", quantity: 4 }]);
  assert.match(parseItemsQuantity("1_3\n2") as string, /bad line "2"/);
  assert.match(parseItemsQuantity("1_0") as string, /bad line/);
  assert.match(parseItemsQuantity("1-3") as string, /bad line "1-3"/);
});

test("Allocation: the cart takes the Items quantity; several addresses must split it exactly", () => {
  const p = (itemId: string, quantity: number) => ({ itemId, url: `https://amazon.in/dp/${itemId}`, quantity, purchaseOption: "auto" as const });
  const at = (fullName: string, itemsQuantity = "") => ({ fullName, phone: "", pincode: "521333", line1: "1", line2: "",
    landmark: "", city: "", state: "", country: "India", itemsQuantity });
  assert.deepEqual(allocate([p("1", 2), p("2", 5)], [at("a")]), { multi: false, shares: [[2], [5]], totals: [2, 5], free: [] });
  // Items quantity 5 over three addresses, any split that adds up: 3 + 1 + 1.
  const three = [at("a", "1_3\n2_2"), at("b", "1_1\n2_1"), at("c", "1_1")];
  assert.deepEqual(allocate([p("1", 5), p("2", 3)], three), {
    multi: true, shares: [[3, 1, 1], [2, 1, 0]], totals: [5, 3], free: [0, 0, 0],
  });
  // Lines for the same item in one address add up.
  assert.deepEqual(allocate([p("1", 4)], [at("a", "1_1\n1_2"), at("b", "1_1")]), {
    multi: true, shares: [[3, 1]], totals: [4], free: [0, 0],
  });
  assert.match(allocate([p("1", 5)], three) as string, /item_id 2 is not in this account's items/);
  assert.match(allocate([p("1", 6), p("2", 3)], three) as string, /^item 1: Items quantity 6, but the addresses add up to 5 \(3\/1\/1\)/);
  assert.match(allocate([p("1", 5), p("2", 4)], three) as string, /^item 2: Items quantity 4, but the addresses add up to 3/);
  assert.match(allocate([p("1", 2)], [at("a", "1_1"), at("b")]) as string, /^b: no ItemsQuantity/);
  assert.match(allocate([p("1", 2)], [at("a", "1_1"), at("b", "9_1")]) as string, /item_id 9 is not/);
  assert.match(allocate([p("1", 2), p("1", 3)], [at("a", "1_1"), at("b", "1_1")]) as string, /on two Items rows/);
  assert.match(allocate([p("1", 2), p("2", 3)], [at("a", "1_1"), at("b", "1_1")]) as string, /item 2 is in no ItemsQuantity/);
});

test("Free items: *_N routes Amazon's free product, whatever count Amazon gives; single takes all", () => {
  const p = (itemId: string, quantity: number) => ({ itemId, url: `https://amazon.in/dp/${itemId}`, quantity, purchaseOption: "auto" as const });
  const at = (fullName: string, itemsQuantity = "") => ({ fullName, phone: "", pincode: "521333", line1: "1", line2: "",
    landmark: "", city: "", state: "", country: "India", itemsQuantity });
  const shampoo = { sku: "B0D6BNL45S", title: "WishCare Multi Peptide Anti Hairfall Shampoo", quantity: 1 };
  // Account 17: 2 + 2 of item 11, the free one to the third address, which takes nothing else.
  const acct17 = [at("suresh 4a", "11_2"), at("suresh 5a", "11_2"), at("suresh 6a", "*_1")];
  const plan = allocate([p("11", 4)], acct17);
  assert.deepEqual(plan, { multi: true, shares: [[2, 2, 0]], totals: [4], free: [0, 0, 1] });
  if (typeof plan === "string") return;
  assert.deepEqual(placeFreeItems(plan, [shampoo]), [[0, 0, 1]]);
  assert.deepEqual(placeFreeItems(plan, []) , "ItemsQuantity sends 1 free item(s) (*_N) but neither the product page nor the cart shows a free item");
  // Amazon gave 2 where the sheet expected 1: both go to the "*" address.
  assert.deepEqual(placeFreeItems(plan, [{ ...shampoo, quantity: 2 }]), [[0, 0, 2]]);
  // Two different free products where one was expected: both to the "*" address too.
  assert.deepEqual(placeFreeItems(plan, [shampoo, { sku: "B000000002", title: "Other", quantity: 1 }]), [[0, 0, 1], [0, 0, 1]]);
  // A free item and no "*" anywhere: multi-address fails at add_items.
  const noStar = allocate([p("11", 4)], [at("a", "11_2"), at("b", "11_2")]);
  if (typeof noStar === "string") throw new Error(noStar);
  assert.match(placeFreeItems(noStar, [shampoo]) as string, /1 free item\(s\) offered \(WishCare.*\) but no address has \*_1/);
  assert.deepEqual(placeFreeItems(noStar, []), []);
  // Single address: everything goes there, no shares needed.
  const single = allocate([p("11", 4)], [at("a")]);
  if (typeof single === "string") throw new Error(single);
  assert.equal(placeFreeItems(single, [shampoo]), null);
  // Two free products share the "*" pool in address order.
  const two = allocate([p("1", 2)], [at("a", "1_1\n*_1"), at("b", "1_1\n*_1")]);
  if (typeof two === "string") throw new Error(two);
  assert.deepEqual(placeFreeItems(two, [shampoo, { sku: "B000000002", title: "Other", quantity: 1 }]), [[1, 0], [0, 1]]);
  // Three where two "*" addresses expect one each: each takes its one, the extra goes to the first.
  assert.deepEqual(placeFreeItems(two, [{ ...shampoo, quantity: 3 }]), [[2, 1]]);
  // Fewer than expected is fine.
  assert.deepEqual(placeFreeItems(two, [shampoo]), [[1, 0]]);
});

test("Multi-address rows: one row per address, at that address's share", () => {
  const keys = ["a", "b"];
  // 8 of item 1 to "a" only (the minimum-quantity case): one row, stepped to 8.
  assert.deepEqual(planRowAction([{ item: 0, qty: 2, key: "b" }], keys, [[8, 0]]), { kind: "assign", row: 0, key: "a" });
  assert.deepEqual(planRowAction([{ item: 0, qty: 2, key: "a" }], keys, [[8, 0]]), { kind: "step", row: 0, dir: "increment" });
  assert.equal(planRowAction([{ item: 0, qty: 8, key: "a" }], keys, [[8, 0]]), null);
  // 2 + 2 over two addresses: one more row, then each row its address and count.
  const shares = [[2, 2], [0, 1]];
  const start = [{ item: 0, qty: 4, key: "a" }, { item: 1, qty: 1, key: "a" }];
  assert.deepEqual(planRowAction(start, keys, shares), { kind: "split", row: 0 });
  const split = [{ item: 0, qty: 3, key: "a" }, { item: 0, qty: 1, key: "a" }, { item: 1, qty: 1, key: "a" }];
  assert.deepEqual(planRowAction(split, keys, shares), { kind: "assign", row: 1, key: "b" });
  const assigned = [{ item: 0, qty: 3, key: "a" }, { item: 0, qty: 1, key: "b" }, { item: 1, qty: 1, key: "a" }];
  assert.deepEqual(planRowAction(assigned, keys, shares), { kind: "step", row: 0, dir: "decrement" });
  const sized = [{ item: 0, qty: 2, key: "a" }, { item: 0, qty: 2, key: "b" }, { item: 1, qty: 1, key: "a" }];
  assert.deepEqual(planRowAction(sized, keys, shares), { kind: "assign", row: 2, key: "b" });
  assert.equal(planRowAction([...sized.slice(0, 2), { item: 1, qty: 1, key: "b" }], keys, shares), null);
  // The bad old state (8 rows of one address): rows it does not need go.
  const eight = Array.from({ length: 8 }, () => ({ item: 0, qty: 2, key: "a" }));
  assert.deepEqual(planRowAction(eight, keys, [[8, 0]]), { kind: "delete", row: 1 });
  assert.match(planRowAction([], keys, [[8, 0]]) as string, /item 1 is not on the multi-address page/);
});

test("Multi-address rows match basket items by ASIN, else by title", () => {
  const basket = [{ sku: "B0FY6KL849", title: lamp, quantity: 3 }, { sku: "B0CKZ7MBBT", title: study, quantity: 1 }];
  assert.equal(matchBasketItem({ item: "anything", asin: "b0ckz7mbbt" }, basket), 1);
  assert.equal(matchBasketItem({ item: "XECH Quest PRO Table Lamp with 15W…", asin: null }, basket), 0);
  assert.equal(matchBasketItem({ item: "FREE Delivery Tomorrow", asin: null }, basket), -1);
});

const nhdi = { fullName: "nhdi naman jain", phone: "", pincode: "521333", line1: "1-66/86",
  line2: "zz kaikaluru Shabalini colony Gopa Ji Ki Dhani Pratap Nager GH Mangai garden", landmark: "", city: "", state: "", country: "India" };
const jypj = { fullName: "jypj vidhi singh", phone: "", pincode: "521333", line1: "20-16/47",
  line2: "zz kaikaluru near Rajeshwari mobile store Trishul Society As", landmark: "", city: "", state: "", country: "India" };
const lamp = "XECH Quest PRO Table Lamp with 15W Wireless Charger, Pen Stand & Dual USB Ports";
const study = "Xech 4-in-1 Study Lamp with Digital Clock, Pen Stand & Phone Holder";
const ship = (t: typeof nhdi, items: Array<[string, number]>) => ({
  key: checkoutAddressKey(`${t.fullName} ${t.line1}, ${t.line2.slice(0, 60)}, KAIKALUR, ANDHRA PRADESH, 521333, IN`),
  name: t.fullName, items: items.map(([title, quantity]) => ({ title, quantity })) });

test("Review check: the basket may shrink, never grow or go elsewhere", () => {
  const basket = [{ sku: "B0FY6KL849", title: lamp, quantity: 2 }, { sku: "B0CKZ7MBBT", title: study, quantity: 2 }];
  const good = [ship(nhdi, [[lamp, 1], [study, 1]]), ship(jypj, [[study, 1], [lamp, 1]])];
  assert.equal(reviewError(basket, [nhdi, jypj], good), null);
  // One address split over two delivery dates is still fine.
  assert.equal(reviewError(basket, [nhdi, jypj], [ship(nhdi, [[lamp, 1]]), ship(nhdi, [[study, 1]]), good[1]!]), null);
  // An address left with nothing (its items removed or unavailable): allowed, and said.
  const shrunk = reviewBasket(basket, [nhdi, jypj], [good[0]!]);
  assert.ok(shrunk.ok);
  assert.deepEqual(shrunk.shipping, [nhdi]);
  assert.match(shrunk.changes.join("; "), /nothing ships to jypj/);
  // One unit fewer: allowed. One more, an unrequested item, or no address at all: refused.
  const fewer = reviewBasket(basket, [nhdi, jypj], [ship(nhdi, [[lamp, 1]]), good[1]!]);
  assert.ok(fewer.ok && /x0 of x1/.test(fewer.changes.join("; ")));
  assert.match(reviewError(basket, [nhdi, jypj], [ship(nhdi, [[lamp, 2], [study, 1]]), good[1]!])!, /x2, more than the x1 asked/);
  assert.match(reviewError(basket, [nhdi, jypj], [ship(nhdi, [[lamp, 1], ["Some other product", 1]]), good[1]!])!, /not requested/);
  assert.match(reviewError(basket, [nhdi, jypj], [])!, /no delivery address/);
  assert.match(reviewError(basket, [nhdi], [good[0]!, good[1]!])!, /not in the sheet/);
});

test("Review check: with shares, each address gets its ItemsQuantity", () => {
  const basket = [
    { sku: "B0FY6KL849", title: lamp, quantity: 3, shares: [2, 1] },
    { sku: "B0CKZ7MBBT", title: study, quantity: 1, shares: [0, 1] },
  ];
  assert.equal(reviewError(basket, [nhdi, jypj], [ship(nhdi, [[lamp, 2]]), ship(jypj, [[lamp, 1], [study, 1]])]), null);
  assert.match(reviewError(basket, [nhdi, jypj], [ship(nhdi, [[lamp, 2], [study, 1]]), ship(jypj, [[lamp, 1]])])!,
    /nhdi naman jain: Xech 4-in-1 .* x1, more than the x0 asked/);
  // A share that came out short (unavailable) is allowed; one that came out long is not.
  assert.equal(reviewError(basket, [nhdi, jypj], [ship(nhdi, [[lamp, 1]]), ship(jypj, [[lamp, 1], [study, 1]])]), null);
  assert.match(reviewError(basket, [nhdi, jypj], [ship(nhdi, [[lamp, 1]]), ship(jypj, [[lamp, 2], [study, 1]])])!, /x2, more than the x1 asked/);
});

test("New orders: the ones not on Your Orders before, one per sheet address", () => {
  const cards = [
    { id: "406-6040956-0673968", shipTo: "nhdi naman jain", titles: [lamp, study], cancelled: false },
    { id: "406-1457638-9489927", shipTo: "jypj vidhi singh", titles: [lamp, study], cancelled: false },
    { id: "402-0000000-0000001", shipTo: "suresh 991c", titles: [study], cancelled: false },
  ];
  const known = ["402-0000000-0000001"];
  const found = newOrdersFor(cards, known, [nhdi, jypj]);
  assert.ok(found.ok && found.orders.map((o) => o.id).join() === "406-6040956-0673968,406-1457638-9489927");
  assert.ok(!newOrdersFor(cards, [...known, "406-1457638-9489927"], [nhdi, jypj]).ok);
  assert.ok(!newOrdersFor(cards, [], [nhdi, jypj]).ok);
});

test("note_order_id: orders by the sheet's address names; same-day splits kept; older ones skipped once 'before' is known", () => {
  const cards = [
    { id: "403-0000000-0000003", shipTo: "nhdi naman jain", titles: [lamp], cancelled: false, placed: "8 October 2026" },
    { id: "403-0000000-0000002", shipTo: "nhdi naman jain", titles: [study], cancelled: false, placed: "8 October 2026" },
    { id: "403-0000000-0000001", shipTo: "nhdi naman jain", titles: [lamp], cancelled: false, placed: "1 October 2026" },
    { id: "403-0000000-0000009", shipTo: "jypj vidhi singh", titles: [lamp], cancelled: true, placed: "8 October 2026" },
  ];
  // Nothing known: any order with the name — the newest day's, both of its orders.
  const any = ordersByName(cards, [nhdi, jypj], null);
  assert.ok(any.ok);
  assert.deepEqual(any.orders.map((o) => o.id), ["403-0000000-0000003", "403-0000000-0000002"]);
  // The cancelled one does not count, so only nhdi ships.
  assert.deepEqual(any.shipping, [nhdi]);
  // Known "before": orders already there are not this run's.
  const before = ["403-0000000-0000003", "403-0000000-0000002", "403-0000000-0000001"];
  assert.ok(!ordersByName(cards, [nhdi, jypj], before).ok);
  assert.match((ordersByName(cards, [nhdi], before) as { reason: string }).reason, /since Pay Now/);
  const fresh = ordersByName(cards, [nhdi], ["403-0000000-0000001"]);
  assert.ok(fresh.ok && fresh.orders.length === 2);
});

test("Remove blocks: per-address shares cut to what the cart holds, never more than asked", () => {
  const rows = [{ item: 0, qty: 3 }, { item: 0, qty: 2 }, { item: 2, qty: 1 }];
  // Item 0 has 5 of 8 left; item 1 is gone; item 2 has more than asked.
  assert.deepEqual(fitSharesToCart([[4, 4], [1, 1], [0, 1]], rows), [[4, 1], [0, 0], [0, 1]]);
  assert.deepEqual(fitSharesToCart([[2, 3]], [{ item: 0, qty: 5 }]), [[2, 3]]);
});

test("Vouchers: every code goes to the claim page, whatever its type; Used ones left alone", () => {
  const plan = planVouchers([
    { code: "AP1", row: 2, type: "apay", status: "" },
    { code: "CP1", row: 3, type: "coupon", status: "" },
    { code: "OLD", row: 4, type: "apay", status: "USED" },
    { code: "RETRY", row: 5, type: "coupon", status: "" },
    { code: "ODD", row: 6, type: "unknown", status: "" },
    { code: "  ", row: 7, type: "coupon", status: "" },
    { code: "LEGACY" },
  ], new Set(["RETRY"]));
  assert.deepEqual(plan.todo.map((v) => v.code), ["AP1", "CP1", "ODD", "LEGACY"]);
  assert.equal(plan.alreadyUsed, 2);
});

test("Vouchers: nothing on the voucher path reloads a page — a reload re-sends the claim form's POST", () => {
  // Reloading the claim page after Add submitted the same code again ("already
  // used", then a captcha) — 2026-10-08. Each code must open the form with a GET.
  const src = readFileSync(new URL("../src/vouchers.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /\.reload\(/);
});

test("Proxy: http://host:port, bare host:port means http, anything else refuses", () => {
  assert.equal(parseAccountProxy(""), null);
  assert.deepEqual(parseAccountProxy(" https://10.0.0.1:8080 "), {
    url: "https://10.0.0.1:8080", host: "10.0.0.1", port: 8080, label: "https://10.0.0.1:8080",
  });
  assert.equal(parseAccountProxy("proxy.example.com:3128")!.url, "http://proxy.example.com:3128");
  assert.equal(parseAccountProxy("http://10.0.0.1:8080")!.url, "http://10.0.0.1:8080");
  assert.equal(parseAccountProxy("socks5://u:p@1.2.3.4:1080")!.label, "socks5://1.2.3.4:1080");
  assert.throws(() => parseAccountProxy("10.0.0.1"), /not http:\/\/host:port/);
  assert.throws(() => parseAccountProxy("ftp://10.0.0.1:21"));
});

test("Your Orders: every new order matched to its address by Ship to name, exactly", () => {
  const addr = (fullName: string) => ({ fullName, phone: "", pincode: "521139", line1: "x", line2: "", landmark: "",
    city: "", state: "", country: "India" });
  const card = (id: string, shipTo: string) => ({ id, shipTo, titles: [], cancelled: false });
  const cards = [card("402-8867819-1957120", "suresh 10"), card("402-7221865-5850735", "suresh 11")];
  const found = newOrdersFor(cards, [], [addr("suresh 10"), addr("suresh 11")]);
  assert.ok(found.ok);
  assert.deepEqual(found.ok && found.orders.map((o) => o.id), ["402-8867819-1957120", "402-7221865-5850735"]);
  // "suresh 1" is not "suresh 10" unless Amazon cut the name short.
  assert.equal(newOrdersFor([card("402-8867819-1957120", "suresh 10")], [], [addr("suresh 1")]).ok, false);
  assert.ok(newOrdersFor([card("402-8867819-1957120", "suresh…")], [], [addr("suresh 10")]).ok);
});

test("Resume: a master that starts sending each address's sheet row does not rewind to set_address", () => {
  const a = { fullName: "suresh 10", phone: "1", pincode: "521139", line1: "x", line2: "", landmark: "",
    city: "", state: "", country: "India", itemsQuantity: "9_1" };
  const job = (addresses: typeof a[]) => ({ credentials: {}, address: addresses[0], addresses, items: [],
    payment: { method: "voucher", codes: [] }, rewards: [] }) as unknown as SheetJob;
  const before = job([a]);
  assert.equal(resumeStep(before, job([{ ...a, row: 30 } as typeof a]), 9), 9);
  assert.equal(inputsChanged(before, job([{ ...a, row: 30 } as typeof a])), false);
  // A changed split is a changed basket: back to clear_cart.
  assert.equal(resumeStep(before, job([{ ...a, itemsQuantity: "9_2" }]), 9), 3);
});

test("Cleanup: finds this folder's slots, runners and browsers; orphans are the ones no live slot owns", () => {
  // Command lines as Windows reports them (Win32_Process.CommandLine).
  const win = { dist: String.raw`C:\bots\AmazonBot\bot\dist`, profiles: String.raw`C:\bots\AmazonBot\bot\browser-profiles` };
  const procs = [
    { pid: 10, ppid: 1, cmd: "node  dist/manager.js" },
    { pid: 20, ppid: 1, cmd: String.raw`"C:\Program Files\nodejs\node.exe" C:\bots\AmazonBot\bot\dist\slot.js` },
    { pid: 21, ppid: 20, cmd: String.raw`"node.exe" C:\bots\AmazonBot\bot\dist\runner.js "{\"run_id\":\"run-live\",\"cdp_url\":\"ws://x\"}"` },
    { pid: 22, ppid: 20, cmd: String.raw`chrome.exe --fleet-bot-browser --user-data-dir=C:\bots\AmazonBot\bot\browser-profiles\run-aaa --remote-debugging-port=0` },
    { pid: 23, ppid: 22, cmd: String.raw`chrome.exe --type=renderer --user-data-dir=C:\bots\AmazonBot\bot\browser-profiles\run-aaa` },
    // A runner whose slot died hours ago, and a browser nobody owns.
    { pid: 30, ppid: 999, cmd: String.raw`"node.exe" C:\bots\AmazonBot\bot\dist\runner.js "{\"run_id\":\"run-dead\"}"` },
    { pid: 31, ppid: 998, cmd: String.raw`chrome.exe --user-data-dir=C:\bots\AmazonBot\bot\browser-profiles\run-bbb` },
    // Not ours: another bot folder, the operator's own Chrome.
    { pid: 40, ppid: 1, cmd: String.raw`node C:\other\bot\dist\runner.js {}` },
    { pid: 41, ppid: 1, cmd: String.raw`chrome.exe --user-data-dir=C:\Users\me\AppData\Local\Google\Chrome` },
  ];
  const fleet = fleetProcesses(procs, win);
  assert.deepEqual(fleet.map((p) => `${p.kind}:${p.pid}`), ["slot:20", "runner:21", "browser:22", "runner:30", "browser:31"]);
  assert.equal(fleet.find((p) => p.pid === 21)!.runId, "run-live");
  assert.equal(fleet.find((p) => p.pid === 31)!.profileId, "run-bbb");
  const live = { slotPids: new Set([20]), runIds: new Set(["run-live"]), profileIds: new Set(["run-aaa"]) };
  assert.deepEqual(orphans(fleet, live).map((p) => p.pid), [30, 31]);
  // The manager gone or reset: nothing is live, everything of ours goes.
  assert.deepEqual(orphans(fleet, { slotPids: new Set(), runIds: new Set(), profileIds: new Set() }).map((p) => p.pid), [20, 21, 22, 30, 31]);
  // macOS command lines.
  const mac = { dist: "/Users/a/AmazonBot/bot/dist", profiles: "/Users/a/AmazonBot/bot/browser-profiles" };
  const macFleet = fleetProcesses([
    { pid: 5, ppid: 1, cmd: "/usr/local/bin/node /Users/a/AmazonBot/bot/dist/runner.js {\"run_id\":\"run-x\"}" },
    { pid: 6, ppid: 1, cmd: "/Users/a/Library/shardx/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/Users/a/AmazonBot/bot/browser-profiles/run-ccc" },
  ], mac);
  assert.deepEqual(macFleet.map((p) => [p.kind, p.runId ?? p.profileId]), [["runner", "run-x"], ["browser", "run-ccc"]]);
});
