import express from "express";
import { join } from "node:path";
import { jsonFile, saveJson } from "./deploy.js";
import { releaseId, validateRelease, verify, type Release } from "./protocol.js";

export function createReceiver(options: {
  secret: string; repository: string; history: string;
  deploy: (release: Release) => Promise<void>;
  onIdle?: () => void;
}) {
  let busy = false;
  let stopping = false;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.raw({ type: "application/json", limit: "8kb" }));
  app.post(["/deploy", "/status"], async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !verify(options.secret, req.header("x-deploy-timestamp") ?? "", req.path,
      req.body, req.header("x-deploy-signature") ?? "")) {
      res.status(401).json({ error: "Invalid signature or expired timestamp" }); return;
    }
    try {
      const release = validateRelease(JSON.parse(req.body.toString("utf8")), options.repository);
      const file = join(options.history, `${releaseId(release)}.json`);
      const previous = await jsonFile<any>(file);
      if (previous && previous.sha !== release.sha) { res.status(409).json({ error: "Release ID conflict" }); return; }
      if (req.path === "/status") { res.status(previous ? 200 : 404).json(previous ?? { status: "unknown" }); return; }
      if (previous) { res.status(200).json(previous); return; }
      if (busy || stopping) { res.status(409).json({ error: "Deployment already running or receiver stopping" }); return; }
      busy = true;
      const record = { ...release, status: "deploying", startedAt: new Date().toISOString() };
      try { await saveJson(file, record); }
      catch (error) { busy = false; throw error; }
      res.status(202).json(record);
      void (async () => {
        let result: Record<string, unknown>;
        try {
          await options.deploy(release);
          result = { ...record, status: "succeeded", finishedAt: new Date().toISOString() };
        } catch (error) {
          console.error("Deployment failed:", error);
          result = { ...record, status: "failed", error: (error as Error).message, finishedAt: new Date().toISOString() };
        }
        // A failed state write must leave the receiver locked; don't accept a new deployment.
        await saveJson(file, result);
        busy = false;
        options.onIdle?.();
      })().catch((error) => { stopping = true; console.error("Cannot persist deployment result; restart receiver to recover", error); });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  return { app, isBusy: () => busy, stop: () => { stopping = true; } };
}
