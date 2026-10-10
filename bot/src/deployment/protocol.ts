import { createHmac, timingSafeEqual } from "node:crypto";

export interface Release { repository: string; sha: string; runId: number; attempt: number }
export const releaseId = (r: Release): string => `${r.runId}-${r.attempt}`;

export function validateRelease(value: unknown, repository: string): Release {
  const r = value as Partial<Release> | null;
  if (!r || r.repository !== repository || !/^[a-f0-9]{40}$/.test(r.sha ?? "") ||
      !Number.isSafeInteger(r.runId) || (r.runId ?? 0) < 1 ||
      !Number.isSafeInteger(r.attempt) || (r.attempt ?? 0) < 1) throw new Error("Invalid release");
  return r as Release;
}

export function signature(secret: string, timestamp: string, path: string, body: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${path}.`).update(body).digest("hex")}`;
}

export function verify(secret: string, timestamp: string, path: string, body: Buffer, supplied: string, now = Date.now()): boolean {
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300_000 ||
      !/^sha256=[a-f0-9]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(signature(secret, timestamp, path, body)), Buffer.from(supplied));
}

export interface DeploymentSteps {
  prepare(): Promise<void>;
  drain(): Promise<void>;
  activate(): Promise<void>;
  health(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  resume(): Promise<void>;
}

/** Prepare before interrupting work; rollback even a partially completed activation. */
export async function runDeployment(steps: DeploymentSteps): Promise<void> {
  let activationStarted = false;
  let drainStarted = false;
  try {
    await steps.prepare();
    drainStarted = true;
    await steps.drain();
    activationStarted = true;
    await steps.activate();
    await steps.health();
    await steps.commit();
  } catch (error) {
    try {
      if (activationStarted) await steps.rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Deployment and rollback failed; maintenance remains enabled");
    }
    throw error;
  } finally {
    // resume() checks for an unfinished transaction and fails closed in that case.
    if (drainStarted) await steps.resume();
  }
}
