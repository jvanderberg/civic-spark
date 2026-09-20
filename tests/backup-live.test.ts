import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import type { BackupStatus } from "../apps/server/src/backups.ts";
import { acquireWriter, validateDeployment } from "../apps/server/src/deployment.ts";
import { unpackArchive } from "../packages/backup/src/backup.ts";
import {
  applyPendingRestore,
  backupDirectoryFor,
  currentRelease,
  lastRestorePath,
  pendingRestorePath,
  type RestoreReport,
  readPendingRestore,
} from "../packages/backup/src/live.ts";
import { archiveTar, archiveTarSize, extractTar } from "../packages/backup/src/tar.ts";
import type { PortalState, SessionView } from "../packages/domain/src/access-types.ts";
import type { Result } from "../packages/domain/src/types.ts";

const origin = "http://127.0.0.1:4310";
const release = "b".repeat(40);
const roots: string[] = [];
const apps: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function unwrap<T>(result: Result<T>) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const headers = (cookie = "") => ({ host: "127.0.0.1:4310", origin, cookie });
function privateBase() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "civic-spark-live-backup-")));
  chmodSync(base, 0o700);
  roots.push(base);
  return base;
}
async function start(root: string, restart?: () => void) {
  vi.stubEnv("CIVIC_SPARK_RELEASE", release);
  const created = await createApp(
    root,
    false,
    origin,
    undefined,
    "demo",
    undefined,
    undefined,
    restart,
  );
  apps.push(created.app);
  return created;
}
async function signIn(app: Awaited<ReturnType<typeof createApp>>["app"], email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/demo/sign-in",
    headers: headers(),
    payload: { email, callbackURL: origin },
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
async function seed(root: string) {
  const created = await start(root);
  const { app } = created;
  const admin = await signIn(app, "organizer@example.test");
  const member = await signIn(app, "member@example.test");
  const event = await app.inject({
    method: "POST",
    url: "/api/events",
    headers: headers(admin),
    payload: {
      name: "Backup rehearsal",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 10,
      budget: 10,
      templateId: "blank",
    },
  });
  expect(event.statusCode).toBe(200);
  const eventId = event.json<{ id: string }>().id;
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/events/${eventId}/status`,
        headers: headers(admin),
        payload: { status: "registration" },
      })
    ).statusCode,
  ).toBe(200);
  const project = await app.inject({
    method: "POST",
    url: `/api/events/${eventId}/projects`,
    headers: headers(admin),
    payload: { name: "Recovery project", brief: "A detailed brief for the recovery project." },
  });
  expect(project.statusCode).toBe(200);
  const projectId = project.json<{ id: string }>().id;
  const team = await app.inject({
    method: "POST",
    url: "/api/teams",
    headers: headers(member),
    payload: { eventId, name: "First team", projectId },
  });
  expect(team.statusCode).toBe(200);
  const teamId = team.json<{ team: { id: string } }>().team.id;
  return { ...created, admin, member, eventId, projectId, teamId };
}
async function status(
  app: Awaited<ReturnType<typeof createApp>>["app"],
  eventId: string,
  cookie: string,
) {
  const response = await app.inject({
    url: `/api/events/${eventId}/backups`,
    headers: headers(cookie),
  });
  expect(response.statusCode).toBe(200);
  return response.json<BackupStatus>();
}
async function createBackup(
  app: Awaited<ReturnType<typeof createApp>>["app"],
  eventId: string,
  cookie: string,
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/events/${eventId}/backups`,
    headers: headers(cookie),
    payload: {},
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ backupId: string; teams: number }>();
}
const teams = async (
  app: Awaited<ReturnType<typeof createApp>>["app"],
  eventId: string,
  cookie: string,
) => {
  const response = await app.inject({ url: "/api/state", headers: headers(cookie) });
  expect(response.statusCode).toBe(200);
  return response
    .json<PortalState>()
    .teams.filter((team) => team.eventId === eventId)
    .map((team) => team.name)
    .sort();
};

