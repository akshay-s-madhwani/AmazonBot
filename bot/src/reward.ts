import { pause, shortPause, sleep } from "./human.js";
import { rewardActionable, rewardDone, type RewardMark, type RewardMarkExtra, type RewardSpec } from "./config.js";
import { couponNumbers, describeCoupon, matchCoupon, parseWantedCoupons, type WantedCoupon } from "./coupons.js";
import type { CDPSession, Locator, Page } from "./pw.js";

/**
 * THE REWARD STEP. Three kinds of page:
 *
 *   coupon    a reward link's coupon page: press each coupon's Collect.
 *   SPIN      the spin game -> spin -> answer the quiz with the row's
 *             `answer` -> Amazon redirects to the won coupons -> collect.
 *   STICKERS  the sticker task page (called ACTIONS until 2026-10-06):
 *             a row of task cards, each "add any item to cart" on a page the
 *             card opens, then a Claim card -> View reward -> collect.
 *
 * A row's reward_url is opened first, whatever its type, and the page it
 * lands on decides which of the three it is (2026-10-08). When the link is
 * dead, expired or already claimed, a SPIN / STICKERS row falls back to that
 * type's default page below; any other type ends there (fails when dead,
 * COMPLETED when already claimed). A SPIN / STICKERS row with no link goes
 * straight to its default page. FunZone is no longer searched.
 *
 * COUPONS. A coupon page can offer one or several coupons. Each coupon's
 * description states two numbers ("₹50 off on ₹250") that are matched against
 * the row's `coupons` cell (see coupons.ts); only matching ones are collected,
 * and those are written to "Found coupons". A blank cell takes any coupon.
 *
 * THE STEP FAILS unless every row ends COMPLETED. A row is COMPLETED when its
 * coupon is collected, or the page shows it already claimed — the coupon's
 * button reads "Order now" / "Redeemed" rather than "Collect now" / "Redeem".
 * Every other outcome fails the row, and its reason goes to the row's notes.
 * Rows are independent: one failing does not stop the rest.
 *
 * The game and coupon pages only render on the MOBILE site, so all of it runs
 * in a separate tab with phone emulation. The run's own tab never leaves the
 * desktop site: emulation set over CDP does not fully reset when the session
 * detaches (the viewport stays), so the mobile tab is closed rather than
 * switched back.
 *
 * SPIN, verified by hand on 2026-09-30 (campaign gSUN0DE):
 *   /game/<id>: .sw-tap-to-spin -> POST /game/<id>/state
 *   -> "Congratulations" + .sw-claim-your-prize-btn ("Answer now")
 *   -> /game/<id> reloads as a quiz: .mcq-option[data-option-id]
 *   -> correct answer redirects to /rewards/checkoutCoupons?uuid=<rewardId>
 *   -> button[id^="amzn1.rewards.reward."] "Collect now" -> POST /h/coupon-actions
 * Once played, the /game/ link goes straight to that coupon page.
 *
 * STICKERS, verified by hand the same day (task page /b?node=221530152031):
 *   cards [data-engagement-streak-count=1..3], each with a
 *   #streakActionButtonServerData carrying data-action-type (ADD_ITEM_TO_CART
 *   or SINGLE_CLICK_CHECK_IN), data-action-url and an activeButton /
 *   lockedButton class. A done card shows "Completed" and loses the button.
 *   -> Start opens the task page in the same tab (price drops, today's deals)
 *   -> a product on it is opened (not the "+" Add to cart icon on its tile,
 *      changed 2026-10-07) and its product page's Add to cart pressed
 *   -> straight back to the task page's URL. The next card turns active.
 *      ("Refresh to check status" is only an image link to the same page.)
 *   -> Claim (SINGLE_CLICK_CHECK_IN) updates the card over ajax to
 *      "View reward" -> /rewards/streaks/checkoutCoupons?streakId=... ->
 *      the same coupon screen as the spin.
 * The items it adds stay in the cart; add_items clears the cart first.
 */

const SPIN_URL = "https://www.amazon.in/game/gSUN0DE";
const STICKERS_URL = "https://www.amazon.in/b?node=221530152031";
const STICKERS_NODE = /[?&]node=221530152031\b/;

const REWARD_BUTTON = 'button[id^="amzn1.rewards.reward."]';
/** Everything a coupon's action can be: Amazon renders some as a-button spans. */
const CONTROLS = 'button, a, [role="button"], input[type="submit"], input[type="button"], .a-button';
/** A coupon still to collect. */
const OPEN_LABEL = /^(collect|collect now|redeem|redeem now)$/i;
/** A coupon already collected. */
/**
 * "Buy Now": the spin's prize page ("Congratulations! This prize is valid
 * till …") grants the coupon outright and offers no Collect (seen 2026-10-08).
 */
const CLAIMED_LABEL = /^(order now|buy now|redeemed|collected)$|available to use/i;
/**
 * A claimed coupon whose card shows a plain label, not a button: "AVAILABLE TO
 * USE DURING GREAT INDIAN FESTIVAL" on /rewards/checkoutCoupons.
 */
const CLAIMED_TEXT = /^available to use\b/i;
const TAP_TO_SPIN = ".sw-tap-to-spin";
/**
 * "Answer now" after the wheel stops. Campaigns differ: gSUN0DE shows it as
 * .sw-claim-your-prize-btn, gMHJQCC in a popup (#gx-popup-footer-close-btn)
 * while a hidden, disabled .sw-claim-your-prize-btn stays in the page.
 */
const ANSWER_NOW = ".sw-claim-your-prize-btn, .gx-popup-footer-close-btn";
const MCQ_OPTION = ".mcq-option";
const TASK_CARD = "[data-engagement-streak-count]";
const TASK_BUTTON = "#streakActionButtonServerData";
const VIEW_REWARD = '[data-mix-operations="viewRewardButtonClick"]';
/** A product tile's link to its product page, on the deals page a task opens. */
const PRODUCT_LINK = 'a[href*="/dp/"], a[href*="/gp/product/"], a[href*="/gp/aw/d/"], a[href*="/deal/"]';
const PRODUCT_PAGE = /\/(dp|gp\/product|gp\/aw\/d)\//i;
/** The product page's own Add to cart, desktop and mobile site. */
const PRODUCT_ADD_TO_CART =
  '#add-to-cart-button, #add-to-cart-button-ubb, input[name="submit.add-to-cart"], button[name="submit.add-to-cart"]';
/** A task card that does not advance after this many tries fails the row. */
const TASK_ATTEMPTS = 3;
const MAX_TASK_ROUNDS = 12;
/** A coupon whose Collect does not take after this many presses fails the row. */
const COLLECT_ATTEMPTS = 3;
/** window.name of the tab this step opens, so a retry can close a stale one. */
const TAB_NAME = "fleet-reward-tab";
/** Notes cell length cap. */
const NOTE_MAX = 300;

const NAV_TIMEOUT_MS = 30_000;
/** How long one screen may take to turn into the next (the wheel spins ~6s). */
const TRANSITION_MS = 25_000;
/** Screens one row may go through: spin, answer, quiz, then a press per coupon. */
const MAX_TRANSITIONS = 20;

export type RewardOutcome = "collected" | "already_claimed" | "all_completed";

