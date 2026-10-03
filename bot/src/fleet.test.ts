import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TELEMETRY_WILDCARD,
  TelemetryEventSchema,
  HeartbeatSchema,
  NodeRegisterSchema,
  commandSubject,
  type CommandEnvelope,
} from "@app/contracts";
import { connect, ensureStream } from "@app/transport";
import { FleetLink, NoSlotError, jobSpecSummary, redactEmail, type FleetHooks } from "./fleet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, "..", "artifacts", ".fleet");

let checks = 0;
const check = (label: string, fn: () => void): void => {
  fn();
  checks += 1;
  console.log(`  ok  ${label}`);
};

check("redactEmail hides the account but keeps it recognisable", () => {
  assert.equal(redactEmail("someone@gmail.com"), "s*****e@gmail.com");
  assert.equal(redactEmail("ab@x.com"), "a*b@x.com");
  assert.equal(redactEmail(""), "");
});

check("jobSpecSummary carries no credentials and no payment codes", () => {
  const spec = jobSpecSummary({
    sheetId: "sheet-1",
    rowNumber: 2,
    revision: "abc123",
    userId: "25",
    email: "buyer@gmail.com",
    items: [{ url: "https://amzn.in/d/x", quantity: 5, purchaseOption: "auto" }],
    paymentMethod: "voucher",
  });
  assert.equal(spec.source_row_id, "2");
  assert.equal(spec.product_list[0]?.quantity, 5);
  assert.equal(spec.payment_method, "voucher");
  const flat = JSON.stringify(spec);
  assert.ok(!flat.includes("buyer@gmail.com"), "raw email must not travel upstream");
  assert.ok(!/password|totp|code/i.test(flat), "no secret-shaped fields");
});

const natsUrl = process.env.NATS_URL;

