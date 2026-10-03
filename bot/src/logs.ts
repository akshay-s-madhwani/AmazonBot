import { appendFileSync, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

export type LogName = "manager" | "slot" | "runner" | "browser";

export interface LogEvent {
  ts: string;
  run_id: string;
  slot_index: number | null;
  type: string;
  [key: string]: unknown;
}

export function logsDir(artifactsDir: string): string {
  const dir = join(artifactsDir, "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function openLog(artifactsDir: string, name: LogName): WriteStream {
  return createWriteStream(join(logsDir(artifactsDir), `${name}.log`), { flags: "a" });
}

export function tee(
  stream: Readable | null,
  sink: WriteStream,
  prefix: string,
  mirror = true,
): void {
  if (!stream) return;
  stream.setEncoding("utf8");
  let carry = "";
  stream.on("data", (chunk: string) => {
    sink.write(chunk);
    if (!mirror) return;
    carry += chunk;
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) console.log(`${prefix} ${line}`);
  });
  stream.on("error", (err) => sink.write(`\n[tee error] ${(err as Error).message}\n`));
}

export function appendEvent(artifactsDir: string, event: LogEvent): void {
  try {
    appendFileSync(join(logsDir(artifactsDir), "events.ndjson"), `${JSON.stringify(event)}\n`);
  } catch (err) {
    console.error(`[logs] failed to append event: ${(err as Error).message}`);
  }
}

export function makeEvent(
  run_id: string,
  slot_index: number | null,
  type: string,
  extra: Record<string, unknown> = {},
): LogEvent {
  return { ts: new Date().toISOString(), run_id, slot_index, type, ...extra };
}
