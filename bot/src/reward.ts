import { pause, shortPause, sleep } from "./human.js";
import { rewardDone, type RewardMark, type RewardSpec } from "./config.js";
import type { CDPSession, Page } from "./pw.js";

/**
 * THE REWARD STEP. Three kinds, set per account by the Reward tab's `type`:
 *
 *   URL      open the reward link and press Collect.
 *   SPIN     FunZone -> "Play & win" -> spin -> answer the one quiz question
 *            -> Amazon redirects to the won coupon -> Collect.
 *   ACTIONS  FunZone "Complete actions": a row of task cards, each "add any
 *            item to cart" on a page the card opens, then a Claim card.
 *
 * An account's reward code can point at several Reward rows; each is done in
 * sheet order, skipping COMPLETED ones, and marked BLOCKED while it is worked
 * on and COMPLETED once its coupon is collected.
 *
 * FunZone and the coupon pages only render on the MOBILE site (the desktop
 * site shows "Get the app", and a /rewards/checkoutCoupons link renders a bare
 * category page), so all of it runs in a separate tab with phone emulation.
 * The run's own tab never leaves the desktop site: emulation set over CDP does
 * not fully reset when the session detaches (the viewport stays), so the
 * mobile tab is closed rather than switched back.
 *
 * Flow verified by hand on 2026-09-30 (campaign gSUN0DE):
 *   search "funzone" -> first card links /b?node=14351766031
 *   -> "Guaranteed rewards" row: two links side by side, left /game/<id>
 *      (Play & win), right /b?node=... (Complete actions)
 *   -> /game/<id>: .sw-tap-to-spin -> POST /game/<id>/state
 *   -> "Congratulations" + .sw-claim-your-prize-btn ("Answer now")
 *   -> /game/<id> reloads as a quiz: .mcq-option[data-option-id]
 *   -> correct answer redirects to /rewards/checkoutCoupons?uuid=<rewardId>
 *   -> button[id^="amzn1.rewards.reward."] "Collect now" -> POST /h/coupon-actions
 *   -> the button becomes "AVAILABLE TO USE DURING ...".
 * Once played, the /game/ link goes straight to that coupon page.
 *
 * ACTIONS, verified by hand the same day (task page /b?node=221530152031):
 *   cards [data-engagement-streak-count=1..3], each with a
 *   #streakActionButtonServerData carrying data-action-type (ADD_ITEM_TO_CART
 *   or SINGLE_CLICK_CHECK_IN), data-action-url and an activeButton /
 *   lockedButton class. A done card shows "Completed" and loses the button.
 *   -> Start opens the task page in the same tab (price drops, today's deals)
 *   -> any button[aria-label="Add to cart"] (a "+" icon on the deals page)
 *   -> back to the task page; "Refresh to check status" is only an image
 *      link to the same page. The next card turns active.
 *   -> Claim (SINGLE_CLICK_CHECK_IN) updates the card over ajax to
 *      "View reward" -> /rewards/streaks/checkoutCoupons?streakId=... ->
 *      Collect now, the same coupon screen as the spin.
 * The items it adds stay in the cart; add_items clears the cart first.
 */

const FUNZONE_SEARCH_URL = "https://www.amazon.in/s?k=funzone&i=specialty-aps&rh=n%3A14351766031&ref=nb_sb_noss";
const FUNZONE_NODE = "14351766031";
const FUNZONE_URL = `https://www.amazon.in/b?node=${FUNZONE_NODE}`;

const REWARD_BUTTON = 'button[id^="amzn1.rewards.reward."]';
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
const ADD_TO_CART = 'button[aria-label="Add to cart" i]';
/** A task card that does not advance after this many tries fails the step. */
const TASK_ATTEMPTS = 3;
const MAX_TASK_ROUNDS = 12;
/** window.name of the tab this step opens, so a retry can close a stale one. */
const TAB_NAME = "fleet-reward-tab";

