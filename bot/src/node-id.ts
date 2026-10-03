import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const NODE_ID_FILE = join(HERE, "..", ".node-id");

export function normaliseNodeId(raw: string | undefined | null): string {
  return (raw ?? "").trim();
}

export function readNodeIdFile(): string {
  try {
    return existsSync(NODE_ID_FILE) ? normaliseNodeId(readFileSync(NODE_ID_FILE, "utf8")) : "";
  } catch {
    return "";
  }
}

export function writeNodeIdFile(id: string): void {
  writeFileSync(NODE_ID_FILE, `${normaliseNodeId(id)}\n`, "utf8");
}

export type NodeIdSource = "argument" | "env" | "file" | "enrollment" | "unset";

export interface NodeIdentity {
  id: string;
  source: NodeIdSource;
}

export function resolveNodeId(explicit?: string | null): NodeIdentity {
  const arg = normaliseNodeId(explicit);
  if (arg) return { id: arg, source: "argument" };

  const env = normaliseNodeId(process.env.NODE_ID);
  if (env) return { id: env, source: "env" };

  const file = readNodeIdFile();
  if (file) return { id: file, source: "file" };

  return { id: "", source: "unset" };
}

export function describeNodeId(identity: NodeIdentity): string {
  switch (identity.source) {
    case "argument":
      return `${identity.id} (from --id)`;
    case "env":
      return `${identity.id} (from NODE_ID)`;
    case "file":
      return `${identity.id} (from .node-id)`;
    case "enrollment":
      return `${identity.id} (assigned when this machine was approved)`;
    default:
      return "unset — will only run rows whose node_id is blank";
  }
}
