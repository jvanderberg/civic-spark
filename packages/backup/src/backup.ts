import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { acquireWriter } from "../../../apps/server/src/deployment.ts";
import {
  absentDestination,
  contained,
  decryptFile,
  digest,
  encryptFile,
  entrySchema,
  inventory,
  makeDirectory,
  privateDirectory,
  readKey,
  syncPath,
  validateEntries,
  writePrivate,
} from "./archive.ts";
import { invalidateAuthentication, verifyTree } from "./verify.ts";

export const installationSchema = z
  .object({
    id: z.string().min(1).max(200),
    authMode: z.enum(["email", "demo", "prototype"]),
    release: z.string().regex(/^[a-f0-9]{40}$/),
    origin: z.url(),
    spriteOrg: z.string().min(1).nullable(),
    spriteApiOrigin: z.url(),
  })
  .strict();
export const createSchema = z
  .object({
    dataRoot: z.string().min(1),
    operatorRoot: z.string().min(1),
    destination: z.string().min(1),
    keyFile: z.string().min(1),
    installation: installationSchema,
    // This is an operator assertion, never an instruction to stop participants or cloud resources.
    coordinatedOffline: z.literal(true),
    operatorFiles: z
      .object({ configuration: z.string(), receipt: z.string(), secrets: z.string() })
      .strict(),
  })
  .strict();
export type CreateOptions = z.infer<typeof createSchema>;
export const restoreSchema = z
  .object({
    archive: z.string().min(1),
    target: z.string().min(1),
    keyFile: z.string().min(1),
    installation: installationSchema,
  })
  .strict();
