import {
  parseRewardType,
  type Credentials,
  type PaymentSpec,
  type ProductSpec,
  type RewardMark,
  type RewardMarkExtra,
  type RewardSpec,
  type TargetAddress,
} from "./config.js";
import { loadCredentials, refreshApiToken } from "./enroll.js";
import { sheetDirectClient, sheetDirectMode } from "./sheet-direct.js";

export interface SheetJob {
  id: string;
  sheetId: string;
  rowNumber: number;
  revision: string;
  userId: string;
  nodeId: string;
  status: string;
  credentials: Credentials;
  address: TargetAddress;
  addresses: TargetAddress[];
  items: ProductSpec[];
  payment: PaymentSpec;
  rewards: RewardSpec[];
  orderId: string;
}

interface WireJob {
  id: string;
  sheet_id: string;
  row_number: number;
  revision: string;
  user_id: string;
  node_id: string;
  status: string;
  credentials: Credentials;
  address: TargetAddress;
  addresses?: TargetAddress[] | null;
  items: ProductSpec[];
  payment: PaymentSpec;
  rewards?: Array<{ row: number; type: string; url: string; status: string; answer?: string; coupons?: string }> | null;
  orderId?: string;
}

function rewardsFromWire(rows: WireJob["rewards"]): RewardSpec[] {
  const out: RewardSpec[] = [];
  for (const r of rows ?? []) {
    // A type that does not read is kept, so check_reward fails it with a note.
    out.push({
      row: r.row,
      type: parseRewardType(r.type ?? "", r.url ?? "") ?? "unknown",
      url: r.url ?? "",
      status: r.status ?? "",
      answer: r.answer ?? "",
      coupons: r.coupons ?? "",
    });
  }
  return out;
}

export function fromWire(w: WireJob): SheetJob {
  return {
    id: w.id,
    sheetId: w.sheet_id,
    rowNumber: w.row_number,
    revision: w.revision,
    userId: w.user_id,
    nodeId: w.node_id,
    status: w.status,
    credentials: w.credentials,
    address: w.address,
    addresses: w.addresses ?? [],
    items: w.items ?? [],
    payment: w.payment,
    rewards: rewardsFromWire(w.rewards),
    orderId: w.orderId ?? "",
  };
}

export interface JobFilter {
  status?: string;
  rows?: number[];
  userId?: string;
  sinceRevision?: string;
  runnable?: boolean;
  secrets?: boolean;
  limit?: number;
}

export interface ClaimedJob {
  dispatch: boolean;
  run_id: string;
  job: SheetJob;
}

export interface JobResult {
  status: string;
  order_id?: string;
  notes?: string;
  run_id?: string;
}

const TIMEOUT_MS = 15_000;
const RESULT_ATTEMPTS = 3;

export class JobClient {
  private constructor(
    private readonly master_url: string,
    /** Replaced in place when the master re-issues it (see call). */
    private api_token: string,
    readonly node_id: string,
    private readonly log: (msg: string) => void,
  ) {}

  static fromEnv(log: (msg: string) => void = () => {}): JobClient | null {
    if (sheetDirectMode()) return sheetDirectClient(log) as unknown as JobClient;
    const masterUrl = (process.env.MASTER_URL ?? "").trim().replace(/\/+$/, "");
    const creds = loadCredentials();
    if (!masterUrl || !creds) return null;
    return new JobClient(masterUrl, creds.api_token, creds.bot_id, log);
  }

