import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import Database from "better-sqlite3";
import { accessStateSchema } from "../../domain/src/access-types.ts";
import { stateSchema } from "../../domain/src/types.ts";
import { inventory } from "./archive.ts";

export function modeRoot(root: string, mode: "email" | "demo" | "prototype") {
  return mode === "email" ? root : join(root, mode);
}
export function database(path: string, writable = false) {
  const db = new Database(path, { readonly: !writable, fileMustExist: true });
  db.pragma("trusted_schema = OFF");
  return db;
}
function sqliteCheck(path: string) {
  const db = database(path);
  try {
    if (
      db.pragma("integrity_check", { simple: true }) !== "ok" ||
      (db.pragma("foreign_key_check") as unknown[]).length !== 0
    )
      throw new Error("SQLite integrity check failed");
  } finally {
    db.close();
  }
}
export function stateInventory(root: string, mode: "email" | "demo" | "prototype") {
  const active = modeRoot(root, mode);
  for (const name of ["auth.sqlite", "access.sqlite", "state.sqlite"])
    if (!existsSync(join(active, name))) throw new Error("Required management database missing");
  const access = database(join(active, "access.sqlite"));
  const state = database(join(active, "state.sqlite"));
  const auth = database(join(active, "auth.sqlite"));
  try {
    const accessRow = access.prepare("SELECT body FROM access_state WHERE id=1").get() as
      | { body: string }
      | undefined;
    const stateRow = state.prepare("SELECT body FROM state WHERE id=1").get() as
      | { body: string }
      | undefined;
    const a = accessStateSchema.parse(
      accessRow
        ? JSON.parse(accessRow.body)
        : { version: 1, users: [], eventMembers: [], memberships: [] },
    );
    const s = stateSchema.parse(
      stateRow
        ? JSON.parse(stateRow.body)
        : { version: 1, events: [], teams: [], participants: [], contributions: [], activity: [] },
    );
    const users = auth.prepare('SELECT id,email FROM "user"').all() as {
      id: string;
      email: string;
    }[];
    const authIds = new Set(
      users.map((u) => (mode === "prototype" ? u.email.toLowerCase() : u.id)),
    );
    const userIds = new Set(a.users.map((u) => u.id));
    const events = new Set(s.events.map((e) => e.id));
    const teams = new Set(s.teams.map((t) => t.id));
    const reservedNames = s.participants.flatMap((p) => (p.spriteName ? [p.spriteName] : []));
    if (new Set(reservedNames).size !== reservedNames.length)
      throw new Error("Duplicate Sprite reservation");
    if (
      a.users.some((u) => !authIds.has(u.id)) ||
      a.eventMembers.some((m) => !events.has(m.eventId) || !userIds.has(m.userId)) ||
      a.memberships.some(
        (m) => !events.has(m.eventId) || !teams.has(m.teamId) || !userIds.has(m.userId),
      ) ||
      s.teams.some((t) => !events.has(t.eventId)) ||
      s.participants.some((p) => !teams.has(p.teamId))
    )
      throw new Error("Management identity or ownership associations are inconsistent");
    for (const team of s.teams) {
      if (
        !/^[a-f0-9-]{36}$/.test(team.id) ||
        !existsSync(join(active, "repos", `${team.id}.git`, "HEAD"))
      )
        throw new Error("Shared team repository missing");
    }
    const bindingsPath = join(active, "preview-origins.json");
    const bindings: unknown = existsSync(bindingsPath)
      ? JSON.parse(readFileSync(bindingsPath, "utf8"))
      : {};
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings))
      throw new Error("Invalid preview bindings");
    const hosts = new Set<string>();
    for (const [id, origin] of Object.entries(bindings)) {
      if (!/^[a-f0-9-]{36}$/.test(id) || typeof origin !== "string")
        throw new Error("Invalid preview binding");
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.origin !== origin || hosts.has(url.hostname))
        throw new Error("Preview binding collision");
      hosts.add(url.hostname);
    }
    return {
      users: users.length,
      eventUsers: a.users.length,
      events: s.events.length,
      teams: s.teams.length,
      memberships: a.memberships.length,
      projects: s.events.reduce((n, e) => n + e.projects.length, 0),
      workspaces: s.participants.length,
      previewBindings: hosts.size,
      reservations: s.participants
        .filter((p) => p.spriteName)
        .map((p) => ({
          workspaceId: p.id,
          spriteName: p.spriteName as string,
          status: p.spriteStatus,
        })),
    };
  } finally {
    access.close();
    state.close();
    auth.close();
  }
}

