import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
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
import { pipeline } from "node:stream/promises";
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
  exportBackup,
  lastRestorePath,
  pendingRestorePath,
  type RestoreReport,
  readPendingRestore,
} from "../packages/backup/src/live.ts";
import { unzipFile, zipDirectory } from "../packages/backup/src/zip.ts";
import type { PortalState, SessionView } from "../packages/domain/src/access-types.ts";
import type { Result } from "../packages/domain/src/types.ts";

const origin = "http://127.0.0.1:4310";
// Wrap (not replace) the blocking calls so tests can prove backups never use them for Git.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
    spawnSync: vi.fn(actual.spawnSync),
  };
});
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
  expect(download.headers["content-type"]).toBe("application/zip");
  expect(download.headers["content-disposition"]).toMatch(/civic-spark-backup-\d{8}T\d{6}Z\.zip/);
  // The ZIP holds the real files under one folder, readable with any archive tool.
  const zipPath = join(base, "download.zip");
  writeFileSync(zipPath, download.rawPayload);
  const extracted = join(base, "extracted");
  mkdirSync(extracted, { mode: 0o700 });
  const names = await unzipFile(zipPath, extracted);
  expect(names).toContain("manifest.json");
  expect(names).toContain("data/demo/state.sqlite");
  expect(names.some((name) => name.startsWith("data/demo/repos/"))).toBe(true);
  expect(names).toContain("operator/receipt.json");
  expect(JSON.parse(readFileSync(join(extracted, "manifest.json"), "utf8")).backupId).toBe(
    created.backupId,
  );
  expect(readdirSync(directory).filter((name) => name.startsWith("."))).toEqual([]);

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
  ).toBe(400);

  const upload = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/backups/upload`,
    headers: { ...headers(f.admin), "content-type": "application/zip" },
    payload: download.rawPayload,
  });
  expect(upload.statusCode, upload.body).toBe(200);
  expect(upload.json<{ backupId: string; teams: number }>()).toMatchObject({
    backupId: created.backupId,
    teams: 1,
  });
  const again = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/backups/upload`,
    headers: { ...headers(f.admin), "content-type": "application/zip" },
    payload: download.rawPayload,
  });
  expect(again.statusCode).toBe(400);
  expect(again.json<{ error: string }>().error).toContain("already stored");
  const garbage = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/backups/upload`,
    headers: { ...headers(f.admin), "content-type": "application/zip" },
    payload: Buffer.from("not a zip archive at all, but long enough to have a tail"),
  });
  expect(garbage.statusCode).toBe(400);
  expect(garbage.json<{ error: string }>().error).toContain("not a ZIP");
  // Streams larger than the JSON body limit are accepted and judged on their content.
  const big = join(privateBase(), "big");
  mkdirSync(join(big, "notes"), { recursive: true, mode: 0o700 });
  writeFileSync(join(big, "notes", "large.bin"), Buffer.alloc(3 * 1024 * 1024, 9));
  const bigChunks: Buffer[] = [];
  for await (const chunk of zipDirectory(big, "folder")) bigChunks.push(chunk as Buffer);
  const oversized = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.eventId}/backups/upload`,
    headers: { ...headers(f.admin), "content-type": "application/zip" },
    payload: Buffer.concat(bigChunks),
  });
  expect(oversized.statusCode).toBe(400);
  expect(oversized.json<{ error: string }>().error).toContain("no data folder");
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
    headers: { ...headers(other.admin), "content-type": "application/zip" },
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

it("round-trips directories through ZIP, strips a shared top folder and rejects unsafe names", async () => {
  const base = privateBase();
  const source = join(base, "tree");
  mkdirSync(join(source, "data", "nested"), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, "manifest.json"), '{"ok":true}');
  writeFileSync(join(source, "data", "empty"), Buffer.alloc(0));
  writeFileSync(join(source, "data", "nested", "blob.bin"), Buffer.alloc(200000, 5));
  writeFileSync(join(source, "data", "text.txt"), "héllo wörld\n".repeat(1000));
  const chunks: Buffer[] = [];
  for await (const chunk of zipDirectory(source, "civic-spark-backup-test"))
    chunks.push(chunk as Buffer);
  const zipPath = join(base, "round.zip");
  writeFileSync(zipPath, Buffer.concat(chunks));
  // A standard tool reads it too.
  const listing = execFileSync("unzip", ["-l", zipPath]).toString();
  expect(listing).toContain("civic-spark-backup-test/data/nested/blob.bin");
  const destination = join(base, "out");
  mkdirSync(destination, { mode: 0o700 });
  const names = await unzipFile(zipPath, destination);
  expect(names.sort()).toEqual([
    "data/empty",
    "data/nested/blob.bin",
    "data/text.txt",
    "manifest.json",
  ]);
  for (const name of names)
    expect(readFileSync(join(destination, name))).toEqual(readFileSync(join(source, name)));
  // A ZIP made by another tool, with Finder metadata, extracts the same way.
  const external = join(base, "external.zip");
  mkdirSync(join(source, "__MACOSX"), { mode: 0o700 });
  writeFileSync(join(source, "__MACOSX", "._manifest.json"), "resource fork");
  writeFileSync(join(source, ".DS_Store"), "finder");
  execFileSync("zip", ["-qr", external, "."], { cwd: source });
  const fromTool = join(base, "from-tool");
  mkdirSync(fromTool, { mode: 0o700 });
  expect((await unzipFile(external, fromTool)).sort()).toEqual(names.sort());
  // Names that escape the destination are refused before anything is written.
  const hostile = join(base, "hostile.zip");
  const escaping: Buffer[] = [];
  for await (const chunk of zipDirectory(join(source, "data"), ".."))
    escaping.push(chunk as Buffer);
  writeFileSync(hostile, Buffer.concat(escaping));
  const target = join(base, "hostile-out");
  mkdirSync(target, { mode: 0o700 });
  await expect(unzipFile(hostile, target)).rejects.toThrow(/Unsafe/);
  expect(readdirSync(target)).toEqual([]);
  const truncated = join(base, "truncated.zip");
  const whole = Buffer.concat(chunks);
  writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length / 2)));
  await expect(unzipFile(truncated, join(base, "nowhere"))).rejects.toThrow(/ZIP/);
});

