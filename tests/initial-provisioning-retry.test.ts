import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspaceProvisioning } from "../apps/server/src/provisioning.ts";
import { spriteCreationMessages } from "../packages/domain/src/provisioning.ts";
import { EventService } from "../packages/domain/src/service.ts";
import { fail, ok, type Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "./auth-fixture.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const unwrap = <T>(r: Result<T>) => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function provider() {
  vi.stubEnv("SPRITE_TOKEN", "test-org/org-id/token-id/private-token");
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "test-org");
  vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", "https://provider.example.test");
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ error: "concurrent_sprite_limit_exceeded" }, { status: 429 }),
    );
  return request;
}
async function fixture() {
  const request = provider();
  const root = mkdtempSync(join(tmpdir(), "civic-spark-initial-retry-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let service = new EventService(root);
  const owner = {
    id: "owner",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(owner, {
      name: "Initial retry",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    service.createTeam(owner, { eventId: event.id, name: "Retry team", projectId: "data-starter" }),
  );
  const id = team.workspace.id;
  const name = `civic-spark-${id}`;
  const client = new SpriteClient("test-org", undefined, request);
  const command = vi.spyOn(client, "command").mockRejectedValue(Error("No live commands"));
  const files = vi.spyOn(client, "files").mockResolvedValue(ok(["README.md"]));
  const exec = vi.spyOn(client, "exec").mockResolvedValue(fail("Unavailable"));
  const upload = vi.spyOn(client, "uploadBundle").mockResolvedValue(ok(Buffer.from("")));
  let provisioning = new WorkspaceProvisioning(service, root, client);
  const current = () => unwrap(service.workspace(owner, id));
  const authorize = async () => service.workspace(owner, id, true);
  const run = async (explicit = true) => {
    const result = await provisioning.start(current(), authorize, explicit);
    if (result.ok) await provisioning.wait(id);
    return result;
  };
  cleanups.push(async () => {
    await provisioning.close();
    service.close();
  });
  unwrap(await run(false));
  expect(current()).toMatchObject({
    spriteStatus: "error",
    spritePhase: "creating",
    spriteCreationFailure: "capacity",
  });
  expect(service.initialCreation(id)).toMatchObject({ name, state: "creating", org: "test-org" });
  request.mockReset();
  return {
    root,
    owner,
    event,
    team,
    id,
    name,
    client,
    request,
    command,
    files,
    exec,
    upload,
    current,
    authorize,
    run,
    get service() {
      return service;
    },
    get provisioning() {
      return provisioning;
    },
    async restart() {
      await provisioning.close();
      service.close();
      service = new EventService(root);
      provisioning = new WorkspaceProvisioning(service, root, client);
    },
  };
}
function allowMissing(f: Awaited<ReturnType<typeof fixture>>) {
  f.request.mockImplementation(async (_url, init) =>
    init?.method === "GET"
      ? Response.json({}, { status: 404 })
      : Response.json({ name: f.name, organization: "test-org" }, { status: 201 }),
  );
}

it("explicitly retries the same initial reservation after restart, then permanently seals it", async () => {
  const f = await fixture();
  const head = git(f.service.workspacePath(f.id), ["rev-parse", "HEAD"]).toString();
  unwrap(f.service.setSprite(f.id, f.name, "provisioning", null, "creating"));
  await f.restart();
  expect(f.current().spriteError).toContain("server restart");
  allowMissing(f);
  f.files.mockResolvedValueOnce(fail("No checkout"));
  f.exec.mockResolvedValue(ok(Buffer.from("")));
  f.upload.mockImplementation(async () => {
    expect(f.service.initialCreation(f.id)?.state).toBe("sealed");
    return ok(Buffer.from(""));
  });
  unwrap(await f.run());
  expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST"]);
  expect(String(f.request.mock.calls[0]?.[0])).toBe(
    `https://provider.example.test/v1/sprites/${f.name}`,
  );
  expect(f.request.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ name: f.name }));
  expect(f.current()).toMatchObject({
    spriteName: f.name,
    spriteStatus: "ready",
    spriteCreationFailure: null,
  });
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.exec).toHaveBeenCalledWith(f.name, [
    "bash",
    "-lc",
    "test ! -e /home/sprite/project && test ! -L /home/sprite/project",
  ]);
  expect(git(f.service.workspacePath(f.id), ["rev-parse", "HEAD"]).toString()).toBe(head);
  await f.restart();
  // An old retry phase cannot erase proof that checkout/ready was reached.
  unwrap(f.service.setSprite(f.id, f.name, "error", "Unreachable", "creating"));
  f.request.mockClear();
  f.exec.mockResolvedValue(fail("Unavailable"));
  unwrap(await f.run());
  expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  expect(f.service.initialCreation(f.id)?.state).toBe("sealed");
});

it("ordinary reopen never recreates even with valid initial evidence and authenticated absence", async () => {
  const f = await fixture();
  allowMissing(f);
  unwrap(await f.run(false));
  expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.service.initialCreation(f.id)?.state).toBe("creating");
});

