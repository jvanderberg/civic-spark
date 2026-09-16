import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

export const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const entrySchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(["directory", "file", "symlink"]),
    mode: z.number().int().min(0).max(0o777),
    size: z.number().int().nonnegative(),
    sha256: hashSchema.optional(),
    blob: z
      .string()
      .regex(/^[0-9]{8}\.enc$/)
      .optional(),
    target: z.string().optional(),
  })
  .strict();
export type Entry = z.infer<typeof entrySchema>;

export function contained(root: string, candidate: string) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
export function safeRelative(value: string) {
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe archive path");
  return value;
}
export function privateDirectory(path: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || realpathSync(path) !== resolve(path))
    throw new Error("Use a real private directory (mode 0700), without symlink ancestors");
}
export function readKey(path: string) {
  const info = lstatSync(path);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size !== 32)
    throw new Error("Backup key must be a private, regular 32-byte file (mode 0600)");
  return readFileSync(path);
}
export function syncPath(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function writePrivate(path: string, content: string | Buffer) {
  writeFileSync(path, content, { flag: "wx", mode: 0o600, flush: true });
}

// Format: magic (8), nonce (12), ciphertext, GCM tag (16). All metadata is encrypted too.
const magic = Buffer.from("CSPARK01");
export async function encryptFile(source: string, destination: string, key: Buffer, aad: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const hash = createHash("sha256");
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  output.write(Buffer.concat([magic, nonce]));
  await pipeline(createReadStream(source), counter, cipher, output, { end: false });
  output.end(cipher.getAuthTag());
  await new Promise<void>((resolveDone, reject) => {
    output.on("finish", resolveDone);
    output.on("error", reject);
  });
  syncPath(destination);
  return { sha256: hash.digest("hex"), size };
}
export async function decryptFile(source: string, destination: string, key: Buffer, aad: string) {
  const size = statSync(source).size;
  if (size < 36) throw new Error("Truncated encrypted file");
  const header = Buffer.alloc(20);
  const tag = Buffer.alloc(16);
  const { readSync } = await import("node:fs");
  const fd = openSync(source, "r");
  try {
    readSync(fd, header, 0, 20, 0);
    readSync(fd, tag, 0, 16, size - 16);
  } finally {
    closeSync(fd);
  }
  if (!header.subarray(0, 8).equals(magic)) throw new Error("Unknown backup encryption format");
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(8));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  const hash = createHash("sha256");
  let plainSize = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      plainSize += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(
    size === 36 ? Readable.from([]) : createReadStream(source, { start: 20, end: size - 17 }),
    decipher,
    counter,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  return { sha256: hash.digest("hex"), size: plainSize };
}

export function inventory(root: string, prefix: string): Entry[] {
  const entries: Entry[] = [];
  function visit(path: string, name: string) {
    const info = lstatSync(path);
    const mode = info.mode & 0o777;
    if (info.isSymbolicLink()) {
      entries.push({ path: name, kind: "symlink", mode, size: 0, target: readlinkSync(path) });
    } else if (info.isDirectory()) {
      entries.push({ path: name, kind: "directory", mode, size: 0 });
      for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`);
    } else if (info.isFile()) {
      entries.push({ path: name, kind: "file", mode, size: info.size });
    } else throw new Error("Unsupported special file in backup source");
  }
  visit(root, prefix);
  for (const entry of entries) safeRelative(entry.path);
  return entries;
}
export function validateEntries(entries: Entry[]) {
  const seen = new Map<string, Entry>();
  const blobs = new Set<string>();
  for (const entry of entries) {
    safeRelative(entry.path);
    if (!/^(data|operator)(\/|$)/.test(entry.path) || seen.has(entry.path))
      throw new Error("Duplicate or unknown archive path");
    const parent = dirname(entry.path);
    if (parent !== "." && seen.get(parent)?.kind !== "directory")
      throw new Error("Archive parent must precede its children and be a directory");
    if (entry.kind === "file") {
      if (!entry.blob || !entry.sha256 || blobs.has(entry.blob) || entry.target !== undefined)
        throw new Error("Invalid encrypted file entry");
      blobs.add(entry.blob);
    } else if (
      entry.blob ||
      entry.sha256 ||
      entry.size !== 0 ||
      (entry.kind === "symlink"
        ? typeof entry.target !== "string" || entry.target.includes("\0")
        : entry.target !== undefined)
    )
      throw new Error("Invalid directory or link entry");
    seen.set(entry.path, entry);
  }
  if (seen.get("data")?.kind !== "directory" || seen.get("operator")?.kind !== "directory")
    throw new Error("Missing backup scope");
}
export function absentDestination(path: string) {
  if (existsSync(path)) throw new Error("Destination already exists; restore never overwrites");
  // lstat also detects dangling symbolic links.
  try {
    lstatSync(path);
    throw new Error("Destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  privateDirectory(dirname(path));
}
export function makeDirectory(path: string) {
  mkdirSync(path, { mode: 0o700 });
}
