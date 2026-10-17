// Setup's node id check: prints bot/.node-id and exits 0 when this machine is
// already approved as that id, so setup need not ask again. Exits 1 (setup
// asks) for no id, an id never approved, or a bot folder copied from another
// machine — the same tests the bot itself applies at start (enroll.ts
// discardForeignIdentity).
import { readFileSync } from "node:fs";
import { hostname } from "node:os";

const read = (name) => {
  try {
    return readFileSync(new URL(`../bot/${name}`, import.meta.url), "utf8");
  } catch {
    return null;
  }
};
const json = (name) => {
  try {
    return JSON.parse(read(name) ?? "");
  } catch {
    return null;
  }
};

const id = (read(".node-id") ?? "").trim();
const creds = json(".fleet-credentials.json");
const identity = json(".bot-identity.json");
const approved =
  /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
  creds?.bot_id === id &&
  typeof creds.api_token === "string" && creds.api_token !== "" &&
  // An identity file from before hostnames were recorded counts as this machine's, as in the bot.
  (typeof identity?.hostname !== "string" || identity.hostname === hostname());

if (!approved) process.exit(1);
console.log(id);