it.each([401, 403, 429, 503, 200])("fails closed on uncertain GET HTTP%s", async (status) => {
  const f = await fixture();
  f.request.mockResolvedValue(
    Response.json(
      { name: "wrong", organization: "test-org", message: "Bearer secret" },
      { status },
    ),
  );
  unwrap(await f.run());
  expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  expect(f.current().spriteError).toContain("could not confirm the reserved workspace");
  expect(f.current().spriteError).not.toContain("secret");
  expect(f.exec).not.toHaveBeenCalled();
  expect(f.files).not.toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
});

it.each(["private", "absent", "unverifiable"] as const)(
  "reconciles an existing Sprite with %s project without replacing it",
  async (project) => {
    const f = await fixture();
    f.request.mockResolvedValue(Response.json({ name: f.name, organization: "test-org" }));
    if (project !== "private") f.files.mockResolvedValueOnce(fail("Unknown checkout"));
    if (project === "absent") f.exec.mockResolvedValue(ok(Buffer.from("")));
    unwrap(await f.run());
    expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
    expect(f.upload).toHaveBeenCalledTimes(project === "absent" ? 1 : 0);
    expect(f.service.initialCreation(f.id)?.state).toBe("sealed");
    expect(f.current().spriteStatus).toBe(project === "unverifiable" ? "error" : "ready");
    if (project === "unverifiable")
      expect(f.current().spriteError).toContain("files were not replaced");
  },
);

it.each([
  [429, { error: "sprite_creation_rate_limited" }, "rate"],
  [401, {}, "auth"],
  [503, {}, "transient"],
  [409, { error: "already_exists" }, "unknown"],
] as const)(
  "retains original cause while reporting a new POST HTTP%s failure",
  async (status, body, cause) => {
    const f = await fixture();
    f.request
      .mockResolvedValueOnce(Response.json({}, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ ...body, message: "Bearer never-expose" }, { status }),
      );
    unwrap(await f.run());
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.current().spriteCreationFailure).toBe("capacity");
    expect(f.current().spriteError).toContain(spriteCreationMessages.capacity);
    expect(f.current().spriteError).toContain(spriteCreationMessages[cause]);
    expect(f.current().spriteError).not.toContain("never-expose");
    expect(f.files).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.service.initialCreation(f.id)?.state).toBe("creating");
    await f.restart();
    expect(f.current().spriteError).toContain(spriteCreationMessages[cause]);
  },
);

it.each(["pause", "pause-unpause", "revoke", "generation", "origin", "account"] as const)(
  "does not dispatch after delayed absence check and %s",
  async (action) => {
    const f = await fixture();
    const arrived = deferred();
    const gate = deferred();
    cleanups.push(gate.resolve);
    f.request.mockImplementation(async () => {
      arrived.resolve();
      await gate.promise;
      return Response.json({}, { status: 404 });
    });
    const running = f.run();
    await arrived.promise;
    if (action === "pause" || action === "pause-unpause") {
      unwrap(f.service.setExecution(f.owner, f.event.id, true));
      if (action === "pause-unpause") unwrap(f.service.setExecution(f.owner, f.event.id, false));
    } else if (action === "revoke")
      unwrap(f.service.removeMember(f.owner, f.team.team.id, f.owner.id));
    else if (action === "generation")
      f.service.setRuntime(f.id, { generation: f.service.runtime(f.id).generation + 1 });
    else if (action === "origin")
      vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", "https://changed.example.test");
    else vi.stubEnv("SPRITE_TOKEN", "test-org/other-account/token-id/private-token");
    const newerState = f.service.provisioningRecords().find((w) => w.id === f.id);
    gate.resolve();
    unwrap(await running);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.files).not.toHaveBeenCalled();
    if (action === "generation")
      expect(f.service.provisioningRecords().find((w) => w.id === f.id)).toEqual(newerState);
    else
      expect(f.service.provisioningRecords().find((w) => w.id === f.id)?.spriteStatus).toBe(
        "error",
      );
  },
);