export type RewardResult =
  | { ok: true; outcome: RewardOutcome; detail: string }
  | { ok: false; reason: string; retriable?: boolean };

/** One Reward row's outcome. `note` / `reason` go to the row's notes cell. */
type RowResult =
  | { ok: true; outcome: "collected" | "already_claimed"; found: string[]; note: string }
  | {
      ok: false;
      reason: string;
      retriable?: boolean;
      /** No point trying the other rows. */
      fatal?: boolean;
      /** The reward link itself is unusable (bad, expired, not a reward page): try the type's page. */
      dead?: boolean;
    };

const SIGNED_OUT: RowResult = { ok: false, reason: "Signed out", fatal: true };

// ---------------------------------------------------------------------------
// Mobile tab
// ---------------------------------------------------------------------------

interface MobileTab {
  tab: Page;
  session: CDPSession;
}

/** A phone UA on the same Chrome major version the profile already reports. */
async function mobileUserAgent(page: Page): Promise<{ ua: string; major: string }> {
  const desktop = await page.evaluate(() => navigator.userAgent).catch(() => "");
  const major = desktop.match(/Chrome\/(\d+)/)?.[1] ?? "140";
  return {
    ua: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    major,
  };
}

/** The reward step's mobile tab while it is open (it is left open when a row fails). */
export async function openRewardTab(page: Page): Promise<Page | null> {
  for (const p of page.context().pages()) {
    if (p === page || p.isClosed()) continue;
    if ((await p.evaluate(() => window.name).catch(() => "")) === TAB_NAME) return p;
  }
  return null;
}

async function closeStaleTabs(page: Page): Promise<void> {
  for (const p of page.context().pages()) {
    if (p === page) continue;
    const name = await p.evaluate(() => window.name).catch(() => "");
    if (name === TAB_NAME) await p.close().catch(() => {});
  }
}

async function openMobileTab(page: Page): Promise<MobileTab> {
  await closeStaleTabs(page);
  const { ua, major } = await mobileUserAgent(page);
  const tab = await page.context().newPage();
  // In front: a tab left behind another takes no clicks (see vouchers.ts).
  await tab.bringToFront().catch(() => {});
  const session = await page.context().newCDPSession(tab);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
  });
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await session.send("Emulation.setUserAgentOverride", {
    userAgent: ua,
    platform: "Linux armv8l",
    userAgentMetadata: {
      brands: [
        { brand: "Chromium", version: major },
        { brand: "Google Chrome", version: major },
        { brand: "Not_A Brand", version: "24" },
      ],
      fullVersion: `${major}.0.0.0`,
      platform: "Android",
      platformVersion: "10.0.0",
      architecture: "",
      model: "K",
      mobile: true,
    },
  });
  console.log(`[bot] rewards: opened a mobile tab (Chrome ${major} on Android)`);
  return { tab, session };
}

async function closeMobileTab(page: Page, m: MobileTab): Promise<void> {
  await m.session.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await m.session.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
  await m.session.detach().catch(() => {});
  await m.tab.close().catch(() => {});
  await page.bringToFront().catch(() => {});
}

async function goto(tab: Page, url: string): Promise<boolean> {
  const ok = await tab
    .goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (ok) await tab.evaluate((n) => (window.name = n), TAB_NAME).catch(() => {});
  return ok;
}

function signedOut(tab: Page): boolean {
  // /ax/claim is Amazon's sign-in too: where a game link goes without a session.
  return /\/ap\/signin|\/ax\/claim/.test(tab.url());
}

/** The page is drawn signed out: its header says "Sign in", or a button "Sign-in to collect". */
async function drawnSignedOut(tab: Page): Promise<boolean> {
  return tab
    .evaluate(() => {
      const squash = (s: string) => s.replace(/\s+/g, " ").trim();
      const shown = (e: Element) => e.getBoundingClientRect().width > 0;
      const label = (e: Element) => squash((e as HTMLElement).innerText || (e as HTMLInputElement).value || "");
      const header = [...document.querySelectorAll("#nav-logobar-greeting, #nav-link-accountList-nav-line-1")]
        .filter(shown)
        .some((e) => /^(hello, )?sign[- ]?in\b/i.test(label(e)));
      const button = [...document.querySelectorAll("button, a, .a-button, input[type=submit]")]
        .filter(shown)
        .some((e) => /^sign[- ]?in to\b/i.test(label(e)));
      return header || button;
    })
    .catch(() => false);
}

const SIGNED_OUT_REOPENS = 3;

/**
 * Amazon now and then draws a reward page signed out ("Sign in ›", "Sign-in
 * to collect") with the session still good — it happens after many trips to
 * the rewards pages (2026-10-09). Home, then the page again, up to 3 times.
 * True when the page is (now) signed in; false when it is not, or the home
 * page is signed out too — the session really is gone.
 */
async function reopenSignedIn(tab: Page, url: string): Promise<boolean> {
  for (let i = 1; signedOut(tab) || (await drawnSignedOut(tab)); i++) {
    if (i > SIGNED_OUT_REOPENS) return false;
    console.log(`[bot] rewards: ${where(tab)} shows signed out — home, then the page again (${i}/${SIGNED_OUT_REOPENS})`);
    await pause("reward page drawn signed out");
    if (!(await goto(tab, "https://www.amazon.in/"))) return false;
    await pause("home page loaded");
    if (signedOut(tab) || (await drawnSignedOut(tab))) {
      console.log("[bot] rewards: the home page is signed out too");
      return false;
    }
    if (!(await goto(tab, url))) return false;
    await pause("letting the reward page load");
  }
  return true;
}

/** "the home page" when Amazon sent a reward link there instead of its page, else null. */
function sentHome(tab: Page): string | null {
  try {
    const path = new URL(tab.url()).pathname;
    return path === "/" || /^\/(ref=|gp\/homepage)/.test(path) ? "the home page" : null;
  } catch {
    return null;
  }
}

/** The page the tab is on, short, for a failure reason. */
function where(tab: Page): string {
  try {
    const u = new URL(tab.url());
    return `${u.pathname}${u.search}`.slice(0, 80);
  } catch {
    return tab.url().slice(0, 80);
  }
}

function amazonLink(url: string): boolean {
  return /^https?:\/\/(www\.)?(amazon\.in|amzn\.in)\//i.test(url);
}

// ---------------------------------------------------------------------------
// Game / coupon screens
// ---------------------------------------------------------------------------

interface CouponCard {
  /** Index into querySelectorAll(CONTROLS), for clicking it. */
  idx: number;
  /** The control's id (a reward id for Collect buttons), "" if none. */
  id: string;
  label: string;
  state: "open" | "claimed";
  /** The coupon's own text, without its button. */
  description: string;
}

type Screen =
  | { kind: "wheel" }
  | { kind: "answer_now" }
  | { kind: "quiz"; question: string; options: string[] }
  /** One or more coupons; `pick` on a "Pick any 3 out of 14 · 0/3 selected" page. */
  | { kind: "coupons"; cards: CouponCard[]; pick: { need: number; picked: number } | null }
  /** The page says the reward was already claimed, with no coupon to show. */
  | { kind: "done"; text: string }
  | { kind: "wrong_answer" }
  | { kind: "unknown"; controls: string[] };

