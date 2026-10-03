import assert from "node:assert/strict";
import { base32Decode, generate } from "./totp.js";

const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

assert.equal(
  base32Decode(RFC_SECRET_B32).toString("ascii"),
  "12345678901234567890",
  "base32Decode of RFC secret",
);

const vectors: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

for (const [seconds, expected] of vectors) {
  const got = generate(RFC_SECRET_B32, { digits: 8, timestamp: seconds * 1000 });
  assert.equal(got, expected, `TOTP at t=${seconds}s`);
}

assert.equal(
  generate("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ", { digits: 8, timestamp: 59_000 }),
  "94287082",
  "spaced secret",
);

console.log(`TOTP: all ${vectors.length + 2} checks passed.`);
