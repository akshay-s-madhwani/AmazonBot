import type { TargetAddress } from "./config.js";
import { pause, rand, shortPause, sleep } from "./human.js";
import type { Page } from "./pw.js";


const ADDRESSES_URL = "https://www.amazon.in/a/addresses";
const ADD_URL = "https://www.amazon.in/a/addresses/add?ref=ya_address_book_add_button";
const NAV_TIMEOUT_MS = 20_000;
/** PIN autofill: at least this, then until city and state are filled, at most the max. */
const AVS_AUTOFILL_MIN_MS = 500;
const AVS_AUTOFILL_MAX_MS = 4_000;

export type AddressAction = "verified_default" | "set_default" | "added";
export type AddressResult = { ok: true; action: AddressAction } | { ok: false; reason: string };

interface Tile {
  index: number;
  fullName: string;
  line1: string;
  line2: string;
  cityStatePostal: string;
  phone: string;
  isDefault: boolean;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function pincodeOf(text: string): string {
  const m = text.match(/\b(\d{6})\b/);
  return m ? m[1]! : "";
}

async function readTiles(page: Page): Promise<Tile[]> {
  return page.evaluate(() => {
    const blocks = [...document.querySelectorAll('[id^="ya-myab-display-address-block-"]')];
    return blocks.map((block) => {
      const el = block as HTMLElement;
      const pick = (id: string) => {
        const node = el.querySelector(`[id="${id}"]`) as HTMLElement | null;
        return node ? node.innerText.trim() : "";
      };
      const idxMatch = el.id.match(/(\d+)$/);
      return {
        index: idxMatch ? Number(idxMatch[1]) : -1,
        fullName: pick("address-ui-widgets-FullName"),
        line1: pick("address-ui-widgets-AddressLineOne"),
        line2: pick("address-ui-widgets-AddressLineTwo"),
        cityStatePostal: pick("address-ui-widgets-CityStatePostalCode"),
        phone: pick("address-ui-widgets-PhoneNumber").replace(/[^\d]/g, ""),
        isDefault: !!el.querySelector(".address-section-with-default"),
      };
    });
  });
}

async function setAsDefault(page: Page, index: number): Promise<boolean> {
  // The form POSTs and Amazon answers with a new page: wait for it, or the
  // next navigation (clear_cart's cart) cancels the change in flight — the
  // same race that left deleted addresses in place (2026-10-10).
  const from = page.url();
  const answered = page
    .waitForURL((u) => u.href !== from, { timeout: NAV_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  const done = await page.evaluate((i) => {
    const row = document.getElementById(`ya-myab-edit-address-desktop-row-${i}`);
    const container = row?.closest(".address-column") ?? row?.parentElement ?? null;
    const form = container?.querySelector("form.set-address-default") as HTMLFormElement | null;
    if (form) {
      form.submit();
      return true;
    }
    const link = [...(container?.querySelectorAll("a, input[type=submit], button") ?? [])].find((n) =>
      /set as default/i.test((n as HTMLElement).innerText || (n as HTMLInputElement).value || ""),
    ) as HTMLElement | null;
    if (link) {
      link.click();
      return true;
    }
    return false;
  }, index);
  if (!done) return false;
  if (!(await answered)) console.log(`[bot] set default: no new page after the submit (still on ${page.url()})`);
  await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
  console.log(`[bot] set default answered at ${page.url()}`);
  return true;
}

/**
 * Picks an option by its text. An option already selected is left alone:
 * selecting it again still fires "change", and Amazon redraws the address
 * form on a country change — wiping a field typed straight after it (the PIN
 * read back empty, 2026-10-10). Returns "changed" when it did select.
 */
async function selectByText(page: Page, selector: string, value: string): Promise<false | "kept" | "changed"> {
  const found = await page.evaluate(
    ({ selector, value }) => {
      const sel = document.querySelector(selector) as HTMLSelectElement | null;
      if (!sel) return null;
      const want = value.toLowerCase().trim();
      const opt = [...sel.options].find(
        (o) => o.text.toLowerCase().trim() === want || o.value.toLowerCase().trim() === want,
      );
      return opt ? { value: opt.value, current: sel.value === opt.value } : null;
    },
    { selector, value },
  );
  if (found === null) return false;
  if (found.current) return "kept";
  await page.selectOption(selector, found.value);
  return "changed";
}

async function readFormError(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const sels = [
      ".a-alert-inline-error .a-alert-content",
      ".a-alert-error .a-alert-content",
      '[id*="error"]:not([style*="display: none"])',
    ];
    for (const s of sels) {
      for (const node of document.querySelectorAll(s)) {
        const el = node as HTMLElement;
        if (el.offsetParent !== null) {
          const t = (el.innerText || "").trim();
          if (t) return t;
        }
      }
    }
    return null;
  });
}

async function addNewAddress(page: Page, target: TargetAddress): Promise<AddressResult> {
  await page.goto(ADD_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page
    .locator("#address-ui-widgets-enterAddressFullName")
    .waitFor({ timeout: NAV_TIMEOUT_MS })
    .catch(() => { });
  await pause("add-address form loaded");

  if ((await selectByText(page, "#address-ui-widgets-countryCode-dropdown-nativeId", target.country)) === "changed") {
    // A new country redraws the form: let it, before typing into it.
    await page.waitForLoadState("domcontentloaded").catch(() => { });
    await sleep(1_500);
  }

  await setField(page, "#address-ui-widgets-enterAddressPostalCode", target.pincode, "pincode");
  await waitForPinAutofill(page);
  await shortPause();

  const filled: Array<[string, string, string]> = [
    ["#address-ui-widgets-enterAddressFullName", target.fullName, "full name"],
    ["#address-ui-widgets-enterAddressPhoneNumber", target.phone, "phone"],
    ["#address-ui-widgets-enterAddressLine1", target.line1, "address line 1"],
  ];
  if (target.line2) {
    filled.push(["#address-ui-widgets-enterAddressLine2", target.line2, "address line 2"]);
  } else {
    console.warn(
      "[bot] WARNING: ADDRESS_LINE2 is not set. Amazon's 'Area, Street, Sector, Village' " +
      "field is effectively required for Indian addresses and its absence usually " +
      "triggers 'unable to verify the street address'.",
    );
  }
  if (target.landmark) {
    filled.push(["#address-ui-widgets-landmark", target.landmark, "landmark"]);
  }
  const autoCity = (
    await page.inputValue("#address-ui-widgets-enterAddressCity").catch(() => "")
  ).trim();
  if (autoCity) {
    console.log(`[bot] keeping Amazon's autofilled city "${autoCity}"`);
  } else {
    filled.push(["#address-ui-widgets-enterAddressCity", target.city, "town/city"]);
  }

  for (const [selector, value, label] of filled) {
    const ok = await setField(page, selector, value, label);
    if (!ok) {
      return { ok: false, reason: `could not reliably set ${label} — Amazon kept clearing it` };
    }
    await shortPause();
  }

  // Sheet addresses carry no state: Amazon fills it from the PIN. Selecting
  // "" here picked the blank placeholder and wiped that autofill.
  const STATE = "#address-ui-widgets-enterAddressStateOrRegion-dropdown-nativeId";
  const autoState = (await page.inputValue(STATE).catch(() => "")).trim();
  if (target.state.trim()) {
    if (!(await selectByText(page, STATE, target.state))) {
      return { ok: false, reason: `state "${target.state}" not found in the dropdown` };
    }
  } else if (autoState) {
    console.log(`[bot] keeping Amazon's autofilled state "${autoState}"`);
  } else {
    return { ok: false, reason: `no state for PIN ${target.pincode}: Amazon did not fill it and the sheet has none` };
  }

  const required: Array<[string, string]> = [
    ["#address-ui-widgets-enterAddressFullName", target.fullName],
    ["#address-ui-widgets-enterAddressPhoneNumber", target.phone],
    ["#address-ui-widgets-enterAddressPostalCode", target.pincode],
    ["#address-ui-widgets-enterAddressLine1", target.line1],
  ];
  const cityNow = (
    await page.inputValue("#address-ui-widgets-enterAddressCity").catch(() => "")
  ).trim();
  if (!cityNow) required.push(["#address-ui-widgets-enterAddressCity", target.city]);

  for (const [selector, rawWant] of required) {
    const want = await effectiveValue(page, selector, rawWant);
    const got = await page.inputValue(selector).catch(() => "");
    if (got.trim().toLowerCase() !== want.trim().toLowerCase()) {
      console.log(`[bot] pre-submit: ${selector} was "${got}" — re-filling`);
      const ok = await setField(page, selector, want, selector);
      if (!ok) {
        return { ok: false, reason: `field ${selector} would not hold its value before submit` };
      }
    }
  }
  await pause("all fields verified, about to submit");

  const checkbox = page.locator("#address-ui-widgets-use-as-my-default");
  if ((await checkbox.count()) > 0 && !(await checkbox.isChecked().catch(() => false))) {
    await checkbox.dispatchEvent("click").catch(() => { });
  }

  await shortPause();
  await submitAddressForm(page, false);
  let err = await waitForSave(page);

  if (err && AVS_SOFT_BLOCK.test(err)) {
    console.log(`[bot] AVS soft-block: "${err}" — confirming address as entered`);
    await submitAddressForm(page, true);
    err = await waitForSave(page);
  }
  if (err) return { ok: false, reason: `${err} (form still open — nothing was saved)` };
  await pause("address saved");
  console.log("[bot] address saved and form closed ✓");
  return { ok: true, action: "added" };
}

/**
 * Amazon fills city and state from the PIN. Waits until both are filled —
 * what the code below keeps — never longer than AVS_AUTOFILL_MAX_MS, after
 * which the form is used as it is (the old fixed 1.5 s wait plus a pause).
 */
async function waitForPinAutofill(page: Page): Promise<void> {
  const deadline = Date.now() + AVS_AUTOFILL_MAX_MS;
  await sleep(AVS_AUTOFILL_MIN_MS);
  while (Date.now() < deadline) {
    const filled = await page
      .evaluate(() => {
        const v = (id: string) => ((document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "").trim();
        return !!v("address-ui-widgets-enterAddressCity") && !!v("address-ui-widgets-enterAddressStateOrRegion-dropdown-nativeId");
      })
      .catch(() => false);
    if (filled) return;
    await sleep(250);
  }
  console.log("[bot] PIN autofill not complete — using the form as it is");
}

/**
 * After submit: null once Amazon leaves the add form (saved), else the error
 * it shows. Polled, because the save redirects — reading the form while it
 * navigates threw "execution context was destroyed" on a successful save.
 */
async function waitForSave(page: Page, budgetMs = 20_000): Promise<string | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(800);
    if (!/\/a\/addresses\/add/.test(page.url())) return null;
    await dismissAvsSuggestion(page);
    const err = await readFormError(page).catch(() => null);
    if (err) return err;
  }
  return /\/a\/addresses\/add/.test(page.url()) ? `add form did not submit (still on ${page.url()})` : null;
}

async function effectiveValue(page: Page, selector: string, value: string): Promise<string> {
  const maxLen = await page
    .evaluate((s) => {
      const node = document.querySelector(s) as HTMLInputElement | null;
      return node && node.maxLength > 0 ? node.maxLength : 0;
    }, selector)
    .catch(() => 0);
  return maxLen > 0 && value.length > maxLen ? value.slice(0, maxLen).trimEnd() : value;
}

async function setField(
  page: Page,
  selector: string,
  value: string,
  label: string,
): Promise<boolean> {
  const el = page.locator(selector);

  const want = await effectiveValue(page, selector, value);
  if (want !== value) {
    console.warn(
      `[bot] ${label}: value is ${value.length} chars but the field caps shorter — ` +
      `using "${want}"`,
    );
  }
  value = want;

  // Typed key by key, then read back below and retyped when Amazon dropped it:
  // the read-back, not the typing speed, is what makes a field reliable. At
  // 70–130 ms a key plus ~2 s of fixed sleeps a field, six addresses took
  // close to two minutes (2026-10-10).
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { });
      await el.focus();
      await sleep(rand(150, 300));
      await el.fill("");
      await sleep(rand(80, 160));
      await el.pressSequentially(value, { delay: 25 + Math.floor(Math.random() * 25) });
      await sleep(rand(150, 300));
      await page.evaluate((s) => {
        (document.querySelector(s) as HTMLElement | null)?.blur();
      }, selector);
      await sleep(rand(150, 300));