const NAV_TIMEOUT_MS = 30_000;
/** How long one screen may take to turn into the next (the wheel spins ~6s). */
const TRANSITION_MS = 25_000;
const MAX_TRANSITIONS = 10;

/**
 * Quiz questions with a known answer: [question, option to pick]. A wrong
 * answer forfeits the prize for the day, so an unknown non-True/False question
 * stops the step instead of guessing — add it here once answered.
 */
const KNOWN_ANSWERS: Array<[RegExp, RegExp]> = [
  [/first-ever amazon order could be eligible for free delivery/i, /^true$/i],
];

export type RewardOutcome =
  | "collected"
  | "already_redeemed"
  | "none_available";

export type RewardResult =
  | { ok: true; outcome: RewardOutcome; detail: string }
  | { ok: false; reason: string; retriable?: boolean };

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
  return /\/ap\/signin/.test(tab.url());
}

// ---------------------------------------------------------------------------
// FunZone
// ---------------------------------------------------------------------------

interface FunZoneCards {
  container: string;
  spin: string;
  actions: string;
}

/**
 * The "Guaranteed rewards" row: the first FunZone block holding exactly two
 * wide links side by side, a /game/ one on the left (Play & win) and a
 * non-game one on the right (Complete actions). Every card on the page is an
 * image labelled "Live now", so position and href are all there is to go on.
 */
async function findGuaranteedRewards(tab: Page): Promise<FunZoneCards | null> {
  return tab
    .evaluate(() => {
      for (const block of document.querySelectorAll("li[id]")) {
        const links = [...block.querySelectorAll("a[href]")].filter(
          (a) => a.getBoundingClientRect().width > 50,
        );
        if (links.length !== 2) continue;
        const [left, right] = links.sort(
          (a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x,
        );
        const l = left!.getAttribute("href") ?? "";
        const r = right!.getAttribute("href") ?? "";
        if (/\/game\//.test(l) && !/\/game\//.test(r)) {
          return { container: block.id, spin: l, actions: r };
        }
      }
      return null;
    })
    .catch(() => null);
}

async function openFunZone(tab: Page): Promise<FunZoneCards | string> {
  console.log("[bot] rewards: searching FunZone");
  if (!(await goto(tab, FUNZONE_SEARCH_URL))) return "could not load the FunZone search page";
  await pause("letting the search results settle");
  if (signedOut(tab)) return "rewards page bounced to sign-in — the session is not logged in";

  const card = tab.locator(`a[href*="node=${FUNZONE_NODE}"]`).first();
  const found = await card
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (found) {
    console.log("[bot] rewards: opening the FunZone card");
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await shortPause();
    await card.click({ timeout: 10_000 });
    await tab.waitForLoadState("domcontentloaded").catch(() => {});
  } else {
    console.log("[bot] rewards: no FunZone card in the results — opening FunZone directly");
    if (!(await goto(tab, FUNZONE_URL))) return "could not load the FunZone page";
  }
  await pause("letting FunZone load");

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const cards = await findGuaranteedRewards(tab);
    if (cards) return cards;
    await sleep(1000);
  }
  return `FunZone has no "Guaranteed rewards" row (Play & win / Complete actions) on ${tab.url()}`;
}

async function clickCard(tab: Page, cards: FunZoneCards, href: string, label: string): Promise<void> {
  const link = tab.locator(`li[id="${cards.container}"] a[href="${href}"]`).first();
  await link.scrollIntoViewIfNeeded().catch(() => {});
  await shortPause();
  console.log(`[bot] rewards: opening ${label}`);
  await link.click({ timeout: 10_000 });
  await tab.waitForLoadState("domcontentloaded").catch(() => {});
}

// ---------------------------------------------------------------------------
// Game / coupon screens
// ---------------------------------------------------------------------------