async function liveTest(url: string): Promise<void> {
  rmSync(STATE_DIR, { recursive: true, force: true });

  const node_id = `test-node-${Date.now()}`;
  const RUN = `test-run-${Date.now()}`;
  const master = await connect({ servers: [url], name: "fake-master" });
  await ensureStream(master, { name: "TELEMETRY", subjects: [TELEMETRY_WILDCARD] });

  const registered: unknown[] = [];
  const heartbeats: unknown[] = [];
  master.subscribe(`fleet.node.${node_id}.register`, (d) => {
    registered.push(d);
  });
  master.subscribe(`fleet.node.${node_id}.heartbeat`, (d) => {
    heartbeats.push(d);
  });

  const received: Array<Record<string, unknown>> = [];
  const consumer = await master.jsSubscribe(
    "TELEMETRY",
    TELEMETRY_WILDCARD,
    `test-${node_id}`,
    (data) => {
      received.push(data as Record<string, unknown>);
    },
  );

  const calls: string[] = [];
  const hooks: FleetHooks = {
    startPushedJob: async (run_id, job) => {
      calls.push(`startPushed:${run_id}:row${job.rowNumber}`);
      return run_id;
    },
    startJobs: async (n) => {
      calls.push(`startJobs:${n}`);
      return [RUN, "run-2"].slice(0, n);
    },
    resumeRun: async (id, from, stopAfter) => {
      calls.push(`resume:${id}:${from ?? "last"}${stopAfter === undefined ? "" : `:until${stopAfter}`}`);
    },
    cancelRun: async (id) => {
      if (id === "run-gone") throw new NoSlotError(`no live slot holds ${id}`);
      calls.push(`cancel:${id}`);
    },
    stopRun: async (id) => {
      calls.push(`stopRun:${id}`);
    },
    probeRun: async (id) => ({ has_slot: id === RUN, slot_status: id === RUN ? "BUSY" : null }),
    closeSession: async (id) => {
      calls.push(`close:${id}`);
    },
    captureArtifacts: async (id) => {
      calls.push(`capture:${id}`);
    },
    pauseRun: () => {
      throw new Error("pause is not supported on this node");
    },
    stopAll: async () => {
      calls.push("stopAll");
      return 2;
    },
    reset: async () => {
      calls.push("reset");
      return 2;
    },
    openBrowser: async (run_id, job_id) => {
      calls.push(`openBrowser:${run_id}:${job_id ?? "-"}`);
    },
    drain: async () => {
      calls.push("drain");
    },
    updateConfig: async (patch) => {
      calls.push(`config:${JSON.stringify(patch)}`);
    },
    slots: () => [
      {
        slot_index: 0,
        status: "stuck",
        current_run_id: RUN,
        step_index: 2,
        step_key: "set_address",
        browser_alive: true,
        browser_idle_ms: 4_000,
      },
    ],
    workerCount: () => 3,
  };

  const link = await FleetLink.start(
    { node_id, nats_url: url, heartbeatMs: 200, drainMs: 100 },
    hooks,
  );
  assert.ok(link, "the link must connect to a running nats-server");

  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  await settle(500);

  check("the node registers itself with a canonical NodeRegister", () => {
    assert.equal(registered.length >= 1, true, "no register received");
    const reg = NodeRegisterSchema.parse(registered[0]);
    assert.equal(reg.node_id, node_id);
    assert.equal(reg.worker_count, 3);
  });

  check("heartbeats carry the canonical slot vocabulary, including 'stuck'", () => {
    assert.ok(heartbeats.length >= 1, "no heartbeat received");
    const hb = HeartbeatSchema.parse(heartbeats.at(-1));
    assert.equal(hb.slots[0]?.status, "stuck");
    assert.equal(hb.slots[0]?.step_key, "set_address");
  });

  link.emit({
    run_id: RUN,
    worker_id: 0,
    event: "job.started",
    payload: jobSpecSummary({
      sheetId: "sheet-1",
      rowNumber: 2,
      revision: "rev-1",
      userId: "25",
      email: "buyer@gmail.com",
      items: [{ url: "https://amzn.in/d/x", quantity: 5 }],
      paymentMethod: "voucher",
    }) as unknown as Record<string, unknown>,
  });
  link.emit({ run_id: RUN, worker_id: 0, event: "step.started", step_index: 0, step_key: "login" });
  link.emit({
    run_id: RUN,
    worker_id: 0,
    event: "run.stuck",
    step_index: 0,
    step_key: "login",
    failure_code: "stuck_inactive",
    failure_detail: "quiet for 130s",
  });
  await settle(800);

  check("telemetry arrives on JetStream, in order, with per-run seq from 0", () => {
    const mine = received.filter((e) => e.run_id === RUN);
    assert.equal(mine.length, 3, `expected 3 events, got ${mine.length}`);
    assert.deepEqual(
      mine.map((e) => e.seq),
      [0, 1, 2],
    );
    const parsed = mine.map((e) => TelemetryEventSchema.parse(e));
    assert.deepEqual(
      parsed.map((e) => e.event),
      ["job.started", "step.started", "run.stuck"],
    );
    assert.equal(parsed[0]?.payload.source_row_id, "2");
    assert.equal(parsed[2]?.failure_code, "stuck_inactive");
  });

  const send = async (
    action: CommandEnvelope["action"],
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; error: string | null }> => {
    const envelope: CommandEnvelope = {
      v: 1,
      command_id: `cmd-${action}`,
      target: { node_id, worker_id: null },
      action,
      payload,
      issued_at: new Date().toISOString(),
      requires_ack: true,
    };
    return (await master.request(commandSubject(node_id), envelope, 5_000)) as {
      ok: boolean;
      error: string | null;
    };
  };

  const start = await send("start_job", { instances: 2 });
  const restart = await send("restart_from_step", { run_id: RUN, step_index: 4 });
  const resume = await send("resume_from_last_success", { run_id: RUN });
  const capture = await send("capture_artifacts", { run_id: RUN });
  const cancel = await send("cancel", { run_id: RUN });
  const close = await send("close_session", { run_id: RUN });
  const drain = await send("drain", {});
  const config = await send("update_config", { patch: { worker_count: 5 } });

  check("every supported command is accepted and reaches the right hook", () => {
    for (const [name, res] of Object.entries({ start, restart, resume, capture, cancel, close, drain, config })) {
      assert.equal(res.ok, true, `${name} was rejected: ${res.error}`);
    }
    assert.deepEqual(calls, [
      "startJobs:2",
      `resume:${RUN}:4`,
      `resume:${RUN}:last`,
      `capture:${RUN}`,
      `cancel:${RUN}`,
      `close:${RUN}`,
      "drain",
      'config:{"worker_count":5}',
    ]);
  });

  const pause = await send("pause", { run_id: RUN });
  const badRestart = await send("restart_from_step", { run_id: RUN });

  check("unsupported and malformed commands are REFUSED, not silently swallowed", () => {
    assert.equal(pause.ok, false);
    assert.match(pause.error ?? "", /pause is not supported/);
    assert.equal(badRestart.ok, false);
    assert.match(badRestart.error ?? "", /step_index/);
  });

  calls.length = 0;
  const checkpoint = (await send("restart_from_step", {
    run_id: RUN,
    step_index: 1,
    stop_after: 4,
  })) as { ok: boolean };
  const stopRun = (await send("stop_run", { run_id: RUN })) as { ok: boolean };
  const gone = (await send("cancel", { run_id: "run-gone" })) as { ok: boolean; outcome?: string };
  const probe = (await send("probe_run", { run_id: RUN })) as {
    ok: boolean;
    data?: Record<string, unknown>;
  };

  check("a checkpoint travels with restart, and stop_run reaches its hook", () => {
    assert.equal(checkpoint.ok, true);
    assert.equal(stopRun.ok, true);
    assert.deepEqual(calls, [`resume:${RUN}:1:until4`, `stopRun:${RUN}`]);
  });

  check("a run this node does not hold is acked no_slot, so the master can release it", () => {
    assert.equal(gone.ok, true);
    assert.equal(gone.outcome, "no_slot");
  });

  check("probe_run answers with the node's view of the run", () => {
    assert.equal(probe.ok, true);
    assert.equal(probe.data?.has_slot, true);
  });

  await link.close();
  await consumer.stop();
  await master.close();
}

async function main(): Promise<void> {
  if (!natsUrl) {
    console.log(
      `\nfleet: ${checks} pure check(s) passed. ` +
        `Set NATS_URL to also run the live round-trip against nats-server -js.`,
    );
    return;
  }
  console.log(`live round-trip against ${natsUrl}`);
  await liveTest(natsUrl);
  console.log(`\nfleet: all ${checks} checks passed.`);
}

main().catch((err: unknown) => {
  console.error("\nfleet test FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
