import { createHmac, timingSafeEqual } from "node:crypto";

export interface Release { repository: string; sha: string; runId: number; attempt: number; prNumber?: number }
export const releaseId = (r: Release): string => `${r.runId}-${r.attempt}`;

export function validateRelease(value: unknown, repository: string): Release {
  const r = value as Partial<Release> | null;
  if (!r || r.repository !== repository || !/^[a-f0-9]{40}$/.test(r.sha ?? "") ||
      !Number.isSafeInteger(r.runId) || (r.runId ?? 0) < 1 ||
      !Number.isSafeInteger(r.attempt) || (r.attempt ?? 0) < 1 ||
      (r.prNumber !== undefined && (!Number.isSafeInteger(r.prNumber) || r.prNumber < 1))) throw new Error("Invalid release");
  return r as Release;
}

export function validateWorkflowRun(release: Release, run: any, pr?: any, jobs: any[] = []): void {
  const finished = run.status === "completed" && run.conclusion === "success";
  const buildingDeployment = run.status === "in_progress" && run.conclusion == null &&
    jobs.some(job => job.name === "Build and test bot" && job.status === "completed" &&
      job.conclusion === "success" && job.run_id === release.runId && job.run_attempt === release.attempt);
  if ((!finished && !buildingDeployment) ||
      run.run_attempt !== release.attempt || run.path !== ".github/workflows/deploy.yml" ||
      run.repository?.full_name !== release.repository || run.head_repository?.full_name !== release.repository)
    throw new Error("Unapproved workflow run");
  if (release.prNumber !== undefined) {
    const matchingSource = (run.event === "pull_request" && run.head_sha === release.sha && pr?.head?.ref === run.head_branch) ||
      (run.event === "workflow_dispatch" && run.head_branch === "main");
    if (!matchingSource || pr?.number !== release.prNumber || pr.state !== "open" ||
        pr.base?.ref !== "main" || pr.base?.repo?.full_name !== release.repository ||
        pr.head?.repo?.full_name !== release.repository || pr.head.sha !== release.sha)
      throw new Error("PR is closed, changed, from a fork, or does not match this build");
  } else if (!["push", "workflow_dispatch"].includes(run.event) || run.head_branch !== "main" || run.head_sha !== release.sha) {
    throw new Error("Only main builds or explicitly selected PR builds can deploy");
  }
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
