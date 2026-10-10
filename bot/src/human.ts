const PACE = (() => {
  const raw = Number((process.env.BOT_PACE ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(3, Math.max(0.3, raw));
})();

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function rand(minMs: number, maxMs: number): number {
  return Math.floor((minMs + Math.random() * (maxMs - minMs)) * PACE);
}

export async function pause(reason = ""): Promise<void> {
  const ms = rand(800, 2000);
  if (reason) console.log(`[bot] waiting ${(ms / 1000).toFixed(1)}s (${reason})`);
  await sleep(ms);
}

export async function shortPause(): Promise<void> {
  await sleep(rand(400, 850));
}

/**
 * Checkout's pauses: never quicker than BOT_PACE 1. At 0.3 (0.3–0.6s waits)
 * checkout raced its own page updates — the multi-address list read while
 * Amazon was still redrawing it (2026-10-09). A slower pace still slows them.
 */
const STEADY = Math.max(1, PACE);

export async function steadyPause(reason = ""): Promise<void> {
  const ms = Math.floor((800 + Math.random() * 1200) * STEADY);
  if (reason) console.log(`[bot] waiting ${(ms / 1000).toFixed(1)}s (${reason})`);
  await sleep(ms);
}

export async function steadyShortPause(): Promise<void> {
  await sleep(Math.floor((400 + Math.random() * 450) * STEADY));
}
