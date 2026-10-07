import { STEP_KEYS, type StepKey } from "@app/contracts";
import type { SheetJob } from "./job-client.js";

/**
 * RESUME STARTS WHERE THE OPERATOR ASKED (decided 2026-10-07). Sheet edits are
 * still adopted — the runner gets the fresh job — but they only take effect in
 * the steps that run from there. The one exception is the basket: changed
 * Items (or an address's ItemsQuantity split) go back to clear_cart, because
 * the cart already holds the old basket.
 */

/** By key, so inserting a step cannot point an edit at the wrong one. */
const at = (key: StepKey): number => STEP_KEYS.indexOf(key);

/** What the cart is built from: the items and how they split over the addresses. */
function basketKey(job: SheetJob): string {
  return JSON.stringify([job.items ?? [], (job.addresses ?? []).map((a) => a.itemsQuantity ?? "")]);
}

/**
 * Everything an operator can edit, without the run's own progress (a Reward
 * turning COMPLETED, a voucher turning USED) or the address rows' sheet row
 * numbers, which are where order ids go, not edits.
 */
function editKey(job: SheetJob): string {
  const address = (a: SheetJob["address"] | undefined) => {
    if (!a) return null;
    const { row: _row, ...rest } = a;
    return rest;
  };
  return JSON.stringify([
    job.credentials,
    address(job.address),
    (job.addresses ?? []).map(address),
    job.items ?? [],
    (job.rewards ?? []).map(({ status: _status, ...r }) => r),
    job.payment?.method,
    (job.payment?.codes ?? []).map(({ status: _status, ...c }) => c),
  ]);
}

export function resumeStep(previous: SheetJob, current: SheetJob, requested: number): number {
  return basketKey(previous) !== basketKey(current) ? Math.min(requested, at("clear_cart")) : requested;
}

/** Did the operator edit anything this run's runner should be handed? */
export function inputsChanged(previous: SheetJob, current: SheetJob): boolean {
  return editKey(previous) !== editKey(current);
}
