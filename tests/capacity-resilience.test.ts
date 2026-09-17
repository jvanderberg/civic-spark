import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import * as deployment from "../apps/server/src/deployment.ts";
import { acquireWriter } from "../apps/server/src/deployment.ts";
import { WorkspaceProvisioning } from "../apps/server/src/provisioning.ts";
import { EventService } from "../packages/domain/src/service.ts";
import { ok, type Result } from "../packages/domain/src/types.ts";
import * as asyncGit from "../packages/git/src/async.ts";
import * as jobs from "../packages/git/src/jobs.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(r: Result<T>) => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(spritesEnabled = false) {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-resilience-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const instance = await createApp(
    root,
    spritesEnabled,
    "http://127.0.0.1:4310",
    undefined,
    "email",
  );
  cleanups.push(() => instance.app.close());
  const { service, authentication, app } = instance;
  const owner = await testIdentity(authentication, "Capacity Owner");
  const member = await testIdentity(authentication, "Capacity Member");
  if (!owner.actor || !member.actor) throw new Error("Missing identity");
  const event = unwrap(
    service.createEvent(owner.actor, {
      name: "Resilience",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Local",
      capacity: 60,
      budget: 0,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    service.createTeam(owner.actor, {
      eventId: event.id,
      name: "Resilience team",
      projectId: "data-starter",
    }),
  );
  unwrap(service.transition(owner.actor, event.id, "registration"));
  const workspace = unwrap(service.joinTeam(member.actor, team.team.id));
  const dir = service.workspacePath(workspace.id);
  const repo = join(root, "repos", `${team.team.id}.git`);
  const head = () => git(repo, ["rev-parse", "main"]).toString().trim();
  const initial = head();
  writeFileSync(join(dir, "fixture.txt"), "Private local change\n");
  const revision = new WorkspaceFiles(dir).snapshot().revision;
  const share = () =>
    app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/share`,
      headers: { cookie: member.cookie, origin: "http://127.0.0.1:4310" },
      payload: { title: "Explicit fixture Share", revision },
    });
  return {
    ...instance,
    root,
    owner: owner.actor,
    ownerCookie: owner.cookie,
    memberCookie: member.cookie,
    member: member.actor,
    event,
    team,
    workspace,
    dir,
    repo,
    head,
    initial,
    revision,
    share,
    cookie: member.cookie,
  };
}

it.each(["revoked", "paused", "signed-out"])(
  "rechecks %s authorization after deferred Git preparation on the actual Share route",
  async (action) => {
    const f = await fixture();
    const original = jobs.gitJob;
    let ready!: () => void;
    const prepared = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(jobs, "gitJob").mockImplementation(async (input, signal) => {
      const result = await original(input, signal);
      if (input.operation === "prepare") {
        ready();
        await gate;
      }
      return result;
    });
    const pending = f.share();
    // Injection starts when awaited/then attached.
    const result = Promise.resolve(pending);
    await prepared;
    if (action === "revoked") unwrap(f.service.removeMember(f.owner, f.team.team.id, f.member.id));
    else if (action === "paused") unwrap(f.service.setExecution(f.owner, f.event.id, true));
    else {
      const db = new DatabaseSync(join(f.root, "auth.sqlite"));
      db.prepare("DELETE FROM session WHERE userId=?").run(f.member.id);
      db.close();
    }
    resume();
    expect((await result).statusCode).toBe(
      action === "revoked" ? 404 : action === "paused" ? 423 : 401,
    );
    expect(f.head()).toBe(f.initial);
    expect(git(f.dir, ["rev-parse", "HEAD"]).toString().trim()).not.toBe(f.initial);
  },
);

it("checks pause immediately before CAS and rejects a stale shared ref without rewriting it", async () => {
  const f = await fixture();
  const original = asyncGit.gitAsync;
  const change = vi.spyOn(asyncGit, "gitAsync").mockImplementation(async (cwd, args, signal) => {
    const value = await original(cwd, args, signal);
    if (cwd === f.repo && args.join(" ") === "rev-parse main")
      unwrap(f.service.setExecution(f.owner, f.event.id, true));
    return value;
  });
  expect((await f.share()).statusCode).toBe(423);
  expect(f.head()).toBe(f.initial);
  change.mockRestore();
  unwrap(f.service.setExecution(f.owner, f.event.id, false));
  const tree = git(f.repo, ["rev-parse", `${f.initial}^{tree}`])
    .toString()
    .trim();
  const advanced = git(f.repo, [
    "commit-tree",
    tree,
    "-p",
    f.initial,
    "-m",
    "Another explicit commit",
  ])
    .toString()
    .trim();
  git(f.repo, ["update-ref", "refs/heads/main", advanced, f.initial]);
  expect((await f.share()).statusCode).toBe(409);
  expect(f.head()).toBe(advanced);
});

it.each(["before-cas", "after-cas"])(
  "restarts with a durable %s intent and reconciles only on an authorized explicit retry",
  async (phase) => {
    const f = await fixture();
    const original = asyncGit.gitAsync;
    const state = new DatabaseSync(join(f.root, "state.sqlite"));
    cleanups.push(() => state.close());
    const fault = vi.spyOn(asyncGit, "gitAsync").mockImplementation(async (cwd, args, signal) => {
      if (args[0] === "update-ref" && args[1] === "refs/heads/main") {
        expect(state.prepare("SELECT count(*) AS n FROM publication_intents").get()?.n).toBe(1);
        if (phase === "before-cas") throw new Error("Injected worker loss before CAS");
        state.exec(
          "CREATE TRIGGER injected_full BEFORE UPDATE ON state BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END",
        );
      }
      return original(cwd, args, signal);
    });
    expect((await f.share()).statusCode).toBe(phase === "before-cas" ? 503 : 409);
    const retained = git(f.dir, ["rev-parse", "HEAD"]).toString().trim();
    expect(f.head()).toBe(phase === "before-cas" ? f.initial : retained);
    expect(state.prepare("SELECT count(*) AS n FROM publication_intents").get()?.n).toBe(1);
    fault.mockRestore();
    state.exec("DROP TRIGGER IF EXISTS injected_full");
    await f.app.close();
    const reopened = await createApp(f.root, false, "http://127.0.0.1:4310", undefined, "email");
    cleanups.push(() => reopened.app.close());
    expect(f.head()).toBe(phase === "before-cas" ? f.initial : retained);
    const request = () =>
      reopened.app.inject({
        method: "POST",
        url: `/api/workspaces/${f.workspace.id}/share`,
        headers: { cookie: f.cookie, origin: "http://127.0.0.1:4310" },
        payload: { title: "Explicit retry", revision: f.revision },
      });
    unwrap(reopened.service.setExecution(f.owner, f.event.id, true));
    expect((await request()).statusCode).toBe(423);
    unwrap(reopened.service.setExecution(f.owner, f.event.id, false));
    expect((await request()).statusCode).toBe(200);
    expect(f.head()).toBe(retained);
    expect(reopened.service.portal(f.member, false).contributions).toHaveLength(1);
    expect(state.prepare("SELECT count(*) AS n FROM publication_intents").get()?.n).toBe(0);
  },
);

it("reconciles a lost CAS response and metadata ENOSPC on explicit retry without a second publication", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.root, "state.sqlite"));
  cleanups.push(() => db.close());
  db.exec(
    "CREATE TRIGGER injected_full BEFORE UPDATE ON state BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END",
  );
  const original = asyncGit.gitAsync;
  let swaps = 0;
  vi.spyOn(asyncGit, "gitAsync").mockImplementation(async (cwd, args, signal) => {
    const result = await original(cwd, args, signal);
    if (args[0] === "update-ref" && args[1] === "refs/heads/main") {
      swaps++;
      throw new Error("Lost response after child completion");
    }
    return result;
  });
  expect((await f.share()).statusCode).toBe(409);
  const commit = f.head();
  expect(commit).not.toBe(f.initial);
  expect(f.service.portal(f.member, false).contributions).toHaveLength(0);
  expect(db.prepare("SELECT count(*) AS n FROM publication_intents").get()?.n).toBe(1);
  db.exec("DROP TRIGGER injected_full");
  expect((await f.share()).statusCode).toBe(200);
  expect(f.head()).toBe(commit);
  expect(swaps).toBe(1);
  expect(db.prepare("SELECT count(*) AS n FROM publication_intents").get()?.n).toBe(0);
});

it("rolls back failed role and event writes in memory as well as SQLite", async () => {
  const f = await fixture();
  const access = new DatabaseSync(join(f.root, "access.sqlite"));
  cleanups.push(() => access.close());
  access.exec(
    "CREATE TRIGGER injected_full BEFORE UPDATE ON access_state BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END",
  );
  expect(() => f.service.removeMember(f.owner, f.team.team.id, f.member.id)).toThrow("full");
  expect(f.service.workspace(f.member, f.workspace.id).ok).toBe(true);
  const state = new DatabaseSync(join(f.root, "state.sqlite"));
  cleanups.push(() => state.close());
  state.exec(
    "CREATE TRIGGER injected_full BEFORE UPDATE ON state BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END",
  );
  expect(() =>
    f.service.setSprite(
      f.workspace.id,
      `civic-spark-${f.workspace.id}`,
      "provisioning",
      null,
      "creating",
    ),
  ).toThrow("full");
  expect(unwrap(f.service.workspace(f.member, f.workspace.id)).spriteStatus).toBe("local");
  const reopened = new EventService(f.root);
  cleanups.push(() => reopened.close());
  expect(unwrap(reopened.workspace(f.member, f.workspace.id)).spriteStatus).toBe("local");
});

it("kills a Git worker, drains its slot, and allows a clean retry without publishing", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const pending = jobs.gitJob(
    { operation: "commit", root: f.dir, title: "Interrupted", revision: f.revision },
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(f.head()).toBe(f.initial);
  const retry = await jobs.gitJob({
    operation: "commit",
    root: f.dir,
    title: "Retry",
    revision: f.revision,
  });
  expect(retry.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(f.head()).toBe(f.initial);
});

it("releases the management writer lock after SIGKILL", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-crash-lock-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const module = new URL("../apps/server/src/deployment.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {acquireWriter} from ${JSON.stringify(module)}; acquireWriter(process.argv[1]); console.log('locked'); setInterval(()=>{},1000);`,
      root,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  cleanups.push(() => {
    child.kill("SIGKILL");
  });
  await once(child.stdout, "data");
  expect(() => acquireWriter(root)).toThrow("active");
  child.kill("SIGKILL");
  await once(child, "close");
  acquireWriter(root)();
});