// Run Git only against a constructed inert object store. Never read backed-up config,
// hooks, attributes, filters, external alternates or commands from participant files.
function verifyRepository(path: string) {
  const paths = inventory(path, "repo");
  if (
    paths.some((p) => p.kind === "symlink" || p.path.endsWith(".promisor")) ||
    existsSync(join(path, "objects/info/alternates")) ||
    existsSync(join(path, "objects/info/http-alternates"))
  )
    throw new Error("Linked Git storage requires a self-contained backup before proceeding");
  const temp = mkdtempSync(join(tmpdir(), "civic-spark-git-verify-"));
  try {
    for (const name of ["objects", "refs", "HEAD", "packed-refs", "shallow"])
      if (existsSync(join(path, name)))
        cpSync(join(path, name), join(temp, name), { recursive: true });
    const env = {
      PATH: process.env.PATH,
      HOME: temp,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    };
    const run = (args: string[]) =>
      execFileSync("git", ["--git-dir", temp, "-c", "core.hooksPath=/dev/null", ...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      }).toString();
    try {
      run(["fsck", "--full", "--strict", "--no-reflogs"]);
      return {
        head: readFileSync(join(temp, "HEAD"), "utf8"),
        refs: run(["for-each-ref", "--format=%(refname) %(objectname)"]),
      };
    } catch {
      throw new Error("Git object/ref integrity check failed");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
export function verifyTree(root: string, mode: "email" | "demo" | "prototype") {
  const entries = inventory(root, "data");
  // Reject authoritative links before opening any SQLite file or resolving repository paths.
  for (const entry of entries) {
    if (
      entry.kind === "symlink" &&
      (/\.sqlite(?:-|$)/.test(entry.path) ||
        /\/(repos|demo|prototype)(\/|$)/.test(entry.path) ||
        entry.path.endsWith("/preview-origins.json") ||
        entry.path.endsWith("/auth-secret"))
    )
      throw new Error("Linked authoritative state is unsupported");
  }
  const repos = new Set<string>();
  for (const entry of entries) {
    const path = join(root, entry.path.slice(5));
    if (
      entry.kind === "file" &&
      /^data\/(?:demo\/|prototype\/)?(?:auth|access|state)\.sqlite$/.test(entry.path)
    )
      sqliteCheck(path);
    if (entry.kind === "file" && entry.path.endsWith("/.git"))
      throw new Error("External Git worktree references are unsupported");
    if (
      entry.kind === "file" &&
      entry.path.endsWith("/HEAD") &&
      existsSync(join(dirname(path), "objects"))
    )
      repos.add(dirname(path));
  }
  const repositories = [...repos]
    .sort()
    .map((path) => ({ path: relative(root, path), ...verifyRepository(path) }));
  // Never open a DB, config or repository through a symlink.
  for (const entry of entries) {
    if (
      entry.kind === "symlink" &&
      (/\.sqlite(?:-|$)/.test(entry.path) || /\/(repos|demo|prototype)$/.test(entry.path))
    )
      throw new Error("Linked authoritative state is unsupported");
  }
  return { ...stateInventory(root, mode), repositories };
}
export function invalidateAuthentication(root: string) {
  // Only these three locations are application auth stores. A project may contain
  // its own auth.sqlite with unrelated sessions; never interpret or mutate it.
  for (const path of [
    join(root, "auth.sqlite"),
    join(root, "demo/auth.sqlite"),
    join(root, "prototype/auth.sqlite"),
  ]) {
    if (!existsSync(path)) continue;
    if (!lstatSync(path).isFile()) throw new Error("Invalid auth store");
    const db = database(path, true);
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().length)
        throw new Error("Unexpected auth triggers require operator review");
      db.transaction(() => {
        db.exec('DELETE FROM "session"; DELETE FROM "verification";');
      })();
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  }
}
