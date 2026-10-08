import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface Credentials {
  email: string;
  password: string;
  totpSecret: string;
}

export interface BotConfig {
  credentials: Credentials;
  headless: boolean;
}

export type PaymentMethod = "voucher" | "amazon_pay" | "none";

export interface PaymentCode {
  code: string;
  amount?: number;
  /** Vouchers tab row, where its "Used" mark goes. Absent outside the sheet. */
  row?: number;
  /** apay: redeem into the Amazon Pay balance; coupon: apply at checkout. */
  type?: "apay" | "coupon" | "unknown";
  /** Vouchers.status, upper-cased; "USED" is not redeemed again. */
  status?: string;
}

export interface PaymentSpec {
  method: PaymentMethod;
  codes: PaymentCode[];
}

export function parsePaymentCodes(raw: string): PaymentCode[] {
  return raw
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [code, amt] = entry.split(":").map((s) => s.trim());
      const amount = amt ? Number(amt) : undefined;
      return amount !== undefined && Number.isFinite(amount)
        ? { code: code ?? "", amount }
        : { code: code ?? "" };
    })
    .filter((c) => c.code.length > 0);
}

export type PurchaseOption = "auto" | "one_time" | "subscribe_save" | "fresh";

export interface ProductSpec {
  /** Items.item_id: what a multi-address account's ItemsQuantity names. */
  itemId?: string;
  applyCoupon?: boolean;
  url: string;
  quantity: number;
  purchaseOption: PurchaseOption;
  expectedPrice?: number;
  /** Items.buffer: how far (₹) the live price may be from expectedPrice. Absent = ₹5. */
  priceBuffer?: number;
}

/**
 * The Reward tab row an account points at. URL claims a reward link directly;
 * SPIN plays the spin wheel; STICKERS (called ACTIONS until 2026-10-06) works
 * through the sticker task cards. UNKNOWN is a row whose type did not read,
 * which the step fails with a note.
 */
export type RewardType = "url" | "spin" | "stickers" | "unknown";

export interface RewardSpec {
  /** Reward-tab row number, so its status can be written back. 0 = not from the sheet. */
  row: number;
  type: RewardType;
  /**
   * The reward link, tried first whatever the type. SPIN/STICKERS fall back
   * to their default page when it is dead, expired or already claimed.
   */
  url: string;
  /** Reward-tab status: PENDING (or blank), BLOCKED, COMPLETED. */
  status: string;
  /** SPIN quiz option to pick (case-insensitive). Blank = the first option. */
  answer: string;
  /** Wanted coupons, one per line (see coupons.ts). Blank = any. */
  coupons: string;
}

/** What the bot writes to a Reward row: BLOCKED while it works on it, COMPLETED once claimed. */
export type RewardMark = "BLOCKED" | "COMPLETED";

/** The cells written along with a mark; absent = leave the cell as it is. */
export interface RewardMarkExtra {
  found_coupons?: string;
  notes?: string;
}

export function rewardDone(r: RewardSpec): boolean {
  return r.status.trim().toUpperCase() === "COMPLETED";
}

/**
 * A row check_reward can act on: SPIN / STICKERS, or anything with a
 * reward_url. A row with neither a known type nor a url is left alone.
 */
export function rewardActionable(r: RewardSpec): boolean {
  return r.type === "spin" || r.type === "stickers" || r.url.trim() !== "";
}

/** Sheet spelling -> RewardType. SPIN / STICKERS by name; anything else with a url means URL. */
export function parseRewardType(raw: string, url = ""): RewardType | null {
  const t = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (t === "url" || t === "link") return "url";
  if (t === "spin" || t === "spin_wheel" || t === "spinwheel") return "spin";
  if (t === "stickers" || t === "sticker" || t === "actions" || t === "action") return "stickers";
  return url.trim() ? "url" : null;
}

export interface TargetAddress {
  fullName: string;
  phone: string;
  pincode: string;
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  state: string;
  country: string;
  /** Multi-address only: the ItemsQuantity cell, "item_id_quantity" per line. See allocation.ts. */
  itemsQuantity?: string;
  /** The Address-tab row (fleet jobs): where note_order_id's order id for this address goes. */
  row?: number;
}