it("fails storage-starved writes before starting Git and resumes after space recovery", async () => {
  const f = await fixture();
  const worker = vi.spyOn(jobs, "gitJob");
  const fault = vi.spyOn(deployment, "storageHeadroom").mockImplementation(() => {
    throw new Error("Injected ENOSPC");
  });
  const denied = await f.share();
  expect(denied.statusCode).toBe(503);
  expect(denied.headers["retry-after"]).toBe("10");
  expect(worker).not.toHaveBeenCalled();
  expect(f.head()).toBe(f.initial);
  fault.mockRestore();
  expect((await f.share()).statusCode).toBe(200);
});

it("bounds concurrent incoming bodies without allocating the declared file contents", async () => {
  const f = await fixture();
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  const address = f.app.server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const url = `http://127.0.0.1:${address.port}/api/workspaces/${f.workspace.id}/file`;
  const options = {
    method: "PUT",
    headers: {
      cookie: f.cookie,
      origin: "http://127.0.0.1:4310",
      "content-type": "application/json",
      "content-length": String(140 * 1024 * 1024),
    },
  };
  const first = request(url, options);
  first.on("error", () => {});
  first.write('{"path":');
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = request(url, options);
    second.on("error", () => {});
    const response = once(second, "response");
    second.write('{"path":');
    const [incoming] = await response;
    expect(incoming.statusCode).toBe(429);
    incoming.resume();
    second.destroy();
  } finally {
    first.destroy();
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await f.share()).statusCode).toBe(200);
});