  private async call<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const send = (): Promise<Response> =>
      fetch(`${this.master_url}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.api_token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    let res = await send();
    // Token refused: pick up a re-issued one and retry once.
    if (res.status === 401) {
      const fresh = await refreshApiToken(this.master_url, this.api_token, this.log);
      if (fresh) {
        this.api_token = fresh;
        res = await send();
      }
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        detail = (JSON.parse(text) as { error?: string }).error ?? detail;
      } catch {
      }
      throw new Error(`master ${res.status} on ${path}: ${detail}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async listJobs(filter: JobFilter = {}): Promise<SheetJob[]> {
    const q = new URLSearchParams();
    if (filter.status) q.set("status", filter.status);
    if (filter.rows?.length) q.set("rows", filter.rows.join(","));
    if (filter.userId) q.set("user_id", filter.userId);
    if (filter.sinceRevision) q.set("since_revision", filter.sinceRevision);
    if (filter.runnable) q.set("runnable", "true");
    if (filter.secrets) q.set("include_secrets", "true");
    if (filter.limit !== undefined) q.set("limit", String(filter.limit));
    const body = await this.call<{ jobs: WireJob[] }>(`/node/jobs?${q.toString()}`);
    return (body.jobs ?? []).map(fromWire);
  }

  async getJob(job_id: string, opts: { secrets?: boolean } = {}): Promise<SheetJob> {
    const q = opts.secrets ? "?include_secrets=true" : "";
    const body = await this.call<{ job: WireJob }>(
      `/node/jobs/${encodeURIComponent(job_id)}${q}`,
    );
    return fromWire(body.job);
  }

  async claim(instances: number, rows?: number[]): Promise<ClaimedJob[]> {
    const body = await this.call<{ claimed: Array<{ run_id: string; job: WireJob; dispatch: boolean }> }>(
      "/node/jobs/claim",
      {
        method: "POST",
        body: JSON.stringify({ instances, ...(rows?.length ? { rows } : {}) }),
      },
    );
    return (body.claimed ?? []).map((c) => ({ run_id: c.run_id, job: fromWire(c.job), dispatch: c.dispatch === true }));
  }

  async reportResult(job_id: string, result: JobResult): Promise<boolean> {
    for (let attempt = 1; attempt <= RESULT_ATTEMPTS; attempt += 1) {
      try {
        await this.call(`/node/jobs/${encodeURIComponent(job_id)}/result`, {
          method: "POST",
          body: JSON.stringify(result),
        });
        return true;
      } catch (err) {
        const message = (err as Error).message;
        if (/master 4\d\d/.test(message) || attempt === RESULT_ATTEMPTS) {
          this.log(`[job] could not report ${result.status} for ${job_id}: ${message}`);
          return false;
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    return false;
  }

  /**
   * BLOCKED while a Reward row is being worked on, COMPLETED once claimed;
   * `extra` fills the row's "Found coupons" and "notes" cells.
   */
  async markReward(
    job_id: string,
    run_id: string,
    row: number,
    status: RewardMark,
    extra: RewardMarkExtra = {},
  ): Promise<void> {
    await this.call(`/node/jobs/${encodeURIComponent(job_id)}/rewards`, {
      method: "POST",
      body: JSON.stringify({ run_id, row_number: row, status, ...extra }),
    });
  }

  beginPurchase(run_id: string, job_id: string): Promise<{ token: string; attempted_at: string }> {
    return this.call("/node/purchases/begin", { method: "POST", body: JSON.stringify({ run_id, job_id }) });
  }

  requestRetry(run_id: string): Promise<{ ok: boolean; queued: boolean }> {
    return this.call(`/node/runs/${encodeURIComponent(run_id)}/retry`, { method: "POST" });
  }

  async resumeInputs(run_id: string, execute = true): Promise<{ job: SheetJob | null; fresh_attempt: boolean }> {
    const result = await this.call<{ job: WireJob | null; fresh_attempt: boolean }>(
      `/node/runs/${encodeURIComponent(run_id)}/resume-inputs`, { method: "POST", body: JSON.stringify({ execute }) });
    return { job: result.job ? fromWire(result.job) : null, fresh_attempt: result.fresh_attempt };
  }

  completePurchase(run_id: string, job_id: string, token: string, order_id: string, evidence: unknown): Promise<{ ok: boolean }> {
    return this.call("/node/purchases/complete", { method: "POST", body: JSON.stringify({ run_id, job_id, token, order_id, evidence }) });
  }

  async config(): Promise<{ instances: number; raw: Record<string, string> }> {
    return this.call<{ instances: number; raw: Record<string, string> }>(
      "/node/config",
    );
  }
}

export function requireJobClient(log?: (msg: string) => void): JobClient {
  const client = JobClient.fromEnv(log);
  if (!client) {
    throw new Error(
      "no master to get jobs from — the master owns the sheet now. Set MASTER_URL " +
        "and enroll this bot (it needs .fleet-credentials.json), or run a single " +
        "job from .env instead.",
    );
  }
  return client;
}
