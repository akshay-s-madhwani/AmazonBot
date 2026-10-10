import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deploy, jsonFile, recover, ROOT, saveJson, STATE } from "./deploy.js";
import { createReceiver } from "./receiver.js";

const env = join(ROOT, "deploy.env");
if (existsSync(env)) process.loadEnvFile(env);
const secret = process.env.DEPLOY_SECRET ?? "";
const repository = process.env.DEPLOY_REPOSITORY ?? "";
if (secret.length < 32 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !process.env.DEPLOY_GITHUB_TOKEN)
  throw new Error("Configure deploy.env: secret (32+ characters), repository and GitHub token are required");
const port = Number(process.env.DEPLOY_PORT ?? 7901);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid webhook port");
await mkdir(join(STATE, "history"), { recursive: true });
const lock = join(STATE, "receiver.lock");
if (existsSync(lock)) {
  const pid = Number(await readFile(lock, "utf8"));
  if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid receiver lock; inspect it before removing");
  try { process.kill(pid, 0); throw new Error("Another receiver is running"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  await rm(lock);
}
await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
// Never silently start the manager on a partially installed release.
await recover();
for (const file of await readdir(join(STATE, "history"))) {
  if (!/^\d+-\d+\.json$/.test(file)) continue;
  const record = await jsonFile<any>(join(STATE, "history", file));
  if (record?.status === "deploying") await saveJson(join(STATE, "history", file), {
    ...record, status: "failed", error: "Receiver interrupted; recovery completed. Rerun the build to retry.",
  });
}
let stopping = false;
const receiver = createReceiver({
  secret, repository, history: join(STATE, "history"), deploy,
  onIdle: () => { if (stopping) void shutdown(); },
});
const server = receiver.app.listen(port, process.env.DEPLOY_HOST ?? "127.0.0.1", () => console.log(`Deployment receiver on port ${port}`));
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
async function shutdown(): Promise<void> {
  stopping = true;
  receiver.stop();
  if (receiver.isBusy()) return; // PM2's hard timeout may interrupt us; journal recovery handles that case.
  server.close();
  await rm(lock, { force: true });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("message", (message) => { if (message === "shutdown") void shutdown(); });