it("handles provisioning error-persistence failure without an unhandled rejection or another allocation", async () => {
  const f = await fixture();
  // Use the untouched owner checkout; the other checkout intentionally has private edits.
  const workspace = f.team.workspace;
  const client = new SpriteClient();
  const create = vi
    .spyOn(client, "create")
    .mockResolvedValue({ ok: false, status: 502, error: "Uncertain provider result" });
  const provisioning = new WorkspaceProvisioning(f.service, f.root, client);
  const original = f.service.setSprite.bind(f.service);
  const storage = vi.spyOn(f.service, "setSprite").mockImplementation((...args) => {
    if (args[2] === "error") throw new Error("Injected disk full while recording provider failure");
    return original(...args);
  });
  unwrap(await provisioning.start(workspace));
  await expect(provisioning.wait(workspace.id)).rejects.toThrow("disk full");
  await provisioning.close();
  storage.mockRestore();
  const saved = unwrap(f.service.workspace(f.owner, workspace.id));
  expect(saved.spriteName).toBe(`civic-spark-${workspace.id}`);
  expect(provisioning.status(saved).spriteStatus).toBe("error");
  expect(create).toHaveBeenCalledTimes(1);
});

it("rejects dirty local HTTP preparation without reservation, then permits Share and a fresh successful prepare", async () => {
  const f = await fixture(true);
  const command = vi
    .spyOn(SpriteClient.prototype, "command")
    .mockRejectedValue(new Error("No provider calls allowed"));
  const create = vi
    .spyOn(SpriteClient.prototype, "create")
    .mockResolvedValue(ok(`civic-spark-${f.workspace.id}`));
  const upload = vi
    .spyOn(SpriteClient.prototype, "uploadBundle")
    .mockResolvedValue(ok(Buffer.alloc(0)));
  vi.spyOn(SpriteClient.prototype, "files").mockResolvedValue(ok(["fixture.txt"]));
  const url = `/api/workspaces/${f.workspace.id}/sprite`;
  const headers = { cookie: f.memberCookie, origin: "http://127.0.0.1:4310" };
  const before = unwrap(f.service.workspace(f.member, f.workspace.id));
  const denied = await f.app.inject({ method: "POST", url, headers });
  expect(denied.statusCode).toBe(409);
  expect(denied.json().error).toContain("Share saved changes");
  const after = unwrap(f.service.workspace(f.member, f.workspace.id));
  expect({ ...after, runtime: undefined }).toEqual({ ...before, runtime: undefined });
  expect(after).toMatchObject({ spriteStatus: "local", spriteName: null });
  expect(create).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
  expect(readFileSync(join(f.dir, "fixture.txt"), "utf8")).toBe("Private local change\n");
  expect((await f.share()).statusCode).toBe(200);
  const shared = f.head();
  expect(git(f.dir, ["rev-parse", "HEAD"]).toString().trim()).toBe(shared);
  expect((await f.app.inject({ method: "POST", url, headers })).statusCode).toBe(202);
  await vi.waitFor(async () =>
    expect((await f.app.inject({ url, headers })).json()).toMatchObject({ spriteStatus: "ready" }),
  );
  expect(create).toHaveBeenCalledExactlyOnceWith(`civic-spark-${f.workspace.id}`);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(command).not.toHaveBeenCalled(); // No reconnect probe for a never-reserved Sprite.
  expect(f.head()).toBe(shared);
  expect(readFileSync(join(f.dir, "fixture.txt"), "utf8")).toBe("Private local change\n");
});

