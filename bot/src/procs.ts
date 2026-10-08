import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { profilesDir } from "./shardx.js";

/**
 * THIS BOT FOLDER'S PROCESSES, found by their command lines — the cleanup's
 * eyes. A slot or runner is a node process running this folder's
 * dist/slot.js or dist/runner.js; a browser is a ShardX browser whose
 * --user-data-dir is in this folder's browser-profiles. Nothing else on the
 * machine (another bot folder, the operator's own Chrome) ever matches.
 *
 * Why it exists (2026-10-08): slots, runners and browsers are detached so a
 * manager restart can reattach to them — which also means nothing ever
 * collected one whose owner died. A slot killed hard (Reset's fallback, the
 * TTL reaper on Windows, a crash) leaves its runner parked on its control
 * port forever and its browser open; machines filled up after a few runs.
 */

export interface Proc {
  pid: number;
  ppid: number;
  cmd: string;
}

export type FleetKind = "slot" | "runner" | "browser";

export interface FleetProc extends Proc {
  kind: FleetKind;
  /** runner: the run_id in its config argument. */
  runId: string | null;
  /** browser: its ShardX profile folder name (profileIdForRun of its run). */
  profileId: string | null;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every process on the machine, with its parent and full command line. */
export function listProcesses(): Promise<Proc[]> {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
        (err, stdout) => {
          if (err) return reject(err);
          try {
            const raw = JSON.parse(stdout || "[]") as
              | Array<{ ProcessId: number; ParentProcessId: number; CommandLine: string | null }>
              | { ProcessId: number; ParentProcessId: number; CommandLine: string | null };
            const rows = Array.isArray(raw) ? raw : [raw];
            resolve(rows.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, cmd: r.CommandLine ?? "" })));
          } catch (e) {
            reject(e);
          }
        },
      );
      return;
    }
    execFile(
      "ps",
      ["-axww", "-o", "pid=,ppid=,command="],
      { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        if (err) return reject(err);
        const out: Proc[] = [];
        for (const line of stdout.split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
          if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! });
        }
        resolve(out);
      },
    );
  });
}

/** Paths compared case-insensitively with one kind of slash: command lines quote them every which way. */
const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

export interface FleetRoots {
  /** The folder holding slot.js / runner.js. */
  dist: string;
  /** The ShardX profiles folder. */
  profiles: string;
}

export function fleetRoots(): FleetRoots {
  return { dist: HERE, profiles: profilesDir() };
}

/** Which of `all` are this folder's slots, runners and browsers (a browser's main process only). */
export function fleetProcesses(all: Proc[], roots: FleetRoots): FleetProc[] {
  const slot = norm(join(roots.dist, "slot.js"));
  const runner = norm(join(roots.dist, "runner.js"));
  const profiles = norm(roots.profiles).replace(/\/+$/, "") + "/";
  const out: FleetProc[] = [];
  for (const p of all) {
    const cmd = norm(p.cmd);
    if (!cmd) continue;
    if (cmd.includes(runner)) {
      // The config is JSON on the command line, quotes escaped or not.
      const id = p.cmd.match(/run_id\\?"\s*:\s*\\?"([^"\\]+)/)?.[1] ?? null;
      out.push({ ...p, kind: "runner", runId: id, profileId: null });
    } else if (cmd.includes(slot)) {
      out.push({ ...p, kind: "slot", runId: null, profileId: null });
    } else if (cmd.includes(profiles) && /--user-data-dir/.test(cmd) && !/--type=/.test(cmd)) {
      // Renderers, GPU and utility processes carry --type= and die with their main process.
      const id = cmd.slice(cmd.indexOf(profiles) + profiles.length).match(/^([a-z0-9_.-]+)/)?.[1] ?? null;
      out.push({ ...p, kind: "browser", runId: null, profileId: id });
    }
  }
  return out;
}

/** What the manager still owns: anything outside this is an orphan. */
export interface LiveSet {
  slotPids: Set<number>;
  runIds: Set<string>;
  profileIds: Set<string>;
}

/**
 * The fleet processes no live slot owns. A browser or runner whose parent is
 * a live slot is always kept, whatever its run id says.
 */
export function orphans(fleet: FleetProc[], live: LiveSet): FleetProc[] {
  return fleet.filter((p) => {
    if (p.kind === "slot") return !live.slotPids.has(p.pid);
    if (live.slotPids.has(p.ppid)) return false;
    if (p.kind === "runner") return !p.runId || !live.runIds.has(p.runId);
    return !p.profileId || !live.profileIds.has(p.profileId);
  });
}

function descendants(pid: number, all: Proc[]): number[] {
  const out: number[] = [];
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const p of all) {
      if (p.ppid === parent && p.pid !== parent && !out.includes(p.pid)) {
        out.push(p.pid);
        queue.push(p.pid);
      }
    }
  }
  return out;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Kills a process and everything under it. Windows: taskkill /T /F; elsewhere TERM, then KILL. */
export async function killTree(pid: number, all: Proc[]): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) =>
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()),
    );
    return;
  }
  const tree = [pid, ...descendants(pid, all)];
  for (const p of tree) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  for (const p of tree) {
    if (!alive(p)) continue;
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** One line for logs: what a fleet process is. */
export function describe(p: FleetProc): string {
  const what = p.kind === "runner" ? `runner ${p.runId ?? "?"}` : p.kind === "browser" ? `browser ${p.profileId ?? "?"}` : "slot";
  return `${what} (pid ${p.pid})`;
}

/**
 * Kills `doomed`, slots first (their runner and browser go with their tree),
 * skipping anything already taken down with an earlier tree.
 */
export async function killAll(doomed: FleetProc[], all: Proc[]): Promise<FleetProc[]> {
  const order: Record<FleetKind, number> = { slot: 0, runner: 1, browser: 2 };
  const killed: FleetProc[] = [];
  for (const p of [...doomed].sort((a, b) => order[a.kind] - order[b.kind])) {
    if (!alive(p.pid)) continue;
    await killTree(p.pid, all);
    killed.push(p);
  }
  return killed;
}
