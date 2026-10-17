import type { BrowserContext, Page } from "./pw.js";

/**
 * STUCK PAGES (user, 2026-10-09): a page that has not finished loading after
 * PAGE_STALL_MS (90 s) is refreshed and its step restarted — at most
 * STALL_RESTARTS (3) times, then the step fails. The 2-minute cap is on a
 * single wait, never on a step's running time: every single wait in the bot
 * is already ≤ 90 s, so this catches the one thing that could wait forever,
 * a page that never loads.
 *
 * "Not finished loading": document.readyState is not "complete", or the page
 * does not answer at all (a hung renderer), on the same address the whole
 * time. A page that moves to another address starts its clock again.
 *
 * The restart is a NEW runner process from the same step (the slot spawns
 * it): the stalled attempt cannot be cancelled in place, and left running it
 * could keep clicking alongside the new one.
 */
export const PAGE_STALL_MS = Number(process.env.PAGE_STALL_MS ?? 90_000);
export const STALL_RESTARTS = 3;
/** The runner's exit code for "restart this step". */
export const STALL_EXIT_CODE = 75;

const CHECK_MS = 5_000;
const ANSWER_MS = 10_000;

export interface Stall {
  page: Page;
  url: string;
  state: string;
  forMs: number;
}

/** How a page is doing: its readyState, or "hung" when it does not answer. */
async function readiness(page: Page): Promise<string> {
  return Promise.race([
    page.evaluate(() => document.readyState).catch(() => "error"),
    new Promise<string>((r) => setTimeout(() => r("hung"), ANSWER_MS)),
  ]);
}

/**
 * Watches every open tab while a step runs; calls onStall once with the
 * first page that stays unloaded for PAGE_STALL_MS. Returns a stop function.
 */
export function watchForStall(context: BrowserContext, onStall: (s: Stall) => void): () => void {
  const since = new Map<Page, { url: string; at: number }>();
  let stopped = false;
  let checking = false;
  const timer = setInterval(() => {
    if (stopped || checking) return;
    checking = true;
    void (async () => {
      try {
        for (const page of context.pages()) {
          if (stopped) return;
          if (page.isClosed()) {
            since.delete(page);
            continue;
          }
          const url = page.url();
          // A page that errored out ("error") is loaded as far as it goes.
          const state = url === "about:blank" ? "complete" : await readiness(page);
          if (state === "complete" || state === "error") {
            since.delete(page);
            continue;
          }
          const seen = since.get(page);
          if (!seen || seen.url !== url) {
            since.set(page, { url, at: Date.now() });
            continue;
          }
          const forMs = Date.now() - seen.at;
          if (forMs >= PAGE_STALL_MS) {
            stopped = true;
            clearInterval(timer);
            onStall({ page, url, state, forMs });
            return;
          }
        }
      } finally {
        checking = false;
      }
    })();
  }, CHECK_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Refreshes the step's main page with a GET of its address (never a reload:
 * that would re-send a form the page was posting, a voucher or Pay Now).
 * Side tabs are closed instead — the step opens its own again.
 */
export async function recoverFromStall(context: BrowserContext, main: Page): Promise<void> {
  for (const p of context.pages()) {
    if (p === main || p.isClosed()) continue;
    if (p.url() === "about:blank") continue;
    await p.close().catch(() => {});
  }
  const url = main.url();
  if (!url || url === "about:blank") return;
  await main.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  await main.bringToFront().catch(() => {});
}
