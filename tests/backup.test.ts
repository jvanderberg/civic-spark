import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { createAuthentication } from "../apps/server/src/auth.ts";
import { acquireWriter, validateDeployment } from "../apps/server/src/deployment.ts";
import {
  decryptFile,
  digest,
  type Entry,
  encryptFile,
  inventory,
  validateEntries,
} from "../packages/backup/src/archive.ts";
import {
  type CreateOptions,
  createBackup,
  type RestoreOptions,
  restoreBackup,
} from "../packages/backup/src/backup.ts";
import { verifyTree } from "../packages/backup/src/verify.ts";
import type { Identity } from "../packages/domain/src/access-types.ts";
import { EventService } from "../packages/domain/src/service.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { testIdentity } from "./auth-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function unwrap<T>(result: Result<T>) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const sql = (path: string, query: string) => {
  const db = new Database(path);
  try {
    return db.prepare(query).all();
  } finally {
    db.close();
  }
};
async function fixture(mode: "email" | "demo" | "prototype" = "demo") {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "civic-spark-backup-test-")));
  roots.push(base);
  chmodSync(base, 0o700);
  const root = join(base, "source");
  mkdirSync(root, { mode: 0o700 });
  const active = mode === "email" ? root : join(root, mode);
  mkdirSync(active, { recursive: true });
  const auth = await createAuthentication(
    active,
    "http://127.0.0.1:4310",
    { configured: true, async send() {} },
    mode === "demo" ? "demo" : mode === "prototype",
  );
  const first = await testIdentity(auth, "Backup Admin", mode !== "demo");
  const second = await testIdentity(auth, "Backup Member", mode !== "demo");
  const identities: Identity[] = [first, second].map(({ user }) =>
    mode === "demo"
      ? { ...user, authMode: "demo" as const, emailVerified: false as const }
      : { ...user, id: mode === "prototype" ? user.email : user.id, emailVerified: true as const },
  );
  const admin = identities[0] as Identity;
  const member = identities[1] as Identity;
  const service = new EventService(active);
  const event = unwrap(
    service.createEvent(admin, {
      name: "Recovery rehearsal",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 10,
      budget: 10,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(admin, event.id, "registration"));
  const project = unwrap(
    service.createProject(admin, event.id, {
      name: "Recovery project",
      brief: "A sufficiently detailed project description with **Markdown**.",
    }),
  );
  const created = unwrap(
    service.createTeam(member, { eventId: event.id, name: "Recovery team", projectId: project.id }),
  );
  const workspace = created.workspace;
  unwrap(service.setSprite(workspace.id, `civic-spark-${workspace.id}`, "ready", null, "ready"));
  const repo = join(active, "repos", `${created.team.id}.git`);
  execFileSync("git", ["--git-dir", repo, "update-ref", "refs/tags/recovery", "refs/heads/main"]);
  execFileSync("git", [
    "--git-dir",
    repo,
    "update-ref",
    "refs/civic-spark/preserved",
    "refs/heads/main",
  ]);
  service.close();
  auth.close();
  const authDb = new Database(join(active, "auth.sqlite"));
  authDb
    .prepare(
      'INSERT INTO "account" (id,accountId,providerId,userId,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
    )
    .run("recovery-account", first.user.id, "test-provider", first.user.id, Date.now(), Date.now());
  authDb
    .prepare(
      'INSERT INTO "verification" (id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
    )
    .run(
      "recovery-link",
      "test-only-login-link",
      "hashed-test-value",
      Date.now() + 600000,
      Date.now(),
      Date.now(),
    );
  authDb.close();
  // Lifecycle tables must survive without schema-specific projection or rewriting.
  const db = new Database(join(active, "access.sqlite"));
  db.exec(
    "CREATE TABLE event_execution(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE workspace_runtime(id TEXT PRIMARY KEY,body TEXT NOT NULL)",
  );
  db.prepare("INSERT INTO event_execution VALUES(?,?)").run(
    event.id,
    JSON.stringify({ paused: true, changedAt: "2026-09-16T00:00:00Z", generation: 4 }),
  );
  db.prepare("INSERT INTO workspace_runtime VALUES(?,?)").run(
    workspace.id,
    JSON.stringify({
      held: true,
      reason: "admin",
      lastUsedAt: null,
      stopState: "pending",
      stopError: null,
      stoppedAt: null,
    }),
  );
  db.close();
  writeFileSync(
    join(active, "preview-origins.json"),
    JSON.stringify({ [workspace.id]: "https://preview.example.test" }),
  );
  mkdirSync(join(active, "agent-integrations"));
  writeFileSync(
    join(active, "agent-integrations", "ticket.json"),
    '{"status":"resolving","owner":"private-test"}',
  );
  writeFileSync(join(active, `${workspace.id}.bundle`), "retained provisioning seed");
  writeFileSync(join(active, "unknown-future-state"), "Preserve unknown files too");
  writeFileSync(join(root, "empty-file"), "");
  const operator = join(base, "operator");
  mkdirSync(operator, { mode: 0o700 });
  for (const name of ["config.json", "receipt.json", "secrets.json"])
    writeFileSync(join(operator, name), JSON.stringify({ test: "PRIVATE-RECOVERY-SECRET", name }), {
      mode: 0o600,
    });
  const keyFile = join(base, "key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const options: CreateOptions = {
    dataRoot: root,
    operatorRoot: operator,
    destination: join(base, "archive"),
    keyFile,
    installation: {
      id: "isolated-test",
      authMode: mode,
      release: "a".repeat(40),
      origin: "http://127.0.0.1:4310",
      spriteOrg: "test-org",
      spriteApiOrigin: "https://api.sprites.dev",
    },
    coordinatedOffline: true,
    operatorFiles: {
      configuration: "config.json",
      receipt: "receipt.json",
      secrets: "secrets.json",
    },
  };
  const restore: RestoreOptions = {
    archive: options.destination,
    target: join(base, "restore"),
    keyFile,
    installation: options.installation,
  };
  return {
    base,
    root,
    active,
    options,
    restore,
    admin,
    member,
    event,
    workspace,
    repo,
    oldCookie: first.cookie,
  };
}

it.each(["email", "demo", "prototype"] as const)(
  "round trips complete %s state, Git refs/objects, credentials and lifecycle; revokes sessions; fences restart",
  async (mode) => {
    const f = await fixture(mode);
    const before = verifyTree(f.root, mode);
    const result = await createBackup(f.options);
    expect(result).toMatchObject({
      users: 2,
      teams: 1,
      projects: 2,
      previewBindings: 1,
      spritePrivateState: "excluded-disposable",
    });
    await expect(
      restoreBackup({ ...f.restore, target: join(f.base, "dry-run") }, true),
    ).resolves.toMatchObject({ validated: true, dryRun: true });
    expect(existsSync(join(f.base, "dry-run"))).toBe(false);
    await restoreBackup(f.restore);
    const restoredRoot = join(f.restore.target, "data");
    const restored = mode === "email" ? restoredRoot : join(restoredRoot, mode);
    expect(verifyTree(restoredRoot, mode)).toEqual(before);
    for (const name of [
      "access.sqlite",
      "state.sqlite",
      "preview-origins.json",
      "unknown-future-state",
      `${f.workspace.id}.bundle`,
      "agent-integrations/ticket.json",
    ])
      expect(readFileSync(join(restored, name))).toEqual(readFileSync(join(f.active, name)));
    expect(sql(join(restored, "auth.sqlite"), 'SELECT * FROM "user"')).toEqual(
      sql(join(f.active, "auth.sqlite"), 'SELECT * FROM "user"'),
    );
    expect(sql(join(restored, "auth.sqlite"), 'SELECT * FROM "account"')).toEqual(
      sql(join(f.active, "auth.sqlite"), 'SELECT * FROM "account"'),
    );
    expect(sql(join(restored, "auth.sqlite"), 'SELECT * FROM "session"')).toEqual([]);
    expect(sql(join(restored, "auth.sqlite"), 'SELECT * FROM "verification"')).toEqual([]);
    expect(sql(join(f.active, "auth.sqlite"), 'SELECT * FROM "verification"')).toHaveLength(1);
    expect(sql(join(f.active, "auth.sqlite"), 'SELECT * FROM "session"')).toHaveLength(2);
    expect(sql(join(restored, "access.sqlite"), "SELECT * FROM event_execution")).toEqual(
      sql(join(f.active, "access.sqlite"), "SELECT * FROM event_execution"),
    );
    for (const entry of inventory(f.options.destination, "archive")) {
      const path = join(f.options.destination, entry.path.slice(8));
      expect(statSync(path).mode & 0o077).toBe(0);
      if (entry.kind === "file")
        expect(readFileSync(path).includes(Buffer.from("PRIVATE-RECOVERY-SECRET"))).toBe(false);
    }
    expect(readFileSync(join(f.restore.target, "operator/secrets.json"))).toEqual(
      readFileSync(join(f.options.operatorRoot, "secrets.json")),
    );
    expect(() => validateDeployment(restoredRoot, f.options.installation.origin, mode, {})).toThrow(
      "fenced",
    );
    await expect(
      createApp(restoredRoot, false, f.options.installation.origin, undefined, mode),
    ).rejects.toThrow("fenced");
    const secondTarget = join(f.base, "restore-again");
    await restoreBackup({ ...f.restore, target: secondTarget });
    expect(verifyTree(join(secondTarget, "data"), mode)).toEqual(before);
  },
  30000,
);

it("refuses an active writer, releases its lock after failure, and never replaces a destination", async () => {
  const f = await fixture();
  const release = acquireWriter(f.root);
  await expect(createBackup(f.options)).rejects.toThrow("active");
  release();
  const bad = { ...f.options, operatorFiles: { ...f.options.operatorFiles, secrets: "absent" } };
  await expect(createBackup(bad)).rejects.toThrow();
  await createBackup(f.options);
  await expect(createBackup(f.options)).rejects.toThrow("exists");
  mkdirSync(f.restore.target);
  writeFileSync(join(f.restore.target, "sentinel"), "keep");
  await expect(restoreBackup(f.restore)).rejects.toThrow("exists");
  expect(readFileSync(join(f.restore.target, "sentinel"), "utf8")).toBe("keep");
});
it("rejects changed modes, release, installation, wrong keys, partial and corrupt artifacts with no published restore", async () => {
  const f = await fixture();
  await createBackup(f.options);
  for (const installation of [
    { ...f.restore.installation, authMode: "email" as const },
    { ...f.restore.installation, release: "b".repeat(40) },
    { ...f.restore.installation, id: "different" },
  ])
    await expect(restoreBackup({ ...f.restore, installation })).rejects.toThrow("mismatch");
  const wrong = join(f.base, "wrong-key");
  writeFileSync(wrong, randomBytes(32), { mode: 0o600 });
  await expect(restoreBackup({ ...f.restore, keyFile: wrong })).rejects.toThrow();
  const partial = join(f.base, "partial");
  cpSync(f.options.destination, partial, { recursive: true });
  chmodSync(partial, 0o700);
  rmSync(join(partial, "FINALIZED"));
  await expect(restoreBackup({ ...f.restore, archive: partial })).rejects.toThrow("partial");
  const file = join(
    f.options.destination,
    readdirSync(f.options.destination).find(
      (n) => n.endsWith(".enc") && n !== "manifest.enc",
    ) as string,
  );
  const original = readFileSync(file);
  const corrupted = Buffer.from(original);
  corrupted[22] = (corrupted[22] ?? 0) ^ 1;
  writeFileSync(file, corrupted);
  await expect(restoreBackup(f.restore)).rejects.toThrow();
  expect(existsSync(f.restore.target)).toBe(false);
  expect(readdirSync(f.base).filter((n) => n.startsWith(".civic-spark-restore-partial"))).toEqual(
    [],
  );
  writeFileSync(file, original);
  await restoreBackup(f.restore);
});
it("validates archive traversal, duplicates, link parents, self-contained Git and inert participant configuration", async () => {
  const entry: Entry = { path: "data", kind: "directory", size: 0, mode: 0o700 };
  expect(() => validateEntries([entry, { ...entry, path: "data/../../escape" }])).toThrow("Unsafe");
  expect(() => validateEntries([entry, entry])).toThrow("Duplicate");
  expect(() =>
    validateEntries([
      entry,
      { ...entry, path: "data/link", kind: "symlink", target: "/tmp" },
      { ...entry, path: "data/link/write" },
    ]),
  ).toThrow("parent");
  const f = await fixture();
  const malicious = join(f.base, "must-not-exist");
  writeFileSync(
    join(f.repo, "config"),
    `[core]\n bare = true\n hooksPath = ${f.base}\n[include]\n path = /missing/operator/config\n[alias]\n fsck = !touch ${malicious}\n`,
  );
  await createBackup(f.options);
  await restoreBackup(f.restore);
  expect(existsSync(malicious)).toBe(false);
  writeFileSync(join(f.repo, "objects/info/alternates"), "/outside/object-store\n");
  await expect(
    createBackup({ ...f.options, destination: join(f.base, "invalid") }),
  ).rejects.toThrow("Linked Git");
});
it("preserves opaque symlinks without following them and rejects authoritative links", async () => {
  const f = await fixture();
  symlinkSync("/never/read/private-target", join(f.root, "opaque-link"));
  await createBackup(f.options);
  await restoreBackup(f.restore);
  rmSync(join(f.active, "state.sqlite"));
  symlinkSync("/never/read/database", join(f.active, "state.sqlite"));
  await expect(
    createBackup({ ...f.options, destination: join(f.base, "invalid") }),
  ).rejects.toThrow("Linked authoritative");
});
it("authenticates even a modified manifest before accepting restored paths", async () => {
  const f = await fixture();
  await createBackup(f.options);
  const plain = join(f.base, "manifest.json");
  const key = readFileSync(f.options.keyFile);
  await decryptFile(
    join(f.options.destination, "manifest.enc"),
    plain,
    key,
    "civic-spark-manifest-v1",
  );
  const manifest = JSON.parse(readFileSync(plain, "utf8"));
  manifest.entries[0].path = "../escape";
  writeFileSync(plain, JSON.stringify(manifest));
  rmSync(join(f.options.destination, "manifest.enc"));
  await encryptFile(
    plain,
    join(f.options.destination, "manifest.enc"),
    key,
    "civic-spark-manifest-v1",
  );
  writeFileSync(
    join(f.options.destination, "FINALIZED"),
    digest(readFileSync(join(f.options.destination, "manifest.enc"))),
  );
  await expect(restoreBackup(f.restore)).rejects.toThrow("Unsafe");
  expect(existsSync(f.restore.target)).toBe(false);
});

it("preserves committed WAL-only lifecycle rows and all shared repository object bytes", async () => {
  const f = await fixture();
  const db = new Database(join(f.active, "access.sqlite"));
  db.pragma("journal_mode=WAL");
  db.pragma("wal_autocheckpoint=0");
  db.prepare("UPDATE workspace_runtime SET body=?").run(
    JSON.stringify({ held: true, stopState: "failed", futureField: "WAL-only recovery state" }),
  );
  try {
    expect(statSync(join(f.active, "access.sqlite-wal")).size).toBeGreaterThan(0);
    await createBackup(f.options);
    await restoreBackup(f.restore);
    expect(
      sql(join(f.restore.target, "data/demo/access.sqlite"), "SELECT * FROM workspace_runtime"),
    ).toEqual(db.prepare("SELECT * FROM workspace_runtime").all());
    const targetRepo = join(f.restore.target, "data/demo/repos", `${f.workspace.teamId}.git`);
    for (const entry of inventory(f.repo, "repo"))
      if (entry.kind === "file")
        expect(readFileSync(join(targetRepo, entry.path.slice(5)))).toEqual(
          readFileSync(join(f.repo, entry.path.slice(5))),
        );
  } finally {
    db.close();
  }
});

it("recovers the OS writer lock after a killed backup and refuses its partial output", async () => {
  const { spawn } = await import("node:child_process");
  const f = await fixture();
  writeFileSync(join(f.root, "large-test-file"), Buffer.alloc(8 * 1024 * 1024, 7));
  const job = join(f.base, "job.json");
  writeFileSync(job, JSON.stringify(f.options), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/backup.ts", "create", job], {
    stdio: "ignore",
  });
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  let partial: string | undefined;
  try {
    const deadline = Date.now() + 15000;
    while (!partial && Date.now() < deadline && child.exitCode === null) {
      partial = readdirSync(f.base).find((n) => n.startsWith(".civic-spark-backup-partial-"));
      if (!partial) await new Promise((r) => setTimeout(r, 5));
    }
    expect(partial).toBeDefined();
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  expect(existsSync(f.options.destination)).toBe(false);
  await expect(
    restoreBackup({ ...f.restore, archive: join(f.base, partial as string) }),
  ).rejects.toThrow("partial");
  await createBackup(f.options);
  await restoreBackup(f.restore);
}, 30000);

it("explicitly reconciles missing Sprites using authenticated metadata only, preserves reservations and origin ledger, then permits startup", async () => {
  const { resumeRestore, recoveryPermission, completeRecovery } = await import(
    "../packages/backup/src/recovery.ts"
  );
  const f = await fixture();
  await createBackup(f.options);
  const result = await restoreBackup(f.restore);
  const recovered = join(f.restore.target, "data");
  const futureId = "00000000-0000-4000-8000-000000000002";
  const options = {
    target: f.restore.target,
    installation: f.options.installation,
    backupId: result.backupId,
    spriteOrg: "test-org",
    spriteApiOrigin: "https://api.sprites.dev",
    previewBindings: {
      [f.workspace.id]: "https://preview.example.test",
      [futureId]: "https://later.example.test",
    },
    sourceWriterFenced: true as const,
    sharedGitReviewed: true as const,
    previewLedgerComplete: true as const,
    providerActivityReviewed: true as const,
    operatorCredentialsReviewed: true as const,
  };
  const request = vi.fn<typeof fetch>(async (url) =>
    String(url).includes("?")
      ? Response.json({ name: "test-org", sprites: [] })
      : new Response(null, { status: 404 }),
  );
  const wrong = {
    ...options,
    previewBindings: { [f.workspace.id]: "https://recycled.example.test" },
  };
  await expect(resumeRestore(wrong, "test-org/id/token/value", request)).rejects.toThrow(
    "reassigned",
  );
  expect(request).not.toHaveBeenCalled();
  await expect(resumeRestore(options, "test-org/id/token/value", request)).resolves.toMatchObject({
    resumed: true,
    missingSprites: 1,
    cloudMutations: 0,
  });
  expect(request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  expect(existsSync(join(recovered, ".civic-spark-recovery.json"))).toBe(false);
  const mode = join(recovered, "demo");
  expect(
    recoveryPermission(mode, f.workspace.id, `civic-spark-${f.workspace.id}`, "test-org"),
  ).toMatchObject({ httpStatus: 404 });
  expect(() =>
    recoveryPermission(mode, f.workspace.id, `civic-spark-${f.workspace.id}`, "other-org"),
  ).toThrow("mismatch");
  expect(JSON.parse(readFileSync(join(mode, "preview-origins.json"), "utf8"))).toEqual(
    options.previewBindings,
  );
  const app = await createApp(
    recovered,
    false,
    f.options.installation.origin,
    { configured: true, async send() {} },
    "demo",
  );
  try {
    const priorSession = await app.app.inject({
      url: "/api/session",
      headers: { cookie: f.oldCookie },
    });
    expect(priorSession.json().user).toBeNull();
    expect(app.service.provisioningRecords()[0]?.spriteName).toBe(`civic-spark-${f.workspace.id}`);
  } finally {
    await app.app.close();
  }
  completeRecovery(mode, f.workspace.id, `civic-spark-${f.workspace.id}`);
  expect(
    recoveryPermission(mode, f.workspace.id, `civic-spark-${f.workspace.id}`, "test-org"),
  ).toBeNull();
}, 30000);

it.each([401, 403, 429, 500])(
  "keeps restore fenced and issues no recovery permission after provider %s",
  async (status) => {
    const { resumeRestore } = await import("../packages/backup/src/recovery.ts");
    const f = await fixture();
    await createBackup(f.options);
    const result = await restoreBackup(f.restore);
    const options = {
      target: f.restore.target,
      installation: f.options.installation,
      backupId: result.backupId,
      spriteOrg: "test-org",
      spriteApiOrigin: "https://api.sprites.dev",
      previewBindings: { [f.workspace.id]: "https://preview.example.test" },
      sourceWriterFenced: true as const,
      sharedGitReviewed: true as const,
      previewLedgerComplete: true as const,
      providerActivityReviewed: true as const,
      operatorCredentialsReviewed: true as const,
    };
    const request = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("?")
        ? Response.json({ name: "test-org", sprites: [] })
        : new Response(null, { status }),
    );
    await expect(resumeRestore(options, "test-org/id/token/value", request)).rejects.toThrow(
      "unknown",
    );
    expect(existsSync(join(f.restore.target, "data/.civic-spark-recovery.json"))).toBe(true);
    expect(
      existsSync(join(f.restore.target, "data/demo/.civic-spark-recovery-resources.json")),
    ).toBe(false);
  },
);

it("provider helper accepts only authenticated matching identities and distinguishes missing from errors", async () => {
  const { inspectRecoverySprite } = await import("../packages/backup/src/recovery.ts");
  const name = "civic-spark-00000000-0000-4000-8000-000000000001";
  const present = vi.fn<typeof fetch>(async (url) =>
    String(url).includes("?")
      ? Response.json({ name: "test-org", sprites: [] })
      : Response.json({ id: "opaque-provider-id", name, organization: "test-org" }),
  );
  await expect(
    inspectRecoverySprite(
      name,
      "test-org",
      "https://api.sprites.dev",
      "test-org/id/token/value",
      present,
    ),
  ).resolves.toBe("present");
  const wrong = vi.fn<typeof fetch>(async () => Response.json({ name: "wrong-org", sprites: [] }));
  await expect(
    inspectRecoverySprite(
      name,
      "test-org",
      "https://api.sprites.dev",
      "test-org/id/token/value",
      wrong,
    ),
  ).rejects.toThrow("organization mismatch");
  const disconnected = vi.fn<typeof fetch>(async () => {
    throw new Error("test network outage");
  });
  await expect(
    inspectRecoverySprite(
      name,
      "test-org",
      "https://api.sprites.dev",
      "test-org/id/token/value",
      disconnected,
    ),
  ).rejects.toThrow("unknown");
});

it("retention refuses unverified replicas then prunes only validated conventional finalized archives", async () => {
  const { pruneBackups } = await import("../packages/backup/src/backup.ts");
  const f = await fixture();
  await createBackup(f.options);
  const local = join(f.base, "retention");
  const remote = join(f.base, "replicas");
  mkdirSync(local, { mode: 0o700 });
  mkdirSync(remote, { mode: 0o700 });
  for (const name of ["backup-2026-09-15T000000Z-aaaaaaaa", "backup-2026-09-16T000000Z-bbbbbbbb"]) {
    cpSync(f.options.destination, join(local, name), { recursive: true });
    chmodSync(join(local, name), 0o700);
    cpSync(f.options.destination, join(remote, name), { recursive: true });
    chmodSync(join(remote, name), 0o700);
  }
  mkdirSync(join(local, "unrecognized"));
  mkdirSync(join(local, ".civic-spark-backup-partial-stale"));
  const options = {
    directory: local,
    replicaDirectory: remote,
    keep: 1,
    keyFile: f.options.keyFile,
    installation: f.options.installation,
  };
  const missing = join(remote, "backup-2026-09-15T000000Z-aaaaaaaa", "FINALIZED");
  const data = readFileSync(missing);
  rmSync(missing);
  await expect(pruneBackups(options)).rejects.toThrow("partial");
  expect(readdirSync(local).filter((n) => n.startsWith("backup-"))).toHaveLength(2);
  writeFileSync(missing, data, { mode: 0o600 });
  await expect(pruneBackups(options)).resolves.toMatchObject({ pruned: 1, keep: 1 });
  expect(existsSync(join(local, "unrecognized"))).toBe(true);
  expect(existsSync(join(local, ".civic-spark-backup-partial-stale"))).toBe(true);
  expect(readdirSync(remote)).toHaveLength(2);
}, 30000);

it("backs up and resumes an empty installation without cloud credentials or calls", async () => {
  const { resumeRestore } = await import("../packages/backup/src/recovery.ts");
  const f = await fixture();
  const empty = join(f.base, "empty-source");
  const app = await createApp(
    empty,
    false,
    "http://127.0.0.1:4310",
    { configured: true, async send() {} },
    "email",
  );
  await app.app.close();
  const installation = { ...f.options.installation, authMode: "email" as const, spriteOrg: null };
  await createBackup({ ...f.options, dataRoot: empty, installation });
  const result = await restoreBackup({ ...f.restore, installation });
  const request = vi.fn<typeof fetch>();
  await expect(
    resumeRestore(
      {
        target: f.restore.target,
        installation,
        backupId: result.backupId,
        spriteOrg: null,
        spriteApiOrigin: "https://api.sprites.dev",
        previewBindings: {},
        sourceWriterFenced: true,
        sharedGitReviewed: true,
        previewLedgerComplete: true,
        providerActivityReviewed: true,
        operatorCredentialsReviewed: true,
      },
      undefined,
      request,
    ),
  ).resolves.toMatchObject({ resumed: true, missingSprites: 0 });
  expect(request).not.toHaveBeenCalled();
});
