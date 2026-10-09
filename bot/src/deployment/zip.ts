import { inflateRawSync } from "node:zlib";

/**
 * One file out of a .zip (GitHub's artifact download), with Node's own zlib —
 * no npm package, so a machine whose node_modules predates the updater still
 * builds. Reads the central directory, so entries whose sizes come after the
 * data (data descriptors) work. Stored and deflate only, no ZIP64: artifacts
 * are capped at 50 MB. Null when the archive has no such file.
 */
export function unzipEntry(zip: Buffer, name: string, maxBytes: number): Buffer | null {
  // End of central directory record: in the last 22 bytes + up to 64 KiB of comment.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip archive");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt zip directory");
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    if (entry !== name) continue;
    if (size >= maxBytes) throw new Error(`${name} is too large`);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("Corrupt zip entry");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    let out: Buffer;
    if (method === 0) out = Buffer.from(data);
    else if (method === 8) out = inflateRawSync(data, { maxOutputLength: maxBytes });
    else throw new Error(`Unsupported zip compression ${method}`);
    if (out.length !== size) throw new Error(`${name} did not unpack whole`);
    return out;
  }
  return null;
}