      const got = (await el.inputValue().catch(() => "")).trim();
      if (got.toLowerCase() === value.trim().toLowerCase()) return true;
      console.log(`[bot] ${label}: value did not stick (got "${got}") — retry ${attempt}/3`);
    } catch (err) {
      console.log(`[bot] ${label}: fill error (${(err as Error).message}) — retry ${attempt}/3`);
    }
  }
  return false;
}

const AVS_SOFT_BLOCK =
  /unable to verify|please review before saving|couldn't find|could not find|check the address/i;

async function submitAddressForm(page: Page, suppressAvs: boolean): Promise<void> {
  if (suppressAvs) {
    await page
      .evaluate(() => {
        for (const name of [
          "address-ui-widgets-avsSuppressSoftblock",
          "address-ui-widgets-avsSuppressSuggestion",
        ]) {
          const el = document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
          if (el) el.value = "true";
        }
      })
      .catch(() => { });
  }
  await page
    .locator('#address-ui-address-form input[type="submit"]:visible')
    .first()
    .dispatchEvent("click");
  await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
}

async function dismissAvsSuggestion(page: Page): Promise<void> {
  const clicked = await page
    .evaluate(() => {
      const controls = [...document.querySelectorAll("input[type=submit], button, a")];
      const target = controls.find((n) => {
        if ((n as HTMLElement).offsetParent === null) return false;
        const t = ((n as HTMLElement).innerText || (n as HTMLInputElement).value || "").trim();
        return /use this address|use as entered|keep original|original address|add address/i.test(t);
      }) as HTMLElement | null;
      if (target) {
        target.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
  if (clicked) await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
}

/**
 * AN ADDRESS'S IDENTITY: name, line 1, line 2 and PIN, as one normalised
 * string. Built only from what Amazon shows — on the address-book cards and
 * in checkout's address lists alike — so one key finds an address in both.
 * Amazon cuts each line at 60 characters, so the sheet's values are cut the
 * same way before keying (line 2 "... Pratap Nager GH Mangai garden" shows as
 * "... Pratap Nager").
 */
export const ADDRESS_LINE_MAX = 60;

/** Amazon collapses runs of spaces before it cuts, so "a  b" counts as "a b". */
const cutLine = (v: string): string => v.replace(/\s+/g, " ").trim().slice(0, ADDRESS_LINE_MAX);

/** Already-cut text -> key. Never re-cut: name + lines together run past 60. */
const keyOf = (text: string, pincode: string): string => `${norm(text)}|${pincode.trim()}`;

export function addressKey(parts: { name: string; line1: string; line2: string; pincode: string }): string {
  return keyOf(`${cutLine(parts.name)} ${cutLine(parts.line1)} ${cutLine(parts.line2)}`, parts.pincode);
}

export function targetKey(t: TargetAddress): string {
  return addressKey({ name: t.fullName, line1: t.line1, line2: t.line2, pincode: t.pincode });
}

/**
 * Key of an address as checkout prints it: "name line1, line2, CITY, STATE,
 * PIN, India" in the address lists and dropdowns. The trailing city, state,
 * PIN and country are split off so the rest keys exactly like a sheet address
 * (see addressKey in address.ts).
 */
export function checkoutAddressKey(text: string): string | null {
  const parts = text.replace(/\s+/g, " ").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 5) return null;
  const pin = parts[parts.length - 2]!;
  if (!/^\d{6}$/.test(pin)) return null;
  return keyOf(parts.slice(0, -4).join(" "), pin);
}

/** The sheet address keyed the same way: name, line 1 and line 2 joined, each cut to Amazon's 60. */
export function sheetAddressKey(t: TargetAddress): string {
  return addressKey({ name: t.fullName, line1: t.line1, line2: t.line2, pincode: t.pincode });
}

function tileKey(t: Tile): string {
  return addressKey({ name: t.fullName, line1: t.line1, line2: t.line2, pincode: pincodeOf(t.cityStatePostal) });
}

async function openAddressBook(page: Page): Promise<Map<string, Tile>> {
  await page.goto(ADDRESSES_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await pause("addresses page loaded");
  const book = new Map<string, Tile>();
  for (const t of await readTiles(page)) book.set(tileKey(t), t);
  return book;
}

/**
 * Removes one address card. Amazon refuses the address used as the
 * residential address for digital purchases ("Removal failed"): that one is
 * left in place.
 */
async function removeTile(page: Page, tile: Tile): Promise<"removed" | "residential" | "failed"> {
  const del = page.locator(`#ya-myab-address-delete-btn-${tile.index}`);
  if (!(await del.count())) return "failed";
  await shortPause();
  await del.click({ timeout: NAV_TIMEOUT_MS });
  const yes = page.locator(`#deleteAddressModal-${tile.index}-submit-btn`).filter({ visible: true });
  const refused = page.locator(`#deleteAddressModal-${tile.index}-choose-new-address-btn`).filter({ visible: true });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await yes.count()) {
      await shortPause();
      // Yes POSTs the delete and Amazon answers on ...?alertId=yaab-deleteAddressSuccess.
      // Wait for that: the next address-book load used to start while the
      // POST was in flight and cancelled it — the card stayed, was "removed"
      // again 30 times, ~70 s a run (2026-10-10, at BOT_PACE 0.3).
      const done = page
        .waitForURL((u) => /alertId=yaab-deleteAddress/i.test(u.href), { timeout: NAV_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      await yes.locator("input, button").first().click({ timeout: NAV_TIMEOUT_MS });
      if (!(await done)) {
        console.log(`[bot] remove: Amazon did not answer the delete (still at ${page.url().slice(0, 100)})`);
        return "failed";
      }
      await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => { });
      await shortPause();
      if (/deleteAddressSuccess/i.test(page.url())) return "removed";
      console.log(`[bot] remove: Amazon answered ${page.url().slice(0, 120)}`);
      return "failed";
    }
    if (await refused.count()) {
      await page.locator(`#deleteAddressModal-${tile.index}-cancel-btn`).click().catch(() => { });
      return "residential";
    }
    await sleep(500);
  }
  return "failed";
}

/**
 * THE ADDRESS STEP. The account's address book ends up holding every sheet
 * address. Cards that are not a sheet address are removed first — except the
 * default, and the residential address Amazon will not delete — then the
 * missing sheet addresses are added one by one, and the first sheet address
 * is made the default (single-address checkout ships to the default).
 */
export async function runAddresses(page: Page, targets: TargetAddress[]): Promise<AddressResult> {
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  const wanted = targets.filter((t) => t.pincode && t.line1 && t.fullName);
  if (wanted.length === 0) return { ok: false, reason: "no address for this account — check its address code in the Address tab" };
  await pause("starting address step");

  const wantedKeys = new Set(wanted.map(targetKey));
  const kept = new Set<string>();
  let removed = 0;
  // Re-read after every removal: the page reloads and card indexes shift.
  for (let guard = 0; guard < 30; guard++) {
    const book = await openAddressBook(page);
    if (guard === 0) console.log(`[bot] address book: ${book.size} card(s), sheet: ${wanted.length} address(es)`);
    const extra = [...book.entries()].find(([key, t]) => !wantedKeys.has(key) && !t.isDefault && !kept.has(key));
    if (!extra) break;
    const [key, tile] = extra;
    const outcome = await removeTile(page, tile);
    console.log(`[bot] remove "${tile.fullName}": ${outcome}`);
    if (outcome === "removed") removed++;
    else kept.add(key);
  }

  let added = 0;
  // Read once: adding one address never makes another appear, and the check
  // after the loop re-reads the book and finds any that did not save. A
  // reload before every address cost a page load and a pause each.
  const before = await openAddressBook(page);
  for (const [i, t] of wanted.entries()) {
    if (before.has(targetKey(t))) {
      console.log(`[bot] address ${i + 1}/${wanted.length} already saved (${t.fullName})`);
      continue;
    }
    console.log(`[bot] adding address ${i + 1}/${wanted.length} (${t.fullName}, ${t.pincode})`);
    const r = await addNewAddress(page, t);
    if (!r.ok) return { ok: false, reason: `address ${i + 1} (${t.fullName}): ${r.reason}` };
    added++;
  }

  const book = await openAddressBook(page);
  const missing = wanted.filter((t) => !book.has(targetKey(t)));
  if (missing.length) {
    return {
      ok: false,
      reason: `not in the address book after saving: ${missing.map((t) => t.fullName).join(", ")}`,
    };
  }
  const first = book.get(targetKey(wanted[0]!))!;
  if (!first.isDefault) {
    console.log(`[bot] making "${first.fullName}" the default address`);
    if (!(await setAsDefault(page, first.index))) return { ok: false, reason: "could not set the first address as default" };
    await pause("default set");
  }
  console.log(`[bot] addresses ready: ${wanted.length} in the book (${added} added, ${removed} removed)`);
  return { ok: true, action: added ? "added" : "verified_default" };
}
