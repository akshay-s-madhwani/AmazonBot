import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productIdentity, type BasketItem } from "./purchase-evidence.js";
import type { Page } from "./pw.js";
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
import { runLogin } from "./login.js";
import { proxyUnreachable, type Proxy } from "./proxy.js";
import { runCheckReward } from "./reward.js";
import { runAddresses } from "./address.js";
import { runApplyCoupon, runOpenProduct, runSetQuantity } from "./product.js";
import {
  runAddToCart,
  runApplyPayment,
  runClearCart,
  runNoteOrderId,
  runPlaceOrder,
  runProceedToBuy,
  runSelectAddresses,
} from "./checkout.js";
import { classifyFailure, type StepResult } from "./protocol.js";
import { allocate } from "./allocation.js";
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

export const STEPS: StepDef[] = [
  {
    key: "login",
    // Covers runLogin's own budget (LOGIN_TIMEOUT_MS, 200s) plus its final signed-in check.
    timeoutMs: 300_000,
    inactivityMs: 120_000,
    run: async (page, ctx) => {
      // Before the first Amazon page: a dead proxy fails here, by name.
      if (ctx.proxy) {
        const why = await proxyUnreachable(ctx.proxy);
        if (why) return toResult({ ok: false, reason: `proxy ${ctx.proxy.label} unreachable: ${why}` });
        console.log(`[bot] proxy ${ctx.proxy.label} answers`);
      }
      const r = await runLogin(page, ctx.creds);
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
    key: "check_reward",
    timeoutMs: 300_000,
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
      // Already claimed / COMPLETED rows are the only "nothing to do" outcomes.
      return r.outcome === "collected" ? { status: "succeeded" } : { status: "skipped" };
    },
  },
  {
    key: "set_address",
    timeoutMs: 120_000,
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
    timeoutMs: 120_000,
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

        const coupon = item.applyCoupon === false ? { ok: true as const } : await runApplyCoupon(page);
        if (!coupon.ok) return toResult({ ok: false, reason: `${label}: ${coupon.reason}` });

        const added = await runAddToCart(page);
        if (!added.ok) return toResult({ ok: false, reason: `${label}: ${added.reason}` });
      }
      writeFileSync(join(ctx.artifactsDir, "expected-basket.json"), JSON.stringify(expected));
      return toResult({ ok: true, detail: `${ctx.products.length} item(s) in cart` });
    },
  },
  {
    key: "proceed_to_buy",
    timeoutMs: 120_000,
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
    timeoutMs: 120_000,
    inactivityMs: 60_000,
    run: async (page, ctx) => {
      const targets = deliveryAddresses(ctx);
      if (targets.length < 2) return toResult(await runSelectAddresses(page, targets, []));
      const basket = readBasket(ctx.artifactsDir);
      if (!basket?.length || basket.some((b) => b.shares?.length !== targets.length)) {
        return toResult({ ok: false, reason: "no per-address basket from add_items - run add_items again" });
      }
      return toResult(await runSelectAddresses(page, targets, basket));
    },
  },
  {
    key: "select_payment",
    timeoutMs: 120_000,
    inactivityMs: 90_000,
    run: async (page, ctx) => toResult(await runApplyPayment(page, ctx.payment)),
  },
  {
    // Pay Now (skipped when this run already pressed it), then the ids from
    // Your Orders. Was confirm_order + note_order_id until 2026-10-07.
    key: "note_order_id",
    timeoutMs: 300_000,
    inactivityMs: 180_000,
    run: async (page, ctx) => {
      const placed = await runPlaceOrder(page, idempotencyKey(ctx), ctx.artifactsDir, deliveryAddresses(ctx));
      if (!placed.ok) return toResult(placed);
      return toResult(await runNoteOrderId(page, idempotencyKey(ctx), ctx.artifactsDir, deliveryAddresses(ctx)));
    },
  },
];

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