it("creates, lists, downloads, re-uploads and deletes live backups through the admin API", async () => {
  const base = privateBase();
  const root = join(base, "data");
  const f = await seed(root);
  const before = await status(f.app, f.eventId, f.admin);
  expect(before).toMatchObject({
    directory: backupDirectoryFor(root),
    backups: [],
    pending: null,
    lastRestore: null,
    canRestart: false,
  });
  // Members and outsiders never see installation backups.
  expect(
    (await f.app.inject({ url: `/api/events/${f.eventId}/backups`, headers: headers(f.member) }))
      .statusCode,
  ).toBe(403);
  const created = await createBackup(f.app, f.eventId, f.admin);
  expect(created.teams).toBe(1);
  const listed = await status(f.app, f.eventId, f.admin);
  expect(listed.backups).toHaveLength(1);
  expect(listed.backups[0]).toMatchObject({
    backupId: created.backupId,
    consistency: "live-online-snapshot",
    release,
    authMode: "demo",
    events: 1,
    teams: 1,
    users: 2,
  });
  expect(listed.backups[0]?.repositories).toBeGreaterThanOrEqual(1);
  // No staging directory remains beside the sealed archive.
  const directory = backupDirectoryFor(root);
  expect(readdirSync(directory).filter((name) => name.startsWith("."))).toEqual([]);
  const archive = join(directory, readdirSync(directory)[0] as string);
  expect(
    readdirSync(archive).every((name) => /^(manifest\.enc|FINALIZED|\d{8}\.enc)$/.test(name)),
  ).toBe(true);
  // Archives are plain: account data is readable, but no session token is carried.
  const blobs = readdirSync(archive).map((name) => readFileSync(join(archive, name)));
  expect(blobs.some((blob) => blob.includes("organizer@example.test"))).toBe(true);
  const sessionCookie = decodeURIComponent(f.admin.split("=")[1] ?? "").split(".")[0] ?? "";
  expect(sessionCookie.length).toBeGreaterThan(10);
  expect(blobs.some((blob) => blob.includes(sessionCookie))).toBe(false);
  // The live application kept working during and after the capture.
  expect(await teams(f.app, f.eventId, f.admin)).toEqual(["First team"]);

  const download = await f.app.inject({
    url: `/api/events/${f.eventId}/backups/${created.backupId}/download`,
    headers: headers(f.admin),
  });
  expect(download.statusCode).toBe(200);
  expect(download.headers["content-type"]).toBe("application/x-tar");
  expect(download.rawPayload.length).toBe(archiveTarSize(archive));
  expect(Number(download.headers["content-length"])).toBe(download.rawPayload.length);

  const deleted = await f.app.inject({
    method: "DELETE",
    url: `/api/events/${f.eventId}/backups/${created.backupId}`,
    headers: headers(f.admin),
    payload: { confirmed: true },
  });
  expect(deleted.statusCode).toBe(200);
  expect((await status(f.app, f.eventId, f.admin)).backups).toEqual([]);
  expect(
    (
      await f.app.inject({
        url: `/api/events/${f.eventId}/backups/${created.backupId}/download`,
        headers: headers(f.admin),
      })
    ).statusCode,
  ).toBe(404);

  const upload = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/backups/upload`,
    headers: { ...headers(f.admin), "content-type": "application/x-tar" },
    payload: download.rawPayload,
  });
  expect(upload.statusCode, upload.body).toBe(200);
  expect(upload.json<{ backupId: string }>().backupId).toBe(created.backupId);
  const again = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/backups/upload`,
    headers: { ...headers(f.admin), "content-type": "application/x-tar" },
    payload: download.rawPayload,
  });
  expect(again.statusCode).toBe(400);
  expect(again.json<{ error: string }>().error).toContain("already stored");
  const garbage = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/backups/upload`,
    headers: { ...headers(f.admin), "content-type": "application/x-tar" },
    payload: Buffer.from("not a tar archive at all"),
  });
  expect(garbage.statusCode).toBe(400);
  // Streams larger than the JSON body limit are accepted and judged on their content.
  const big = join(privateBase(), "big");
  mkdirSync(big, { mode: 0o700 });
  writeFileSync(join(big, "manifest.enc"), Buffer.alloc(3 * 1024 * 1024, 9));
  writeFileSync(join(big, "FINALIZED"), "0".repeat(64));
  const bigChunks: Buffer[] = [];
  for await (const chunk of archiveTar(big)) bigChunks.push(chunk as Buffer);
  const oversized = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/backups/upload`,
    headers: { ...headers(f.admin), "content-type": "application/x-tar" },
    payload: Buffer.concat(bigChunks),
  });
  expect(oversized.statusCode).toBe(400);
  expect(oversized.json<{ error: string }>().error).toMatch(/checksum|damaged/);
  expect(readdirSync(directory).filter((name) => name.startsWith("."))).toEqual([]);
  expect((await status(f.app, f.eventId, f.admin)).backups.map((b) => b.backupId)).toEqual([
    created.backupId,
  ]);

  // A backup from another installation can be uploaded and restored; the restore warns.
  const otherRoot = join(privateBase(), "data");
  const other = await seed(otherRoot);
  const foreign = await other.app.inject({
    method: "POST",
    url: `/api/events/${other.eventId}/backups/upload`,
    headers: { ...headers(other.admin), "content-type": "application/x-tar" },
    payload: download.rawPayload,
  });
  expect(foreign.statusCode, foreign.body).toBe(200);
  const restore = await other.app.inject({
    method: "POST",
    url: `/api/events/${other.eventId}/backups/${created.backupId}/restore`,
    headers: headers(other.admin),
    payload: { confirmed: true },
  });
  expect(restore.statusCode, restore.body).toBe(200);
  expect(restore.json<RestoreReport>().warnings.join(" ")).toContain("different installation");
  expect(readPendingRestore(otherRoot)?.backupId).toBe(created.backupId);
});

