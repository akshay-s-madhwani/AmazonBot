import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAddresses } from "./address.js";
import { allocate, placeFreeItems, type FreeItem } from "./allocation.js";
import {
  lookUpOrders,
  openCart,
  readFreebieMessages,
  readOfferedFreebie,
  recordOrders,
  runAddToCart,
  runApplyPayment,
  runClearCart,
  runNoteOrderId,
  runPlaceOrder,
  runProceedToBuy,
  runSelectAddresses,
  saveOrdersBefore,
} from "./checkout.js";
import type {
  Credentials,
  PaymentCode,
  PaymentSpec,
  ProductSpec,
  RewardMark,
  RewardMarkExtra,
  RewardSpec,
  TargetAddress,
} from "./config.js";
import { pause, sleep } from "./human.js";
import { runLogin } from "./login.js";
import { runApplyCoupon, runOpenProduct, runSetQuantity } from "./product.js";
import { classifyFailure, type StepResult } from "./protocol.js";
import { proxyUnreachable, type Proxy } from "./proxy.js";
import { productIdentity, type BasketItem } from "./purchase-evidence.js";
import type { Page } from "./pw.js";
import { runCheckReward } from "./reward.js";
import { runAddVouchers } from "./vouchers.js";

/**
 * A hard stop for local debugging only. Keep it null in anything the panel
 * drives: the panel's column checkpoints already park runs, and a second park
 * here swallowed the operator's first click after that step.
 */
export const LAST_STEP: string | null = null;

export interface StepContext {
  creds: Credentials;
  address: TargetAddress;
  /** Every Address row of the account's code; 2+ means a multi-address checkout. */
  addresses: TargetAddress[];
  products: ProductSpec[];
  payment: PaymentSpec;
  /** The Reward-tab rows this account's reward code points at, in sheet order. */
  rewards: RewardSpec[];
  /** Records a Reward row's status on the master (and from there the sheet). */
  markReward?: (r: RewardSpec, status: RewardMark, extra?: RewardMarkExtra) => Promise<void>;
  /** Records a Vouchers row as Used on the master (and from there the sheet). */
  markVoucher?: (v: PaymentCode) => Promise<void>;
  /** The proxy the browser was launched through; login checks it answers first. */
  proxy?: Proxy | null;
  runId: string;
  artifactsDir: string;
  /** Remove blocks: the operator aligned the checkout by hand (RunnerConfig.unblocked). */
  unblocked?: boolean;
}

export function idempotencyKey(ctx: StepContext): string {
  return createHash("sha256").update(`${process.env.RUN_ID ?? ctx.artifactsDir}|${process.env.JOB_ID ?? "standalone"}`).digest("hex").slice(0, 32);
}

function toResult(r: { ok: true; detail?: string } | { ok: false; reason: string }): StepResult {
  if (r.ok) {
    if (r.detail) console.log(`[bot] ✓ ${r.detail}`);
    return { status: "succeeded" };
  }
  return {
    status: "failed",
    failure_code: classifyFailure(r.reason),
    detail: r.reason,
    retriable: true,
  };
}

/** The account's delivery addresses; the single `address` when the job has no list. */
export function deliveryAddresses(ctx: Pick<StepContext, "address" | "addresses">): TargetAddress[] {
  return ctx.addresses.length > 0 ? ctx.addresses : [ctx.address];
}