/** Which screen of the game or coupon flow is showing. */
async function readScreen(tab: Page): Promise<Screen> {
  return tab
    .evaluate(
      ([tap, answer, mcq, reward, controlSel, openSrc, claimedSrc, claimedTextSrc]) => {
        const shown = (el: Element | null): boolean => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const squash = (s: string) => s.replace(/\s+/g, " ").trim();
        const text = squash(document.body?.innerText ?? "");

        if (/answer you gave was incorrect|not eligible to win the prize/i.test(text)) {
          return { kind: "wrong_answer" as const };
        }

        const options = [...document.querySelectorAll(mcq!)].filter(shown);
        if (options.length > 0) {
          const labels = options.map((o) => squash((o as HTMLElement).innerText));
          // The question is the last line of the quiz card that is not an option or boilerplate.
          let box: Element | null = options[0]!.parentElement;
          while (box && box.parentElement && (box as HTMLElement).innerText.split("\n").length < labels.length + 2) {
            box = box.parentElement;
          }
          const lines = ((box as HTMLElement | null)?.innerText ?? text)
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !labels.includes(l))
            .filter((l) => !/^(well done|answer correctly to claim|you are just a step away)/i.test(l));
          const question = lines.find((l) => /\?|true or false|:/i.test(l)) ?? lines[lines.length - 1] ?? "";
          return { kind: "quiz" as const, question, options: labels };
        }

        // Coupons: every visible control reading Collect/Redeem (open) or
        // Order now/Redeemed (claimed). Off a rewards page only the reward
        // buttons themselves count, so a deal's "Order now" is not a coupon.
        const open = new RegExp(openSrc!, "i");
        const claimed = new RegExp(claimedSrc!, "i");
        const claimedText = new RegExp(claimedTextSrc!, "i");
        const rewardPage =
          /\/rewards\//.test(location.pathname) ||
          !!document.querySelector(reward!) ||
          /this prize is valid till/i.test(text);
        const all = [...document.querySelectorAll(controlSel!)];
        const hits: Array<{ el: HTMLElement; idx: number; label: string; state: "open" | "claimed" }> = [];
        all.forEach((el, idx) => {
          if (!shown(el)) return;
          const h = el as HTMLElement;
          const label = squash(h.innerText || (h as HTMLInputElement).value || "");
          const state = open.test(label) ? "open" : claimed.test(label) ? "claimed" : null;
          if (!state) return;
          if (!el.matches(reward!) && !rewardPage) return;
          if (state === "open" && ((h as HTMLButtonElement).disabled || h.classList.contains("a-button-disabled"))) return;
          hits.push({ el: h, idx, label, state });
        });
        // Claimed cards labelled by text alone: the innermost element saying so.
        // idx -1: a claimed coupon is never pressed.
        if (rewardPage) {
          for (const el of document.querySelectorAll("div, span, p")) {
            const h = el as HTMLElement;
            const label = squash(h.innerText ?? "");
            if (label.length > 80 || !claimedText.test(label) || !shown(el)) continue;
            if ([...h.children].some((ch) => squash((ch as HTMLElement).innerText ?? "") === label)) continue;
            if (hits.some((o) => o.el.contains(h) || h.contains(o.el))) continue;
            hits.push({ el: h, idx: -1, label, state: "claimed" });
          }
        }
        // An a-button span and the button inside it are one control: keep the innermost.
        const controls = hits.filter((c) => !hits.some((o) => o !== c && c.el.contains(o.el)));
        const cards = controls.map((c) => {
          // The coupon card: the widest ancestor holding no other coupon control.
          let card: HTMLElement = c.el;
          while (card.parentElement && card.parentElement !== document.body) {
            const p = card.parentElement;
            if (controls.some((o) => o !== c && p.contains(o.el))) break;
            if (squash(p.innerText ?? "").length > 500) break;
            card = p;
          }
          return {
            idx: c.idx,
            id: c.el.id ?? "",
            label: c.label,
            state: c.state,
            description: squash((card.innerText ?? "").replace(c.el.innerText ?? "", " ")),
          };
        });
        const pickMatch = text.match(/pick any (\d+) out of (\d+)/i);
        const pick = pickMatch
          ? { need: Number(pickMatch[1]), picked: Number(text.match(/(\d+)\s*\/\s*\d+\s*selected/i)?.[1] ?? 0) }
          : null;
        if (cards.length > 0 || pick) return { kind: "coupons" as const, cards, pick };

        if (/\/(rewards|game)\//.test(location.pathname) &&
          /already (been )?(claimed|collected|redeemed)|you have already (played|claimed)/i.test(text)) {
          return { kind: "done" as const, text: text.slice(0, 120) };
        }

        // Any VISIBLE match: a campaign can keep a hidden copy of a button in the page.
        const visible = (sel: string): boolean =>
          [...document.querySelectorAll(sel)].some(
            (el) => shown(el) && !el.classList.contains("a-button-disabled") && !el.classList.contains("aok-hidden"),
          );
        if (visible(answer!)) return { kind: "answer_now" as const };
        if (visible(tap!)) return { kind: "wheel" as const };

        const labels = [...document.querySelectorAll("button, .a-button, a[role=button]")]
          .filter(shown)
          .map((el) => squash((el as HTMLElement).innerText))
          .filter((l) => l && l.length < 40)
          .slice(0, 8);
        return { kind: "unknown" as const, controls: labels };
      },
      [TAP_TO_SPIN, ANSWER_NOW, MCQ_OPTION, REWARD_BUTTON, CONTROLS, OPEN_LABEL.source, CLAIMED_LABEL.source, CLAIMED_TEXT.source] as const,
    )
    .catch(() => ({ kind: "unknown" as const, controls: [] }));
}

/** Waits for the screen to stop being `from` (and to be recognisable). */
async function nextScreen(tab: Page, from: Screen["kind"], budgetMs = TRANSITION_MS): Promise<Screen> {
  const deadline = Date.now() + budgetMs;
  let s = await readScreen(tab);
  while (Date.now() < deadline && (s.kind === from || s.kind === "unknown")) {
    await sleep(1000);
    s = await readScreen(tab);
  }
  return s;
}

/** Amazon's a-button: the transparent input on top takes the click. */
async function pressAButton(tab: Page, selector: string): Promise<void> {
  // The visible, enabled one: hidden disabled copies of these buttons exist.
  const button = tab
    .locator(selector)
    .filter({ visible: true })
    .and(tab.locator(":not(.a-button-disabled):not(.aok-hidden)"))
    .first();
  const input = button.locator("input.a-button-input");
  const target = (await input.count()) > 0 ? input.first() : button;
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await shortPause();
  await target.click({ timeout: 10_000 });
}

const fold = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The quiz option to pick: the row's `answer` matched case-insensitively
 * (whole option first, else the one option containing it). A blank answer
 * takes the first option. Null when the answer is not among the options —
 * a wrong answer forfeits the prize for the day, so nothing is guessed.
 */
export function chooseAnswer(options: string[], answer: string): string | null {
  if (options.length === 0) return null;
  const want = fold(answer);
  if (!want) return options[0]!;
  const exact = options.find((o) => fold(o) === want);
  if (exact) return exact;
  const partial = options.filter((o) => fold(o).includes(want));
  return partial.length === 1 ? partial[0]! : null;
}

