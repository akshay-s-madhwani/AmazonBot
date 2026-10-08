import { loadDotEnv } from "./config.js";
import { describe, fleetProcesses, fleetRoots, killAll, listProcesses } from "./procs.js";

/**
 * CLEANUP — kills this bot folder's leftover slots, runners and browsers.
 *
 *   npm run cleanup              orphans only, or everything if no manager runs
 *   npm run cleanup -- --all     every slot, runner and browser of this folder
 *   npm run cleanup -- --dry-run list what would go, kill nothing
 *
 * With the manager running, it is asked to do it: it knows which runs are
 * live, and tells the master about every session it closes. With no manager,
 * nothing here is being managed, so everything of this folder goes — the
 * next manager start reports those runs' sessions closed.
 *
 * Only processes of THIS folder are touched (its dist/slot.js, dist/runner.js
 * and browsers on its browser-profiles); the operator's own Chrome and other
 * bot folders are left alone.
 */
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || args.has("--dry");
const everything = args.has("--all");

loadDotEnv();
const port = Number(process.env.MANAGER_PORT ?? 7800);
const manager = `http://127.0.0.1:${port}`;

async function viaManager(): Promise<boolean> {
  const up = await fetch(`${manager}/fleet/status`, { signal: AbortSignal.timeout(3_000) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!up) return false;
  console.log(`manager is running on ${manager} — asking it to clean up${everything ? " EVERYTHING" : " orphans"}…`);
  const res = await fetch(`${manager}/fleet/cleanup?all=${everything ? 1 : 0}&dry=${dryRun ? 1 : 0}`, {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(
      `the manager answered ${res.status} — it is older than this script. Restart the manager (it cleans up on start), ` +
        `or stop it and run this again.`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as {
    processes?: Array<{ kind: string; pid: number; run_id: string | null; profile: string | null }>;
  };
  const list = body.processes ?? [];
  for (const p of list) console.log(`  ${dryRun ? "would kill" : "killed"} ${p.kind} pid ${p.pid} ${p.run_id ?? p.profile ?? ""}`);
  console.log(list.length ? `${list.length} process(es) ${dryRun ? "found" : "cleaned up"}` : "nothing to clean up");
  return true;
}

async function direct(): Promise<void> {
  console.log("no manager running — everything of this bot folder is unmanaged");
  const all = await listProcesses();
  const found = fleetProcesses(all, fleetRoots());
  if (found.length === 0) {
    console.log("nothing to clean up");
    return;
  }
  if (dryRun) {
    for (const p of found) console.log(`  would kill ${describe(p)}`);
    console.log(`${found.length} process(es) found`);
    return;
  }
  const killed = await killAll(found, all);
  for (const p of killed) console.log(`  killed ${describe(p)}`);
  console.log(`${killed.length} process(es) cleaned up`);
}

try {
  if (!(await viaManager())) await direct();
} catch (err) {
  console.error(`cleanup failed: ${(err as Error).message}`);
  process.exit(1);
}
