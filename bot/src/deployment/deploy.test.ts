import test from "node:test";
import assert from "node:assert/strict";
import { signature, validateRelease, verify, runDeployment, type DeploymentSteps } from "./protocol.js";
import { validateBuild } from "./deploy.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePaths, restoreRuntime, switchRuntime, type Transaction } from "./runtime.js";
import { createReceiver } from "./receiver.js";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

const release = { repository: "owner/bot", sha: "a".repeat(40), runId: 123, attempt: 1 };
test("signed requests bind timestamp, route and body, and expire", () => {
  const secret = "s".repeat(32);
  const body = Buffer.from(JSON.stringify(release));
  const now = 1800000000000;
  const timestamp = String(now);
  const signed = signature(secret, timestamp, "/deploy", body);
  assert.ok(verify(secret, timestamp, "/deploy", body, signed, now));
  assert.ok(!verify(secret, timestamp, "/status", body, signed, now));
  assert.ok(!verify(secret, timestamp, "/deploy", Buffer.from("{}"), signed, now));
  assert.ok(!verify(secret, timestamp, "/deploy", body, signed, now + 300001));
  assert.ok(!verify(secret, timestamp, "/deploy", body, signed, now - 300001));
  assert.ok(!verify(secret, timestamp, "/deploy", body, "bad", now));
});
test("release rejects other repos, shell arguments and invalid run IDs", () => {
  assert.deepEqual(validateRelease(release, "owner/bot"), release);
  for (const patch of [{ repository: "other/bot" }, { sha: "--upload-pack=bad" }, { runId: -1 }, { attempt: 1.2 }])
    assert.throws(() => validateRelease({ ...release, ...patch }, "owner/bot"));
});
test("build rejects traversal, unexpected files and mismatched commits", () => {
  const files = Object.fromEntries(["bot/dist/manager.js", "bot/dist/deployment/webhook.js", "packages/contracts/dist/index.js",
    "packages/transport/dist/index.js"].map((file) => [file, Buffer.from("export {};").toString("base64")]));
  const build = { sha: release.sha, packagesSha: "b".repeat(40), files };
  assert.equal(validateBuild(build, build.sha, build.packagesSha), files);
  assert.throws(() => validateBuild(build, "c".repeat(40), build.packagesSha));
  for (const file of ["bot/dist/../../.env", "bot/dist/../../../outside.js", "/tmp/file.js", "bot/.env", "bot/dist/x\\file.js"])
    assert.throws(() => validateBuild({ ...build, files: { ...files, [file]: "eA==" } }, build.sha, build.packagesSha));
});
function steps(failure?: keyof DeploymentSteps) {
  const calls: string[] = [];
  const adapter = Object.fromEntries(["prepare", "drain", "activate", "health", "commit", "rollback", "resume"].map(name =>
    [name, async () => { calls.push(name); if (name === failure) throw new Error(name); }])) as unknown as DeploymentSteps;
  return { calls, adapter };
}
test("successful deployment prepares before draining and resumes only after health check", async () => {
  const { calls, adapter } = steps();
  await runDeployment(adapter);
  assert.deepEqual(calls, ["prepare", "drain", "activate", "health", "commit", "resume"]);
});
test("failed preparation never interrupts manager", async () => {
  const { calls, adapter } = steps("prepare");
  await assert.rejects(runDeployment(adapter));
  assert.deepEqual(calls, ["prepare"]);
});
test("drain timeout resumes intake without activating or rolling back", async () => {
  const { calls, adapter } = steps("drain");
  await assert.rejects(runDeployment(adapter));
  assert.deepEqual(calls, ["prepare", "drain", "resume"]);
});
for (const failure of ["activate", "health"] as const) test(`${failure} failure restores previous release`, async () => {
  const { calls, adapter } = steps(failure);
  await assert.rejects(runDeployment(adapter));
  assert.ok(calls.indexOf("rollback") > calls.indexOf("activate"));
  assert.equal(calls.at(-1), "resume");
  assert.ok(!calls.includes("commit"));
});
test("rollback failures are surfaced together with deployment failures", async () => {
  const { adapter } = steps("health");
  adapter.rollback = async () => { throw new Error("rollback"); };
  await assert.rejects(runDeployment(adapter), AggregateError);
});

for (const failAfter of [1, 2, 5, 12, 99]) test(`runtime transaction recovers from interruption at journal write ${failAfter}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-deploy-test-"));
  const tx: Transaction = { oldSha: release.sha, oldVersion: null, stage: join(root, ".deploy/staging/123-1"), moved: [], installed: [] };
  try {
    for (const name of runtimePaths) {
      for (const [base, contents] of [[root, "old"], [join(tx.stage, "work"), "new"]]) {
        await mkdir(join(base!, name), { recursive: true });
        await writeFile(join(base!, name, "sentinel"), contents!);
      }
    }
    await writeFile(join(root, "bot/.node-id"), "machine-identity");
    await writeFile(join(root, "bot/.env"), "private-settings");
    let writes = 0;
    try { await switchRuntime(root, tx, async () => { if (++writes === failAfter) throw new Error("Simulated crash"); }); }
    catch (e) { assert.match((e as Error).message, /Simulated crash/); }
    await restoreRuntime(root, tx);
    await restoreRuntime(root, tx); // Recovery can itself be interrupted and restarted.
    for (const name of runtimePaths) assert.equal(await readFile(join(root, name, "sentinel"), "utf8"), "old");
    assert.equal(await readFile(join(root, "bot/.node-id"), "utf8"), "machine-identity");
    assert.equal(await readFile(join(root, "bot/.env"), "utf8"), "private-settings");
    await assert.rejects(restoreRuntime(root, { ...tx, stage: tmpdir() }), /Invalid deployment journal/);
    await assert.rejects(restoreRuntime(root, { ...tx, installed: ["../outside"] }), /Invalid deployment journal/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("HTTP receiver authenticates, serializes deployments and persists deduplication across restarts", async () => {
  const history = await mkdtemp(join(tmpdir(), "bot-receiver-test-"));
  const secret = "s".repeat(32);
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let count = 0;
  const options = { secret, repository: release.repository, history, deploy: async () => { count++; await pending; } };
  let receiver = createReceiver(options);
  let server = receiver.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  async function post(route: string, value = release, authenticated = true) {
    const body = Buffer.from(JSON.stringify(value));
    const timestamp = String(Date.now());
    return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${route}`, {
      method: "POST", body, headers: { "content-type": "application/json", "x-deploy-timestamp": timestamp,
        "x-deploy-signature": authenticated ? signature(secret, timestamp, route, body) : "bad" },
    });
  }
  try {
    assert.equal((await post("/deploy", release, false)).status, 401);
    assert.equal(count, 0);
    assert.equal((await post("/deploy")).status, 202);
    assert.equal((await post("/deploy")).status, 200);
    assert.equal((await post("/deploy", { ...release, runId: 124 })).status, 409);
    assert.equal((await post("/deploy", { ...release, sha: "b".repeat(40) })).status, 409);
    finish();
    for (let i = 0; i < 100 && receiver.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(receiver.isBusy(), false);
    assert.equal((await (await post("/status")).json() as any).status, "succeeded");
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    receiver = createReceiver(options);
    server = receiver.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    assert.equal((await (await post("/deploy")).json() as any).status, "succeeded");
    assert.equal(count, 1);
  } finally {
    finish();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(history, { recursive: true, force: true });
  }
});