type Screen =
  | { kind: "wheel" }
  | { kind: "answer_now" }
  | { kind: "quiz"; question: string; options: string[] }
  | { kind: "collect"; prize: string }
  /** "SELECT YOUR COUPONS — Pick any 3 out of 14 · 0/3 selected". */
  | { kind: "pick"; need: number; offered: number; picked: number; prize: string }
  | { kind: "collected"; prize: string }
  | { kind: "wrong_answer" }
  | { kind: "unknown"; controls: string[] };

/** Which screen of the game or coupon flow is showing. */
async function readScreen(tab: Page): Promise<Screen> {
  return tab
    .evaluate(
      ([tap, answer, mcq, reward]) => {
        const shown = (el: Element | null): boolean => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const text = (document.body?.innerText ?? "").replace(/\s+/g, " ");
        const prize = (text.match(/get flat .{1,60}?min order:?\s*₹\s*[\d,]+/i)?.[0] ?? "").trim();

        if (/answer you gave was incorrect|not eligible to win the prize/i.test(text)) {
          return { kind: "wrong_answer" as const };
        }

        const options = [...document.querySelectorAll(mcq!)].filter(shown);
        if (options.length > 0) {
          const labels = options.map((o) => (o as HTMLElement).innerText.replace(/\s+/g, " ").trim());
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

        // A choice page: several coupons, collect `need` of them. Its counter,
        // not the buttons, says when it is done.
        const pick = text.match(/pick any (\d+) out of (\d+)/i);
        if (pick) {
          const need = Number(pick[1]);
          const picked = Number(text.match(/(\d+)\s*\/\s*\d+\s*selected/i)?.[1] ?? 0);
          if (picked >= need) return { kind: "collected" as const, prize: `${need} coupons, ${prize}` };
          return { kind: "pick" as const, need, offered: Number(pick[2]), picked, prize };
        }

        const collect = [...document.querySelectorAll(reward!)].find(
          (b) => shown(b) && !(b as HTMLButtonElement).disabled && /collect/i.test((b as HTMLElement).innerText),
        );
        if (collect) return { kind: "collect" as const, prize };
        if (/\/rewards\//.test(location.pathname) || prize) {
          if (/available to use|collected|already (been )?(claimed|collected|redeemed)/i.test(text)) {
            return { kind: "collected" as const, prize };
          }
        }

        // Any VISIBLE match: a campaign can keep a hidden copy of a button in the page.
        const visible = (sel: string): boolean =>
          [...document.querySelectorAll(sel)].some(
            (el) => shown(el) && !el.classList.contains("a-button-disabled") && !el.classList.contains("aok-hidden"),
          );
        if (visible(answer!)) return { kind: "answer_now" as const };
        if (visible(tap!)) return { kind: "wheel" as const };

        const controls = [...document.querySelectorAll("button, .a-button, a[role=button]")]
          .filter(shown)
          .map((el) => (el as HTMLElement).innerText.replace(/\s+/g, " ").trim())
          .filter((l) => l && l.length < 40)
          .slice(0, 8);
        return { kind: "unknown" as const, controls };
      },
      [TAP_TO_SPIN, ANSWER_NOW, MCQ_OPTION, REWARD_BUTTON] as const,
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

export function chooseAnswer(question: string, options: string[]): string | null {
  for (const [q, answer] of KNOWN_ANSWERS) {
    if (!q.test(question)) continue;
    const hit = options.find((o) => answer.test(o));
    if (hit) return hit;
  }
  // FunZone's True/False questions state an Amazon benefit, so they are true.
  const folded = options.map((o) => o.toLowerCase());
  if (folded.length === 2 && folded.includes("true") && folded.includes("false")) {
    return options[folded.indexOf("true")]!;
  }
  return null;
}

/**
 * Drives whatever screen is showing until the coupon is collected: spin,
 * "Answer now", the quiz, then Collect. Also the whole of a URL reward, which
 * is just the last screen.
 */
async function playThrough(tab: Page, label: string): Promise<RewardResult> {
  let s = await nextScreen(tab, "unknown", 15_000);
  let collectTries = 0;

  for (let i = 0; i < MAX_TRANSITIONS; i++) {
    if (signedOut(tab)) {
      return { ok: false, reason: "rewards page bounced to sign-in — the session is not logged in" };
    }
    console.log(`[bot] rewards: ${label} screen = ${s.kind}`);

    switch (s.kind) {
      case "wheel":
        await pause("before spinning");
        await pressAButton(tab, TAP_TO_SPIN);
        console.log("[bot] rewards: spun — waiting for the wheel to stop");
        s = await nextScreen(tab, "wheel");
        break;

      case "answer_now":
        await pause("after the wheel stopped");
        await pressAButton(tab, ANSWER_NOW);
        s = await nextScreen(tab, "answer_now");
        break;

      case "quiz": {
        const pick = chooseAnswer(s.question, s.options);
        if (!pick) {
          return {
            ok: false,
            retriable: true,
            reason:
              `spin quiz has no known answer: "${s.question}" [${s.options.join(" / ")}]. ` +
              `Answer it in the open browser tab and resume, or add it to KNOWN_ANSWERS in bot/src/reward.ts`,
          };
        }
        console.log(`[bot] rewards: quiz "${s.question}" -> ${pick}`);
        await pause("reading the question");
        const exact = new RegExp(`^\\s*${pick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
        const option = tab.locator(MCQ_OPTION, { hasText: exact }).first();
        await option.scrollIntoViewIfNeeded().catch(() => {});
        await option.click({ timeout: 10_000 });
        s = await nextScreen(tab, "quiz");
        break;
      }

      case "collect":
        if (++collectTries > 3) {
          return { ok: false, reason: `the reward's Collect button did not take after 3 presses on ${tab.url()}` };
        }
        await pause("before collecting");
        await tab.locator(REWARD_BUTTON, { hasText: /collect/i }).first().click({ timeout: 10_000 });
        console.log(`[bot] rewards: pressed Collect${s.prize ? ` (${s.prize})` : ""}`);
        s = await nextScreen(tab, "collect", 15_000);
        break;

      case "pick": {
        // The coupons on these pages have read identical so far: take them in order.
        console.log(`[bot] rewards: pick ${s.need} of ${s.offered} coupons (${s.picked} picked) — ${s.prize}`);
        const before = s.picked;
        if (++collectTries > s.need + 3) {
          return { ok: false, reason: `picked ${before} of ${s.need} coupons; the rest would not collect on ${tab.url()}` };
        }
        await pause("before picking a coupon");
        const next = tab.locator(REWARD_BUTTON, { hasText: /collect/i }).filter({ visible: true }).first();
        await next.scrollIntoViewIfNeeded().catch(() => {});
        await next.click({ timeout: 10_000 });
        // Wait for the counter to move rather than for the screen to change.
        const deadline = Date.now() + 15_000;
        do {
          await sleep(1000);
          s = await readScreen(tab);
        } while (Date.now() < deadline && s.kind === "pick" && s.picked === before);
        break;
      }

      case "collected":
        await pause("after collecting");
        return collectTries > 0
          ? { ok: true, outcome: "collected", detail: `${label} collected${s.prize ? `: ${s.prize}` : ""}` }
          : {
              ok: true,
              outcome: "already_redeemed",
              detail: `${label} already collected${s.prize ? `: ${s.prize}` : ""} — nothing to do`,
            };

      case "wrong_answer":
        return {
          ok: false,
          retriable: false,
          reason: "the spin quiz answer was rejected — this account cannot win the spin prize today",
        };

      case "unknown":
        return {
          ok: false,
          reason:
            `${label}: unrecognised page ${tab.url()}` +
            (s.controls.length ? ` — controls: ${s.controls.join(", ")}` : ""),
        };
    }
  }
  return { ok: false, reason: `${label}: still not collected after ${MAX_TRANSITIONS} screens on ${tab.url()}` };
}

// ---------------------------------------------------------------------------
// ACTIONS
// ---------------------------------------------------------------------------

interface TaskCard {
  index: string;
  title: string;
  /** ADD_ITEM_TO_CART, SINGLE_CLICK_CHECK_IN, or "" when the card has no button left. */
  type: string;
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

/**
 * "Scroll down until you see an Add to Cart button, click it." Tries up to
 * three buttons (one can open an options sheet instead of adding) and counts
 * the add as done when Amazon's cart API answers or the cart badge goes up.
 */
async function addAnyItemToCart(tab: Page): Promise<boolean> {
  const tried = new Set<number>();
  for (let scroll = 0; scroll < 20 && tried.size < 3; scroll++) {
    const buttons = tab.locator(ADD_TO_CART);
    const n = await buttons.count();
    let index = -1;
    for (let i = 0; i < n; i++) {
      if (tried.has(i)) continue;
      if (await buttons.nth(i).isVisible().catch(() => false)) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      await tab.mouse.wheel(0, 700).catch(() => {});
      await sleep(1200);
      continue;
    }
    tried.add(index);
    const button = buttons.nth(index);
    await button.scrollIntoViewIfNeeded().catch(() => {});
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
    if (apiOk || (before >= 0 && after > before)) {
      console.log(`[bot] rewards: added an item to the cart (cart ${before} -> ${after})`);
      return true;
    }
    console.log("[bot] rewards: that Add to cart did not take — trying another item");
  }
  return false;
}

/** Back to the task board and press "Refresh to check status" (an image link to the same page). */
async function refreshTasks(tab: Page, taskUrl: string): Promise<TaskBoard> {
  if (!/node=221530152031|streak/i.test(tab.url()) || (await readTasks(tab)).cards.length === 0) {
    await goto(tab, taskUrl);
    await pause("back on the task page");
  }
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

async function runActions(tab: Page): Promise<RewardResult> {
  const funzone = await openFunZone(tab);
  if (typeof funzone === "string") return { ok: false, reason: funzone };
  await clickCard(tab, funzone, funzone.actions, "Complete actions");
  await pause("letting the task page load");
  const taskUrl = tab.url();

  const attempts = new Map<string, number>();
  let board = await waitForTasks(tab);
  if (board.cards.length === 0) {
    return { ok: false, reason: `Complete actions page has no task cards on ${tab.url()}` };
  }

  for (let round = 0; round < MAX_TASK_ROUNDS; round++) {
    if (signedOut(tab)) {
      return { ok: false, reason: "rewards page bounced to sign-in — the session is not logged in" };
    }
    console.log(`[bot] rewards: tasks ${describeBoard(board)}`);

    if (board.viewReward) {
      await pause("before opening the reward");
      await tab.locator(VIEW_REWARD).first().click({ timeout: 10_000 });
      await tab.waitForLoadState("domcontentloaded").catch(() => {});
      await pause("letting the reward page load");
      return playThrough(tab, "actions reward");
    }

    const card = board.cards.find((c) => c.active);
    if (!card) {
      return { ok: false, reason: `no task to start and no reward to view (${describeBoard(board)})` };
    }
    const tries = (attempts.get(card.index) ?? 0) + 1;
    attempts.set(card.index, tries);
    if (tries > TASK_ATTEMPTS) {
      return {
        ok: false,
        reason: `task "${card.title}" did not complete after ${TASK_ATTEMPTS} tries (${describeBoard(board)})`,
      };
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
      return { ok: false, reason: `task "${card.title}" is a ${card.type || "unknown"} task, which is not automated` };
    }

    // "Start", or "Try again" when a previous add did not count.
    console.log(`[bot] rewards: task "${card.title}" (${card.label}), try ${tries}`);
    await pause("before starting the task");
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 10_000 });
    await tab.waitForLoadState("domcontentloaded").catch(() => {});
    await pause("letting the task's page load");
    if (!(await addAnyItemToCart(tab))) {
      return { ok: false, reason: `task "${card.title}": no Add to cart button that worked on ${tab.url()}` };
    }
    await pause("after adding to cart");
    board = await refreshTasks(tab, taskUrl);
    // Progress can lag the add by a few seconds: look once more before retrying the card.
    if (board.cards.find((c) => c.active)?.index === card.index && !board.viewReward) {
      await sleep(5000);
      board = await refreshTasks(tab, taskUrl);
    }
  }
  return { ok: false, reason: `actions reward not reached after ${MAX_TASK_ROUNDS} rounds (${describeBoard(board)})` };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function runSpin(tab: Page): Promise<RewardResult> {
  const cards = await openFunZone(tab);
  if (typeof cards === "string") return { ok: false, reason: cards };
  await clickCard(tab, cards, cards.spin, "Play & win (spin wheel)");
  await pause("letting the spin wheel load");
  return playThrough(tab, "spin reward");
}

async function runUrl(tab: Page, url: string): Promise<RewardResult> {
  if (!url) return { ok: false, retriable: false, reason: "reward type is URL but reward_url is blank" };
  if (!/^https?:\/\/(www\.)?(amazon\.in|amzn\.in)\//i.test(url)) {
    return { ok: false, retriable: false, reason: `reward_url must be an amazon.in link, got "${url}"` };
  }
  console.log(`[bot] rewards: opening ${url}`);
  if (!(await goto(tab, url))) return { ok: false, reason: `could not load the reward link ${url}` };
  await pause("letting the reward page load");
  return playThrough(tab, "reward link");
}

function runOne(tab: Page, r: RewardSpec): Promise<RewardResult> {
  if (r.type === "spin") return runSpin(tab);
  if (r.type === "actions") return runActions(tab);
  return runUrl(tab, r.url.trim());
}

function describe(r: RewardSpec): string {
  return `${r.type.toUpperCase()}${r.row ? ` (Reward row ${r.row})` : ""}`;
}

/**
 * Every Reward row of this account, in sheet order, skipping COMPLETED ones.
 * Stops at the first failure: that row stays BLOCKED until the run is
 * released (which puts it back to PENDING) or resumed.
 */
export async function runCheckReward(
  page: Page,
  rewards: RewardSpec[],
  mark: (r: RewardSpec, status: RewardMark) => Promise<void> = async () => {},
): Promise<RewardResult> {
  if (rewards.length === 0) {
    return { ok: true, outcome: "none_available", detail: "no reward set for this account — skipping" };
  }
  const todo = rewards.filter((r) => !rewardDone(r));
  const skipped = rewards.length - todo.length;
  if (todo.length === 0) {
    return { ok: true, outcome: "already_redeemed", detail: `all ${rewards.length} reward(s) already COMPLETED` };
  }

  await pause("before checking rewards");
  const mobile = await openMobileTab(page);
  const notes: string[] = skipped ? [`${skipped} already COMPLETED`] : [];
  let collected = false;

  for (const r of todo) {
    console.log(`[bot] rewards: -- ${describe(r)} --`);
    await mark(r, "BLOCKED");
    let result: RewardResult;
    try {
      result = await runOne(mobile.tab, r);
    } catch (err) {
      result = { ok: false, reason: `reward step crashed: ${(err as Error).message.split("\n")[0]}` };
    }
    if (!result.ok) {
      // Left open so the operator can see — and finish — the reward by hand.
      console.log(`[bot] rewards: leaving the mobile tab open at ${mobile.tab.url()}`);
      await page.bringToFront().catch(() => {});
      return { ...result, reason: [`${describe(r)}: ${result.reason}`, ...notes].join("; ") };
    }
    await mark(r, "COMPLETED");
    collected ||= result.outcome === "collected";
    notes.push(`${describe(r)}: ${result.detail}`);
  }

  await closeMobileTab(page, mobile);
  return { ok: true, outcome: collected ? "collected" : "already_redeemed", detail: notes.join("; ") };
}
