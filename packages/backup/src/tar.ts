import { createReadStream, lstatSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

// Minimal ustar reader/writer for archive directories: flat regular files with short
// names. Downloads and uploads never carry directories, links, owners or attributes.
const block = 512;
const entryName = /^(manifest\.enc|FINALIZED|[0-9]{8}\.enc)$/;
export const archiveEntryName = (name: string) => entryName.test(name);

function header(name: string, size: number) {
  const buffer = Buffer.alloc(block);
  buffer.write(name, 0, 100, "utf8");
  buffer.write("0000600\0", 100, 8);
  buffer.write("0000000\0", 108, 8);
  buffer.write("0000000\0", 116, 8);
  buffer.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  buffer.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
    12,
  );
  buffer.write("        ", 148, 8);
  buffer.write("0", 156, 1);
  buffer.write("ustar\0", 257, 6);
  buffer.write("00", 263, 2);
  let sum = 0;
  for (const byte of buffer) sum += byte;
  buffer.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return buffer;
}
export function archiveTar(directory: string): Readable {
  const names = readdirSync(directory).filter(archiveEntryName).sort();
  for (const name of names)
    if (!lstatSync(join(directory, name)).isFile())
      throw new Error("Archive contains a link or special entry");
  async function* entries() {
    for (const name of names) {
      const path = join(directory, name);
      const size = lstatSync(path).size;
      yield header(name, size);
      let sent = 0;
      for await (const chunk of createReadStream(path)) {
        sent += (chunk as Buffer).length;
        yield chunk as Buffer;
      }
      if (sent !== size) throw new Error("Archive changed while downloading");
      const padding = (block - (size % block)) % block;
      if (padding) yield Buffer.alloc(padding);
    }
    yield Buffer.alloc(block * 2);
  }
  return Readable.from(entries());
}
export function archiveTarSize(directory: string) {
  let total = block * 2;
  for (const name of readdirSync(directory).filter(archiveEntryName)) {
    const size = lstatSync(join(directory, name)).size;
    total += block + size + ((block - (size % block)) % block);
  }
  return total;
}

function parseHeader(buffer: Buffer) {
  if (buffer.every((byte) => byte === 0)) return null;
  const field = (start: number, length: number) =>
    buffer
      .subarray(start, start + length)
      .toString("utf8")
      .replace(/\0.*$/s, "");
  const declared = Number.parseInt(field(148, 8).trim() || "0", 8);
  let sum = 0;
  for (let i = 0; i < block; i++) sum += i >= 148 && i < 156 ? 32 : (buffer[i] as number);
  if (sum !== declared) throw new Error("Upload is not a valid backup archive");
  const type = field(156, 1);
  const size = Number.parseInt(field(124, 12).trim() || "0", 8);
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error("Upload is not a valid backup archive");
  return { name: field(0, 100), type: type === "" ? "0" : type, size };
}
/**
 * Write a streamed tar into `destination` (which must already exist and be private),
 * accepting only the flat archive layout. Returns the stored entry names.
 */
export async function extractTar(
  source: AsyncIterable<Buffer | string>,
  destination: string,
  maxBytes: number,
) {
  const names: string[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let consumed = 0;
  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  async function need(length: number) {
    while (pending.length < length && !finished) {
      const next = await iterator.next();
      if (next.done) finished = true;
      else {
        const chunk = typeof next.value === "string" ? Buffer.from(next.value) : next.value;
        consumed += chunk.length;
        if (consumed > maxBytes) throw new Error("Upload exceeds the available storage");
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      }
    }
    if (pending.length < length) throw new Error("Upload ended before the archive was complete");
    const out = pending.subarray(0, length);
    pending = pending.subarray(length);
    return out;
  }
  for (;;) {
    const record = parseHeader(await need(block));
    if (!record) break;
    if (record.type !== "0" || !archiveEntryName(record.name) || names.includes(record.name))
      throw new Error("Upload is not a Civic Spark backup archive");
    const file = await open(join(destination, record.name), "wx", 0o600);
    try {
      let remaining = record.size;
      while (remaining > 0) {
        const chunk = await need(Math.min(remaining, 1 << 20));
        await file.write(chunk);
        remaining -= chunk.length;
      }
      await file.sync();
    } finally {
      await file.close();
    }
    names.push(record.name);
    const padding = (block - (record.size % block)) % block;
    if (padding) await need(padding);
  }
  if (!names.includes("manifest.enc") || !names.includes("FINALIZED"))
    throw new Error("Upload is not a complete backup archive");
  return names;
}
