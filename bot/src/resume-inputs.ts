import { rewardDone } from "./config.js";
import type { SheetJob } from "./job-client.js";

/**
 * An unfinished Reward row that is new or edited. A row turning COMPLETED is
 * the run's own progress, not an operator's change, so it moves nothing.
 */
function rewardsChanged(previous: SheetJob, current: SheetJob): boolean {
  const key = (r: SheetJob["rewards"][number]) => JSON.stringify([r.row, r.type, r.url, r.answer, r.coupons]);
  const before = new Set((previous.rewards ?? []).map(key));
  return (current.rewards ?? []).some((r) => !rewardDone(r) && !before.has(key(r)));
}

export function resumeStep(previous: SheetJob, current: SheetJob, requested: number): number {
  const changed = (key: "credentials" | "address" | "items" | "payment") =>
    JSON.stringify(previous[key]) !== JSON.stringify(current[key]);
  let from = requested;
  if (changed("credentials")) from = 0;
  if (rewardsChanged(previous, current)) from = Math.min(from, 1);
  if (changed("address") || JSON.stringify(previous.addresses ?? []) !== JSON.stringify(current.addresses ?? [])) {
    from = Math.min(from, 2);
  }
  if (changed("items")) from = Math.min(from, 3);
  if (changed("payment")) from = Math.min(from, 7);
  return from;
}

export function inputsChanged(previous: SheetJob, current: SheetJob): boolean {
  return resumeStep(previous, current, 10) !== 10;
}
