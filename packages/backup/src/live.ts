import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { z } from "zod";
import { acquireWriter, storageHeadroom } from "../../../apps/server/src/deployment.ts";
import {
  contained,
  inventory,
  makeDirectory,
  privateDirectory,
  readArchiveFile,
  syncPath,
  writePrivate,
} from "./archive.ts";
import {
  fenceName,
  installationSchema,
  type Manifest,
  manifestSchema,
  readManifest,
  sealArchive,
  unpackArchive,
} from "./backup.ts";
import { invalidateAuthentication, modeRoot, verifyTree } from "./verify.ts";
import { type ZipItem, zipItems } from "./zip.ts";

export type Installation = z.infer<typeof installationSchema>;
export type AuthMode = Installation["authMode"];

// Sibling paths of the data root. Nothing here is written inside the data tree, so a
// backup never contains other backups, keys, restore intents or replaced roots.
export const backupDirectoryFor = (base: string) => `${resolve(base)}-backups`;
export const pendingRestorePath = (base: string) => `${resolve(base)}.restore-pending.json`;
export const lastRestorePath = (base: string) => `${resolve(base)}.restore-last.json`;
const installationFile = "installation.json";
const writerLock = "control-plane-writer.sqlite";
// Local auth signing material never leaves the host; restore keeps the live copy.
const authSecretFile = "auth-secret";

function ensurePrivateDirectory(path: string) {
  try {
    if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES")
      throw new Error(
        `The server user cannot create ${path}; grant it write access to the parent directory`,
      );
    throw error;
  }
  privateDirectory(path);
}
function replacePrivate(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writePrivate(temporary, JSON.stringify(value, null, 2));
    renameSync(temporary, path);
    syncPath(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Stable installation identity persisted inside the data tree so restores can match it. */
export function installationId(base: string) {
  const path = join(base, installationFile);
  const schema = z.object({ version: z.literal(1), id: z.uuid(), createdAt: z.iso.datetime() });
  if (existsSync(path)) return schema.parse(JSON.parse(readFileSync(path, "utf8"))).id;
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const record = { version: 1, id: randomUUID(), createdAt: new Date().toISOString() };
  replacePrivate(path, record);
  return record.id;
}
export function currentRelease(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const configured = env.CIVIC_SPARK_RELEASE;
  if (configured && /^[a-f0-9]{40}$/.test(configured)) return configured;
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    timeout: 5000,
    encoding: "utf8",
    env: { PATH: env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  const sha = result.status === 0 ? result.stdout.trim() : "";
  return /^[a-f0-9]{40}$/.test(sha) ? sha : "0".repeat(40);
}

const execFileAsync = promisify(execFile);
const gitEnvironment = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
};
function isRepository(path: string) {
  return (
    existsSync(join(path, "HEAD")) &&
    lstatSync(join(path, "HEAD")).isFile() &&
    existsSync(join(path, "objects")) &&
    lstatSync(join(path, "objects")).isDirectory()
  );
}
// A mirror clone reads refs and objects through Git's own locking, so concurrent pushes
// cannot produce a torn object store. Metadata files are then overlaid from the source so
// the captured layout matches the offline archive format (config, hooks, logs, index).
// Clones and copies run asynchronously so the live server keeps answering meanwhile.
async function captureRepository(source: string, destination: string) {
  if (existsSync(join(source, "objects", "info", "alternates")))
    throw new Error("Linked Git storage requires a self-contained backup before proceeding");
  await execFileAsync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      "--mirror",
      "--quiet",
      "--no-hardlinks",
      source,
      destination,
    ],
    { env: gitEnvironment, timeout: 300000 },
  );
  chmodSync(destination, 0o700);
  const overlay = (path: string, rel: string) => {
    for (const child of readdirSync(path).sort()) {
      const from = join(path, child);
      const name = rel ? `${rel}/${child}` : child;
      const info = lstatSync(from);
      if (
        name === "objects" ||
        name === "refs" ||
        name === "packed-refs" ||
        name === "HEAD" ||
        name === "shallow" ||
        child.endsWith(".lock") ||
        name === "objects/info/alternates"
      )
        continue;
      const to = join(destination, name);
      if (info.isSymbolicLink()) throw new Error("Linked Git metadata is unsupported");
      else if (info.isDirectory()) {
        if (!existsSync(to)) mkdirSync(to, { mode: 0o700 });
        overlay(from, name);
      } else if (info.isFile()) {
        rmSync(to, { force: true });
        copyFileSync(from, to);
        chmodSync(to, 0o600 | (info.mode & 0o100));
      } else throw new Error("Unsupported special file in Git metadata");
    }
  };
  overlay(source, "");
}
// SQLite's online backup API copies a consistent snapshot while the application keeps
// writing; the copy is standalone (no WAL) and is integrity-checked before sealing.
async function captureDatabase(source: string, destination: string) {
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }
  // The copy is standalone: leave WAL mode so later checks create no sidecar files.
  const copy = new Database(destination, { fileMustExist: true });
  try {
    copy.pragma("journal_mode = DELETE");
  } finally {
    copy.close();
  }
  chmodSync(destination, 0o600);
}
function removeSidecars(path: string) {
  for (const child of readdirSync(path)) {
    const full = join(path, child);
    const info = lstatSync(full);
    if (info.isDirectory()) removeSidecars(full);
    else if (info.isFile() && /\.sqlite-(wal|shm|journal)$/.test(child)) rmSync(full);
  }
}
function excludedFile(name: string) {
  return (
    name === writerLock ||
    name === authSecretFile ||
    name.startsWith(`${writerLock}-`) ||
    /\.sqlite-(wal|shm|journal)$/.test(name) ||
    name.startsWith(".civic-spark-health")
  );
}
function estimateBytes(path: string): number {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return 0;
  if (info.isFile()) return excludedFile(basename(path)) ? 0 : info.size;
  if (!info.isDirectory()) return 0;
  return readdirSync(path).reduce((sum, child) => sum + estimateBytes(join(path, child)), 0);
}
async function captureTree(source: string, destination: string) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination);
    return;
  }
  if (info.isDirectory()) {
    if (isRepository(source)) {
      await captureRepository(source, destination);
      return;
    }
    mkdirSync(destination, { mode: 0o700 });
    for (const child of readdirSync(source).sort())
      await captureTree(join(source, child), join(destination, child));
    return;
  }
  if (!info.isFile()) throw new Error("Unsupported special file in backup source");
  if (excludedFile(basename(source))) return;
  if (source.endsWith(".sqlite")) await captureDatabase(source, destination);
  else {
    await copyFile(source, destination);
    chmodSync(destination, 0o600 | (info.mode & 0o100));
  }
}

