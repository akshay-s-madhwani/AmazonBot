import { createHash, createSign, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePaymentCodes, type ProductSpec, type PurchaseOption } from "./config.js";
import type { ClaimedJob, JobFilter, JobResult, SheetJob } from "./job-client.js";
import { resolveNodeId } from "./node-id.js";

/**
 * DIRECT SHEET ACCESS IS FOR A STANDALONE BOT ONLY.
 *
 * A bot linked to a master (MASTER_URL set) takes its work from the master,
 * which claims rows under a database lock and serialises runs per Amazon
 * account. A direct client can do neither — two machines reading and then
 * writing the same cell can both claim one row — so the two modes must never
 * be mixed. Direct mode is on when there is no master and a sheet is named.
 */
export function sheetDirectMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const master = (env.MASTER_URL ?? "").trim();
  const sheet = (SHEET_ID || env.SHEET_ID || "").trim();
  if (master && sheet) {
    throw new Error(
      "both MASTER_URL and SHEET_ID are set — a bot linked to a master must not read the " +
        "sheet itself. Remove SHEET_ID (fleet bot) or MASTER_URL (standalone bot).",
    );
  }
  return !master && sheet !== "";
}

const SHEET_ID = "";
const CREDENTIALS_PATH = "";
const USERS_TAB = "Sheet1";
const ITEMS_TAB = "Items";
const CONFIG_TAB = "Config";
const DEFAULT_INSTANCES = 1;

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_PATH = join(HERE, "..", ".sheet-direct-ledger.json");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 400;
const LAST_COL = "AZ";
const MAX_USER_ROWS = 1000;
const MAX_ITEM_ROWS = 2000;
const MAX_CONFIG_ROWS = 50;

const USER_HEADERS = [
  "status",
  "user_id",
  "node_id",
  "account_email",
  "account_password",
  "account_totp_secret",
  "address_name",
  "address_phone",
  "address_pincode",
  "address_line1",
  "address_line2",
  "address_landmark",
  "address_city",
  "address_state",
  "payment_method",
  "payment_codes",
  "order_id",
  "order_placed_at",
  "notes",
  "row_uid",
] as const;

const ITEM_HEADERS = [
  "user_id",
  "product_url",
  "quantity",
  "purchase_option",
  "apply_coupon",
  "price",
  "notes",
] as const;

type UserCol = (typeof USER_HEADERS)[number];
type ItemCol = (typeof ITEM_HEADERS)[number];
type ColumnMap<K extends string> = Record<K, number>;

const PURCHASE_OPTIONS: PurchaseOption[] = ["auto", "one_time", "subscribe_save", "fresh"];

function sheetId(): string {
  const id = (SHEET_ID || process.env.SHEET_ID || "").trim();
  if (!id) {
    throw new Error(
      "sheet-direct is on but no spreadsheet is configured — set SHEET_ID in sheet-direct.ts or in the environment.",
    );
  }
  return id;
}