export interface CouponPlan {
  /** Indexes of the open coupons that match, to collect in order (capped by a pick limit). */
  open: number[];
  /** Claimed coupons that match — the row's Found coupons. */
  found: string[];
  /** Claimed coupons that do not match. */
  claimedOther: string[];
  /** Open coupons that do not match. */
  offeredOther: string[];
  pickFull: boolean;
}

function cardKey(c: CouponCard): string {
  return `${c.id}|${c.description}`;
}

export function planCoupons(
  cards: Array<Pick<CouponCard, "state" | "description">>,
  pick: { need: number; picked: number } | null,
  wanted: WantedCoupon[],
): CouponPlan {
  const left = pick ? Math.max(0, pick.need - pick.picked) : Infinity;
  const plan: CouponPlan = { open: [], found: [], claimedOther: [], offeredOther: [], pickFull: left === 0 };
  cards.forEach((c, i) => {
    const numbers = couponNumbers(c.description);
    // A blank Coupons cell takes any coupon, recorded by its own numbers.
    const hit = wanted.length ? matchCoupon(numbers, wanted)?.text ?? null : numbers.length ? describeCoupon(numbers) : "any";
    if (c.state === "claimed") {
      if (hit) {
        if (!plan.found.includes(hit)) plan.found.push(hit);
      } else plan.claimedOther.push(describeCoupon(numbers));
    } else if (hit) {
      if (plan.open.length < left) plan.open.push(i);
    } else plan.offeredOther.push(describeCoupon(numbers));
  });
  return plan;
}

/**
 * Drives whatever screen is showing until the row's coupons are collected:
 * spin, "Answer now", the quiz, then each wanted coupon. Also the whole of a
 * URL reward, which is just the last screen.
 */