it.each(["revoked", "paused", "signed-out", "generation", "git-failed"] as const)(
  "revalidates deferred provisioning preflight without reservation when %s",
  async (action) => {
    const f = await fixture(true);
    rmSync(join(f.dir, "fixture.txt"));
    const command = vi
      .spyOn(SpriteClient.prototype, "command")
      .mockRejectedValue(new Error("No provider calls allowed"));
    const original = asyncGit.gitAsync;
    let resume!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    cleanups.push(() => resume());
    vi.spyOn(asyncGit, "gitAsync").mockImplementation(async (cwd, args, signal) => {
      const result = await original(cwd, args, signal);
      if (cwd === f.dir && args[0] === "status") {
        ready();
        await gate;
        if (action === "git-failed") throw new Error("Git preflight failed");
      }
      return result;
    });
    const pending = Promise.resolve(
      f.app.inject({
        method: "POST",
        url: `/api/workspaces/${f.workspace.id}/sprite`,
        headers: { cookie: f.memberCookie, origin: "http://127.0.0.1:4310" },
      }),
    );
    await started;
    expect(f.service.provisioningRecords().find((w) => w.id === f.workspace.id)).toMatchObject({
      spriteStatus: "local",
      spriteName: null,
    });
    if (action === "revoked") unwrap(f.service.removeMember(f.owner, f.team.team.id, f.member.id));
    else if (action === "paused") unwrap(f.service.setExecution(f.owner, f.event.id, true));
    else if (action === "generation")
      f.service.setRuntime(f.workspace.id, {
        generation: f.service.runtime(f.workspace.id).generation + 1,
      });
    else if (action === "signed-out") {
      const db = new DatabaseSync(join(f.root, "auth.sqlite"));
      db.prepare("DELETE FROM session WHERE userId=?").run(f.member.id);
      db.close();
    }
    resume();
    expect((await pending).statusCode).toBe(
      action === "revoked"
        ? 404
        : action === "paused"
          ? 423
          : action === "signed-out"
            ? 401
            : action === "git-failed"
              ? 503
              : 409,
    );
    expect(f.service.provisioningRecords().find((w) => w.id === f.workspace.id)).toMatchObject({
      spriteStatus: "local",
      spriteName: null,
    });
    expect(command).not.toHaveBeenCalled();
  },
);

