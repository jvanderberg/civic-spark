import {
  closeSync,
  createReadStream,
  createWriteStream,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw, createInflateRaw } from "node:zlib";
import { safeRelative } from "./archive.ts";

// Dependency-free ZIP (deflate, data descriptors, UTF-8 names) so downloads open with any
// archive tool. ZIP64 end records carry entry counts above 65,535 (Git object stores reach
// that quickly); per-entry ZIP64 sizes are not produced, so backups over 4 GB need the CLI.
const limit = 0xffffffff;
const localSignature = 0x04034b50;
const descriptorSignature = 0x08074b50;
const centralSignature = 0x02014b50;
const endSignature = 0x06054b50;
const zip64EndSignature = 0x06064b50;
const zip64LocatorSignature = 0x07064b50;
const flags = 0x0808; // data descriptor + UTF-8 names

function dosTime(date: Date) {
  const time =
    ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day =
    (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}
type Item = {
  path: string;
  name: string;
  size: number;
  mtime: Date;
  mode: number;
  directory: boolean;
};
// Directory entries are written too: Git needs empty directories such as `refs/`.
function walk(root: string, prefix: string, out: Item[]) {
  for (const child of readdirSync(root).sort()) {
    const path = join(root, child);
    const info = lstatSync(path);
    const name = prefix ? `${prefix}/${child}` : child;
    if (info.isDirectory()) {
      out.push({
        path,
        name: `${name}/`,
        size: 0,
        mtime: info.mtime,
        mode: info.mode,
        directory: true,
      });
      walk(path, name, out);
    } else if (info.isFile())
      out.push({
        path,
        name,
        size: info.size,
        mtime: info.mtime,
        mode: info.mode,
        directory: false,
      });
    // Symbolic links and special files are not exported; the tree is verified without them.
  }
}
class Counter extends Transform {
  crc = 0;
  size = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.crc = crc32(chunk, this.crc);
    this.size += chunk.length;
    this.push(chunk);
    done();
  }
}
/** Stream a directory as a ZIP whose entries live under `prefix/`. */
export function zipDirectory(root: string, prefix: string): Readable {
  const files: Item[] = [];
  walk(root, prefix, files);
  async function* entries() {
    const central: Buffer[] = [];
    let offset = 0;
    for (const file of files) {
      if (file.size > limit) throw new Error("Backups over 4 GB cannot be downloaded as ZIP");
      const name = Buffer.from(file.name, "utf8");
      const { time, day } = dosTime(file.mtime);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(localSignature, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(file.directory ? 0 : 8, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt16LE(name.length, 26);
      const start = offset;
      yield local;
      yield name;
      offset += local.length + name.length;
      const counter = new Counter();
      let compressed = 0;
      if (!file.directory) {
        const deflate = createDeflateRaw({ level: 6 });
        const source = createReadStream(file.path);
        const raw = source.pipe(counter).pipe(deflate);
        for await (const chunk of raw as AsyncIterable<Buffer>) {
          compressed += chunk.length;
          if (compressed > limit) throw new Error("Backups over 4 GB cannot be downloaded as ZIP");
          yield chunk;
        }
      }
      if (counter.size !== file.size) throw new Error("Backup changed while downloading");
      offset += compressed;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(descriptorSignature, 0);
      descriptor.writeUInt32LE(counter.crc >>> 0, 4);
      descriptor.writeUInt32LE(compressed, 8);
      descriptor.writeUInt32LE(counter.size, 12);
      yield descriptor;
      offset += 16;
      const header = Buffer.alloc(46);
      header.writeUInt32LE(centralSignature, 0);
      header.writeUInt16LE((3 << 8) | 20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(flags, 8);
      header.writeUInt16LE(file.directory ? 0 : 8, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(day, 14);
      header.writeUInt32LE(counter.crc >>> 0, 16);
      header.writeUInt32LE(compressed, 20);
      header.writeUInt32LE(counter.size, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE(
        (((file.directory ? 0o040000 : 0o100000) | (file.mode & 0o777)) << 16) >>> 0,
        38,
      );
      if (file.directory) header.writeUInt16LE(0x0010, 36);
      header.writeUInt32LE(start, 42);
      central.push(header, name);
      if (offset > limit) throw new Error("Backups over 4 GB cannot be downloaded as ZIP");
    }
    const directoryStart = offset;
    let directorySize = 0;
    for (const part of central) {
      directorySize += part.length;
      yield part;
    }
    // 0xffff in the classic record tells readers to use the ZIP64 record for the count.
    const many = files.length >= 0xffff;
    if (many) {
      const record = Buffer.alloc(56);
      record.writeUInt32LE(zip64EndSignature, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(files.length), 24);
      record.writeBigUInt64LE(BigInt(files.length), 32);
      record.writeBigUInt64LE(BigInt(directorySize), 40);
      record.writeBigUInt64LE(BigInt(directoryStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(zip64LocatorSignature, 0);
      locator.writeBigUInt64LE(BigInt(directoryStart + directorySize), 8);
      locator.writeUInt32LE(1, 16);
      yield record;
      yield locator;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(endSignature, 0);
    end.writeUInt16LE(many ? 0xffff : files.length, 8);
    end.writeUInt16LE(many ? 0xffff : files.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryStart, 16);
    yield end;
  }
  return Readable.from(entries());
}

function readAt(fd: number, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw new Error("Upload is not a complete ZIP archive");
    done += read;
  }
  return buffer;
}
type Entry = {
  name: string;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
};
function centralDirectory(fd: number, size: number): Entry[] {
  const tailSize = Math.min(size, 22 + 0xffff);
  if (size < 22) throw new Error("Upload is not a ZIP archive");
  const tail = readAt(fd, size - tailSize, tailSize);
  let end = -1;
  for (let i = tailSize - 22; i >= 0; i--)
    if (tail.readUInt32LE(i) === endSignature) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("Upload is not a ZIP archive");
  let count = tail.readUInt16LE(end + 10);
  let directorySize = tail.readUInt32LE(end + 12);
  let directoryOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff) {
    // More entries than the classic record holds: follow the ZIP64 locator to its record.
    if (end < 20 || tail.readUInt32LE(end - 20) !== zip64LocatorSignature)
      throw new Error("Upload is not a valid ZIP archive");
    const recordOffset = Number(tail.readBigUInt64LE(end - 20 + 8));
    if (recordOffset + 56 > size) throw new Error("Upload is not a valid ZIP archive");
    const record = readAt(fd, recordOffset, 56);
    if (record.readUInt32LE(0) !== zip64EndSignature)
      throw new Error("Upload is not a valid ZIP archive");
    count = Number(record.readBigUInt64LE(32));
    directorySize = Number(record.readBigUInt64LE(40));
    directoryOffset = Number(record.readBigUInt64LE(48));
    if (count > 5_000_000) throw new Error("Upload has too many ZIP entries");
  }
  if (directorySize >= limit || directoryOffset >= limit)
    throw new Error("ZIP64 archives are not supported; use the CLI for backups over 4 GB");
  if (directorySize > 512 * 1024 * 1024 || directoryOffset + directorySize > size)
    throw new Error("Upload is not a valid ZIP archive");
  const directory = readAt(fd, directoryOffset, directorySize);
  const entries: Entry[] = [];
  let position = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > directory.length || directory.readUInt32LE(position) !== centralSignature)
      throw new Error("Upload is not a valid ZIP archive");
    const entryFlags = directory.readUInt16LE(position + 8);
    const method = directory.readUInt16LE(position + 10);
    const crc = directory.readUInt32LE(position + 16);
    const csize = directory.readUInt32LE(position + 20);
    const usize = directory.readUInt32LE(position + 24);
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    const offset = directory.readUInt32LE(position + 42);
    const name = directory.subarray(position + 46, position + 46 + nameLength).toString("utf8");
    position += 46 + nameLength + extraLength + commentLength;
    if (entryFlags & 0x0001) throw new Error("Encrypted ZIP entries are not supported");
    if (csize === limit || usize === limit || offset === limit)
      throw new Error("ZIP64 archives are not supported; use the CLI for backups over 4 GB");
    if (method !== 0 && method !== 8) throw new Error("Unsupported ZIP compression method");
    entries.push({ name, method, crc, csize, usize, offset });
  }
  return entries;
}
function ignored(name: string) {
  const parts = name.split("/");
  return parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store" || parts.at(-1) === "Thumbs.db";
}
/**
 * Extract a ZIP file into `destination` (existing, private). A single shared top-level
 * folder is stripped so `manifest.json` and `data/` land at the root. Returns entry names.
 */
export async function unzipFile(path: string, destination: string) {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const entries = centralDirectory(fd, size).filter((entry) => !ignored(entry.name));
    const names = entries.map((entry) => entry.name.replace(/\/$/, "")).filter(Boolean);
    for (const name of names) safeRelative(name);
    const roots = new Set(names.map((name) => name.split("/")[0]));
    const shared = roots.size === 1 && names.every((name) => name.includes("/"));
    const strip = shared ? `${[...roots][0]}/` : "";
    const written: string[] = [];
    for (const entry of entries) {
      const name = entry.name.startsWith(strip) ? entry.name.slice(strip.length) : entry.name;
      if (!name) continue;
      const target = join(destination, name);
      if (entry.name.endsWith("/")) {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const local = readAt(fd, entry.offset, 30);
      if (local.readUInt32LE(0) !== localSignature)
        throw new Error("Upload is not a valid ZIP archive");
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + entry.csize > size) throw new Error("Upload is not a complete ZIP archive");
      const counter = new Counter();
      const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
      const source =
        entry.csize === 0
          ? Readable.from([])
          : createReadStream(path, { start, end: start + entry.csize - 1 });
      if (entry.method === 8) await pipeline(source, createInflateRaw(), counter, output);
      else await pipeline(source, counter, output);
      if (counter.size !== entry.usize || counter.crc >>> 0 !== entry.crc)
        throw new Error("ZIP entry checksum mismatch");
      written.push(name);
    }
    return written;
  } finally {
    closeSync(fd);
  }
}
