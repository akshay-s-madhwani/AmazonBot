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
