import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class StartOutcomeUnknownError extends Error {}

export function wasRunAccepted(root: string, runId: string, jobId: string): boolean {
  const file = join(root, createHash("sha256").update(runId).digest("hex") + ".json");
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  const prior = JSON.parse(raw) as { runId: string; jobId: string };
  if (prior.runId !== runId || prior.jobId !== jobId) throw new Error("run id already belongs to a different job");
  return true;
}

export function acceptRun(root: string, runId: string, jobId: string): boolean {
  mkdirSync(root, { recursive: true });
  const file = join(root, createHash("sha256").update(runId).digest("hex") + ".json");
  try {
    writeFileSync(file, JSON.stringify({ runId, jobId }), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = JSON.parse(readFileSync(file, "utf8")) as { runId: string; jobId: string };
    if (prior.runId !== runId || prior.jobId !== jobId) throw new Error("run id already belongs to a different job");
    return false;
  }
}