it("deduplicates concurrent explicit retries through delayed GET and POST", async () => {
  const f = await fixture();
  const arrived = deferred();
  const gate = deferred();
  cleanups.push(gate.resolve);
  f.request.mockImplementation(async (_url, init) => {
    if (init?.method === "GET") {
      arrived.resolve();
      await gate.promise;
      return Response.json({}, { status: 404 });
    }
    return Response.json({ name: f.name, organization: "test-org" }, { status: 201 });
  });
  const first = f.run();
  await arrived.promise;
  const again = Array.from({ length: 5 }, () => f.run());
  gate.resolve();
  await Promise.all([first, ...again]);
  expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST"]);
  expect(f.current().spriteStatus).toBe("ready");
});

it("never bootstraps initial evidence for a legacy reservation", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.root, "state.sqlite"));
  db.prepare("DELETE FROM initial_sprite_creation WHERE workspace=?").run(f.id);
  db.close();
  allowMissing(f);
  await f.restart();
  unwrap(await f.run());
  expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  expect(f.current().spriteError).toContain("Rebuild from shared work");
  expect(f.service.initialCreation(f.id)).toBeNull();
  expect(() => f.service.reserveInitialCreation(f.id, f.name, unwrapBinding(f.client))).toThrow(
    "never-reserved",
  );
});
function unwrapBinding(client: SpriteClient) {
  const binding = client.provisioningBinding();
  if (!binding) throw Error("Missing test binding");
  return binding;
}

it.each(["signed-out", "revoked", "paused"] as const)(
  "revalidates the actual owner API session after GET when %s",
  async (action) => {
    const request = provider();
    vi.stubGlobal("fetch", request);
    const root = mkdtempSync(join(tmpdir(), "civic-spark-owner-retry-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { app, service, authentication } = await createApp(
      root,
      true,
      "http://127.0.0.1:4310",
      undefined,
      "email",
    );
    cleanups.push(() => app.close());
    vi.spyOn(SpriteClient.prototype, "command").mockRejectedValue(Error("No live commands"));
    const owner = await testIdentity(authentication, "Retry owner");
    if (!owner.actor) throw Error("Missing owner");
    const event = unwrap(
      service.createEvent(owner.actor, {
        name: "Owner retry",
        date: "2026-10-03",
        timezone: "America/Chicago",
        location: "Test",
        capacity: 10,
        budget: 0,
        templateId: "blank",
      }),
    );
    const team = unwrap(
      service.createTeam(owner.actor, {
        eventId: event.id,
        name: "Owner team",
        projectId: "data-starter",
      }),
    );
    const id = team.workspace.id;
    const post = (payload = {}) =>
      app.inject({
        method: "POST",
        url: `/api/workspaces/${id}/sprite`,
        headers: { cookie: owner.cookie, origin: "http://127.0.0.1:4310" },
        payload,
      });
    expect((await post()).statusCode).toBe(202);
    const record = () => service.provisioningRecords().find((w) => w.id === id);
    await expect.poll(() => record()?.spriteStatus).toBe("error");
    const arrived = deferred();
    const gate = deferred();
    cleanups.push(gate.resolve);
    request.mockReset().mockImplementation(async () => {
      arrived.resolve();
      await gate.promise;
      return Response.json({}, { status: 404 });
    });
    expect((await post({ action: "retry-initial-creation" })).statusCode).toBe(202);
    await arrived.promise;
    if (action === "signed-out") {
      const db = new DatabaseSync(join(root, "auth.sqlite"));
      db.prepare("DELETE FROM session WHERE userId=?").run(owner.actor.id);
      db.close();
    } else if (action === "revoked")
      unwrap(service.removeMember(owner.actor, team.team.id, owner.actor.id));
    else unwrap(service.setExecution(owner.actor, event.id, true));
    gate.resolve();
    await expect.poll(() => record()?.spriteStatus).toBe("error");
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  },
);