export type BackupSummary = {
  backupId: string;
  createdAt: string;
  consistency: Manifest["consistency"];
  release: string;
  authMode: AuthMode;
  origin: string;
  bytes: number;
  files: number;
  users: number;
  events: number;
  teams: number;
  workspaces: number;
  repositories: number;
  reservations: number;
};
const inventorySchema = z
  .object({
    users: z.number(),
    events: z.number(),
    teams: z.number(),
    workspaces: z.number(),
    repositories: z.array(z.unknown()),
    reservations: z.array(
      z.object({ workspaceId: z.string(), spriteName: z.string(), status: z.unknown() }),
    ),
  })
  .loose();
const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
export const archiveDirectoryName = (manifest: Pick<Manifest, "backupId" | "createdAt">) =>
  `backup-${stamp(new Date(manifest.createdAt))}-${manifest.backupId}`;
function archiveSize(path: string) {
  let bytes = 0;
  let files = 0;
  for (const name of readdirSync(path)) {
    const info = lstatSync(join(path, name));
    if (!info.isFile()) throw new Error("Archive contains a link or special entry");
    bytes += info.size;
    files++;
  }
  return { bytes, files };
}
function summarize(manifest: Manifest, path: string): BackupSummary {
  const summary = inventorySchema.safeParse(manifest.inventory);
  const counts = summary.success ? summary.data : null;
  return {
    backupId: manifest.backupId,
    createdAt: manifest.createdAt,
    consistency: manifest.consistency,
    release: manifest.installation.release,
    authMode: manifest.installation.authMode,
    origin: manifest.installation.origin,
    ...archiveSize(path),
    users: counts?.users ?? 0,
    events: counts?.events ?? 0,
    teams: counts?.teams ?? 0,
    workspaces: counts?.workspaces ?? 0,
    repositories: counts?.repositories.length ?? 0,
    reservations: counts?.reservations.length ?? 0,
  };
}
export function findArchive(directory: string, backupId: string) {
  z.uuid().parse(backupId);
  const name = readdirSync(directory).find(
    (entry) => /^backup-[0-9TZ]+-/.test(entry) && entry.endsWith(`-${backupId}`),
  );
  if (!name) throw new Error("Backup not found");
  const path = join(directory, name);
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw new Error("Backup not found");
  return path;
}
async function withScratch<T>(directory: string, task: (scratch: string) => Promise<T>) {
  const scratch = mkdtempSync(join(directory, ".civic-spark-scratch-"));
  chmodSync(scratch, 0o700);
  try {
    return await task(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
/** Summaries of finalized archives; unreadable archives are reported, not hidden. */
export async function listBackups(directory: string) {
  ensurePrivateDirectory(directory);
  const backups: BackupSummary[] = [];
  const unreadable: string[] = [];
  await withScratch(directory, async (scratch) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (!/^backup-[0-9TZ]+-[a-f0-9-]{36}$/.test(name) || !lstatSync(path).isDirectory()) continue;
      if (!existsSync(join(path, "FINALIZED"))) {
        unreadable.push(name);
        continue;
      }
      try {
        backups.push(summarize(await readManifest(path, null, scratch), path));
      } catch {
        unreadable.push(name);
      }
    }
  });
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { backups, unreadable };
}

export type LiveCaptureOptions = {
  base: string;
  directory: string;
  installation: Installation;
  configuration: Record<string, unknown>;
  capturedBy: { id: string; email: string };
};
/** Capture the running installation without stopping it. */
export async function createLiveBackup(options: LiveCaptureOptions) {
  const base = resolve(options.base);
  const directory = resolve(options.directory);
  ensurePrivateDirectory(directory);
  if (contained(base, directory) || contained(directory, base))
    throw new Error("The backup directory must be outside the data directory");
  if (!existsSync(base) || !lstatSync(base).isDirectory())
    throw new Error("Data directory is missing");
  if (existsSync(join(base, fenceName)))
    throw new Error("Cannot back up an unreconciled restore as a live installation");
  installationSchema.parse(options.installation);
  // Plaintext staging plus the encrypted archive need roughly twice the source size.
  storageHeadroom(directory, estimateBytes(base));
  const stage = mkdtempSync(join(directory, ".civic-spark-live-partial-"));
  chmodSync(stage, 0o700);
  try {
    const data = join(stage, "data");
    await captureTree(base, data);
    // Archives are plaintext: never carry usable session or login tokens in them.
    invalidateAuthentication(data);
    const summary = await verifyTree(data, options.installation.authMode);
    removeSidecars(data);
    const operator = join(stage, "operator");
    makeDirectory(operator);
    writePrivate(
      join(operator, "configuration.json"),
      JSON.stringify({ ...options.configuration, installation: options.installation }, null, 2),
    );
    const receipt = {
      version: 1,
      capture: "live-online-snapshot",
      capturedAt: new Date().toISOString(),
      capturedBy: options.capturedBy,
      sourceDataRoot: base,
      notes:
        "Captured by the running application. SQLite stores use the online backup API and Git repositories are mirror clones; stores are individually consistent but not cross-store atomic. Sessions, login links, the auth signing secret and deployment secrets are not included.",
    };
    writePrivate(join(operator, "receipt.json"), JSON.stringify(receipt, null, 2));
    const identity = { backupId: randomUUID(), createdAt: new Date().toISOString() };
    const destination = join(directory, archiveDirectoryName(identity));
    const manifest = await sealArchive({
      dataRoot: data,
      operatorRoot: operator,
      destination,
      key: null,
      identity,
      manifest: {
        installation: options.installation,
        sourceDataRoot: base,
        consistency: "live-online-snapshot",
        operatorFiles: { configuration: "configuration.json", receipt: "receipt.json" },
        inventory: summary,
      },
    });
    return summarize(manifest, destination);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function deleteBackup(directory: string, backupId: string) {
  const archive = findArchive(resolve(directory), backupId);
  rmSync(archive, { recursive: true, force: true });
  syncPath(directory);
}

/**
 * Stream a stored backup as a ZIP of its real files, straight from the archive: nothing is
 * unpacked first, so the download starts at once. Each file is checked against its manifest
 * checksum as it streams; a mismatch aborts the download. Links are not exported.
 */
export async function exportBackup(directory: string, backupId: string) {
  directory = resolve(directory);
  const archive = findArchive(directory, backupId);
  const scratch = mkdtempSync(join(directory, ".civic-spark-export-partial-"));
  chmodSync(scratch, 0o700);
  let manifest: Manifest;
  try {
    manifest = await readManifest(archive, null, scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const blobs = new Set(["manifest.enc", "FINALIZED"]);
  for (const entry of manifest.entries) if (entry.blob) blobs.add(entry.blob);
  const stored = readdirSync(archive);
  if (stored.length !== blobs.size || stored.some((name) => !blobs.has(name)))
    throw new Error("Backup has missing or unexpected files");
  const name = `civic-spark-backup-${stamp(new Date(manifest.createdAt))}`;
  const mtime = new Date(manifest.createdAt);
  // Upload reads manifest.json beside data/ and operator/, as an unpacked backup has it.
  const plainManifest = Buffer.from(JSON.stringify(manifest));
  const items: ZipItem[] = [
    {
      name: `${name}/manifest.json`,
      size: plainManifest.length,
      mtime,
      mode: 0o600,
      directory: false,
      open: () => Readable.from([plainManifest]),
    },
  ];
  for (const entry of manifest.entries) {
    if (entry.kind === "directory")
      items.push({ name: `${name}/${entry.path}/`, size: 0, mtime, mode: 0o700, directory: true });
    if (entry.kind === "file" && entry.blob) {
      const blob = join(archive, entry.blob);
      items.push({
        name: `${name}/${entry.path}`,
        size: entry.size,
        mtime,
        mode: 0o600 | (entry.mode & 0o100),
        directory: false,
        open: () => readArchiveFile(blob, entry.path, entry),
      });
    }
  }
  return { stream: zipItems(items), filename: `${name}.zip` };
}

/**
 * Store an extracted backup tree (from an uploaded ZIP) as a verified archive. The tree
 * needs a `data` directory; `manifest.json` and `operator/` are reused when present.
 */
export async function importBackupTree(
  directory: string,
  tree: string,
  installation: Installation,
  uploadedBy: { id: string; email: string },
) {
  directory = resolve(directory);
  const data = join(tree, "data");
  if (!existsSync(data) || !lstatSync(data).isDirectory())
    throw new Error("The ZIP is not a Civic Spark backup: it has no data folder");
  const manifestPath = join(tree, "manifest.json");
  const previous = existsSync(manifestPath)
    ? z
        .object({
          backupId: z.uuid(),
          createdAt: z.iso.datetime(),
          installation: installationSchema,
          consistency: manifestSchema.shape.consistency,
        })
        .loose()
        .safeParse(JSON.parse(readFileSync(manifestPath, "utf8")))
    : null;
  const recorded = previous?.success ? previous.data : null;
  if (recorded && recorded.installation.authMode !== installation.authMode)
    throw new Error("This backup was made in a different sign-in mode");
  const identity = recorded
    ? { backupId: recorded.backupId, createdAt: recorded.createdAt }
    : { backupId: randomUUID(), createdAt: new Date().toISOString() };
  if (existsSync(join(directory, archiveDirectoryName(identity))))
    throw new Error("This backup is already stored");
  // Never keep tokens, this host's signing secret or a writer lock from someone's copy.
  rmSync(join(data, writerLock), { force: true });
  for (const mode of ["", "demo", "prototype"])
    rmSync(join(data, mode, authSecretFile), { force: true });
  removeSidecars(data);
  invalidateAuthentication(data);
  const summary = await verifyTree(data, installation.authMode);
  const operator = join(tree, "operator");
  if (
    !existsSync(join(operator, "configuration.json")) ||
    !existsSync(join(operator, "receipt.json"))
  ) {
    rmSync(operator, { recursive: true, force: true });
    makeDirectory(operator);
    writePrivate(
      join(operator, "configuration.json"),
      JSON.stringify({ installation: recorded?.installation ?? installation }, null, 2),
    );
    writePrivate(
      join(operator, "receipt.json"),
      JSON.stringify({ version: 1, capture: "uploaded-tree" }, null, 2),
    );
  }
  for (const entry of inventory(operator, "operator"))
    if (entry.kind === "file") chmodSync(join(operator, entry.path.slice(9)), 0o600);
  writePrivate(
    join(operator, "upload.json"),
    JSON.stringify({ uploadedAt: new Date().toISOString(), uploadedBy }, null, 2),
  );
  const manifest = await sealArchive({
    dataRoot: data,
    operatorRoot: operator,
    destination: join(directory, archiveDirectoryName(identity)),
    key: null,
    identity,
    manifest: {
      installation: recorded?.installation ?? installation,
      sourceDataRoot: tree,
      consistency: recorded?.consistency ?? "live-online-snapshot",
      operatorFiles: { configuration: "configuration.json", receipt: "receipt.json" },
      inventory: summary,
    },
  });
  return summarize(manifest, join(directory, archiveDirectoryName(identity)));
}

export const restoreReportSchema = z
  .object({
    version: z.literal(1),
    backupId: z.uuid(),
    createdAt: z.iso.datetime(),
    requestedAt: z.iso.datetime(),
    requestedBy: z.object({ id: z.string(), email: z.string() }),
    warnings: z.array(z.string()),
    // Sprite names reserved after the backup that the restored state no longer tracks.
    untrackedSprites: z.array(z.string()),
    // Reservations in the backup that the live installation had already released.
    releasedReservations: z.array(z.string()),
    previewOriginsPreserved: z.number().int(),
    sessionsRevoked: z.literal(true),
    appliedAt: z.iso.datetime().optional(),
    replacedRoot: z.string().optional(),
  })
  .strict();
export type RestoreReport = z.infer<typeof restoreReportSchema>;
const pendingSchema = z
  .object({
    version: z.literal(1),
    backupId: z.uuid(),
    staged: z.string().min(1),
    replaced: z.string().min(1),
    report: restoreReportSchema,
  })
  .strict();
export type PendingRestore = z.infer<typeof pendingSchema>;

export type StageRestoreOptions = {
  base: string;
  directory: string;
  backupId: string;
  installation: Installation;
  liveReservations: { workspaceId: string; spriteName: string }[];
  requestedBy: { id: string; email: string };
};
/**
 * Validate a stored backup of this installation and stage a recovered data root beside
 * the live one. Nothing live is modified; the swap happens in applyPendingRestore after
 * the application has stopped writing.
 */
export async function stageRestore(options: StageRestoreOptions) {
  const base = resolve(options.base);
  const directory = resolve(options.directory);
  privateDirectory(directory);
  if (existsSync(pendingRestorePath(base)))
    throw new Error("A restore is already waiting for the application to restart");
  const archive = findArchive(directory, options.backupId);
  storageHeadroom(directory, archiveSize(archive).bytes);
  const stage = mkdtempSync(join(directory, ".civic-spark-restore-partial-"));
  chmodSync(stage, 0o700);
  try {
    const warnings: string[] = [];
    const { manifest, verified } = await unpackArchive(archive, null, stage, (candidate) => {
      const found = candidate.installation;
      if (found.id !== options.installation.id)
        warnings.push(
          "The backup comes from a different installation; its accounts, events and reservations replace this installation's.",
        );
      if (found.authMode !== options.installation.authMode)
        throw new Error("This backup was made in a different sign-in mode");
      if (found.release !== options.installation.release)
        warnings.push(
          `The backup was made by release ${found.release.slice(0, 12)}; the running release is ${options.installation.release.slice(0, 12)}.`,
        );
      if (found.origin !== options.installation.origin)
        warnings.push(`The backup recorded origin ${found.origin}.`);
      if (
        found.spriteOrg !== options.installation.spriteOrg ||
        found.spriteApiOrigin !== options.installation.spriteApiOrigin
      )
        warnings.push("The backup recorded a different Sprite organization or provider origin.");
    });
    const data = join(stage, "data");
    invalidateAuthentication(data);
    // Keep this host's auth signing secret so the restored root stays self-consistent.
    for (const mode of ["", "demo", "prototype"]) {
      const secret = join(base, mode, authSecretFile);
      if (existsSync(secret) && lstatSync(secret).isFile() && existsSync(join(data, mode))) {
        rmSync(join(data, mode, authSecretFile), { force: true });
        copyFileSync(secret, join(data, mode, authSecretFile));
        chmodSync(join(data, mode, authSecretFile), 0o600);
      }
    }
    // Permanent preview origins allocated after the backup stay bound to their workspaces.
    const active = modeRoot(data, options.installation.authMode);
    const ledgerPath = join(active, "preview-origins.json");
    const ledger = z.record(z.string(), z.string());
    const restored = ledger.parse(
      existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : {},
    );
    const livePath = join(modeRoot(base, options.installation.authMode), "preview-origins.json");
    const live = ledger.parse(
      existsSync(livePath) ? JSON.parse(readFileSync(livePath, "utf8")) : {},
    );
    let preserved = 0;
    for (const [id, origin] of Object.entries(live)) {
      if (restored[id] === undefined) {
        restored[id] = origin;
        preserved++;
      } else if (restored[id] !== origin)
        throw new Error("Permanent preview origins cannot be reassigned by a restore");
    }
    if (preserved) {
      rmSync(ledgerPath, { force: true });
      writePrivate(ledgerPath, JSON.stringify(restored));
    }
    const backedUp = new Set(verified.reservations.map((r) => r.spriteName));
    const liveNames = new Set(options.liveReservations.map((r) => r.spriteName));
    const untrackedSprites = [...liveNames].filter((name) => !backedUp.has(name)).sort();
    const releasedReservations = [...backedUp].filter((name) => !liveNames.has(name)).sort();
    for (const entry of manifest.entries)
      if (entry.kind === "symlink") symlinkSync(entry.target as string, join(stage, entry.path));
    const report: RestoreReport = {
      version: 1,
      backupId: manifest.backupId,
      createdAt: manifest.createdAt,
      requestedAt: new Date().toISOString(),
      requestedBy: options.requestedBy,
      warnings,
      untrackedSprites,
      releasedReservations,
      previewOriginsPreserved: preserved,
      sessionsRevoked: true,
    };
    writePrivate(join(stage, "RESTORE-REPORT.json"), JSON.stringify(report, null, 2));
    for (const entry of inventory(stage, "stage").reverse())
      if (entry.kind !== "symlink") syncPath(join(stage, entry.path.slice(6)));
    const ready = join(directory, `restore-${stamp(new Date())}-${manifest.backupId}`);
    renameSync(stage, ready);
    syncPath(directory);
    const pending: PendingRestore = {
      version: 1,
      backupId: manifest.backupId,
      staged: join(ready, "data"),
      replaced: `${base}.replaced-${stamp(new Date())}`,
      report,
    };
    replacePrivate(pendingRestorePath(base), pending);
    return report;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function readPendingRestore(base: string): PendingRestore | null {
  const path = pendingRestorePath(resolve(base));
  if (!existsSync(path)) return null;
  return pendingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
export function readLastRestore(base: string): RestoreReport | null {
  const path = lastRestorePath(resolve(base));
  if (!existsSync(path)) return null;
  const parsed = restoreReportSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  return parsed.success ? parsed.data : null;
}
export function discardPendingRestore(base: string) {
  const pending = readPendingRestore(base);
  if (!pending) return;
  rmSync(dirname(pending.staged), { recursive: true, force: true });
  rmSync(pendingRestorePath(resolve(base)), { force: true });
}

/**
 * Swap a staged recovery root into place. Safe to call repeatedly: each step checks the
 * on-disk state, so an interrupted swap completes on the next call. Must run with no
 * application writer; it takes the writer lock on the live root to prove that.
 */
export function applyPendingRestore(base: string): RestoreReport | null {
  base = resolve(base);
  const pending = readPendingRestore(base);
  if (!pending) return null;
  const staged = resolve(pending.staged);
  const replaced = resolve(pending.replaced);
  if (contained(base, staged) || contained(base, replaced) || contained(staged, base))
    throw new Error("Invalid restore layout");
  if (existsSync(staged) && !existsSync(join(dirname(staged), "RESTORE-REPORT.json")))
    throw new Error("Staged restore is incomplete; discard it and restore again");
  if (existsSync(base) && !existsSync(replaced)) {
    if (existsSync(join(base, fenceName))) throw new Error("Live root is fenced");
    const release = acquireWriter(base);
    try {
      if (!existsSync(staged)) throw new Error("Staged restore is missing");
      renameSync(base, replaced);
    } finally {
      release();
    }
  }
  if (existsSync(staged)) {
    if (existsSync(base)) throw new Error("Both live and staged roots exist; inspect manually");
    renameSync(staged, base);
    syncPath(dirname(base));
  }
  if (!existsSync(base)) throw new Error("Restore did not produce a data directory");
  const report: RestoreReport = {
    ...pending.report,
    appliedAt: new Date().toISOString(),
    replacedRoot: replaced,
  };
  replacePrivate(lastRestorePath(base), report);
  rmSync(dirname(staged), { recursive: true, force: true });
  rmSync(pendingRestorePath(base), { force: true });
  syncPath(dirname(base));
  return report;
}

/** Replaced roots retained beside the data directory after restores. */
export function replacedRoots(base: string) {
  base = resolve(base);
  const parent = dirname(base);
  const prefix = `${basename(base)}.replaced-`;
  return readdirSync(parent)
    .filter((name) => name.startsWith(prefix) && lstatSync(join(parent, name)).isDirectory())
    .map((name) => join(parent, name))
    .sort();
}