/** What add_items put in the cart, with each item's per-address shares; null before add_items ran. */
function readBasket(artifactsDir: string): BasketItem[] | null {
  const path = join(artifactsDir, "expected-basket.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BasketItem[]) : null;
}

export interface StepDef {
  key: string;
  timeoutMs: number;
  inactivityMs?: number;
  run(page: Page, ctx: StepContext): Promise<StepResult>;
}

/**
 * Every step may take 10 minutes (user, 2026-10-09): 2 min failed set_address
 * on its 6th address and cut short the slower, steadier checkout.
 */
const STEP_TIMEOUT_MS = 600_000;

export const STEPS: StepDef[] = [
  {
    key: "login",
    // Covers runLogin's own budget (LOGIN_TIMEOUT_MS, 200s) plus its final signed-in check.
    timeoutMs: STEP_TIMEOUT_MS,
    inactivityMs: 120_000,
    run: async (page, ctx) => {
      // A proxy is to blame only until Amazon's first sign-in page shows
      // (user, 2026-10-09); after that, login failures are the account's.
      // Final codes (failures.ts FINAL_FAILURES) end the run: browser closed, row CANCELLED.
      const badProxy = (why: string): StepResult => ({
        status: "failed",
        failure_code: "proxy_bad",
        detail: `proxy ${ctx.proxy!.label} failed before the sign-in page: ${why}`,
        retriable: false,
      });
      if (ctx.proxy) {
        const why = await proxyUnreachable(ctx.proxy);
        if (why) return badProxy(`unreachable (${why})`);
        console.log(`[bot] proxy ${ctx.proxy.label} answers`);
      }
      const r = await runLogin(page, ctx.creds);
      if (r.ok) return { status: "succeeded" };
      if (r.blocked) return { status: "failed", failure_code: "account_blocked", detail: r.reason, retriable: false };
      if (r.refused) return { status: "failed", failure_code: "sign_in_refused", detail: r.reason, retriable: false };
      if (r.business) return { status: "failed", failure_code: "business_account", detail: r.reason, retriable: false };
      // Amazon said the password is wrong: final too, like a blocked account.
      if (r.reachedSignIn && classifyFailure(r.reason) === "password_incorrect") {
        return { status: "failed", failure_code: "password_incorrect", detail: r.reason, retriable: false };
      }
      if (ctx.proxy && !r.reachedSignIn) return badProxy(r.reason);
      return {
        status: "failed",
        failure_code: classifyFailure(r.reason),
        detail: r.reason,
        retriable: true,
      };
    },
  },
  {
    key: "check_reward",
    timeoutMs: STEP_TIMEOUT_MS,
    inactivityMs: 90_000,
    run: async (page, ctx) => {
      const r = await runCheckReward(page, ctx.rewards, ctx.markReward);
      if (!r.ok) {
        return {
          status: "failed",
          failure_code: classifyFailure(r.reason),
          detail: r.reason,
          retriable: r.retriable ?? true,
        };
      }
      console.log(`[bot] ✓ rewards: ${r.detail}`);
      // A coupon already claimed is a success (it is the account's, and the
      // row is marked COMPLETED); "skipped" only when every row was COMPLETED
      // in the sheet before this run and nothing was opened.
      return r.outcome === "all_completed" ? { status: "skipped" } : { status: "succeeded" };
    },
  },
  {
    key: "set_address",
    timeoutMs: STEP_TIMEOUT_MS,
    inactivityMs: 90_000,
    run: async (page, ctx) => {
      const r = await runAddresses(page, deliveryAddresses(ctx));
      return r.ok
        ? { status: "succeeded" }
        : {
          status: "failed",
          failure_code: classifyFailure(r.reason),
          detail: r.reason,
          retriable: true,
        };
    },
  },
  {
    key: "clear_cart",
    timeoutMs: STEP_TIMEOUT_MS,
    inactivityMs: 60_000,
    run: async (page) => toResult(await runClearCart(page)),
  },
  {
    key: "add_items",
    timeoutMs: 600_000,
    inactivityMs: 120_000,
    run: async (page, ctx) => {
      if (ctx.products.length === 0) {
        return {
          status: "failed",
          failure_code: "missing_field",
          detail: "no items for this user - add rows to the Items tab with a matching user_id",
          retriable: false,
        };
      }

      const plan = allocate(ctx.products, deliveryAddresses(ctx));
      if (typeof plan === "string") {
        return { status: "failed", failure_code: "missing_field", detail: plan, retriable: false };
      }

      const cleared = await runClearCart(page);
      if (!cleared.ok) return toResult(cleared);

      const expected: BasketItem[] = [];
      /**
       * Free products the product pages offer ("Free with this product"): one
       * unit per order for each product that offers it (a Lifebuoy pack x4
       * brought one shampoo, 2026-10-08). Taken from the product page alone —
       * the cart does not list them; Amazon adds them at checkout.
       */
      const pageOffers: FreeItem[] = [];
      const expectsFree = plan.free.some((q) => q > 0);
      for (const [i, item] of ctx.products.entries()) {
        // The Items quantity, with several addresses too: allocate() checked
        // the addresses add up to it, and select_address spreads it.
        const label = `item ${i + 1}/${ctx.products.length}`;
        console.log(
          `[bot] -- ${label}: ${item.url} x${item.quantity}` +
          (plan.multi ? ` (${plan.totals[i]} over ${plan.shares[i]!.join("/")})` : "") + " --",
        );

        const opened = await runOpenProduct(page, item);
        if (!opened.ok) return toResult({ ok: false, reason: `${label}: ${opened.reason}` });
        expected.push({
          ...(await productIdentity(page, item)),
          quantity: plan.totals[i]!,
          ...(plan.multi ? { shares: plan.shares[i]! } : {}),
        });
        const qty = await runSetQuantity(page, item);
        if (!qty.ok) return toResult({ ok: false, reason: `${label}: ${qty.reason}` });

        // Only an apply_coupon TRUE row presses the product page's coupon box.
        const coupon = item.applyCoupon === true ? await runApplyCoupon(page) : { ok: true as const };
        if (!coupon.ok) return toResult({ ok: false, reason: `${label}: ${coupon.reason}` });

        // The product page's "Free with this product" — a lenient look: it is
        // not always shown, and the cart's own message is checked after the adds.
        const freebie = await readOfferedFreebie(page, 3_000);
        if (freebie?.sku) {
          console.log(`[bot] ${label}: product page offers a free ${freebie.title.slice(0, 60) || freebie.sku} (${freebie.sku})`);
          const same = pageOffers.find((f) => f.sku === freebie.sku);
          if (same) same.quantity += 1;
          else pageOffers.push({ sku: freebie.sku, title: freebie.title || freebie.sku, quantity: 1 });
        }

        const added = await runAddToCart(page);
        if (!added.ok) return toResult({ ok: false, reason: `${label}: ${added.reason}` });
      }

      // Free products Amazon will add at checkout. The "N FREE item(s) will be
      // added to your order" box covers the whole cart, so it decides when
      // shown: first on the "Added to cart" page the last add landed on, then
      // (only if nothing was found anywhere yet and the sheet expects one) on
      // the cart page. Else the product pages' offers. Fails only when the
      // sheet expects a free item and none of the three shows one.
      let freeItems: FreeItem[] = await readFreebieMessages(page);
      let source = "the Added to cart page";
      if (freeItems.length === 0 && pageOffers.length === 0 && expectsFree) {
        await pause("checking the cart for the free item");
        await openCart(page);
        await sleep(1500);
        freeItems = await readFreebieMessages(page);
        source = "the cart page";
      }
      if (freeItems.length === 0 && pageOffers.length > 0) {
        freeItems = pageOffers;
        source = "the product page";
      }
      if (freeItems.length > 0) console.log(`[bot] free item(s) from ${source}`);
      // Routed by "*_N", and part of the basket every later check holds checkout to.
      const freeShares = placeFreeItems(plan, freeItems);
      if (typeof freeShares === "string") {
        return { status: "failed", failure_code: "missing_field", detail: freeShares, retriable: false };
      }
      for (const [f, item] of freeItems.entries()) {
        console.log(
          `[bot] free item: ${item.title.slice(0, 60)} (${item.sku}) x${item.quantity}` +
          (freeShares ? ` -> ${freeShares[f]!.join("/")}` : ""),
        );
        expected.push({ ...item, free: true, ...(freeShares ? { shares: freeShares[f]! } : {}) });
      }

      writeFileSync(join(ctx.artifactsDir, "expected-basket.json"), JSON.stringify(expected));
      const free = freeItems.reduce((n, f) => n + f.quantity, 0);
      return toResult({ ok: true, detail: `${ctx.products.length} item(s) in cart${free ? `, ${free} free at checkout` : ""}` });
    },
  },
  {
    key: "proceed_to_buy",
    timeoutMs: STEP_TIMEOUT_MS,
    inactivityMs: 60_000,
    run: async (page) => toResult(await runProceedToBuy(page)),
  },
  {
    key: "add_vouchers",
    // Each code waits on the page's verdict, with human pauses around it.
    timeoutMs: 600_000,
    inactivityMs: 120_000,
    run: async (page, ctx) => {
      const r = await runAddVouchers(page, ctx.payment.codes, ctx.artifactsDir, ctx.markVoucher);
      if (r.status === "failed") return toResult({ ok: false, reason: r.reason });
      console.log(`[bot] ✓ ${r.detail}`);
      return { status: r.status === "done" ? "succeeded" : "skipped" };
    },
  },
  {
    key: "select_address",
    timeoutMs: STEP_TIMEOUT_MS,
    inactivityMs: 60_000,
    run: async (page, ctx) => {
      const targets = deliveryAddresses(ctx);
      const opts = { unblocked: ctx.unblocked === true };
      if (targets.length < 2) return toResult(await runSelectAddresses(page, targets, [], opts));
      const basket = readBasket(ctx.artifactsDir);
      if (!basket?.length || basket.some((b) => b.shares?.length !== targets.length)) {
        return toResult({ ok: false, reason: "no per-address basket from add_items - run add_items again" });
      }
      return toResult(await runSelectAddresses(page, targets, basket, opts));
    },
  },
  {
    key: "select_payment",
    timeoutMs: STEP_TIMEOUT_MS,
    inactivityMs: 90_000,
    run: async (page, ctx) => {
      const paid = await runApplyPayment(page, ctx.payment);
      // Your Orders before Pay Now can be pressed — by the next step, or by
      // hand while the run is parked here (note_order_id then finds the
      // order). Taken even when this step fails: Remove blocks goes on past it.
      await saveOrdersBefore(page, ctx.artifactsDir).catch((err: Error) =>
        console.warn(`[bot] could not note Your Orders before Pay Now: ${err.message.split("\n")[0]}`));
      return toResult(paid);
    },
  },
  {
    // Your Orders FIRST: an order for the sheet's address names (placed by
    // hand, or by an earlier press) is taken and the row is DONE — no Pay
    // Now. Otherwise Pay Now, then the ids the same way. Was confirm_order +
    // note_order_id until 2026-10-07; orders-first since 2026-10-08.
    key: "note_order_id",
    timeoutMs: STEP_TIMEOUT_MS,
    inactivityMs: 180_000,
    run: async (page, ctx) => {
      const key = idempotencyKey(ctx);
      const targets = deliveryAddresses(ctx);
      const existing = await lookUpOrders(page, ctx.artifactsDir, key, targets);
      if (existing.ok) {
        console.log(`[bot] Your Orders already has ${existing.detail} — taking it, no Pay Now`);
        return toResult(await recordOrders(page, key, ctx.artifactsDir, targets, existing));
      }
      console.log(`[bot] ${existing.reason} — pressing Pay Now`);
      const placed = await runPlaceOrder(page, key, ctx.artifactsDir, targets, { unblocked: ctx.unblocked === true });
      if (!placed.ok) return toResult(placed);
      return toResult(await runNoteOrderId(page, key, ctx.artifactsDir, targets));
    },
  },
];

/**
 * REMOVE BLOCKS — the steps whose failures are passed over (proceed_to_buy up
 * to, not including, note_order_id; that step drops its own checks). The
 * panel's Remove blocks also starts the run here.
 */
export const UNBLOCKABLE_FROM: number = STEPS.findIndex((s) => s.key === "proceed_to_buy");
export const UNBLOCKABLE_UNTIL: number = STEPS.findIndex((s) => s.key === "note_order_id");

export function stepAt(index: number): StepDef | undefined {
  return STEPS[index];
}

export const LAST_STEP_INDEX: number = (() => {
  if (LAST_STEP === null) return -1;
  const i = STEPS.findIndex((s) => s.key === LAST_STEP);
  if (i < 0) {
    throw new Error(
      `LAST_STEP in steps.ts is "${LAST_STEP}", which is not a step key. ` +
      `Use one of: ${STEPS.map((s) => s.key).join(", ")}`,
    );
  }
  return i;
})();
