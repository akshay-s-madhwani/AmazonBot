import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basketError, checkoutError, matchingOrder, newOrdersFor, reviewError, type OrderEvidence } from "./purchase-evidence.js";
import { acceptRun, wasRunAccepted } from "./start-registry.js";
import { FleetLink, type FleetHooks } from "./fleet.js";
import { resumeStep, inputsChanged } from "./resume-inputs.js";
import type { SheetJob } from "./job-client.js";
import { chooseAnswer, planCoupons } from "./reward.js";
import { couponNumbers, matchCoupon, parseWantedCoupons } from "./coupons.js";
import { parseRewardType } from "./config.js";
import { addressKey, targetKey } from "./address.js";
import { checkoutAddressKey, sheetAddressKey } from "./checkout.js";
import { cartQuantity } from "./steps.js";

const basket = [{ sku: "B012345678", quantity: 2, title: "Test product" }];
test("Resume adopts changed inputs from the earliest affected step", () => {
  const job = { credentials: { email: "a@example.com", password: "pw", totpSecret: "" },
    address: { line1: "12 Main Road" }, items: [{ url: "https://amazon.in/dp/B012345678", quantity: 1 }],
    payment: { method: "voucher", codes: [] } } as unknown as SheetJob;
  assert.equal(resumeStep(job, job, 8), 8);
  assert.equal(inputsChanged(job, { ...job, status: "PENDING", orderId: "old-order" }), false);
  assert.equal(resumeStep(job, { ...job, items: [{ ...job.items[0]!, quantity: 2 }] }, 8), 3);
  assert.equal(resumeStep(job, { ...job, address: { ...job.address, line1: "34 Main Road" } }, 8), 2);
  assert.equal(resumeStep(job, { ...job, payment: { method: "amazon_pay", codes: [] } }, 8), 7);
  assert.equal(resumeStep(job, { ...job, credentials: { ...job.credentials, password: "changed" } }, 8), 0);
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

test("A new or edited Reward row resumes from check_reward; one turning COMPLETED does not", () => {
  const base = { credentials: {}, address: {}, items: [], payment: {}, rewards: [] } as unknown as SheetJob;
  const spin = { row: 4, type: "spin" as const, url: "", status: "PENDING", answer: "", coupons: "50-250" };
  const withSpin = { ...base, rewards: [spin] } as SheetJob;
  assert.equal(resumeStep(base, withSpin, 5), 1);
  assert.equal(resumeStep(withSpin, withSpin, 5), 5);
  assert.equal(resumeStep(withSpin, { ...base, rewards: [{ ...spin, status: "BLOCKED" }] } as SheetJob, 5), 5);
  assert.equal(resumeStep(withSpin, { ...base, rewards: [{ ...spin, status: "COMPLETED" }] } as SheetJob, 5), 5);
  assert.equal(resumeStep(withSpin, { ...base, rewards: [{ ...spin, type: "stickers" }] } as SheetJob, 5), 1);
  assert.equal(resumeStep(withSpin, { ...base, rewards: [{ ...spin, answer: "False" }] } as SheetJob, 5), 1);
  assert.equal(resumeStep(withSpin, { ...base, rewards: [{ ...spin, coupons: "40-400" }] } as SheetJob, 5), 1);
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
});

test("Multi-address cart: each address gets the item's sheet quantity", () => {
  const item = { url: "https://amazon.in/dp/B012345678", quantity: 3, purchaseOption: "auto" as const };
  assert.equal(cartQuantity(item, 1).quantity, 3);
  assert.equal(cartQuantity(item, 2).quantity, 6);
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

test("Review check: every sheet address gets every item at its quantity, nothing ships elsewhere", () => {
  const basket = [{ sku: "B0FY6KL849", title: lamp, quantity: 2 }, { sku: "B0CKZ7MBBT", title: study, quantity: 2 }];
  const good = [ship(nhdi, [[lamp, 1], [study, 1]]), ship(jypj, [[study, 1], [lamp, 1]])];
  assert.equal(reviewError(basket, [nhdi, jypj], good), null);
  // One address split over two delivery dates is still fine.
  assert.equal(reviewError(basket, [nhdi, jypj], [ship(nhdi, [[lamp, 1]]), ship(nhdi, [[study, 1]]), good[1]!]), null);
  assert.match(reviewError(basket, [nhdi, jypj], [good[0]!])!, /nothing ships to jypj/);
  assert.match(reviewError(basket, [nhdi, jypj], [ship(nhdi, [[lamp, 2], [study, 1]]), good[1]!])!, /x2, expected x1/);
  assert.match(reviewError(basket, [nhdi], [good[0]!, good[1]!])!, /not in the sheet/);
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