export type RestoreOptions = z.infer<typeof restoreSchema>;
const manifestSchema = z
  .object({
    format: z.literal("civic-spark-management-backup"),
    version: z.literal(1),
    app: z.literal("civic-spark"),
    appVersion: z.literal("0.1.0"),
    backupId: z.uuid(),
    createdAt: z.iso.datetime(),
    installation: installationSchema,
    sourceDataRoot: z.string().min(1),
    consistency: z.literal("coordinated-offline-exclusive-writer"),
    spritePrivateState: z.literal("excluded-disposable"),
    operatorFiles: createSchema.shape.operatorFiles,
    inventory: z.unknown(),
    entries: z.array(entrySchema).max(2000000),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
const fenceName = ".civic-spark-recovery.json";

function requireOperatorFiles(root: string, files: CreateOptions["operatorFiles"]) {
  for (const path of Object.values(files)) {
    if (
      !path ||
      !contained(root, join(root, path)) ||
      path.startsWith("/") ||
      !lstatSync(join(root, path)).isFile()
    )
      throw new Error("Required operator recovery file missing");
    if ((lstatSync(join(root, path)).mode & 0o077) !== 0)
      throw new Error("Operator recovery files must be private (mode 0600)");
  }
}
function snapshot(root: string, prefix: string) {
  return inventory(root, prefix).map((entry) => {
    const stat = lstatSync(join(root, entry.path.slice(prefix.length + 1)));
    return { ...entry, mtime: stat.mtimeMs, ctime: stat.ctimeMs, inode: stat.ino };
  });
}
export async function createBackup(input: CreateOptions) {
  const options = createSchema.parse(input);
  const root = realpathSync(options.dataRoot);
  const operator = realpathSync(options.operatorRoot);
  const destination = resolve(options.destination);
  privateDirectory(operator);
  if (inventory(operator, "operator").some((entry) => entry.kind === "symlink"))
    throw new Error("Operator recovery package must contain real files, not links");
  absentDestination(destination);
  for (const path of [destination, resolve(options.keyFile)])
    if (contained(root, path) || contained(operator, path))
      throw new Error("Backup output and key must be outside source trees");
  if (contained(root, operator) || contained(operator, root))
    throw new Error("Recovery source trees must be separate");
  requireOperatorFiles(operator, options.operatorFiles);
  const key = readKey(options.keyFile);
  const release = acquireWriter(root);
  let stage: string | undefined;
  try {
    if (existsSync(join(root, fenceName)))
      throw new Error("Cannot back up an unreconciled restore as a live installation");
    const summary = verifyTree(root, options.installation.authMode);
    if (summary.reservations.length && !options.installation.spriteOrg)
      throw new Error("Reserved Sprites require recorded provider ownership");
    const before = [...snapshot(root, "data"), ...snapshot(operator, "operator")];
    stage = mkdtempSync(join(dirname(destination), ".civic-spark-backup-partial-"));
    chmodSync(stage, 0o700);
    const entries = [...inventory(root, "data"), ...inventory(operator, "operator")];
    let number = 0;
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      const source = entry.path.startsWith("data/")
        ? join(root, entry.path.slice(5))
        : join(operator, entry.path.slice(9));
      entry.blob = `${String(number++).padStart(8, "0")}.enc`;
      const result = await encryptFile(source, join(stage, entry.blob), key, entry.path);
      if (result.size !== entry.size) throw new Error("Source changed during backup");
      entry.sha256 = result.sha256;
    }
    const after = [...snapshot(root, "data"), ...snapshot(operator, "operator")];
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("Source changed during backup; coordinate all writers");
    const manifest: Manifest = {
      format: "civic-spark-management-backup",
      version: 1,
      app: "civic-spark",
      appVersion: "0.1.0",
      backupId: randomUUID(),
      createdAt: new Date().toISOString(),
      installation: options.installation,
      sourceDataRoot: root,
      consistency: "coordinated-offline-exclusive-writer",
      spritePrivateState: "excluded-disposable",
      operatorFiles: options.operatorFiles,
      inventory: summary,
      entries,
    };
    validateEntries(entries);
    const plain = join(stage, "manifest.tmp");
    writePrivate(plain, JSON.stringify(manifest));
    await encryptFile(plain, join(stage, "manifest.enc"), key, "civic-spark-manifest-v1");
    rmSync(plain);
    writePrivate(join(stage, "FINALIZED"), digest(readFileSync(join(stage, "manifest.enc"))));
    syncPath(stage);
    // Parent is required private; no cooperating operator may race this finalization.
    absentDestination(destination);
    renameSync(stage, destination);
    stage = undefined;
    syncPath(dirname(destination));
    return {
      backupId: manifest.backupId,
      ...summary,
      spritePrivateState: manifest.spritePrivateState,
    };
  } finally {
    release();
    key.fill(0);
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
}

async function unpack(options: RestoreOptions, stage: string) {
  const archive = realpathSync(options.archive);
  privateDirectory(archive);
  if (!existsSync(join(archive, "FINALIZED"))) throw new Error("Backup is partial, not finalized");
  for (const name of readdirSync(archive))
    if (!lstatSync(join(archive, name)).isFile())
      throw new Error("Archive contains a link or special entry");
  if (
    readFileSync(join(archive, "FINALIZED"), "utf8") !==
    digest(readFileSync(join(archive, "manifest.enc")))
  )
    throw new Error("Backup manifest checksum mismatch");
  if (lstatSync(join(archive, "manifest.enc")).size > 256 * 1024 * 1024)
    throw new Error("Manifest exceeds recovery limit");
  const key = readKey(options.keyFile);
  try {
    const plain = join(stage, "manifest.json");
    await decryptFile(join(archive, "manifest.enc"), plain, key, "civic-spark-manifest-v1");
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(plain, "utf8")));
    if (JSON.stringify(manifest.installation) !== JSON.stringify(options.installation))
      throw new Error("Installation, release, origin or authentication mode mismatch");
    validateEntries(manifest.entries);
    const expected = new Set([
      "manifest.enc",
      "FINALIZED",
      ...manifest.entries.flatMap((e) => (e.blob ? [e.blob] : [])),
    ]);
    if (readdirSync(archive).some((n) => !expected.delete(n)) || expected.size)
      throw new Error("Backup has missing or unexpected files");
    for (const entry of manifest.entries) {
      const destination = join(stage, entry.path);
      if (entry.kind === "directory") makeDirectory(destination);
      if (entry.kind === "file") {
        const result = await decryptFile(
          join(archive, entry.blob as string),
          destination,
          key,
          entry.path,
        );
        if (result.size !== entry.size || result.sha256 !== entry.sha256)
          throw new Error("Backup file checksum mismatch");
        chmodSync(destination, 0o600 | (entry.mode & 0o100));
      }
      // Links are inert metadata until all verification and database writes have completed.
    }
    requireOperatorFiles(join(stage, "operator"), manifest.operatorFiles);
    const verified = verifyTree(join(stage, "data"), manifest.installation.authMode);
    if (JSON.stringify(verified) !== JSON.stringify(manifest.inventory))
      throw new Error("Restored inventory mismatch");
    return { manifest, verified };
  } finally {
    key.fill(0);
  }
}
export async function restoreBackup(input: RestoreOptions, dryRun = false) {
  const options = restoreSchema.parse(input);
  const target = resolve(options.target);
  absentDestination(target);
  if (contained(resolve(options.archive), target))
    throw new Error("Restore target cannot be inside the archive");
  const stage = mkdtempSync(join(dirname(target), ".civic-spark-restore-partial-"));
  chmodSync(stage, 0o700);
  try {
    const { manifest, verified } = await unpack(options, stage);
    invalidateAuthentication(join(stage, "data"));
    writePrivate(
      join(stage, "data", fenceName),
      JSON.stringify({
        version: 1,
        backupId: manifest.backupId,
        installationId: manifest.installation.id,
        authMode: manifest.installation.authMode,
        release: manifest.installation.release,
        status: "pending-reconciliation",
        createdAt: new Date().toISOString(),
      }),
    );
    for (const entry of manifest.entries) {
      if (entry.kind === "symlink") symlinkSync(entry.target as string, join(stage, entry.path));
    }
    writePrivate(
      join(stage, "RESTORE-REPORT.json"),
      JSON.stringify({
        version: 1,
        backupId: manifest.backupId,
        ...verified,
        sessionsRevoked: true,
        loginLinksRevoked: true,
        cloudActions: 0,
        startupBlocked: true,
      }),
    );
    if (!dryRun) {
      // Flush the complete staged tree before exposing it under its final name.
      for (const entry of inventory(stage, "stage").reverse())
        if (entry.kind !== "symlink") syncPath(join(stage, entry.path.slice(6)));
      absentDestination(target);
      renameSync(stage, target);
      syncPath(dirname(target));
    }
    return { backupId: manifest.backupId, validated: true, startupBlocked: true, dryRun };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// Retention is opt-in and operates only on recognizable finalized archives; partials
// and unknown directories are never deleted. Replication verification precedes pruning.
export function retentionCandidates(directory: string, keep: number) {
  privateDirectory(directory);
  if (!Number.isInteger(keep) || keep < 1) throw new Error("Keep at least one backup");
  return readdirSync(directory)
    .filter((name) => /^backup-[0-9TZ-]+-[a-f0-9-]+$/.test(name))
    .map((name) => join(directory, name))
    .filter(
      (path) =>
        lstatSync(path).isDirectory() &&
        !lstatSync(path).isSymbolicLink() &&
        existsSync(join(path, "FINALIZED")),
    )
    .sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs)
    .slice(keep);
}

export const retentionSchema = z
  .object({
    directory: z.string().min(1),
    replicaDirectory: z.string().min(1),
    keep: z.number().int().min(1),
    keyFile: z.string().min(1),
    installation: installationSchema,
  })
  .strict();
/** Explicit local retention only; every deletion requires a validated matching replica. */
export async function pruneBackups(input: z.infer<typeof retentionSchema>) {
  const options = retentionSchema.parse(input);
  const directory = realpathSync(options.directory);
  const replicas = realpathSync(options.replicaDirectory);
  privateDirectory(directory);
  privateDirectory(replicas);
  if (contained(directory, replicas) || contained(replicas, directory))
    throw new Error("Retention requires an independent replica directory");
  const candidates = retentionCandidates(directory, options.keep);
  for (const archive of candidates) {
    const replica = join(replicas, archive.slice(directory.length + 1));
    if (
      !readFileSync(join(archive, "manifest.enc")).equals(
        readFileSync(join(replica, "manifest.enc")),
      )
    )
      throw new Error("Retention replica does not match the original backup");
    await restoreBackup(
      {
        archive: replica,
        target: join(replicas, `.retention-validation-${randomUUID()}`),
        keyFile: options.keyFile,
        installation: options.installation,
      },
      true,
    );
    await restoreBackup(
      {
        archive,
        target: join(directory, `.retention-validation-${randomUUID()}`),
        keyFile: options.keyFile,
        installation: options.installation,
      },
      true,
    );
  }
  // No partial deletion if any candidate has missing/corrupt recovery evidence.
  for (const archive of candidates) rmSync(archive, { recursive: true });
  syncPath(directory);
  return { pruned: candidates.length, keep: options.keep };
}