it("deduplicates deferred HTTP preflights and counts them against transient concurrency", async () => {
  vi.stubEnv("CIVIC_SPARK_MAX_PROVISIONING", "1");
  const f = await fixture(true);
  rmSync(join(f.dir, "fixture.txt"));
  const create = vi
    .spyOn(SpriteClient.prototype, "create")
    .mockResolvedValue(ok(`civic-spark-${f.workspace.id}`));
  vi.spyOn(SpriteClient.prototype, "uploadBundle").mockResolvedValue(ok(Buffer.alloc(0)));
  vi.spyOn(SpriteClient.prototype, "files").mockResolvedValue(ok(["README.md"]));
  const original = asyncGit.gitAsync;
  let resume!: () => void;
  let ready!: () => void;
  let checks = 0;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  cleanups.push(() => resume());
  vi.spyOn(asyncGit, "gitAsync").mockImplementation(async (cwd, args, signal) => {
    const result = await original(cwd, args, signal);
    if (cwd === f.dir && args[0] === "status") {
      checks++;
      ready();
      await gate;
    }
    return result;
  });
  const url = `/api/workspaces/${f.workspace.id}/sprite`;
  const headers = { cookie: f.memberCookie, origin: "http://127.0.0.1:4310" };
  const first = Promise.resolve(f.app.inject({ method: "POST", url, headers }));
  await started;
  const second = Promise.resolve(f.app.inject({ method: "POST", url, headers }));
  const busy = await f.app.inject({
    method: "POST",
    url: `/api/workspaces/${f.team.workspace.id}/sprite`,
    headers: { ...headers, cookie: f.ownerCookie },
  });
  expect(busy.statusCode).toBe(429);
  resume();
  expect((await first).statusCode).toBe(202);
  expect((await second).statusCode).toBe(202);
  expect(checks).toBe(1);
  await vi.waitFor(() =>
    expect(unwrap(f.service.workspace(f.member, f.workspace.id)).spriteStatus).toBe("ready"),
  );
  expect(create).toHaveBeenCalledTimes(1);
});

