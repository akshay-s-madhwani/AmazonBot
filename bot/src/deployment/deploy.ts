import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm, lstat, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipEntry } from "./zip.js";
import { releaseId, runDeployment, type Release } from "./protocol.js";
import { restoreRuntime, switchRuntime, validateTransaction, type Transaction } from "./runtime.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const STATE = join(ROOT, ".deploy");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function jsonFile<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export async function saveJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
async function command(exe: string, args: string[], cwd = ROOT): Promise<string> {
  return new Promise((ok, fail) => execFile(exe, args, {
    cwd, windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }, (error, stdout) => error ? fail(new Error(`${exe.split(/[\\/]/).pop()} ${args[0]} failed (${error.code})`)) : ok(stdout.trim())));
}
const git = (args: string[], cwd = ROOT) => command("git", args, cwd);
async function npm(cwd: string): Promise<void> {
  // Execute npm's JS entry point directly: .cmd cannot be execFile'd on Windows.
  const locations = (await command("where.exe", ["npm.cmd"])).split(/\r?\n/);
  const { realpath } = await import("node:fs/promises");
  const launcher = await realpath(locations[0]!);
  const cli = join(dirname(launcher), "node_modules/npm/bin/npm-cli.js");
  await command(process.execPath, [cli, "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd);
}
async function pm2(action: "stop" | "restart"): Promise<void> {
  const launcher = (await command("where.exe", ["pm2.cmd"])).split(/\r?\n/)[0]!;
  await command(process.execPath, [join(dirname(launcher), "node_modules/pm2/bin/pm2"), action, "bot-manager"]);
}
function managerURL(): string {
  const port = Number(process.env.DEPLOY_MANAGER_PORT ?? 7800);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid manager port");
  return `http://127.0.0.1:${port}`;
}
async function manager(path: string, method = "GET"): Promise<any> {
  const response = await fetch(`${managerURL()}${path}`, {
    method, signal: AbortSignal.timeout(path === "/deployment/close-idle" ? 120_000 : 15_000),
  });
  if (!response.ok) throw new Error(`Manager ${path}: HTTP ${response.status}`);
  return response.json();
}
async function health(sha: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const result = await manager("/health");
      if (result.ok && result.ready && result.version === sha && result.deploymentMaintenance) return;
    } catch { /* booting */ }
    await sleep(2000);
  }
  throw new Error("Manager did not become healthy on the expected version");
}
async function api(repository: string, suffix: string): Promise<Response> {
  const result = await fetch(`https://api.github.com/repos/${repository}/${suffix}`, {
    headers: { Authorization: `Bearer ${process.env.DEPLOY_GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(120_000),
  });
  if (!result.ok) throw new Error(`GitHub API ${suffix}: HTTP ${result.status}`);
  return result;
}

export function validateBuild(build: any, sha: string, packagesSha: string): Record<string, string> {
  if (build?.sha !== sha || build?.packagesSha !== packagesSha || !build.files || typeof build.files !== "object")
    throw new Error("Build does not match the approved commits");
  const files = build.files as Record<string, string>;
  const required = ["bot/dist/manager.js", "bot/dist/deployment/webhook.js", "packages/contracts/dist/index.js", "packages/transport/dist/index.js"];
  if (required.some((file) => !files[file])) throw new Error("Incomplete build");
  let bytes = 0;
  for (const [file, value] of Object.entries(files)) {
    if (!/^(bot|packages\/(contracts|transport))\/dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(js|map|ts)$/.test(file) ||
        file.split("/").includes("..") || typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
      throw new Error("Invalid build file");
    bytes += value.length;
  }
  if (bytes > 100 * 1024 * 1024 || Object.keys(files).length > 10_000) throw new Error("Build is too large");
  return files;
}

const journal = join(STATE, "transaction.json");
const maintenance = join(STATE, "maintenance");
const versionFile = join(STATE, "version.json");

async function restore(tx: Transaction): Promise<void> {
  // Persisted paths are checked before any removal, including after a crash.
  validateTransaction(ROOT, tx);
  await pm2("stop");
  await git(["checkout", "--detach", tx.oldSha]);
  await git(["submodule", "update", "--init", "--recursive"]);
  await restoreRuntime(ROOT, tx);
  await saveJson(versionFile, tx.oldVersion ?? { sha: tx.oldSha });
  await pm2("restart");
  await health((tx.oldVersion as { sha?: string } | null)?.sha ?? tx.oldSha);
  await rm(journal);
}

export async function recover(): Promise<void> {
  const tx = await jsonFile<Transaction>(journal);
  if (tx) await restore(tx);
  if (existsSync(maintenance)) {
    await rm(maintenance, { force: true });
    await manager("/deployment/resume", "POST");
  }
}

export async function deploy(release: Release): Promise<void> {
  const stage = join(STATE, "staging", releaseId(release));
  const work = join(stage, "work");
  let tx: Transaction;
  await runDeployment({
    async prepare() {
      if (await git(["status", "--porcelain", "--untracked-files=normal"])) throw new Error("Deployment checkout has local changes");
      if (existsSync(journal)) throw new Error("An interrupted deployment needs recovery");
      const run = await (await api(release.repository, `actions/runs/${release.runId}`)).json() as any;
      if (run.conclusion !== "success" || run.status !== "completed" || run.event !== "push" ||
          run.head_branch !== "main" || run.head_sha !== release.sha || run.run_attempt !== release.attempt ||
          run.path !== ".github/workflows/deploy.yml" || run.repository?.full_name !== release.repository ||
          run.head_repository?.full_name !== release.repository) throw new Error("Unapproved workflow run");
      await git(["fetch", "origin", "main"]);
      if (await git(["rev-parse", "origin/main"]) !== release.sha) throw new Error("Superseded release; only current main can deploy");
      const oldSha = await git(["rev-parse", "HEAD"]);
      await git(["merge-base", "--is-ancestor", oldSha, release.sha]);
      const tree = await git(["ls-tree", release.sha, "packages"]);
      const packagesSha = /^160000 commit ([a-f0-9]{40})\tpackages$/.exec(tree)?.[1];
      if (!packagesSha) throw new Error("Missing packages submodule");
      await git(["fetch", "origin"], join(ROOT, "packages"));
      await mkdir(work, { recursive: true });
      await git(["archive", "--format=tar", `--output=${join(stage, "bot.tar")}`, release.sha]);
      await command("tar", ["-xf", join(stage, "bot.tar"), "-C", work]);
      await mkdir(join(work, "packages"), { recursive: true });
      await git(["archive", "--format=tar", `--output=${join(stage, "packages.tar")}`, packagesSha], join(ROOT, "packages"));
      await command("tar", ["-xf", join(stage, "packages.tar"), "-C", join(work, "packages")]);
      const listing = await (await api(release.repository, `actions/runs/${release.runId}/artifacts?per_page=100`)).json() as any;
      const artifact = listing.artifacts?.find((a: any) => a.name === `bot-${release.sha}-${release.attempt}` && !a.expired);
      if (!artifact || artifact.size_in_bytes > 50 * 1024 * 1024) throw new Error("Build artifact missing, expired or too large");
      const archive = Buffer.from(await (await api(release.repository, `actions/artifacts/${artifact.id}/zip`)).arrayBuffer());
      if (archive.length > 50 * 1024 * 1024) throw new Error("Archive too large");
      if (artifact.digest && artifact.digest !== `sha256:${createHash("sha256").update(archive).digest("hex")}`)
        throw new Error("Artifact checksum mismatch");
      const manifest = unzipEntry(archive, "deployment.json", 110 * 1024 * 1024);
      if (!manifest) throw new Error("Missing deployment manifest");
      const files = validateBuild(JSON.parse(manifest.toString("utf8")), release.sha, packagesSha);
      for (const [file, content] of Object.entries(files)) {
        await mkdir(dirname(join(work, file)), { recursive: true });
        await writeFile(join(work, file), Buffer.from(content, "base64"));
      }
      for (const pkg of ["packages/contracts", "packages/transport", "bot"]) await npm(join(work, pkg));
      // npm creates absolute junctions on Windows. Relink to the final location before switching.
      for (const [pkg, deps] of [["packages/transport", ["contracts"]], ["bot", ["contracts", "transport"]]] as const) {
        for (const dep of deps) {
          const link = join(work, pkg, "node_modules/@app", dep);
          if (!(await lstat(link)).isSymbolicLink()) throw new Error(`Expected local package link: ${dep}`);
          await rm(link);
          await symlink(join(ROOT, "packages", dep), link, "junction");
        }
      }
      tx = { oldSha, oldVersion: await jsonFile(versionFile), stage, moved: [], installed: [] };
    },
    async drain() {
      const timeout = Number(process.env.DEPLOY_DRAIN_TIMEOUT_MS ?? 900_000);
      if (!Number.isFinite(timeout) || timeout < 1000) throw new Error("Invalid drain timeout");
      await writeFile(maintenance, release.sha);
      await manager("/deployment/drain", "POST");
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const state = await manager("/health");
        if (state.ready && state.deploymentMaintenance && state.activeSlots === 0) {
          await manager("/deployment/close-idle", "POST");
          return;
        }
        await sleep(2000);
      }
      throw new Error("Active work did not finish before the deployment timeout");
    },
    async activate() {
      await saveJson(journal, tx);
      await pm2("stop");
      // Recheck after waiting for jobs; don't overwrite edits made during draining.
      if (await git(["status", "--porcelain", "--untracked-files=normal"])) throw new Error("Checkout changed during deployment");
      await git(["checkout", "--detach", release.sha]);
      await git(["submodule", "update", "--init", "--recursive"]);
      await switchRuntime(ROOT, tx, () => saveJson(journal, tx));
      await saveJson(versionFile, { sha: release.sha, runId: release.runId, attempt: release.attempt });
      await pm2("restart");
    },
    health: () => health(release.sha),
    async commit() { await rm(journal); },
    async rollback() { await restore(tx); },
    async resume() {
      if (existsSync(journal)) return;
      await rm(maintenance, { force: true });
      await manager("/deployment/resume", "POST");
    },
  });
}
