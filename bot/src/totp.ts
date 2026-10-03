import { createHmac } from "node:crypto";

const RFC4648_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  if (clean.length === 0) throw new Error("Empty TOTP secret");

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = RFC4648_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character in TOTP secret: "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  digits?: number;
  period?: number;
  timestamp?: number;
}

export function generate(secret: string, opts: TotpOptions = {}): string {
  const digits = opts.digits ?? 6;
  const period = opts.period ?? 30;
  const now = opts.timestamp ?? Date.now();

  const counter = Math.floor(now / 1000 / period);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", base32Decode(secret)).update(counterBuf).digest();

  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const code = binary % 10 ** digits;
  return code.toString().padStart(digits, "0");
}