it("restricts backups to listed operators when configured", async () => {
  const root = join(privateBase(), "data");
  vi.stubEnv("CIVIC_SPARK_BACKUP_OPERATORS", "Owner@Example.test");
  const f = await seed(root);
  const denied = await f.app.inject({
    url: `/api/events/${f.eventId}/backups`,
    headers: headers(f.admin),
  });
  expect(denied.statusCode).toBe(403);
  const owner = await signIn(f.app, "owner@example.test");
  expect((await f.app.inject({ url: "/api/state", headers: headers(owner) })).statusCode).toBe(200);
  const grant = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/admins`,
    headers: headers(f.admin),
    payload: { email: "owner@example.test" },
  });
  expect(grant.statusCode).toBe(200);
  const allowed = await status(f.app, f.eventId, owner);
  expect(allowed.operatorsRestricted).toBe(true);
});

it("restores a live backup by staging, restarting and swapping the data root; sessions are revoked and newer preview origins kept", async () => {
  const base = privateBase();
  const root = join(base, "data");
  let restartRequested: () => void = () => {};
  const restarted = new Promise<void>((resolve) => {
    restartRequested = resolve;
  });
  const first = await seed(root);
  const created = await createBackup(first.app, first.eventId, first.admin);
  // Changes after the backup: another team and a newer permanent preview origin.
  const second = await first.app.inject({
    method: "POST",
    url: "/api/teams",
    headers: headers(first.member),
    payload: { eventId: first.eventId, name: "Later team", projectId: first.projectId },
  });
  expect(second.statusCode).toBe(200);
  const laterWorkspace = second.json<{ workspace: { id: string } }>().workspace.id;
  const ledger = join(root, "demo", "preview-origins.json");
  writeFileSync(ledger, JSON.stringify({ [laterWorkspace]: "https://later.example.test" }), {
    mode: 0o600,
  });
  unwrap(
    first.service.setSprite(
      laterWorkspace,
      `civic-spark-${laterWorkspace}`,
      "ready",
      null,
      "ready",
    ),
  );
  expect(await teams(first.app, first.eventId, first.admin)).toEqual(["First team", "Later team"]);
  await first.app.close();
  apps.splice(0);

  // Restart the application with a restart hook, as the entry point does.
  const live = await start(root, () => restartRequested());
  const admin = await signIn(live.app, "organizer@example.test");
  const denied = await live.app.inject({
    method: "POST",
    url: `/api/events/${first.eventId}/backups/${created.backupId}/restore`,
    headers: headers(admin),
    payload: {},
  });
  expect(denied.statusCode).toBe(400);
  const restore = await live.app.inject({
    method: "POST",
    url: `/api/events/${first.eventId}/backups/${created.backupId}/restore`,
    headers: headers(admin),
    payload: { confirmed: true },
  });
  expect(restore.statusCode, restore.body).toBe(200);
  const report = restore.json<RestoreReport & { restarting: boolean }>();
  expect(report).toMatchObject({
    backupId: created.backupId,
    restarting: true,
    sessionsRevoked: true,
    previewOriginsPreserved: 1,
    untrackedSprites: [`civic-spark-${laterWorkspace}`],
    releasedReservations: [],
    warnings: [],
  });
  await restarted;
  const pending = readPendingRestore(root);
  expect(pending?.backupId).toBe(created.backupId);
  expect(existsSync(pending?.staged as string)).toBe(true);
  // Nothing live changed before the restart.
  expect(await teams(live.app, first.eventId, admin)).toEqual(["First team", "Later team"]);
  const pendingStatus = await status(live.app, first.eventId, admin);
  expect(pendingStatus.pending?.backupId).toBe(created.backupId);
  const blocked = await live.app.inject({
    method: "POST",
    url: `/api/events/${first.eventId}/backups`,
    headers: headers(admin),
    payload: {},
  });
  expect(blocked.statusCode).toBe(400);
  await live.app.close();
  apps.splice(0);

  const applied = applyPendingRestore(root);
  expect(applied?.backupId).toBe(created.backupId);
  expect(applied?.replacedRoot).toBe(pending?.replaced);
  expect(existsSync(pendingRestorePath(root))).toBe(false);
  expect(existsSync(pending?.staged as string)).toBe(false);
  expect(existsSync(join(pending?.replaced as string, "demo", "state.sqlite"))).toBe(true);
  expect(existsSync(lastRestorePath(root))).toBe(true);
  // Idempotent: a second call is a no-op.
  expect(applyPendingRestore(root)).toBeNull();
  // The restored root starts without a recovery fence and with the backed-up state.
  expect(() => validateDeployment(root, origin, "demo")).not.toThrow();
  const restored = await start(root);
  expect(
    (
      await restored.app.inject({ url: "/api/session", headers: headers(admin) })
    ).json<SessionView>().user,
  ).toBeNull();
  const fresh = await signIn(restored.app, "organizer@example.test");
  expect(await teams(restored.app, first.eventId, fresh)).toEqual(["First team"]);
  expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual({
    [laterWorkspace]: "https://later.example.test",
  });
  const after = await status(restored.app, first.eventId, fresh);
  expect(after.lastRestore?.backupId).toBe(created.backupId);
  expect(after.replacedRoots).toEqual([pending?.replaced]);
  expect(after.backups.map((b) => b.backupId)).toEqual([created.backupId]);
  // The same installation identity survives, so the stored backup still matches.
  expect(after.backups[0]?.release).toBe(release);
  const db = new Database(join(root, "demo", "auth.sqlite"), { readonly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM "session"').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

it("discards a staged restore and refuses to swap while a writer is active", async () => {
  const root = join(privateBase(), "data");
  const f = await seed(root);
  const created = await createBackup(f.app, f.eventId, f.admin);
  const restore = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/backups/${created.backupId}/restore`,
    headers: headers(f.admin),
    payload: { confirmed: true },
  });
  expect(restore.statusCode).toBe(200);
  expect(restore.json<{ restarting: boolean }>().restarting).toBe(false);
  // A running control-plane writer blocks the swap; nothing is renamed.
  const writer = acquireWriter(join(root));
  try {
    expect(() => applyPendingRestore(root)).toThrow(/active control-plane writer/);
  } finally {
    writer();
  }
  expect(existsSync(join(root, "demo", "state.sqlite"))).toBe(true);
  const staged = readPendingRestore(root)?.staged as string;
  const discard = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/backups/pending/discard`,
    headers: headers(f.admin),
    payload: { confirmed: true },
  });
  expect(discard.statusCode).toBe(200);
  expect(existsSync(staged)).toBe(false);
  expect(readPendingRestore(root)).toBeNull();
  expect(applyPendingRestore(root)).toBeNull();
  expect(await teams(f.app, f.eventId, f.admin)).toEqual(["First team"]);
});

it("captures consistent Git and SQLite copies without the writer lock, auth secret or sessions", async () => {
  const base = privateBase();
  const root = join(base, "data");
  const f = await seed(root);
  // A ref written outside the application must survive the mirror capture.
  const repo = join(root, "demo", "repos", `${f.teamId}.git`);
  execFileSync("git", [
    "--git-dir",
    repo,
    "update-ref",
    "refs/civic-spark/keep",
    "refs/heads/main",
  ]);
  writeFileSync(join(root, "demo", "auth-secret"), "local-signing-secret", { mode: 0o600 });
  const created = await createBackup(f.app, f.eventId, f.admin);
  const directory = backupDirectoryFor(root);
  const archive = join(
    directory,
    readdirSync(directory).find((n) => n.endsWith(created.backupId)) as string,
  );
  const stage = join(base, "unpacked");
  mkdirSync(stage, { mode: 0o700 });
  const { manifest } = await unpackArchive(archive, null, stage, () => {});
  expect(manifest.consistency).toBe("live-online-snapshot");
  expect(manifest.installation.id).toBe(
    JSON.parse(readFileSync(join(root, "installation.json"), "utf8")).id,
  );
  const data = join(stage, "data");
  const refs = execFileSync("git", [
    "--git-dir",
    join(data, "demo", "repos", `${f.teamId}.git`),
    "for-each-ref",
    "--format=%(refname)",
  ]).toString();
  expect(refs).toContain("refs/civic-spark/keep");
  expect(refs).toContain("refs/heads/main");
  expect(existsSync(join(data, "control-plane-writer.sqlite"))).toBe(false);
  expect(existsSync(join(data, "demo", "auth-secret"))).toBe(false);
  expect(existsSync(join(data, "demo", "auth.sqlite-wal"))).toBe(false);
  const db = new Database(join(data, "demo", "auth.sqlite"), { readonly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM "session"').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM "user"').get()).toEqual({ n: 2 });
  } finally {
    db.close();
  }
  expect(existsSync(join(stage, "operator", "receipt.json"))).toBe(true);
  expect(existsSync(join(stage, "operator", "secrets.json"))).toBe(false);
  expect(currentRelease({ CIVIC_SPARK_RELEASE: release })).toBe(release);
});

it("round-trips archive directories through the flat tar format and rejects foreign entries", async () => {
  const base = privateBase();
  const source = join(base, "archive");
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "manifest.enc"), Buffer.alloc(513, 1));
  writeFileSync(join(source, "FINALIZED"), "f".repeat(64));
  writeFileSync(join(source, "00000000.enc"), Buffer.alloc(0));
  writeFileSync(join(source, "00000001.enc"), Buffer.alloc(1024, 2));
  writeFileSync(join(source, "notes.txt"), "never exported");
  const chunks: Buffer[] = [];
  for await (const chunk of archiveTar(source)) chunks.push(chunk as Buffer);
  const tar = Buffer.concat(chunks);
  expect(tar.length).toBe(archiveTarSize(source));
  expect(tar.length % 512).toBe(0);
  const destination = join(base, "extracted");
  mkdirSync(destination, { mode: 0o700 });
  const names = await extractTar(Readable.from([tar]), destination, tar.length);
  expect(names.sort()).toEqual(["00000000.enc", "00000001.enc", "FINALIZED", "manifest.enc"]);
  for (const name of names)
    expect(readFileSync(join(destination, name))).toEqual(readFileSync(join(source, name)));
  const truncated = join(base, "truncated");
  mkdirSync(truncated, { mode: 0o700 });
  await expect(
    extractTar(Readable.from([tar.subarray(0, tar.length - 1024)]), truncated, tar.length),
  ).rejects.toThrow(/ended before/);
  const oversized = join(base, "oversized");
  mkdirSync(oversized, { mode: 0o700 });
  await expect(extractTar(Readable.from([tar]), oversized, 100)).rejects.toThrow(/exceeds/);
  const renamed = Buffer.from(tar);
  renamed.write("../evil.enc\0", 0, "utf8");
  const hostile = join(base, "hostile");
  mkdirSync(hostile, { mode: 0o700 });
  await expect(extractTar(Readable.from([renamed]), hostile, tar.length)).rejects.toThrow();
  expect(readdirSync(base).includes("evil.enc")).toBe(false);
});
