import { promises as fs, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { EventService } from "../packages/domain/src/service.ts";
import type { Result } from "../packages/domain/src/types.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw Error(result.error);
  return result.value;
};
function root() {
  const path = mkdtempSync(join(tmpdir(), "civic-spark-management-disk-"));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function fixture() {
  const path = root();
  const service = new EventService(path);
  cleanups.push(() => service.close());
  const owner = {
    id: "disk-owner",
    name: "Owner",
    email: "disk@example.test",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(owner, {
      name: "Disk fixture",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 60,
      budget: 0,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(owner, event.id, "registration"));
  const team = unwrap(
    service.createTeam(owner, { eventId: event.id, name: "Disk team", projectId: "data-starter" }),
  );
  const id = team.workspace.id;
  const name = `civic-spark-${id}`;
  const current = () => unwrap(service.workspace(owner, id));
  const state = new DatabaseSync(join(path, "state.sqlite"));
  const access = new DatabaseSync(join(path, "access.sqlite"));
  cleanups.push(() => {
    state.close();
    access.close();
  });
  // Real SQLite triggers count logical writes, not elapsed time or guessed fsyncs.
  for (const [db, tables] of [
    [state, ["state", "initial_sprite_creation"]],
    [access, ["access_state", "workspace_runtime", "event_execution"]],
  ] as const) {
    db.exec("CREATE TABLE test_writes(table_name TEXT NOT NULL)");
    for (const table of tables)
      for (const operation of ["INSERT", "UPDATE"])
        db.exec(
          `CREATE TRIGGER test_${table}_${operation} AFTER ${operation} ON ${table} BEGIN INSERT INTO test_writes VALUES('${table}'); END`,
        );
  }
  const writes = (db: DatabaseSync, table: string) =>
    Number(db.prepare("SELECT count(*) AS n FROM test_writes WHERE table_name=?").get(table)?.n);
  return { path, service, owner, event, team, id, name, current, state, access, writes };
}

it("keeps steady forty-person portal polls read-only and skips identical access/runtime saves", () => {
  const f = fixture();
  const people = Array.from({ length: 40 }, (_, i) => ({
    ...f.owner,
    id: `person-${i}`,
    name: `Person ${i}`,
    email: `person-${i}@example.test`,
  }));
  for (const actor of people) f.service.portal(actor, false);
  const identities = f.writes(f.access, "access_state");
  expect(identities).toBe(40);
  f.service.setRuntime(f.id, { lastUsedAt: "2026-09-17T15:00:00.000Z" });
  const runtime = f.service.runtime(f.id);
  for (let round = 0; round < 10; round++) {
    for (const actor of people) f.service.portal(actor, false);
    unwrap(f.service.joinTeam(f.owner, f.team.team.id));
    unwrap(f.service.setRole(f.owner, f.event.id, f.owner.id, "admin"));
    expect(f.service.setRuntime(f.id, runtime)).toEqual(runtime);
  }
  expect(f.writes(f.access, "access_state")).toBe(identities);
  expect(f.writes(f.access, "workspace_runtime")).toBe(1);
  expect(f.writes(f.state, "state")).toBe(0);
  const person = people[0];
  if (!person) throw Error("Missing fixture person");
  f.service.portal({ ...person, name: "Updated person" }, false);
  expect(f.writes(f.access, "access_state")).toBe(identities + 1);
  // Every changed activity timestamp remains durable: no sampling or idle-policy change.
  f.service.setRuntime(f.id, { lastUsedAt: "2026-09-17T15:00:00.001Z" });
  expect(f.writes(f.access, "workspace_runtime")).toBe(2);
  const reopened = new EventService(f.path);
  try {
    expect(reopened.runtime(f.id).lastUsedAt).toBe("2026-09-17T15:00:00.001Z");
  } finally {
    reopened.close();
  }
});

it("persists each real provisioning transition once, keeps cause/phase/time, and seals before checkout", () => {
  const f = fixture();
  f.service.reserveInitialCreation(f.id, f.name, {
    org: "fixture",
    apiOrigin: "https://provider.example.test",
    account: "a".repeat(64),
  });
  unwrap(f.service.setSprite(f.id, f.name, "error", "Capacity", "creating", "capacity"));
  const before = f.current();
  const activity = f.service.portal(f.owner, false).activity.length;
  for (let round = 0; round < 40; round++)
    unwrap(f.service.setSprite(f.id, f.name, "error", "Capacity", "creating", "auth"));
  expect(f.writes(f.state, "state")).toBe(1);
  expect(f.current()).toEqual(before);
  expect(f.service.portal(f.owner, false).activity).toHaveLength(activity);
  unwrap(f.service.setSprite(f.id, f.name, "provisioning", null, "checkout"));
  expect(f.service.initialCreation(f.id)?.state).toBe("sealed");
  unwrap(f.service.setSprite(f.id, f.name, "provisioning", null, "checkout"));
  expect(f.writes(f.state, "state")).toBe(2);
  expect(f.writes(f.state, "initial_sprite_creation")).toBe(2); // reservation + barrier
  unwrap(f.service.setSprite(f.id, f.name, "provisioning", null, "verifying"));
  unwrap(f.service.setSprite(f.id, f.name, "provisioning", null, "verifying"));
  unwrap(f.service.setSprite(f.id, f.name, "ready", null));
  unwrap(f.service.setSprite(f.id, f.name, "ready", null));
  expect(f.writes(f.state, "state")).toBe(4);
  expect(f.current().spriteCreationFailure).toBeNull();
  const reopened = new EventService(f.path);
  try {
    expect(unwrap(reopened.workspace(f.owner, f.id))).toEqual(f.current());
    expect(reopened.initialCreation(f.id)?.state).toBe("sealed");
  } finally {
    reopened.close();
  }
});

it("never skips lifecycle generations or changed writes, and preserves failure rollback", () => {
  const f = fixture();
  unwrap(f.service.setSprite(f.id, f.name, "provisioning", null, "creating"));
  f.service.setRuntime(f.id, { generation: 1 });
  f.access.exec(
    "CREATE TRIGGER reject_access BEFORE UPDATE ON access_state BEGIN SELECT RAISE(FAIL, 'disk full'); END; CREATE TRIGGER reject_runtime BEFORE UPDATE ON workspace_runtime BEGIN SELECT RAISE(FAIL, 'disk full'); END",
  );
  f.state.exec(
    "CREATE TRIGGER reject_state BEFORE UPDATE ON state BEGIN SELECT RAISE(FAIL, 'disk full'); END",
  );
  unwrap(f.service.joinTeam(f.owner, f.team.team.id));
  expect(f.service.setRuntime(f.id, { generation: 1 }).generation).toBe(1);
  unwrap(f.service.setSprite(f.id, f.name, "provisioning", null, "creating"));
  expect(() => f.service.removeMember(f.owner, f.team.team.id, f.owner.id)).toThrow("disk full");
  expect(() => f.service.setRuntime(f.id, { generation: 2, held: true })).toThrow("disk full");
  expect(() => f.service.setSprite(f.id, f.name, "error", "Changed failure", "creating")).toThrow(
    "disk full",
  );
  expect(f.current()).toMatchObject({ spriteStatus: "provisioning", spriteError: null });
  expect(f.service.runtime(f.id)).toMatchObject({ generation: 1, held: false });
  f.access.exec("DROP TRIGGER reject_access; DROP TRIGGER reject_runtime");
  f.state.exec("DROP TRIGGER reject_state");
  f.service.setRuntime(f.id, { generation: 2, held: true });
  unwrap(f.service.setExecution(f.owner, f.event.id, true));
  unwrap(f.service.setExecution(f.owner, f.event.id, true));
  expect(f.service.execution(f.event.id).generation).toBe(2);
  expect(f.writes(f.access, "event_execution")).toBe(2);
  expect(f.writes(f.access, "workspace_runtime")).toBe(2);
  unwrap(f.service.removeMember(f.owner, f.team.team.id, f.owner.id));
  expect(f.service.workspace(f.owner, f.id).ok).toBe(false);
  const reopened = new EventService(f.path);
  try {
    expect(reopened.workspace(f.owner, f.id).ok).toBe(false);
    expect(reopened.runtime(f.id)).toMatchObject({ generation: 2, held: true });
    expect(reopened.execution(f.event.id)).toMatchObject({ paused: true, generation: 2 });
  } finally {
    reopened.close();
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each([false, true])(
  "coalesces concurrent health writes without blocking other requests or caching results (failure=%s)",
  async (failWrite) => {
    const path = root();
    const { app } = await createApp(path, false, "http://127.0.0.1:4310", undefined, "email");
    cleanups.push(() => app.close());
    const gate = deferred();
    const entered = deferred();
    cleanups.push(gate.resolve);
    const original = fs.open;
    let writes = 0;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await original(...args);
      const write = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementation(async (...args) => {
        writes++;
        entered.resolve();
        await gate.promise;
        if (failWrite && writes === 1) throw Error("fixture disk full");
        return write(...args);
      });
      return file;
    });
    let completed = 0;
    const health = Array.from({ length: 40 }, () =>
      Promise.resolve(app.inject({ url: "/api/health" })).then((r) => {
        completed++;
        return r;
      }),
    );
    await entered.promise;
    expect((await app.inject({ url: "/api/session" })).statusCode).toBe(200);
    expect(completed).toBe(0);
    expect(writes).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);
    gate.resolve();
    const results = await Promise.all(health);
    expect(results.every((r) => r.statusCode === (failWrite ? 503 : 200))).toBe(true);
    expect(readdirSync(path).filter((name) => name.startsWith(".civic-spark-health"))).toEqual([]);
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect(writes).toBe(2); // no cached success or failure after completion
    expect(open).toHaveBeenCalledTimes(2);
  },
);

it("still rejects low-headroom health before writing and detects storage recovery freshly", async () => {
  const path = root();
  const { app } = await createApp(path, false, "http://127.0.0.1:4310", undefined, "email");
  cleanups.push(() => app.close());
  const stat = await fs.statfs(path);
  const inspect = vi.spyOn(fs, "statfs").mockResolvedValue({ ...stat, bavail: 0 });
  const open = vi.spyOn(fs, "open");
  expect((await app.inject({ url: "/api/health" })).statusCode).toBe(503);
  expect(open).not.toHaveBeenCalled();
  expect(inspect.mock.calls.map(([path]) => path)).toEqual([path, tmpdir()]);
  inspect.mockRestore();
  expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
  expect(open).toHaveBeenCalledOnce();
});