for (const route of ["wake", "sprite"] as const) {
  it.each(["signed-out", "revoked", "newer-hold", "newer-release", "newer-deletion"] as const)(
    `preserves deleted recovery hold and permits authorized retry through HTTP ${route} after %s`,
    async (action) => {
      vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "fixture-org");
      vi.stubEnv("SPRITE_TOKEN", "fixture-org/fixture-id/fixture-token/fixture-only");
      const f = await fixture(true);
      const id = f.workspace.id;
      const name = `civic-spark-${id}`;
      unwrap(f.service.setSprite(id, name, "error", "Deleted fixture"));
      f.service.setRuntime(id, {
        generation: 10,
        held: true,
        reason: "admin",
        stopState: "stopped",
        deletion: {
          state: "deleted",
          changedAt: "2026-09-16T00:00:00.000Z",
          replacementReserved: false,
          error: null,
          org: "fixture-org",
          apiOrigin: "https://api.sprites.dev",
        },
      });
      const command = vi
        .spyOn(SpriteClient.prototype, "command")
        .mockRejectedValue(new Error("No provider calls allowed"));
      const create = vi.spyOn(SpriteClient.prototype, "create").mockResolvedValue(ok(name));
      const upload = vi
        .spyOn(SpriteClient.prototype, "uploadBundle")
        .mockResolvedValue(ok(Buffer.alloc(0)));
      vi.spyOn(SpriteClient.prototype, "files").mockResolvedValue(ok(["README.md"]));
      const metadata = vi.fn<typeof fetch>(async (url) =>
        String(url).includes("?")
          ? Response.json({ sprites: [], has_more: false, next_continuation_token: null })
          : new Response(null, { status: 404 }),
      );
      vi.stubGlobal("fetch", metadata);
      const auth = f.authentication.auth.api;
      const original = auth.getSession.bind(auth);
      let resume!: () => void;
      let ready!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      cleanups.push(() => resume());
      const deferred = vi.spyOn(auth, "getSession").mockImplementation(async (input) => {
        if (input?.query?.disableCookieCache) {
          ready();
          await gate;
        }
        return original(input);
      });
      const url = `/api/workspaces/${id}/${route}`;
      const headers = { cookie: f.memberCookie, origin: "http://127.0.0.1:4310" };
      const pending = Promise.resolve(f.app.inject({ method: "POST", url, headers }));
      await started;
      const awake = f.service.runtime(id);
      expect(awake).toMatchObject({
        held: false,
        generation: 11,
        deletion: { state: "deleted", replacementReserved: false },
      });
      if (action === "signed-out") {
        const db = new DatabaseSync(join(f.root, "auth.sqlite"));
        db.prepare("DELETE FROM session WHERE userId=?").run(f.member.id);
        db.close();
      } else if (action === "revoked")
        unwrap(f.service.removeMember(f.owner, f.team.team.id, f.member.id));
      else if (action === "newer-deletion") {
        if (!awake.deletion) throw new Error("Missing fixture deletion");
        f.service.setRuntime(id, {
          deletion: { ...awake.deletion, changedAt: "2026-09-16T01:00:00.000Z" },
        });
      } else
        f.service.setRuntime(id, {
          generation: awake.generation + 1,
          held: action === "newer-hold",
          reason: action === "newer-hold" ? "admin" : null,
        });
      const newer = f.service.runtime(id);
      resume();
      expect((await pending).statusCode).toBe(
        action === "signed-out"
          ? 401
          : action === "revoked"
            ? 404
            : action === "newer-hold"
              ? 423
              : 409,
      );
      const failed = f.service.runtime(id);
      if (action === "signed-out" || action === "revoked")
        expect(failed).toEqual({ ...newer, held: true, reason: "admin" });
      else expect(failed).toEqual(newer); // No overwrite of newer lifecycle/deletion state.
      expect(failed.held).toBe(!["newer-release", "newer-deletion"].includes(action));
      expect(failed.deletion?.replacementReserved).toBe(false);
      expect(f.service.provisioningRecords().find((w) => w.id === id)).toMatchObject({
        spriteName: name,
        spriteStatus: "error",
        spriteError: "Deleted fixture",
      });
      expect(command).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(upload).not.toHaveBeenCalled();
      expect(metadata).not.toHaveBeenCalled();
      deferred.mockRestore();
      if (action === "revoked") unwrap(f.service.joinTeam(f.member, f.team.team.id));
      if (action === "signed-out") {
        const context = await f.authentication.auth.$context;
        const session = await context.internalAdapter.createSession(f.member.id);
        const signature = createHmac("sha256", context.secret)
          .update(session.token)
          .digest("base64");
        headers.cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`;
      }
      expect((await f.app.inject({ method: "POST", url, headers })).statusCode).toBe(202);
      await vi.waitFor(() =>
        expect(unwrap(f.service.workspace(f.member, id))).toMatchObject({
          spriteStatus: "ready",
          spriteError: null,
        }),
      );
      expect(f.service.runtime(id)).toMatchObject({ held: false, deletion: null });
      expect(create).toHaveBeenCalledExactlyOnceWith(name, expect.any(Function), false);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(command).not.toHaveBeenCalled();
      expect(readFileSync(join(f.dir, "fixture.txt"), "utf8")).toBe("Private local change\n");
    },
  );
}