it("never runs Git synchronously while backups of many repositories are created and downloaded", async () => {
  const base = privateBase();
  const f = await seed(join(base, "data"));
  for (let index = 0; index < 12; index++) {
    const team = await f.app.inject({
      method: "POST",
      url: "/api/teams",
      headers: headers(f.member),
      payload: { eventId: f.eventId, name: `Extra team ${index}`, projectId: f.projectId },
    });
    expect(team.statusCode).toBe(200);
  }
  // Synchronous Git blocked the whole server once per repository (41 s on the live site).
  vi.mocked(execFileSync).mockClear();
  vi.mocked(spawnSync).mockClear();
  const created = await createBackup(f.app, f.eventId, f.admin);
  expect(created.teams).toBe(13);
  const download = await f.app.inject({
    url: `/api/events/${f.eventId}/backups/${created.backupId}/download`,
    headers: headers(f.admin),
  });
  expect(download.statusCode).toBe(200);
  expect(download.headers["content-disposition"]).toMatch(/civic-spark-backup-.*\.zip/);
  const blockingGit = [
    ...vi.mocked(execFileSync).mock.calls,
    ...vi.mocked(spawnSync).mock.calls,
  ].filter(([command]) => command === "git");
  expect(blockingGit).toEqual([]);
}, 120000);

it("streams downloads without the backup lock and refuses to delete a backup mid-download", async () => {
  const base = privateBase();
  const root = join(base, "data");
  const f = await seed(root);
  const created = await createBackup(f.app, f.eventId, f.admin);
  const url = `/api/events/${f.eventId}/backups/${created.backupId}/download`;
  // Hold a download open without reading it, as a slow browser would.
  const open = await f.app.inject({ url, headers: headers(f.admin), payloadAsStream: true });
  expect(open.statusCode).toBe(200);
  // Nothing was unpacked to disk to produce it.
  expect(readdirSync(backupDirectoryFor(root)).filter((name) => name.startsWith("."))).toEqual([]);
  // Other downloads, listing and new backups proceed meanwhile.
  expect((await f.app.inject({ url, headers: headers(f.admin) })).statusCode).toBe(200);
  expect((await status(f.app, f.eventId, f.admin)).backups).toHaveLength(1);
  expect((await createBackup(f.app, f.eventId, f.admin)).teams).toBe(1);
  const deleting = await f.app.inject({
    method: "DELETE",
    url: `/api/events/${f.eventId}/backups/${created.backupId}`,
    headers: headers(f.admin),
    payload: { confirmed: true },
  });
  expect(deleting.statusCode).toBe(409);
  expect(deleting.json().error).toBe(
    "This backup is being downloaded. Delete it after the download finishes.",
  );
  const zipPath = join(base, "streamed.zip");
  await pipeline(open.stream(), createWriteStream(zipPath));
  const extracted = join(base, "streamed");
  mkdirSync(extracted, { mode: 0o700 });
  expect(await unzipFile(zipPath, extracted)).toContain("data/demo/state.sqlite");
  const deleted = await f.app.inject({
    method: "DELETE",
    url: `/api/events/${f.eventId}/backups/${created.backupId}`,
    headers: headers(f.admin),
    payload: { confirmed: true },
  });
  expect(deleted.statusCode).toBe(200);
});

it("aborts a download when a stored file no longer matches its checksum", async () => {
  const base = privateBase();
  const root = join(base, "data");
  const f = await seed(root);
  const created = await createBackup(f.app, f.eventId, f.admin);
  const directory = backupDirectoryFor(root);
  const archive = join(directory, readdirSync(directory)[0] as string);
  const blob = readdirSync(archive)
    .filter((name) => /^\d{8}\.enc$/.test(name))
    .map((name) => join(archive, name))
    .find((path) => readFileSync(path).length > 64) as string;
  const bytes = readFileSync(blob);
  bytes[30] = (bytes[30] ?? 0) ^ 0xff;
  writeFileSync(blob, bytes);
  const { stream } = await exportBackup(directory, created.backupId);
  await expect(pipeline(stream, createWriteStream(join(base, "broken.zip")))).rejects.toThrow(
    "checksum mismatch",
  );
});