async function playThrough(tab: Page, label: string, r: RewardSpec): Promise<RowResult> {
  const wanted = parseWantedCoupons(r.coupons);
  if (r.coupons.trim() && wanted.length === 0) {
    return { ok: false, retriable: false, reason: `Coupons cell unreadable: "${r.coupons.slice(0, 60)}"` };
  }
  const tries = new Map<string, number>();
  /** Wanted coupons this row pressed Collect on. */
  const pressed: string[] = [];
  /** The coupon page of the last Collect press, and whether it was reopened to check it. */
  let couponUrl = "";
  let rechecked = false;
  /**
   * This row spun the wheel, pressed Answer now or answered the quiz. A
   * coupon then shown as already granted was won by this run: the prize page
   * grants it outright, with nothing to Collect.
   */
  let played = false;
  let s = await nextScreen(tab, "unknown", 15_000);

  for (let i = 0; i < MAX_TRANSITIONS; i++) {
    if (signedOut(tab)) return SIGNED_OUT;
    console.log(`[bot] rewards: ${label} screen = ${s.kind}`);

    switch (s.kind) {
      case "wheel":
        await pause("before spinning");
        await pressAButton(tab, TAP_TO_SPIN);
        played = true;
        console.log("[bot] rewards: spun — waiting for the wheel to stop");
        s = await nextScreen(tab, "wheel");
        break;

      case "answer_now":
        await pause("after the wheel stopped");
        await pressAButton(tab, ANSWER_NOW);
        played = true;
        s = await nextScreen(tab, "answer_now");
        break;

      case "quiz": {
        const pick = chooseAnswer(s.options, r.answer);
        if (!pick) {
          console.log(`[bot] rewards: quiz "${s.question}" [${s.options.join(" / ")}] has no option "${r.answer}"`);
          return {
            ok: false,
            retriable: false,
            reason: `Answer "${r.answer}" is not an option (${s.options.join(" / ")})`,
          };
        }
        console.log(`[bot] rewards: quiz "${s.question}" -> ${pick}${r.answer ? "" : " (first option)"}`);
        await pause("reading the question");
        const exact = new RegExp(`^\\s*${pick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
        const option = tab.locator(MCQ_OPTION, { hasText: exact }).first();
        await option.scrollIntoViewIfNeeded().catch(() => {});
        await option.click({ timeout: 10_000 });
        played = true;
        s = await nextScreen(tab, "quiz");
        break;
      }

      case "coupons": {
        const plan = planCoupons(s.cards, s.pick, wanted);
        console.log(
          `[bot] rewards: coupons — ${s.cards.map((c) => `${describeCoupon(couponNumbers(c.description))} [${c.label}]`).join(", ") || "none"}` +
            (s.pick ? ` · picked ${s.pick.picked}/${s.pick.need}` : ""),
        );
        const next = plan.open.length ? s.cards[plan.open[0]!] : undefined;
        if (next) {
          const key = cardKey(next);
          const n = (tries.get(key) ?? 0) + 1;
          tries.set(key, n);
          const name = describeCoupon(couponNumbers(next.description));
          if (n > COLLECT_ATTEMPTS) {
            return { ok: false, reason: `Collect press had no effect on ${name} after ${COLLECT_ATTEMPTS} tries` };
          }
          await pause("before collecting");
          couponUrl = tab.url();
          const control = tab.locator(CONTROLS).nth(next.idx);
          await control.scrollIntoViewIfNeeded().catch(() => {});
          await control.click({ timeout: 10_000 });
          console.log(`[bot] rewards: pressed ${next.label} on ${name}`);
          const hit = wanted.length ? matchCoupon(couponNumbers(next.description), wanted)?.text : name;
          if (hit && !pressed.includes(hit)) pressed.push(hit);
          s = await afterCollect(tab, key, s.pick?.picked ?? -1);
          break;
        }

        // Nothing left to press: what the page shows now decides the row.
        await pause("after collecting");
        const won = pressed.length > 0 || played;
        const outcome = won ? ("collected" as const) : ("already_claimed" as const);
        const verb = pressed.length ? "Collected" : played ? "Won" : "Already claimed";
        if (plan.found.length) {
          return { ok: true, outcome, found: plan.found, note: `${verb} ${plan.found.join(", ")}` };
        }
        if (pressed.length === 0 && plan.claimedOther.length) {
          return { ok: true, outcome, found: [], note: `${verb} ${plan.claimedOther.join(", ")} (not in Coupons)` };
        }
        if (pressed.length === 0 && plan.pickFull) {
          return { ok: true, outcome, found: [], note: "Already claimed (pick limit reached)" };
        }
        if (pressed.length) {
          return { ok: false, reason: `Collected ${pressed.join(", ")} but the page does not show it claimed` };
        }
        const offered = plan.offeredOther.length ? plan.offeredOther.join(", ") : "none";
        return {
          ok: false,
          retriable: false,
          reason: wanted.length ? `No wanted coupon (offered ${offered})` : "No coupon on the page",
        };
      }

      case "done":
        console.log(`[bot] rewards: page says "${s.text}"`);
        if (pressed.length) {
          return { ok: true, outcome: "collected", found: pressed, note: `Collected ${pressed.join(", ")}` };
        }
        return played
          ? { ok: true, outcome: "collected", found: [], note: "Won" }
          : { ok: true, outcome: "already_claimed", found: [], note: "Already claimed" };

      case "wrong_answer":
        return { ok: false, retriable: false, reason: "Quiz answer rejected — no prize today" };

      case "unknown":
        // After a Collect the coupon page can re-render as a store page with
        // no coupon on it (seen 2026-10-07 on gSUN0DE). Reopen it once: a
        // collected coupon then shows "Order Now".
        if (pressed.length && couponUrl && !rechecked) {
          rechecked = true;
          console.log(`[bot] rewards: ${label}: coupon gone after Collect (${tab.url()}) — reopening ${couponUrl}`);
          if (!(await goto(tab, couponUrl))) return { ok: false, reason: "Coupon page did not reload after Collect" };
          await pause("letting the coupon page reload");
          s = await nextScreen(tab, "unknown", 15_000);
          break;
        }
        console.log(`[bot] rewards: ${label}: unrecognised page ${tab.url()} — ${s.controls.join(", ")}`);
        return {
          ok: false,
          reason: `Unrecognised page ${where(tab)}${s.controls.length ? ` (${s.controls.slice(0, 4).join(", ")})` : ""}`,
        };
    }
  }
  return { ok: false, reason: `Still not collected after ${MAX_TRANSITIONS} screens` };
}

/** After pressing Collect: until that coupon turns claimed, leaves, or the pick counter moves. */
async function afterCollect(tab: Page, key: string, pickedBefore: number): Promise<Screen> {
  const deadline = Date.now() + 15_000;
  let s: Screen;
  do {
    await sleep(1000);
    s = await readScreen(tab);
    if (s.kind !== "coupons") {
      if (s.kind !== "unknown") return s;
      continue;
    }
    const card = s.cards.find((c) => cardKey(c) === key);
    if (!card || card.state === "claimed") return s;
    if (s.pick && s.pick.picked > pickedBefore) return s;
  } while (Date.now() < deadline);
  return s;
}

// ---------------------------------------------------------------------------
// STICKERS
// ---------------------------------------------------------------------------

interface TaskCard {
  index: string;
  title: string;
  /** ADD_ITEM_TO_CART, SINGLE_CLICK_CHECK_IN, or "" when the card has no button left. */
  type: string;
  /** The page the card's Start opens (data-action-url), "" if none. */
  actionUrl: string;
  label: string;
  active: boolean;
  completed: boolean;
}

interface TaskBoard {
  cards: TaskCard[];
  viewReward: boolean;
  progress: string;
}

async function readTasks(tab: Page): Promise<TaskBoard> {
  return tab
    .evaluate(
      ([card, button, view]) => {
        const cards = [...document.querySelectorAll(card!)].map((c) => {
          const b = c.querySelector(button!) as HTMLElement | null;
          const text = (c as HTMLElement).innerText.replace(/\s+/g, " ").trim();
          return {
            index: c.getAttribute("data-engagement-streak-count") ?? "?",
            title: (c.querySelector("span[class*=actionText]")?.textContent ?? "").trim(),
            type: b?.dataset.actionType ?? "",
            actionUrl: b?.dataset.actionUrl ?? "",
            label: (b?.innerText ?? "").trim(),
            active: !!b && /activeButton/.test(String(b.className)),
            completed: /\bcompleted\b/i.test(text),
          };
        });
        const v = document.querySelector(view!);
        const viewReward = !!v && v.getBoundingClientRect().width > 0;
        const progress = (document.body?.innerText.match(/\d+\s*\/\s*\d+\s*Tasks/i) ?? [""])[0];
        return { cards, viewReward, progress };
      },
      [TASK_CARD, TASK_BUTTON, VIEW_REWARD] as const,
    )
    .catch(() => ({ cards: [], viewReward: false, progress: "" }));
}

/**
 * The "Day N — Congratulations! Task completed." check-in popup (#checkInDialog)
 * that can open over the task board once a task is done, covering View
 * reward. Closed with its X rather than "Claim your prize": the board's View
 * reward leads to the coupon page, where only the wanted coupons are taken.
 */
const CHECKIN_DIALOG = "#checkInDialog";
const CHECKIN_CLOSE = '[data-mix-operations="closeCheckInDialog"]';

/** True when the popup was showing and is now closed. */
async function dismissCheckInDialog(tab: Page): Promise<boolean> {
  const close = tab.locator(`${CHECKIN_DIALOG} ${CHECKIN_CLOSE}`).first();
  if (!(await close.isVisible().catch(() => false))) return false;
  console.log("[bot] rewards: closing the check-in popup over the task board");
  await shortPause();
  await close.click({ timeout: 10_000 }).catch(() => tab.keyboard.press("Escape").catch(() => {}));
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; ) {
    if (!(await close.isVisible().catch(() => false))) break;
    await sleep(500);
  }
  if (await close.isVisible().catch(() => false)) {
    await tab.keyboard.press("Escape").catch(() => {});
    await sleep(1000);
  }
  await pause("check-in popup closed");
  return !(await close.isVisible().catch(() => false));
}

async function waitForTasks(tab: Page, budgetMs = 20_000): Promise<TaskBoard> {
  const deadline = Date.now() + budgetMs;
  let board = await readTasks(tab);
  while (board.cards.length === 0 && Date.now() < deadline) {
    await sleep(1000);
    board = await readTasks(tab);
  }
  return board;
}

function describeBoard(b: TaskBoard): string {
  const cards = b.cards.map((c) => `${c.title || `card ${c.index}`}: ${c.completed ? "Completed" : c.label || "?"}`);
  return `${b.progress || "?"} — ${cards.join(", ")}${b.viewReward ? ", View reward" : ""}`;
}

async function cartCount(tab: Page): Promise<number> {
  const raw = await tab
    .evaluate(() => (document.querySelector("#nav-button-cart, #nav-cart-count") as HTMLElement | null)?.innerText ?? "")
    .catch(() => "");
  const digits = raw.replace(/\D/g, "");
  return digits ? Number(digits) : -1;
}

/** findProduct picks at random among this many different products on screen. */
const PICK_POOL = 5;

/** Marks the tile findProduct picked, so it is clicked without a second search. */
const PICK_ATTR = "data-fleet-pick";
/** The whole product hunt on one task, within check_reward's 300s. */
const PRODUCT_HUNT_MS = 150_000;

/**
 * The first product tile on the page not opened yet, scrolling down for one.
 * One evaluate per screen, not a locator round trip per link: the festival
 * pages re-render their tiles while they load, and a per-link read of a tile
 * that just went away waits out its timeout — minutes over a page of links.
 * The pick is marked with PICK_ATTR (and its target dropped, so it opens here).
 */
async function findProduct(tab: Page, tried: Set<string>, deadline: number): Promise<{ key: string; href: string } | null> {
  for (let scroll = 0; scroll < 15 && Date.now() < deadline; scroll++) {
    const hit = await tab
      .evaluate(
        ([selector, skip, mark, pool]) => {
          const keyOf = (href: string): string =>
            href.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)?.[1] ?? href.split(/[?#]/)[0]!;
          document.querySelectorAll(`[${mark}]`).forEach((e) => e.removeAttribute(mark));
          // The first few different products on screen, one picked at random:
          // always the first one kept picking a product already in the cart,
          // which never counts for the task (2026-10-08).
          const picks: Array<{ a: HTMLAnchorElement; key: string; href: string }> = [];
          for (const a of document.querySelectorAll<HTMLAnchorElement>(selector)) {
            const href = a.href;
            if (!href) continue;
            const key = keyOf(href);
            if (skip.includes(key) || picks.some((p) => p.key === key)) continue;
            const r = a.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            picks.push({ a, key, href });
            if (picks.length >= pool) break;
          }
          if (picks.length === 0) return null;
          const pick = picks[Math.floor(Math.random() * picks.length)]!;
          pick.a.setAttribute(mark, "1");
          pick.a.removeAttribute("target");
          return { key: pick.key, href: pick.href, of: picks.length };
        },
        [PRODUCT_LINK, [...tried], PICK_ATTR, PICK_POOL] as const,
      )
      .catch(() => null);
    if (hit) {
      console.log(`[bot] rewards: picked ${hit.key} at random from the first ${hit.of} product(s) on screen`);
      return { key: hit.key, href: hit.href };
    }
    console.log(`[bot] rewards: no product link on screen yet — scrolling (${scroll + 1}/15)`);
    await tab.mouse.wheel(0, 700).catch(() => {});
    await sleep(1200);
  }
  return null;
}

/** Clicks the tile findProduct marked; opens its link directly if the click does not navigate. */
async function openProduct(tab: Page, product: { key: string; href: string }): Promise<boolean> {
  const tile = tab.locator(`[${PICK_ATTR}]`).first();
  await tile.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await shortPause();
  const before = tab.url();
  // A tile re-rendered since it was marked is gone: go to its link rather
  // than wait out the click.
  const clicked = await tile.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  const moved =
    clicked &&
    (await tab
      .waitForURL((u) => u.toString() !== before, { timeout: 15_000, waitUntil: "domcontentloaded" })
      .then(() => true)
      .catch(() => false));
  if (moved) return true;
  console.log(`[bot] rewards: ${clicked ? "clicking" : "could not click"} ${product.key} — opening its link`);
  return goto(tab, product.href);
}

/**
 * Press the product page's own Add to cart. Done when Amazon's cart API
 * answers, the cart badge goes up, or the page moves on to the added-to-cart
 * screen. False when the product has no usable button (needs a size or
 * colour first, or is unavailable).
 */
async function addThisProduct(tab: Page): Promise<boolean> {
  const buttons = tab.locator(PRODUCT_ADD_TO_CART);
  let button: Locator | null = null;
  const n = await buttons.count().catch(() => 0);
  for (let i = 0; i < n && !button; i++) {
    const b = buttons.nth(i);
    if ((await b.isVisible().catch(() => false)) && (await b.isEnabled({ timeout: 2_000 }).catch(() => false))) button = b;
  }
  if (!button) return false;
  await button.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
  await shortPause();
  const before = await cartCount(tab);
  const added = tab
    .waitForResponse(
      (r) => r.request().method() === "POST" && /\/cart\/|add-to-cart|addtocart/i.test(r.url()) && r.ok(),
      { timeout: 12_000 },
    )
    .then(() => true)
    .catch(() => false);
  await button.click({ timeout: 10_000 }).catch(() => {});
  const apiOk = await added;
  await sleep(1500);
  const after = await cartCount(tab);
  const moved = /\/cart\b|smart-wagon|huc\//i.test(tab.url());
  if (apiOk || moved || (before >= 0 && after > before)) {
    console.log(`[bot] rewards: added the product to the cart (cart ${before} -> ${after})`);
    return true;
  }
  return false;
}

/**
 * The deals page a task opens: click a product itself (not the "+" icon on
 * its tile), and on its product page press Add to cart. A deal tile can open
 * a deal page first: one more product is picked there. Up to three products,
 * back on the deals page between them — one can need options first. Bounded
 * by PRODUCT_HUNT_MS so a page that never offers a product fails the task
 * with a reason instead of running the step into its timeout.
 */
export async function addProductFromDeals(tab: Page, added: Set<string> = new Set()): Promise<boolean> {
  const dealsUrl = tab.url();
  const deadline = Date.now() + PRODUCT_HUNT_MS;
  // Products this sticker run already put in the cart are never picked again.
  const tried = new Set<string>(added);
  let current = "";
  console.log(`[bot] rewards: looking for a product on ${dealsUrl}`);
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    if (attempt > 0) {
      if (!(await goto(tab, dealsUrl))) return false;
      await pause("back on the deals page");
    }
    // The deals page, then at most one deal page in between.
    let onProduct = false;
    for (let hop = 0; hop < 2 && !onProduct && Date.now() < deadline; hop++) {
      const product = await findProduct(tab, tried, deadline);
      if (!product) {
        console.log(`[bot] rewards: no product to open on ${tab.url()}`);
        break;
      }
      tried.add(product.key);
      current = product.key;
      console.log(`[bot] rewards: opening ${product.key}`);
      if (!(await openProduct(tab, product))) continue;
      await pause("letting the page load");
      onProduct = PRODUCT_PAGE.test(new URL(tab.url()).pathname);
      if (!onProduct) console.log(`[bot] rewards: ${product.key} opened ${tab.url()} — not a product page`);
    }
    if (!onProduct) continue;
    if (await addThisProduct(tab)) {
      added.add(current);
      return true;
    }
    console.log(`[bot] rewards: that product would not add — trying another`);
  }
  if (Date.now() >= deadline) console.log(`[bot] rewards: gave up finding a product after ${PRODUCT_HUNT_MS / 1000}s`);
  return false;
}

/**
 * Start a task: press its Start, and make sure the tab really left the board.
 * A press that lands before the board finishes loading (slow or headless
 * machines) does nothing; the product hunt then ran ON the board, its add did
 * not count for the task, and the card never moved (2026-10-08: "stuck on the
 * first task" — seen in the log as a task "looking for a product" on
 * node=221530152031). If the press opened another tab, that tab is closed.
 * Either way the card's own page (data-action-url) is opened directly.
 */
export async function openTaskPage(tab: Page, button: Locator, card: TaskCard, taskUrl: string): Promise<boolean> {
  const others = new Set(tab.context().pages());
  const before = tab.url();
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click({ timeout: 10_000 }).catch(() => {});
  const moved = await tab
    .waitForURL((u) => u.toString() !== before && !STICKERS_NODE.test(u.toString()), { timeout: 15_000, waitUntil: "domcontentloaded" })
    .then(() => true)
    .catch(() => false);
  for (const p of tab.context().pages()) {
    if (!others.has(p) && p !== tab) await p.close().catch(() => {});
  }
  if (moved) {
    await pause("letting the task's page load");
    return true;
  }
  const url = card.actionUrl.trim();
  if (!amazonLink(url) || url === taskUrl) {
    console.log(`[bot] rewards: Start on "${card.title}" did not open its page, and the card names none`);
    return false;
  }
  console.log(`[bot] rewards: Start on "${card.title}" stayed on the board — opening its page ${url}`);
  if (!(await goto(tab, url))) return false;
  await pause("letting the task's page load");
  return !STICKERS_NODE.test(tab.url());
}

/** Straight back to the task board's own URL after the add. */
async function backToTasks(tab: Page, taskUrl: string): Promise<TaskBoard> {
  await goto(tab, taskUrl);
  await pause("back on the task page");
  // Still signed out after the reopens: playStickers' round says so.
  await reopenSignedIn(tab, taskUrl);
  await dismissCheckInDialog(tab);
  return waitForTasks(tab);
}

/** Back to the task board and press "Refresh to check status" (an image link to the same page). */
async function refreshTasks(tab: Page, taskUrl: string): Promise<TaskBoard> {
  if ((await readTasks(tab)).cards.length === 0) {
    await goto(tab, taskUrl);
    await pause("back on the task page");
  }
  await dismissCheckInDialog(tab);
  const refresh = tab.locator('a:has(img[src*="refresh" i])').first();
  if (await refresh.count()) {
    await refresh.scrollIntoViewIfNeeded().catch(() => {});
    await shortPause();
    await refresh.click({ timeout: 10_000 }).catch(() => tab.reload({ waitUntil: "domcontentloaded" }));
  } else {
    await tab.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  }
  await tab.waitForLoadState("domcontentloaded").catch(() => {});
  await pause("letting the task status refresh");
  return waitForTasks(tab);
}

async function runStickers(tab: Page, r: RewardSpec): Promise<RowResult> {
  console.log(`[bot] rewards: opening the sticker tasks ${STICKERS_URL}`);
  if (!(await goto(tab, STICKERS_URL))) return { ok: false, reason: "Sticker page did not load" };
  await pause("letting the task page load");
  if (!(await reopenSignedIn(tab, STICKERS_URL))) return SIGNED_OUT;
  return playStickers(tab, r);
}

/** The sticker task board the tab is on, through to its reward. */
async function playStickers(tab: Page, r: RewardSpec): Promise<RowResult> {
  const taskUrl = tab.url();

  const attempts = new Map<string, number>();
  /** Products this run added for a task: never picked again, on a retry or the next card. */
  const added = new Set<string>();
  let board = await waitForTasks(tab);
  if (board.cards.length === 0 && (signedOut(tab) || (await drawnSignedOut(tab)))) {
    if (!(await reopenSignedIn(tab, taskUrl))) return SIGNED_OUT;
    board = await waitForTasks(tab);
  }
  if (board.cards.length === 0) {
    console.log(`[bot] rewards: no task cards on ${tab.url()}`);
    return { ok: false, reason: "No sticker tasks on the page" };
  }

  for (let round = 0; round < MAX_TASK_ROUNDS; round++) {
    if (signedOut(tab) || (await drawnSignedOut(tab))) {
      if (!(await reopenSignedIn(tab, taskUrl))) return SIGNED_OUT;
      board = await waitForTasks(tab);
    }
    // Before anything on the board is pressed: the popup covers it.
    if (await dismissCheckInDialog(tab)) board = await readTasks(tab);
    console.log(`[bot] rewards: tasks ${describeBoard(board)}`);

    if (board.viewReward) {
      await pause("before opening the reward");
      await tab.locator(VIEW_REWARD).first().click({ timeout: 10_000 });
      await tab.waitForLoadState("domcontentloaded").catch(() => {});
      await pause("letting the reward page load");
      return playThrough(tab, "stickers reward", r);
    }

    const card = board.cards.find((c) => c.active);
    if (!card) {
      // Every task done and no reward left to view: the page says it is completed.
      if (board.cards.every((c) => c.completed)) {
        return { ok: true, outcome: "already_claimed", found: [], note: "Already completed" };
      }
      return { ok: false, reason: `No sticker task to start (${board.progress || describeBoard(board)})` };
    }
    const tries = (attempts.get(card.index) ?? 0) + 1;
    attempts.set(card.index, tries);
    if (tries > TASK_ATTEMPTS) {
      return { ok: false, reason: `Sticker task "${card.title}" not completed after ${TASK_ATTEMPTS} tries` };
    }
    const button = tab.locator(`${TASK_CARD}[data-engagement-streak-count="${card.index}"] ${TASK_BUTTON}`).first();

    if (card.type === "SINGLE_CLICK_CHECK_IN") {
      console.log(`[bot] rewards: claiming "${card.title}"`);
      await pause("before claiming");
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await button.click({ timeout: 10_000 });
      // The card re-renders in place over ajax.
      await sleep(4000);
      board = await readTasks(tab);
      if (!board.viewReward) board = await refreshTasks(tab, taskUrl);
      continue;
    }

    if (card.type !== "ADD_ITEM_TO_CART") {
      return { ok: false, retriable: false, reason: `Sticker task "${card.title}" (${card.type || "?"}) is not automated` };
    }

    // "Start", or "Try again" when a previous add did not count.
    console.log(`[bot] rewards: task "${card.title}" (${card.label}), try ${tries}`);
    await pause("before starting the task");
    if (!(await openTaskPage(tab, button, card, taskUrl))) {
      return { ok: false, reason: `Sticker task "${card.title}": its page did not open` };
    }
    if (!(await addProductFromDeals(tab, added))) {
      console.log(`[bot] rewards: no product would add to the cart from ${tab.url()}`);
      return { ok: false, reason: `Sticker task "${card.title}": could not add an item to the cart` };
    }
    await pause("after adding to cart");
    board = await backToTasks(tab, taskUrl);
    // Progress can lag the add by a few seconds: look once more before retrying the card.
    if (board.cards.find((c) => c.active)?.index === card.index && !board.viewReward) {
      await sleep(5000);
      board = await backToTasks(tab, taskUrl);
    }
  }
  return { ok: false, reason: `Sticker reward not reached after ${MAX_TASK_ROUNDS} rounds` };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** The default spin game (a row's reward_url is tried before this). */
async function runSpin(tab: Page, r: RewardSpec): Promise<RowResult> {
  console.log(`[bot] rewards: opening the spin game ${SPIN_URL}`);
  if (!(await goto(tab, SPIN_URL))) return { ok: false, reason: "Spin page did not load" };
  await pause("letting the spin wheel load");
  if (!(await reopenSignedIn(tab, SPIN_URL))) return SIGNED_OUT;
  // Amazon sends a game it will not show this account (campaign over, not
  // eligible) to the home page; say so rather than "unrecognised page".
  const home = sentHome(tab);
  if (home) {
    console.log(`[bot] rewards: ${SPIN_URL} opened ${home} (${tab.url()})`);
    return { ok: false, reason: `Spin game opened ${home} — campaign over or not offered to this account` };
  }
  // The default game redirects to the sticker task board once the campaign
  // moves on: playing the board as a game presses the wrong buttons.
  if (STICKERS_NODE.test(tab.url()) || (await tab.locator(TASK_CARD).count().catch(() => 0)) > 0) {
    console.log(`[bot] rewards: spin game ${SPIN_URL} opened the sticker tasks (${tab.url()})`);
    return {
      ok: false,
      retriable: false,
      reason: `Default spin game ${SPIN_URL} now opens the stickers page — put the current spin game link in reward_url`,
    };
  }
  return playThrough(tab, "spin reward", r);
}

/** A page saying the reward link is gone: expired, ended, or Amazon's 404. */
const EXPIRED_TEXT =
  /expired|has ended|no longer (available|valid|active)|offer is not available|not eligible|looking for something\?|not a functioning page|page not found/i;

/**
 * The row's reward_url, whatever its type: the page it lands on says what it
 * is — the sticker task board, a spin game, or a coupon page. `dead` when
 * the link leads nowhere usable.
 */
async function runLink(tab: Page, r: RewardSpec, url: string): Promise<RowResult> {
  if (!amazonLink(url)) return { ok: false, retriable: false, dead: true, reason: "reward_url is not an amazon.in link" };
  console.log(`[bot] rewards: opening ${url}`);
  if (!(await goto(tab, url))) return { ok: false, dead: true, reason: "Reward link did not load" };
  await pause("letting the reward page load");
  if (!(await reopenSignedIn(tab, url))) return SIGNED_OUT;
  const home = sentHome(tab);
  if (home) {
    console.log(`[bot] rewards: ${url} opened ${home} (${tab.url()})`);
    return { ok: false, retriable: false, dead: true, reason: `Reward link opened ${home} — expired or not offered` };
  }

  // The board's cards and the game's wheel can render a few seconds late —
  // and so can the signed-out drawing, which is reopened once more.
  let screen: Screen = { kind: "unknown", controls: [] };
  for (let pass = 0; pass < 2; pass++) {
    for (const deadline = Date.now() + 15_000; ; ) {
      if (STICKERS_NODE.test(tab.url()) || (await tab.locator(TASK_CARD).count().catch(() => 0)) > 0) {
        console.log(`[bot] rewards: link is the sticker tasks (${where(tab)})`);
        return playStickers(tab, r);
      }
      screen = await readScreen(tab);
      if (screen.kind !== "unknown" || Date.now() >= deadline || (await drawnSignedOut(tab))) break;
      await sleep(1000);
    }
    if (screen.kind !== "unknown" || !(signedOut(tab) || (await drawnSignedOut(tab)))) break;
    if (!(await reopenSignedIn(tab, url))) return SIGNED_OUT;
  }
  if (signedOut(tab) || (await drawnSignedOut(tab))) return SIGNED_OUT;
  if (screen.kind === "unknown") {
    const text = await tab.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const expired = text.match(EXPIRED_TEXT)?.[0];
    console.log(`[bot] rewards: link opened ${tab.url()} — ${expired ? `"${expired}"` : "no reward on it"}`);
    if (expired) return { ok: false, retriable: false, dead: true, reason: `Reward link expired ("${expired}")` };
    const controls = screen.controls.length ? ` (${screen.controls.slice(0, 4).join(", ")})` : "";
    return { ok: false, dead: true, reason: `Reward link opened ${where(tab)}${controls}` };
  }
  const game = screen.kind === "wheel" || screen.kind === "answer_now" || screen.kind === "quiz";
  console.log(`[bot] rewards: link is a ${game ? "spin game" : "coupon page"} (${where(tab)})`);
  return playThrough(tab, game ? "spin reward" : "reward link", r);
}

/** host + path (+ node), to tell whether a link is a type's default page. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    const node = u.searchParams.get("node");
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${node ? `?node=${node}` : ""}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * One row: its reward_url first, then — when that link is dead, expired or
 * already claimed — the default page of its SPIN / STICKERS type. Not when
 * the link was (or landed on) that same page: it would only repeat itself.
 * Mid-flow failures on the link (wrong answer, Collect not taking, a sticker
 * task stuck, no wanted coupon) do not fall back.
 */
async function runOne(tab: Page, r: RewardSpec): Promise<RowResult> {
  const fallback = r.type === "spin" ? runSpin : r.type === "stickers" ? runStickers : null;
  const link = r.url.trim();
  if (!link) return fallback ? fallback(tab, r) : { ok: false, retriable: false, reason: "reward_url is blank" };
  const first = await runLink(tab, r, link);
  if (!fallback) return first;
  const usable = first.ok ? first.outcome !== "already_claimed" : !first.dead;
  if (usable) return first;
  const home = r.type === "spin" ? SPIN_URL : STICKERS_URL;
  if ([link, tab.url()].some((u) => pageKey(u) === pageKey(home))) return first;

  const type = r.type.toUpperCase();
  const what = first.ok ? "already claimed" : `failed: ${first.reason}`;
  console.log(`[bot] rewards: link ${what} — falling back to ${type}`);
  await pause("before the fallback reward");
  const second = await fallback(tab, r);
  const prefix = `Link ${what}; ${type}: `;
  return second.ok ? { ...second, note: prefix + second.note } : { ...second, reason: prefix + second.reason };
}

function describe(r: RewardSpec): string {
  return `${r.type.toUpperCase()}${r.row ? ` (Reward row ${r.row})` : ""}`;
}

/**
 * Every Reward row of this account, in sheet order, skipping COMPLETED ones.
 * Each row is marked BLOCKED, then COMPLETED with its found coupons, or left
 * BLOCKED with the reason in its notes (a release puts it back to PENDING).
 * A failed row does not stop the others, but fails the step.
 */
export async function runCheckReward(
  page: Page,
  rewards: RewardSpec[],
  mark: (r: RewardSpec, status: RewardMark, extra?: RewardMarkExtra) => Promise<void> = async () => {},
): Promise<RewardResult> {
  if (rewards.length === 0) {
    return { ok: false, retriable: false, reason: "No Reward rows for this account's reward code" };
  }
  const open = rewards.filter((r) => !rewardDone(r));
  const skipped = rewards.length - open.length;
  // No type the bot knows and no url: nothing to do on that row.
  const todo = open.filter(rewardActionable);
  const ignored = open.length - todo.length;
  if (todo.length === 0) {
    return {
      ok: true,
      outcome: "all_completed",
      detail: [
        skipped && `${skipped} already COMPLETED`,
        ignored && `${ignored} with no type or reward_url ignored`,
      ].filter(Boolean).join("; "),
    };
  }

  await pause("before checking rewards");
  const mobile = await openMobileTab(page);
  const notes: string[] = [
    ...(skipped ? [`${skipped} already COMPLETED`] : []),
    ...(ignored ? [`${ignored} with no type or reward_url ignored`] : []),
  ];
  const failures: string[] = [];
  let retriable = false;
  let collected = false;

  for (const r of todo) {
    console.log(`[bot] rewards: -- ${describe(r)} --`);
    await mark(r, "BLOCKED");
    let result: RowResult;
    try {
      result = await runOne(mobile.tab, r);
    } catch (err) {
      result = { ok: false, reason: `Reward step crashed: ${(err as Error).message.split("\n")[0]}` };
    }
    if (result.ok) {
      await mark(r, "COMPLETED", { found_coupons: result.found.join("\n"), notes: result.note.slice(0, NOTE_MAX) });
      collected ||= result.outcome === "collected";
      notes.push(`${describe(r)}: ${result.note}`);
      continue;
    }
    console.log(`[bot] rewards: ${describe(r)} failed — ${result.reason}`);
    await mark(r, "BLOCKED", { notes: result.reason.slice(0, NOTE_MAX) });
    failures.push(`${describe(r)}: ${result.reason}`);
    retriable ||= result.retriable !== false;
    if (result.fatal) break;
  }

  if (failures.length) {
    // Left open so the operator can see — and finish — the reward by hand.
    console.log(`[bot] rewards: leaving the mobile tab open at ${mobile.tab.url()}`);
    await page.bringToFront().catch(() => {});
    return { ok: false, retriable, reason: [...failures, ...notes].join("; ") };
  }
  await closeMobileTab(page, mobile);
  return { ok: true, outcome: collected ? "collected" : "already_claimed", detail: notes.join("; ") };
}
