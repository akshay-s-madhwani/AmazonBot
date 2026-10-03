import { existsSync } from "node:fs";
import { ShardX } from "@proxyshard/shardx";
import { profilesDir } from "./shardx.js";

const force = process.argv.includes("--force");

const runtime = new ShardX({
  profilesDir: profilesDir(),
  progress: report,
}).runtime;

const shown = new Map<string, number>();

function report(label: string, received: number, total: number): void {
  if (!total || total <= 0) return;
  const pct = Math.floor((received / total) * 100);
  const step = Math.floor(pct / 5);
  if (shown.get(label) === step) return;
  shown.set(label, step);
  const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
  process.stdout.write(`  ${label}: ${pct}% (${mb(received)}/${mb(total)} MB)\n`);
}

if (runtime.installed && !force) {
  console.log("ShardX runtime already installed — checking for updates");
} else {
  console.log("Downloading the ShardX runtime (browser engine, Widevine, fingerprints)");
  console.log("This is a few hundred MB and only happens once per machine.");
}

await runtime.install(force ? { force: true } : undefined);

if (!runtime.installed || !existsSync(runtime.binaryPath)) {
  console.error("");
  console.error("ShardX reported success but its browser is not on disk:");
  console.error(`  expected: ${runtime.binaryPath}`);
  console.error("Re-run with --force, or check the machine's network/disk space.");
  process.exit(1);
}

console.log("");
console.log(`ShardX runtime ready (chromium ${runtime.chromiumVersion})`);
console.log(`  engine:   ${runtime.binaryPath}`);
console.log(`  profiles: ${runtime.profilesRoot}`);
