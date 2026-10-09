import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const runtimePaths = ["packages/contracts/dist", "packages/contracts/node_modules", "packages/transport/dist",
  "packages/transport/node_modules", "bot/dist", "bot/node_modules"];
export interface Transaction { oldSha: string; oldVersion: unknown; stage: string; moved: string[]; installed: string[] }

export function validateTransaction(root: string, tx: Transaction): void {
  if (!resolve(tx.stage).startsWith(`${resolve(root, ".deploy/staging")}${sep}`) ||
      !/^[a-f0-9]{40}$/.test(tx.oldSha) || [...tx.moved, ...tx.installed].some((p) => !runtimePaths.includes(p)))
    throw new Error("Invalid deployment journal");
}

export async function switchRuntime(root: string, tx: Transaction, persist: () => Promise<void>): Promise<void> {
  validateTransaction(root, tx);
  for (const name of runtimePaths) {
    const live = join(root, name);
    const backup = join(tx.stage, "backup", name);
    if (existsSync(live)) {
      tx.moved.push(name);
      await persist();
      await mkdir(dirname(backup), { recursive: true });
      await rename(live, backup);
    }
    tx.installed.push(name);
    await persist();
    await mkdir(dirname(live), { recursive: true });
    await rename(join(tx.stage, "work", name), live);
  }
}

export async function restoreRuntime(root: string, tx: Transaction): Promise<void> {
  validateTransaction(root, tx);
  for (const name of [...runtimePaths].reverse()) {
    const backup = join(tx.stage, "backup", name);
    if (existsSync(backup)) {
      await rm(join(root, name), { recursive: true, force: true });
      await mkdir(dirname(join(root, name)), { recursive: true });
      await rename(backup, join(root, name));
    } else if (tx.installed.includes(name) && !tx.moved.includes(name)) {
      await rm(join(root, name), { recursive: true, force: true });
    }
  }
}