function credentialsPath(): string {
  const path = (CREDENTIALS_PATH || process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
  if (!path) {
    throw new Error(
      "sheet-direct is on but no Google service-account key is configured — set CREDENTIALS_PATH in sheet-direct.ts or GOOGLE_APPLICATION_CREDENTIALS in the environment.",
    );
  }
  if (!existsSync(path)) {
    throw new Error(`sheet-direct: the service-account key does not exist at ${path}`);
  }
  return path;
}

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let cachedToken: { token: string; expiresAt: number; path: string } | null = null;

async function accessToken(): Promise<string> {
  const path = credentialsPath();
  const nowMs = Date.now();
  if (cachedToken && cachedToken.path === path && cachedToken.expiresAt > nowMs) {
    return cachedToken.token;
  }

  const sa = JSON.parse(readFileSync(path, "utf8")) as {
    client_email?: string;
    private_key?: string;
  };
  if (!sa.client_email || !sa.private_key) {
    throw new Error(`${path} is not a service-account key (missing client_email/private_key)`);
  }

  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(sa.private_key).toString("base64url");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${signature}`,
    }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Google token exchange failed (${res.status}): ${body.error_description ?? JSON.stringify(body)}`,
    );
  }

  cachedToken = {
    token: body.access_token,
    expiresAt: nowMs + Math.max(0, (body.expires_in ?? 3600) * 1000 - 60_000),
    path,
  };
  return body.access_token;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken();
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const res = await fetch(`${API}/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;

    const retriable = res.status === 429 || res.status >= 500;
    const hint =
      res.status === 403
        ? "\nHINT: share the sheet with the service-account email (Editor access)."
        : "";
    lastError = `Sheets API ${res.status} on ${path}: ${text.slice(0, 300)}${hint}`;
    if (!retriable || attempt === MAX_ATTEMPTS) throw new Error(lastError);
    await sleep(BACKOFF_BASE_MS * 2 ** attempt);
  }
  throw new Error(lastError);
}

async function readRange(range: string): Promise<string[][]> {
  const data = await api<{ values?: string[][] }>(
    `${sheetId()}/values/${encodeURIComponent(range)}`,
  );
  return data.values ?? [];
}

async function writeCells(
  updates: Array<{ range: string; values: (string | number)[][] }>,
): Promise<void> {
  if (updates.length === 0) return;
  await api(`${sheetId()}/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: updates }),
  });
}

function colLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const normaliseHeader = (raw: string): string =>
  (raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

const cell = (row: string[], i: number): string => (i < 0 ? "" : (row[i] ?? "").trim());

const bool = (v: string): boolean => /^(true|yes|y|1)$/i.test(v.trim());

function resolveColumns<K extends string>(
  names: readonly K[],
  headerRow: string[] | undefined,
): ColumnMap<K> {
  const at = new Map<string, number>();
  (headerRow ?? []).forEach((raw, i) => {
    const key = normaliseHeader(raw);
    if (key && !at.has(key)) at.set(key, i);
  });
  if (!names.some((n) => at.has(n))) {
    return Object.fromEntries(names.map((h, i) => [h, i])) as ColumnMap<K>;
  }
  const map = {} as ColumnMap<K>;
  for (const n of names) map[n] = at.get(n) ?? -1;
  return map;
}

function parseItem(row: string[], icol: ColumnMap<ItemCol>): ProductSpec | null {
  const qtyRaw = cell(row, icol.quantity);
  const quantity = qtyRaw ? Number(qtyRaw) : 5;
  if (!Number.isInteger(quantity) || quantity < 1) return null;

  const opt = (cell(row, icol.purchase_option) || "auto").toLowerCase();
  if (!PURCHASE_OPTIONS.includes(opt as PurchaseOption)) return null;

  const priceRaw = cell(row, icol.price).replace(/[₹,\s]/g, "");
  const expectedPrice = priceRaw ? Number(priceRaw) : undefined;
  if (expectedPrice !== undefined && !Number.isFinite(expectedPrice)) return null;

  const applyCouponRaw = cell(row, icol.apply_coupon);
  return {
    url: cell(row, icol.product_url),
    quantity,
    purchaseOption: opt as PurchaseOption,
    applyCoupon: icol.apply_coupon < 0 || applyCouponRaw === "" ? true : bool(applyCouponRaw),
    ...(expectedPrice !== undefined ? { expectedPrice } : {}),
  };
}

interface Snapshot {
  userRows: string[][];
  col: ColumnMap<UserCol>;
  itemsByUser: Map<string, ProductSpec[]>;
  config: Record<string, string>;
}

async function snapshot(): Promise<Snapshot> {
  const userRows = await readRange(`${USERS_TAB}!A1:${LAST_COL}${MAX_USER_ROWS}`);
  const col = resolveColumns(USER_HEADERS, userRows[0]);

  const itemsByUser = new Map<string, ProductSpec[]>();
  try {
    const itemRows = await readRange(`${ITEMS_TAB}!A1:${LAST_COL}${MAX_ITEM_ROWS}`);
    const icol = resolveColumns(ITEM_HEADERS, itemRows[0]);
    for (const row of itemRows.slice(1)) {
      const userId = cell(row, icol.user_id);
      if (!userId) continue;
      const item = parseItem(row, icol);
      if (!item || !item.url) continue;
      const list = itemsByUser.get(userId) ?? [];
      list.push(item);
      itemsByUser.set(userId, list);
    }
  } catch {
  }

  const config: Record<string, string> = {};
  try {
    const configRows = await readRange(`${CONFIG_TAB}!A1:B${MAX_CONFIG_ROWS}`);
    for (const row of configRows) {
      const key = normaliseHeader(cell(row, 0));
      if (key) config[key] = cell(row, 1);
    }
  } catch {
  }

  return { userRows, col, itemsByUser, config };
}

const WRITE_BACK_COLUMNS: readonly UserCol[] = [
  "status",
  "order_id",
  "order_placed_at",
  "notes",
];

function rowRevision(row: string[], items: ProductSpec[], col: ColumnMap<UserCol>): string {
  const written = new Set<UserCol>(WRITE_BACK_COLUMNS);
  const input = USER_HEADERS.map((h) => (written.has(h) ? "" : cell(row, col[h])));
  const basket = items.map((i) => [i.url, i.quantity, i.purchaseOption, i.expectedPrice, i.applyCoupon]);
  return createHash("sha256")
    .update(JSON.stringify([input, basket]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * A row's id is its row_uid when the sheet has one, and its position only
 * when it does not. Position is not an identity: sorting or inserting a row
 * moves somebody else's order into it, and a resume that re-read "row 7" would
 * then run on the wrong account.
 */
function jobId(rowNumber: number, rowUid: string): string {
  return `${sheetId()}:${USERS_TAB}:${rowUid || rowNumber}`;
}

/** Finds a job's row in a snapshot by row_uid, or by position as a fallback. */
function locateRow(snap: Snapshot, id: string): { row: string[]; rowNumber: number } | null {
  const key = id.split(":").pop() ?? "";
  if (snap.col.row_uid >= 0 && key && !/^\d+$/.test(key)) {
    for (let i = 1; i < snap.userRows.length; i += 1) {
      const row = snap.userRows[i] ?? [];
      if (cell(row, snap.col.row_uid) === key) return { row, rowNumber: i + 1 };
    }
    return null;
  }
  const n = Number(key);
  if (!Number.isInteger(n) || n < 2) return null;
  // A positional id on a sheet that HAS row ids is stale — refuse it rather
  // than guess which order now sits at that position.
  if (snap.col.row_uid >= 0 && cell(snap.userRows[n - 1] ?? [], snap.col.row_uid)) return null;
  const row = snap.userRows[n - 1];
  return row ? { row, rowNumber: n } : null;
}

function toJob(row: string[], rowNumber: number, snap: Snapshot): SheetJob {
  const col = snap.col;
  const userId = cell(row, col.user_id);
  const method = cell(row, col.payment_method).toLowerCase().replace(/[\s-]+/g, "_");
  const items = snap.itemsByUser.get(userId) ?? [];
  return {
    id: jobId(rowNumber, cell(row, col.row_uid)),
    sheetId: sheetId(),
    rowNumber,
    revision: rowRevision(row, items, col),
    userId,
    nodeId: cell(row, col.node_id),
    status: cell(row, col.status).toUpperCase(),
    credentials: {
      email: cell(row, col.account_email),
      password: col.account_password < 0 ? "" : (row[col.account_password] ?? ""),
      totpSecret: cell(row, col.account_totp_secret).replace(/\s+/g, ""),
    },
    address: {
      fullName: cell(row, col.address_name),
      phone: cell(row, col.address_phone),
      pincode: cell(row, col.address_pincode),
      line1: cell(row, col.address_line1),
      line2: cell(row, col.address_line2),
      landmark: cell(row, col.address_landmark),
      city: cell(row, col.address_city),
      state: cell(row, col.address_state),
      country: "India",
    },
    items,
    payment:
      method === "voucher" || method === "amazon_pay"
        ? { method, codes: parsePaymentCodes(cell(row, col.payment_codes)) }
        : { method: "none", codes: [] },
    // The old single-tab layout has no Reward tab and one inline address.
    addresses: [],
    rewards: [],
    orderId: cell(row, col.order_id),
  };
}

interface Ledger {
  purchases: Record<string, { token: string; attempted_at: string; order_id?: string }>;
}

/**
 * The purchase ledger is what stops a second order, so it must never be
 * silently empty: a missing file is a fresh ledger, but an unreadable one is
 * an error, and a write that fails must fail the purchase rather than let it
 * proceed unrecorded.
 */
function readLedger(): Ledger {
  if (!existsSync(LEDGER_PATH)) return { purchases: {} };
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Ledger;
  } catch (err) {
    throw new Error(
      `sheet-direct: purchase ledger ${LEDGER_PATH} is unreadable (${(err as Error).message}) — ` +
        `refusing to continue without it; restore or remove it by hand`,
    );
  }
}

/** Temp file + rename, so a crash mid-write cannot leave a truncated ledger. */
function writeLedger(ledger: Ledger): void {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  const tmp = `${LEDGER_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
  renameSync(tmp, LEDGER_PATH);
}

export class SheetDirectClient {
  readonly node_id: string;

  constructor(private readonly log: (msg: string) => void = () => { }) {
    this.node_id = resolveNodeId().id;
  }

  private mine(row: string[], col: ColumnMap<UserCol>): boolean {
    const nodeId = cell(row, col.node_id);
    return nodeId === "" || nodeId === this.node_id;
  }

  async listJobs(filter: JobFilter = {}): Promise<SheetJob[]> {
    const snap = await snapshot();
    const wanted = (filter.status ?? "PENDING")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    const jobs: SheetJob[] = [];
    for (let i = 1; i < snap.userRows.length; i += 1) {
      const row = snap.userRows[i] ?? [];
      const rowNumber = i + 1;
      if (!this.mine(row, snap.col)) continue;

      const job = toJob(row, rowNumber, snap);
      if (wanted.length > 0 && !wanted.includes(job.status)) continue;
      if (filter.rows?.length && !filter.rows.includes(rowNumber)) continue;
      if (filter.userId && job.userId !== filter.userId) continue;
      if (filter.runnable && !job.userId) continue;
      jobs.push(filter.secrets ? job : redact(job));
      if (filter.limit !== undefined && jobs.length >= filter.limit) break;
    }
    return jobs;
  }

  async getJob(job_id: string, opts: { secrets?: boolean } = {}): Promise<SheetJob> {
    const snap = await snapshot();
    const found = locateRow(snap, job_id);
    if (!found) throw new Error(`sheet-direct: ${USERS_TAB} has no row for job "${job_id}"`);

    const job = toJob(found.row, found.rowNumber, snap);
    return opts.secrets ? job : redact(job);
  }

  async claim(instances: number, rows?: number[]): Promise<ClaimedJob[]> {
    const snap = await snapshot();
    const picked: Array<{ job: SheetJob; rowNumber: number }> = [];

    for (let i = 1; i < snap.userRows.length && picked.length < instances; i += 1) {
      const row = snap.userRows[i] ?? [];
      const rowNumber = i + 1;
      if (rows?.length && !rows.includes(rowNumber)) continue;
      if (!this.mine(row, snap.col)) continue;
      if (cell(row, snap.col.status).toUpperCase() !== "PENDING") continue;

      const job = toJob(row, rowNumber, snap);
      if (!job.userId) continue;
      picked.push({ job, rowNumber });
    }

    if (picked.length === 0) return [];

    if (snap.col.status >= 0) {
      const letter = colLetter(snap.col.status);
      await writeCells(
        picked.map((p) => ({
          range: `${USERS_TAB}!${letter}${p.rowNumber}`,
          values: [["RUNNING"]],
        })),
      );
    }

    this.log(`[sheet-direct] claimed row(s) ${picked.map((p) => p.rowNumber).join(", ")}`);
    return picked.map((p) => ({
      dispatch: true,
      run_id: randomUUID(),
      job: { ...p.job, status: "RUNNING" },
    }));
  }

  async reportResult(job_id: string, result: JobResult): Promise<boolean> {
    try {
      // The whole tab, not just the header: the row is found by its id, and
      // writing to a remembered position would land on whatever moved there.
      const snap = await snapshot();
      const found = locateRow(snap, job_id);
      if (!found) {
        this.log(`[sheet-direct] could not report ${result.status} for ${job_id}: row not found`);
        return false;
      }
      const rowNumber = found.rowNumber;
      const col = snap.col;
      const updates: Array<{ range: string; values: (string | number)[][] }> = [];
      const put = (index: number, value: string): void => {
        if (index < 0) return;
        updates.push({
          range: `${USERS_TAB}!${colLetter(index)}${rowNumber}`,
          values: [[value]],
        });
      };

      put(col.status, result.status);
      if (result.order_id !== undefined) put(col.order_id, result.order_id);
      if (result.order_id) put(col.order_placed_at, new Date().toISOString());
      if (result.notes !== undefined) put(col.notes, result.notes);

      await writeCells(updates);
      return true;
    } catch (err) {
      this.log(
        `[sheet-direct] could not report ${result.status} for ${job_id}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  async beginPurchase(
    run_id: string,
    job_id: string,
  ): Promise<{ token: string; attempted_at: string }> {
    const ledger = readLedger();
    const key = `${run_id}|${job_id}`;
    const existing = ledger.purchases[key];
    if (existing) {
      if (existing.order_id) {
        throw new Error(
          `sheet-direct: run ${run_id} already placed order ${existing.order_id} — refusing a second attempt`,
        );
      }
      return { token: existing.token, attempted_at: existing.attempted_at };
    }

    const entry = { token: randomUUID(), attempted_at: new Date().toISOString() };
    ledger.purchases[key] = entry;
    writeLedger(ledger);
    return entry;
  }

  async completePurchase(
    run_id: string,
    job_id: string,
    token: string,
    order_id: string,
    _evidence: unknown,
  ): Promise<{ ok: boolean }> {
    const ledger = readLedger();
    const key = `${run_id}|${job_id}`;
    const entry = ledger.purchases[key];
    if (!entry || entry.token !== token) return { ok: false };
    entry.order_id = order_id;
    writeLedger(ledger);
    return { ok: true };
  }

  async resumeInputs(
    run_id: string,
    _execute = true,
  ): Promise<{ job: SheetJob | null; fresh_attempt: boolean }> {
    const jobIdFor = Object.keys(readLedger().purchases).find((k) =>
      k.startsWith(`${run_id}|`),
    );
    const id = jobIdFor?.split("|")[1] ?? (process.env.JOB_ID ?? "").trim();
    if (!id) return { job: null, fresh_attempt: false };
    return { job: await this.getJob(id, { secrets: true }), fresh_attempt: false };
  }

  async requestRetry(_run_id: string): Promise<{ ok: boolean; queued: boolean }> {
    return { ok: false, queued: false };
  }

  async config(): Promise<{ instances: number; raw: Record<string, string> }> {
    const snap = await snapshot();
    const raw = snap.config;
    const requested = Number(raw.instances ?? raw.instances_per_node ?? "");
    return {
      instances: Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_INSTANCES,
      raw,
    };
  }
}

function redact(job: SheetJob): SheetJob {
  const at = job.credentials.email.indexOf("@");
  return {
    ...job,
    credentials: {
      email:
        at > 0
          ? `${job.credentials.email[0]}***${job.credentials.email.slice(at)}`
          : job.credentials.email
            ? "***"
            : "",
      password: "",
      totpSecret: "",
    },
    payment: { method: job.payment.method, codes: job.payment.codes.map(() => ({ code: "***" })) },
  };
}

let singleton: SheetDirectClient | null = null;

export function sheetDirectClient(log?: (msg: string) => void): SheetDirectClient {
  singleton ??= new SheetDirectClient(log);
  return singleton;
}