export function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, "..", ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[key] = value;
  }
  return out;
}

const PROCESS_OWNED = new Set([
  "RUN_ID",
  "SLOT_INDEX",
  "SLOT_TOKEN",
  "SLOT_PORT",
  "MANAGER_URL",
  "JOB_ID",
]);

export function reloadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, "..", ".env");
  if (!existsSync(envPath)) return;
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(envPath, "utf8")))) {
    if (PROCESS_OWNED.has(key)) continue;
    process.env[key] = value;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  loadDotEnv();

  const email = (env.AMAZON_EMAIL ?? "").trim();
  const password = env.AMAZON_PASSWORD ?? "";
  const totpSecret = (env.AMAZON_TOTP_SECRET ?? "").replace(/\s/g, "");

  const missing: string[] = [];
  if (!email) missing.push("AMAZON_EMAIL");
  if (!password) missing.push("AMAZON_PASSWORD");
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(", ")}. ` +
        `Copy bot/.env.example to bot/.env and fill them in.`,
    );
  }

  return { credentials: { email, password, totpSecret }, headless: loadHeadless(env) };
}

export function loadHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.BROWSER_HEADLESS ?? "").trim();
  return raw === "" ? true : !/^(0|false|no|off)$/i.test(raw);
}

export function loadProduct(env: NodeJS.ProcessEnv = process.env): ProductSpec {
  loadDotEnv();

  const url = (env.PRODUCT_URL ?? "").trim();
  if (!url) throw new Error("Missing required env var: PRODUCT_URL");
  if (!/^https?:\/\/(www\.)?(amazon\.in|amzn\.in)\//i.test(url)) {
    throw new Error(`PRODUCT_URL must be an amazon.in or amzn.in link, got "${url}"`);
  }

  const rawQty = (env.PRODUCT_QUANTITY ?? "5").trim();
  const quantity = Number(rawQty);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(`PRODUCT_QUANTITY must be a positive integer, got "${rawQty}"`);
  }

  const rawOpt = (env.PRODUCT_PURCHASE_OPTION ?? "auto").trim().toLowerCase();
  const allowed: PurchaseOption[] = ["auto", "one_time", "subscribe_save", "fresh"];
  if (!allowed.includes(rawOpt as PurchaseOption)) {
    throw new Error(
      `PRODUCT_PURCHASE_OPTION must be one of ${allowed.join(" | ")}, got "${rawOpt}"`,
    );
  }

  return { url, quantity, purchaseOption: rawOpt as PurchaseOption };
}

export function loadAddress(env: NodeJS.ProcessEnv = process.env): TargetAddress {
  loadDotEnv();

  const get = (k: string) => (env[k] ?? "").trim();
  const address: TargetAddress = {
    fullName: get("ADDRESS_NAME"),
    phone: get("ADDRESS_PHONE"),
    pincode: get("ADDRESS_PINCODE"),
    line1: get("ADDRESS_LINE1"),
    line2: get("ADDRESS_LINE2"),
    landmark: get("ADDRESS_LANDMARK"),
    city: get("ADDRESS_CITY"),
    state: get("ADDRESS_STATE"),
    country: get("ADDRESS_COUNTRY") || "India",
  };

  const required: Array<[Exclude<keyof TargetAddress, "itemsQuantity" | "row">, string]> = [
    ["fullName", "ADDRESS_NAME"],
    ["phone", "ADDRESS_PHONE"],
    ["pincode", "ADDRESS_PINCODE"],
    ["line1", "ADDRESS_LINE1"],
    ["city", "ADDRESS_CITY"],
    ["state", "ADDRESS_STATE"],
  ];
  const missing = required.filter(([f]) => address[f].length === 0).map(([, envVar]) => envVar);
  if (missing.length > 0) {
    throw new Error(`Missing required address env var(s): ${missing.join(", ")}.`);
  }
  if (!/^\d{6}$/.test(address.pincode)) {
    throw new Error(`ADDRESS_PINCODE must be a 6-digit PIN code, got "${address.pincode}".`);
  }
  return address;
}
