import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { productIdentity, type BasketItem } from "./purchase-evidence.js";
import type { Page } from "./pw.js";
import type { Credentials, PaymentSpec, ProductSpec, RewardMark, RewardSpec, TargetAddress } from "./config.js";
import { runLogin } from "./login.js";
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
  markReward?: (r: RewardSpec, status: RewardMark) => Promise<void>;
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

/**
 * The cart quantity: every address receives the item's sheet quantity, so a
 * multi-address account needs quantity x addresses in the cart.
 */
export function cartQuantity(item: ProductSpec, addressCount: number): ProductSpec {
  return addressCount > 1 ? { ...item, quantity: item.quantity * addressCount } : item;
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
    timeoutMs: 180_000,
    inactivityMs: 120_000,
    run: async (page, ctx) => {
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

      const cleared = await runClearCart(page);
      if (!cleared.ok) return toResult(cleared);

      const expected: BasketItem[] = [];
      const addressCount = deliveryAddresses(ctx).length;
      for (const [i, sheetItem] of ctx.products.entries()) {
        const item = cartQuantity(sheetItem, addressCount);
        const label = `item ${i + 1}/${ctx.products.length}`;
        console.log(`[bot] -- ${label}: ${item.url} x${item.quantity} --`);

        const opened = await runOpenProduct(page, item);
        if (!opened.ok) return toResult({ ok: false, reason: `${label}: ${opened.reason}` });
        expected.push(await productIdentity(page, item));

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
    key: "select_address",
    timeoutMs: 120_000,
    inactivityMs: 60_000,
    run: async (page, ctx) => toResult(await runSelectAddresses(page, deliveryAddresses(ctx))),
  },
  {
    key: "select_payment",
    timeoutMs: 120_000,
    inactivityMs: 90_000,
    run: async (page, ctx) => toResult(await runApplyPayment(page, ctx.payment)),
  },
  {
    key: "confirm_order",
    timeoutMs: 180_000,
    inactivityMs: 180_000,
    run: async (page, ctx) =>
      toResult(await runPlaceOrder(page, idempotencyKey(ctx), ctx.artifactsDir, deliveryAddresses(ctx))),
  },
  {
    key: "note_order_id",
    timeoutMs: 120_000,
    inactivityMs: 60_000,
    run: async (page, ctx) =>
      toResult(await runNoteOrderId(page, idempotencyKey(ctx), ctx.artifactsDir, deliveryAddresses(ctx))),
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
