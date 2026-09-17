import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspaceLifecycle } from "../apps/server/src/lifecycle.ts";
import { WorkspaceProvisioning } from "../apps/server/src/provisioning.ts";
import { inspectRecoverySprite } from "../packages/backup/src/recovery.ts";
import { EventService } from "../packages/domain/src/service.ts";
import { fail, ok, type Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { SpriteLifecycle, spriteEstimate } from "../packages/sprites/src/lifecycle.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const input = {
  name: "Sprite control fixture",
  date: "2026-10-03",
  timezone: "America/Chicago",
  location: "Test",
  capacity: 50,
  budget: 0,
  templateId: "blank" as const,
};
const actor = {
  id: "fixture",
  name: "Admin",
  email: "fixture@example.test",
  emailVerified: true as const,
};
const roots: string[] = [];
const provider = () => ({
  inspect: vi.fn().mockResolvedValue({
    status: "running",
    observedAt: new Date().toISOString(),
    createdAt: "2026-09-16T00:00:00Z",
    updatedAt: null,
    error: null,
  }),
  stop: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
});
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "cs-row-controls-"));
  roots.push(path);
  return path;
};
function fixture() {
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "fixture-org");
  vi.stubEnv("SPRITE_TOKEN", "fixture-org/id/token/value");
  const path = root();
  const service = new EventService(path);
  const event = unwrap(service.createEvent(actor, input));
  const workspace = unwrap(
    service.createTeam(actor, { eventId: event.id, name: "First team", projectId: "data-starter" }),
  ).workspace;
  const name = `civic-spark-${workspace.id}`;
  const binding = new SpriteClient().provisioningBinding();
  if (!binding) throw Error("Fixture binding");
  service.reserveInitialCreation(workspace.id, name, binding);
  unwrap(service.setSprite(workspace.id, name, "ready", null));
  const runtime = provider();
  const coordinator = new WorkspaceLifecycle(service, runtime, vi.fn(), () => false);
  const current = () => unwrap(service.workspace(actor, workspace.id));
  const action = (
    kind: "pause" | "delete",
    generation = service.runtime(workspace.id).generation,
  ) => coordinator.changeSprite(actor, event.id, workspace.id, kind, generation);
  return { path, service, event, workspace, name, runtime, coordinator, current, action };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function deletionTransport(
  status = 204,
  after: "missing" | "present" | "auth" | "network" = "missing",
) {
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "fixture-org");
  let deleted = false;
  return vi.fn<typeof fetch>(async (url, options) => {
    if (options?.method === "DELETE") {
      deleted = true;
      return new Response(null, { status });
    }
    if (deleted && after === "network") throw Error("PRIVATE network detail");
    if (deleted && after === "auth") return new Response(null, { status: 401 });
    if (new URL(String(url)).search) return Response.json({ name: "fixture-org", sprites: [] });
    if (deleted && after === "missing") return new Response(null, { status: 404 });
    return Response.json({
      id: "resource-id",
      name: "civic-spark-fixture",
      organization: "fixture-org",
    });
  });
}
it.each([204, 404])("confirms exact authenticated absence after DELETE %s", async (status) => {
  const request = deletionTransport(status);
  const managed = vi.fn();
  await new SpriteLifecycle(
    "fixture-org/id/token/value",
    "https://api.example",
    request,
    managed,
  ).destroy("civic-spark-fixture");
  expect(request.mock.calls.map(([, options]) => options?.method)).toEqual([
    "GET",
    "GET",
    "DELETE",
    "GET",
    "GET",
  ]);
  expect(managed).not.toHaveBeenCalled();
});
it.each([200, 202, 401, 403, 429, 500, 503])(
  "does not retire metadata for DELETE HTTP %s",
  async (status) => {
    const request = deletionTransport(status);
    await expect(
      new SpriteLifecycle("fixture-org/id/token/value", "https://api.example", request).destroy(
        "civic-spark-fixture",
      ),
    ).rejects.toThrow(`(${status})`);
  },
);
it.each(["present", "auth", "network"] as const)(
  "rejects acknowledged DELETE with %s follow-up",
  async (after) => {
    const request = deletionTransport(204, after);
    await expect(
      new SpriteLifecycle("fixture-org/id/token/value", "https://api.example", request).destroy(
        "civic-spark-fixture",
      ),
    ).rejects.toThrow();
  },
);
it("accepts already absent resources only after authenticated exact404 and rejects wrong identity before DELETE", async () => {
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "fixture-org");
  let missing = true;
  const request = vi.fn<typeof fetch>(async (url) =>
    new URL(String(url)).search
      ? Response.json({ name: "fixture-org", sprites: [] })
      : missing
        ? new Response(null, { status: 404 })
        : Response.json({ id: "wrong", name: "civic-spark-other", organization: "fixture-org" }),
  );
  const adapter = new SpriteLifecycle("fixture-org/id/token/value", "https://api.example", request);
  await adapter.destroy("civic-spark-fixture");
  missing = false;
  await expect(adapter.destroy("civic-spark-fixture")).rejects.toThrow();
  expect(request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
});
it("estimates one continuously-up amount with documented average resources and setup overrides", () => {
  const now = Date.parse("2026-09-16T02:00:00Z");
  expect(spriteEstimate("2026-09-16T00:00:00Z", now)).toEqual({
    assumedRuntimeHours: 2,
    estimatedUsd: 2 * (0.6 * 0.07 + 1.5 * 0.04375 + 5 * 0.000683 + 10 * 0.000027),
  });
  vi.stubEnv("CIVIC_SPARK_ESTIMATE_CPU", "1");
  expect(spriteEstimate("2026-09-16T00:00:00Z", now).estimatedUsd).toBeCloseTo(0.27862);
  expect(spriteEstimate(null, now).estimatedUsd).toBeNull();
  expect(spriteEstimate("2026-09-17T00:00:00Z", now).estimatedUsd).toBeNull();
});

it("scopes individual HTTP actions to event admins and exactly one reservation, with session/origin/schema checks", async () => {
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "fixture-org");
  vi.stubEnv("SPRITE_TOKEN", "fixture-org/id/token/value");
  const runtime = provider();
  const origin = "http://127.0.0.1:4310";
  const setup = await createApp(root(), true, origin, undefined, "email", undefined, runtime);
  const { service, app, authentication } = setup;
  try {
    const admin = await testIdentity(authentication, "Row admin");
    const member = await testIdentity(authentication, "Row member");
    const other = await testIdentity(authentication, "Other admin");
    if (!admin.actor || !member.actor || !other.actor) throw new Error("Fixture actors");
    const event = unwrap(service.createEvent(admin.actor, input));
    unwrap(service.transition(admin.actor, event.id, "registration"));
    const team = unwrap(
      service.createTeam(admin.actor, {
        eventId: event.id,
        name: "Fixture team",
        projectId: "data-starter",
      }),
    );
    const own = unwrap(service.joinTeam(member.actor, team.team.id));
    const another = unwrap(service.createEvent(other.actor, { ...input, name: "Other event" }));
    const foreign = unwrap(
      service.createTeam(other.actor, {
        eventId: another.id,
        name: "Other team",
        projectId: "data-starter",
      }),
    ).workspace;
    for (const w of [team.workspace, own, foreign])
      unwrap(service.setSprite(w.id, `civic-spark-${w.id}`, "ready", null));
    const url = `/api/events/${event.id}/sprites/${own.id}`;
    const headers = { cookie: admin.cookie, origin };
    const post = (extra = {}, body = { action: "pause", generation: 0 }, path = url) =>
      app.inject({ method: "POST", url: path, headers: { ...headers, ...extra }, payload: body });
    for (const action of ["pause", "delete"]) {
      expect((await post({ cookie: "" }, { action, generation: 0 })).statusCode).toBe(401);
      for (const cookie of [member.cookie, other.cookie])
        expect((await post({ cookie }, { action, generation: 0 })).statusCode).toBe(403);
      expect(
        (await post({ origin: "https://attacker.example" }, { action, generation: 0 })).statusCode,
      ).toBe(403);
      expect(
        (await post({}, { action, generation: 0 }, `/api/events/${event.id}/sprites/${foreign.id}`))
          .statusCode,
      ).toBe(404);
    }
    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect((await post({}, { action: "pause", generation: -1 })).statusCode).toBe(400);
    expect((await post()).json()).toEqual({ failures: 0 });
    expect(runtime.stop).toHaveBeenCalledExactlyOnceWith(`civic-spark-${own.id}`);
    expect(service.runtime(team.workspace.id).held).toBe(false);
    expect((await post({}, { action: "delete", generation: 0 })).statusCode).toBe(409);
    expect(
      (await post({}, { action: "delete", generation: service.runtime(own.id).generation })).json(),
    ).toEqual({ failures: 0 });
    expect(runtime.destroy).toHaveBeenCalledExactlyOnceWith(`civic-spark-${own.id}`);
    expect(service.runtime(own.id).reset).toBeDefined();
    expect(service.provisioningRecords().find((w) => w.id === own.id)?.spriteName).toBeNull();
    expect(
      (
        await app.inject({
          url: `/api/teams/${team.team.id}/export`,
          headers: { ...headers, cookie: member.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(service.runtime(foreign.id).held).toBe(false);
  } finally {
    await app.close();
  }
});

it("gates before abort/drain, rejects concurrent wake/bulk/delete, and leaves unknown failure held and provider-bound across restart", async () => {
  const f = fixture();
  const lease = f.coordinator.acquire(f.name);
  f.runtime.destroy.mockRejectedValueOnce(new Error("PRIVATE failure"));
  const pending = f.action("delete");
  expect(lease.signal.aborted).toBe(true);
  expect(f.service.wakeWorkspace(actor, f.workspace.id)).toMatchObject({ ok: false, status: 423 });
  expect(f.service.executionAllowed(f.workspace.id)).toMatchObject({ ok: false, status: 423 });
  expect(await f.action("delete")).toMatchObject({ ok: false, status: 409 });
  expect(await f.coordinator.change(actor, f.event.id, "pause-event")).toMatchObject({
    ok: false,
    status: 409,
  });
  expect(f.runtime.destroy).not.toHaveBeenCalled();
  lease.release();
  expect(unwrap(await pending).failures).toBe(1);
  expect(f.service.runtime(f.workspace.id).deletion).toMatchObject({
    state: "failed",
    org: "fixture-org",
  });
  f.coordinator.close();
  f.service.close();
  const service = new EventService(f.path);
  const runtime = provider();
  const coordinator = new WorkspaceLifecycle(service, runtime, vi.fn(), () => false);
  try {
    expect(service.wakeWorkspace(actor, f.workspace.id)).toMatchObject({ ok: false, status: 423 });
    vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "wrong-org");
    expect(
      await coordinator.changeSprite(
        actor,
        f.event.id,
        f.workspace.id,
        "delete",
        service.runtime(f.workspace.id).generation,
      ),
    ).toMatchObject({ ok: false, status: 409 });
    expect(runtime.destroy).not.toHaveBeenCalled();
    vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "fixture-org");
    vi.stubEnv("SPRITE_TOKEN", "fixture-org/id/token/value");
    expect(
      unwrap(
        await coordinator.changeSprite(
          actor,
          f.event.id,
          f.workspace.id,
          "delete",
          service.runtime(f.workspace.id).generation,
        ),
      ).failures,
    ).toBe(0);
  } finally {
    coordinator.close();
    service.close();
  }
});

it("marks interrupted durable deletion retryable at restart without provider calls", () => {
  const f = fixture();
  unwrap(
    f.service.holdSprite(actor, f.event.id, f.workspace.id, 0, {
      org: "fixture-org",
      apiOrigin: "https://api.sprites.dev",
    }),
  );
  f.coordinator.close();
  f.service.close();
  const service = new EventService(f.path);
  const runtime = provider();
  const coordinator = new WorkspaceLifecycle(service, runtime, vi.fn(), () => false);
  try {
    expect(service.runtime(f.workspace.id)).toMatchObject({
      held: true,
      deletion: { state: "failed" },
    });
    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
  } finally {
    coordinator.close();
    service.close();
  }
});

it.each(["missing", "allocated-personal"])(
  "connects a fresh %s Sprite only from shared main, preserving workspace/history and retired origin",
  async (existence) => {
    const f = fixture();
    vi.stubEnv("SPRITE_TOKEN", "fixture-org/id/token/value");
    const shared = f.service.sharedWorkspaceRepository(f.workspace.id);
    const head = git(shared, ["rev-parse", "main"]).toString();
    writeFileSync(join(f.service.workspacePath(f.workspace.id), "PRIVATE.txt"), "never share this");
    git(f.service.workspacePath(f.workspace.id), ["add", "PRIVATE.txt"]);
    git(f.service.workspacePath(f.workspace.id), [
      "commit",
      "-m",
      "Unshared private fixture commit",
    ]);
    writeFileSync(
      join(f.path, "preview-origins.json"),
      JSON.stringify({ [f.workspace.id]: "https://permanent.example.test" }),
    );
    const client = new SpriteClient();
    const existingResource = { id: "stable-resource-id", name: "", organization: "personal" };
    const metadata = vi.fn<typeof fetch>(async (url) =>
      new URL(String(url)).searchParams.has("prefix")
        ? Response.json({
            name: "fixture-org",
            sprites: [existingResource],
            has_more: false,
            next_continuation_token: null,
          })
        : new URL(String(url)).search
          ? Response.json({
              name: "fixture-org",
              sprites: [{ name: "unrelated", organization: "unexplained-claim" }],
            })
          : existence === "allocated-personal"
            ? Response.json(existingResource)
            : new Response(null, { status: 404 }),
    );
    const inspect = vi.fn<typeof inspectRecoverySprite>((name, org, origin, token) =>
      inspectRecoverySprite(name, org, origin, token, metadata),
    );
    const create = vi.spyOn(client, "create").mockResolvedValue(ok(f.name));
    const files = vi.spyOn(client, "files").mockResolvedValue(ok(["README.md"]));
    const exec = vi.spyOn(client, "exec").mockResolvedValue(ok(Buffer.alloc(0)));
    if (existence === "allocated-personal")
      files.mockResolvedValueOnce(fail("Project not initialized"));
    const upload = vi.spyOn(client, "uploadBundle").mockImplementation(async (_name, bundle) => {
      const path = join(f.path, "shared-rebuild");
      git(f.path, ["clone", bundle, path]);
      expect(git(path, ["rev-parse", "HEAD"]).toString()).toBe(head);
      expect(git(path, ["ls-files"]).toString()).not.toContain("PRIVATE.txt");
      return ok(Buffer.alloc(0));
    });
    const provisioning = new WorkspaceProvisioning(f.service, f.path, client, inspect);
    try {
      unwrap(await f.action("delete"));
      const replacementName = f.service.runtime(f.workspace.id).reset?.name as string;
      existingResource.name = replacementName;
      expect(replacementName).not.toBe(f.name);
      const oldGeneration = f.service.runtime(f.workspace.id).generation;
      expect(await provisioning.start(f.current())).toMatchObject({ ok: false, status: 423 });
      unwrap(f.service.setExecution(actor, f.event.id, true));
      expect(f.service.wakeWorkspace(actor, f.workspace.id)).toMatchObject({
        ok: false,
        status: 423,
      });
      expect(create).not.toHaveBeenCalled();
      unwrap(f.service.setExecution(actor, f.event.id, false));
      unwrap(f.service.wakeWorkspace(actor, f.workspace.id));
      unwrap(await provisioning.start(f.current()));
      await provisioning.wait(f.workspace.id);
      expect(f.current()).toMatchObject({
        id: f.workspace.id,
        spriteName: replacementName,
        spriteStatus: "ready",
      });
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(metadata.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/v1/sprites",
        `/v1/sprites/${replacementName}`,
        ...(existence === "allocated-personal" ? ["/v1/sprites"] : []),
      ]);
      if (existence === "allocated-personal") {
        expect(create).not.toHaveBeenCalled();
        expect(exec).toHaveBeenCalledWith(replacementName, [
          "bash",
          "-lc",
          "test ! -e /home/sprite/project && test ! -L /home/sprite/project",
        ]);
      } else expect(create).toHaveBeenCalledExactlyOnceWith(replacementName);
      expect(upload).toHaveBeenCalledTimes(1);
      expect(f.service.runtime(f.workspace.id).deletion).toBeNull();
      expect(await f.action("delete", oldGeneration)).toMatchObject({ ok: false, status: 409 });
      expect(f.runtime.destroy).toHaveBeenCalledTimes(1);
      expect(git(shared, ["rev-parse", "main"]).toString()).toBe(head);
      expect(JSON.parse(readFileSync(join(f.path, "preview-origins.json"), "utf8"))).toEqual({
        [f.workspace.id]: "https://permanent.example.test",
      });
    } finally {
      await provisioning.close();
      f.coordinator.close();
      f.service.close();
    }
  },
);

it("admits additional Sprites and explicit deleted-Sprite recovery without an allocation quota", async () => {
  const f = fixture();
  vi.stubEnv("CIVIC_SPARK_MAX_SPRITES", "1");
  const another = unwrap(
    f.service.createTeam(actor, {
      eventId: f.event.id,
      name: "Capacity team",
      projectId: "data-starter",
    }),
  ).workspace;
  const client = new SpriteClient();
  const create = vi.spyOn(client, "create").mockResolvedValue(ok("created"));
  vi.spyOn(client, "uploadBundle").mockResolvedValue(ok(Buffer.alloc(0)));
  vi.spyOn(client, "files").mockResolvedValue(ok(["README.md"]));
  const inspect = vi.fn().mockResolvedValue("missing" as const);
  const provisioning = new WorkspaceProvisioning(f.service, f.path, client, inspect);
  try {
    unwrap(await f.action("delete"));
    unwrap(await provisioning.start(another));
    await provisioning.wait(another.id);
    expect(create).toHaveBeenCalledExactlyOnceWith(`civic-spark-${another.id}`);
    unwrap(f.service.wakeWorkspace(actor, f.workspace.id));
    unwrap(await provisioning.start(f.current()));
    await provisioning.wait(f.workspace.id);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(f.service.runtime(f.workspace.id).deletion).toBeNull();
  } finally {
    await provisioning.close();
    f.coordinator.close();
    f.service.close();
  }
});

it.each(["pause", "pause-sprites", "pause-event"] as const)(
  "drains an in-flight deleted-Sprite replacement during %s and retains its recovery permission",
  async (bulk) => {
    const f = fixture();
    unwrap(await f.action("delete"));
    f.coordinator.close();
    const client = new SpriteClient();
    let resolveCreate!: () => void;
    const create = vi.spyOn(client, "create").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveCreate = resolve;
      });
      return ok(f.name);
    });
    const upload = vi.spyOn(client, "uploadBundle").mockResolvedValue(ok(Buffer.alloc(0)));
    const provisioning = new WorkspaceProvisioning(
      f.service,
      f.path,
      client,
      vi.fn().mockResolvedValue("missing" as const),
    );
    const coordinator = new WorkspaceLifecycle(
      f.service,
      f.runtime,
      vi.fn(),
      () => false,
      () => false,
      (id) => provisioning.wait(id),
    );
    try {
      unwrap(f.service.wakeWorkspace(actor, f.workspace.id));
      unwrap(await provisioning.start(f.current()));
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      const pause =
        bulk === "pause"
          ? coordinator.changeSprite(
              actor,
              f.event.id,
              f.workspace.id,
              "pause",
              f.service.runtime(f.workspace.id).generation,
            )
          : coordinator.change(actor, f.event.id, bulk);
      expect(f.service.runtime(f.workspace.id).held).toBe(true);
      expect(f.service.wakeWorkspace(actor, f.workspace.id)).toMatchObject({
        ok: false,
        status: 423,
      });
      expect(f.runtime.stop).not.toHaveBeenCalled();
      resolveCreate();
      expect((await pause).ok).toBe(true);
      expect(upload).not.toHaveBeenCalled();
      expect(f.runtime.stop).toHaveBeenCalledExactlyOnceWith(
        f.service.runtime(f.workspace.id).reset?.name,
      );
      expect(f.service.runtime(f.workspace.id).reset).toBeDefined();
    } finally {
      await provisioning.close();
      coordinator.close();
      f.service.close();
    }
  },
);

it("does not replace a present resource after an interrupted rebuild, and rechecks unknown provider outcomes on retry", async () => {
  const f = fixture();
  unwrap(await f.action("delete"));
  const client = new SpriteClient();
  const create = vi.spyOn(client, "create").mockResolvedValue(ok(f.name));
  const upload = vi.spyOn(client, "uploadBundle").mockResolvedValue(fail("Fixture upload failure"));
  vi.spyOn(client, "files").mockResolvedValue(ok(["private-existing.txt"]));
  const inspect = vi
    .fn()
    .mockRejectedValueOnce(new Error("401 or network unknown"))
    .mockResolvedValueOnce("missing" as const)
    .mockResolvedValueOnce("present" as const);
  const provisioning = new WorkspaceProvisioning(f.service, f.path, client, inspect);
  try {
    unwrap(f.service.wakeWorkspace(actor, f.workspace.id));
    for (let n = 0; n < 3; n++) {
      unwrap(await provisioning.start(f.current()));
      await provisioning.wait(f.workspace.id);
    }
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(create).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(f.current().spriteStatus).toBe("ready");
    expect(f.service.runtime(f.workspace.id).deletion).toBeNull();
  } finally {
    await provisioning.close();
    f.coordinator.close();
    f.service.close();
  }
});

it.each(["wake", "sprite"] as const)(
  "keeps every failed deleted-Sprite preflight held through POST %s and passive polling",
  async (route) => {
    vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "fixture-org");
    vi.stubEnv("SPRITE_TOKEN", "fixture-org/id/token/value");
    const runtime = provider();
    const origin = "http://127.0.0.1:4310";
    const setup = await createApp(root(), true, origin, undefined, "email", undefined, runtime);
    const { service, app, authentication } = setup;
    const create = vi.spyOn(SpriteClient.prototype, "create").mockResolvedValue(ok("fixture"));
    const exec = vi.spyOn(SpriteClient.prototype, "exec").mockResolvedValue(ok(Buffer.alloc(0)));
    try {
      const owner = await testIdentity(authentication, "Preflight owner");
      if (!owner.actor) throw new Error("Fixture actor");
      const event = unwrap(service.createEvent(owner.actor, input));
      const own = unwrap(
        service.createTeam(owner.actor, {
          eventId: event.id,
          name: "Recovery preflight",
          projectId: "data-starter",
        }),
      ).workspace;
      const another = unwrap(
        service.createTeam(owner.actor, {
          eventId: event.id,
          name: "Other allocated",
          projectId: "data-starter",
        }),
      ).workspace;
      for (const w of [own, another])
        unwrap(service.setSprite(w.id, `civic-spark-${w.id}`, "ready", null));
      const headers = { cookie: owner.cookie, origin };
      const destroy = await app.inject({
        method: "POST",
        url: `/api/events/${event.id}/sprites/${own.id}`,
        headers,
        payload: { action: "delete", generation: 0 },
      });
      expect(destroy.json()).toEqual({ failures: 0 });
      for (const endpoint of ["wake", "sprite"]) {
        const stale = await app.inject({
          method: "POST",
          url: `/api/workspaces/${own.id}/${endpoint}`,
          headers,
        });
        expect(stale.statusCode).toBe(409);
        expect(service.runtime(own.id).held).toBe(true);
        expect(create).not.toHaveBeenCalled();
        const staleGeneration = await app.inject({
          method: "POST",
          url: `/api/workspaces/${own.id}/${endpoint}`,
          headers,
          payload: { action: "connect-new", generation: 0 },
        });
        expect(staleGeneration.statusCode).toBe(409);
      }
      const post = () =>
        app.inject({
          method: "POST",
          url: `/api/workspaces/${own.id}/${route}`,
          headers,
          payload: { action: "connect-new", generation: service.runtime(own.id).generation },
        });
      vi.stubEnv("CIVIC_SPARK_MAX_PROVISIONING", "invalid");
      const invalid = await post();
      expect(invalid.statusCode).toBe(503);
      expect(invalid.json()).toEqual({
        error: "Workspace preparation could not start. Check installation configuration and retry.",
      });
      expect(service.runtime(own.id).held).toBe(true);
      vi.stubEnv("CIVIC_SPARK_MAX_PROVISIONING", "2");
      vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "different-org");
      expect((await post()).statusCode).toBe(409);
      expect(service.runtime(own.id).held).toBe(true);
      vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "fixture-org");
      vi.stubEnv("SPRITE_TOKEN", "fixture-org/id/token/value");
      // A genuine in-flight provisioning job occupies the single concurrent slot.
      vi.stubEnv("CIVIC_SPARK_MAX_PROVISIONING", "1");
      const third = unwrap(
        service.createTeam(owner.actor, {
          eventId: event.id,
          name: "Pending creation",
          projectId: "data-starter",
        }),
      ).workspace;
      let finish!: () => void;
      create.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return fail("Fixture interrupted create");
      });
      expect(
        (await app.inject({ method: "POST", url: `/api/workspaces/${third.id}/sprite`, headers }))
          .statusCode,
      ).toBe(202);
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      expect((await post()).statusCode).toBe(429);
      expect(service.runtime(own.id).held).toBe(true);
      for (const endpoint of ["files", "preview", "manifest", "changes", "team-status"])
        expect(
          (await app.inject({ url: `/api/workspaces/${own.id}/${endpoint}`, headers })).statusCode,
        ).toBe(423);
      expect(
        (await app.inject({ url: `/api/workspaces/${own.id}/sprite`, headers })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ url: `/api/events/${event.id}/sprites`, headers })).statusCode,
      ).toBe(200);
      expect(create).toHaveBeenCalledTimes(1);
      expect(exec).not.toHaveBeenCalled();
      finish();
    } finally {
      await app.close();
    }
  },
);

it("rejects HTTP wake before any reservation or provider work when cloud workspaces are disabled", async () => {
  const runtime = provider();
  const origin = "http://127.0.0.1:4310";
  const { service, app, authentication } = await createApp(
    root(),
    false,
    origin,
    undefined,
    "email",
    undefined,
    runtime,
  );
  const create = vi.spyOn(SpriteClient.prototype, "create").mockResolvedValue(ok("unexpected"));
  const exec = vi.spyOn(SpriteClient.prototype, "exec").mockResolvedValue(ok(Buffer.alloc(0)));
  try {
    const owner = await testIdentity(authentication, "Local owner");
    if (!owner.actor) throw new Error("Fixture actor");
    const event = unwrap(service.createEvent(owner.actor, input));
    const own = unwrap(
      service.createTeam(owner.actor, {
        eventId: event.id,
        name: "Local workspace",
        projectId: "data-starter",
      }),
    ).workspace;
    const before = structuredClone(service.provisioningRecords());
    const previousRuntime = service.runtime(own.id);
    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${own.id}/wake`,
      headers: { cookie: owner.cookie, origin },
    });
    expect(response.statusCode).toBe(409);
    expect(service.provisioningRecords()).toEqual(before);
    expect(service.runtime(own.id)).toEqual(previousRuntime);
    expect(create).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("clears only the confirmed generation metadata and resumes interrupted cleanup without provider calls", async () => {
  const f = fixture();
  const { mkdirSync } = await import("node:fs");
  const { recoveryResourcesFile, readRecoveryResources } = await import(
    "../packages/backup/src/recovery.ts"
  );
  const other = unwrap(
    f.service.createTeam(actor, {
      eventId: f.event.id,
      name: "Unaffected",
      projectId: "data-starter",
    }),
  ).workspace;
  const client = new SpriteClient();
  const binding = client.provisioningBinding();
  if (!binding) throw Error("Fixture binding");
  // Include obsolete checkout repair and old restore evidence, including a stale name.
  f.service.setRuntime(f.workspace.id, {
    projectRepair: { ...binding, name: f.name },
    stopError: "obsolete",
    stoppedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  });
  mkdirSync(join(f.path, "agent-integrations"));
  writeFileSync(
    join(f.path, "agent-integrations", `${f.workspace.id}.json`),
    "old conflict ticket",
  );
  const entries = [f.workspace, other].map((w) => ({
    workspaceId: w.id,
    spriteName: `civic-spark-${w.id}`,
    status: "confirmed-missing",
    observedAt: new Date().toISOString(),
    httpStatus: 404,
  }));
  writeFileSync(
    join(f.path, recoveryResourcesFile),
    JSON.stringify({
      version: 1,
      backupId: crypto.randomUUID(),
      provider: "sprites",
      org: "fixture-org",
      apiOrigin: "https://api.sprites.dev",
      entries,
    }),
  );
  const before = f.service.portal(actor, true);
  // Crash window after provider receipt and engine reset, before access.sqlite reset.
  const setRuntime = f.service.setRuntime.bind(f.service);
  const finish = vi.spyOn(f.service, "setRuntime").mockImplementation((id, change) => {
    if (change.reset) throw Error("disk full");
    return setRuntime(id, change);
  });
  expect(unwrap(await f.action("delete")).failures).toBe(1);
  expect(f.service.runtime(f.workspace.id).deletion?.state).toBe("deleted");
  expect(f.service.wakeWorkspace(actor, f.workspace.id)).toMatchObject({ ok: false, status: 423 });
  expect(unwrap(f.service.spriteInventory(actor, f.event.id))[0]?.spriteName).toBe(f.name);
  finish.mockRestore();
  f.coordinator.close();
  f.service.close();
  const service = new EventService(f.path);
  const runtime = provider();
  const coordinator = new WorkspaceLifecycle(service, runtime, vi.fn(), () => false);
  try {
    const state = service.runtime(f.workspace.id);
    expect(state).toMatchObject({
      generation: 2,
      held: true,
      deletion: null,
      stopError: null,
      stopState: null,
      stoppedAt: null,
      lastUsedAt: null,
    });
    expect(state.projectRepair).toBeUndefined();
    expect(state.reset?.name).not.toBe(f.name);
    expect(service.initialCreation(f.workspace.id)).toBeNull();
    expect(unwrap(service.workspace(actor, f.workspace.id))).toMatchObject({
      spriteName: null,
      spriteStatus: "local",
      spriteError: null,
      spritePhase: null,
      spriteCreationFailure: null,
    });
    expect(readRecoveryResources(f.path)?.entries.map((e) => e.workspaceId)).toEqual([other.id]);
    expect(runtime.destroy).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
    expect(service.portal(actor, true).teams).toEqual(before.teams);
    expect(service.portal(actor, true).events).toEqual(before.events);
    expect(
      await coordinator.changeSprite(actor, f.event.id, f.workspace.id, "delete", 0),
    ).toMatchObject({ ok: false });
  } finally {
    coordinator.close();
    service.close();
  }
});

it("drains an active turn and ignores stale ordinary provisioning failure before resetting", async () => {
  const f = fixture();
  f.coordinator.close();
  const active = { working: true };
  let drained!: () => void;
  const drain = new Promise<void>((resolve) => {
    drained = resolve;
  });
  const coordinator = new WorkspaceLifecycle(
    f.service,
    f.runtime,
    () => {
      active.working = false;
    },
    () => active.working,
    () => false,
    () => drain,
  );
  const lease = coordinator.acquire(f.name);
  const pending = coordinator.changeSprite(actor, f.event.id, f.workspace.id, "delete", 0);
  expect(active.working).toBe(false);
  expect(lease.signal.aborted).toBe(true);
  lease.release();
  await Promise.resolve();
  expect(f.runtime.destroy).not.toHaveBeenCalled();
  drained();
  expect(unwrap(await pending).failures).toBe(0);
  expect(() => coordinator.acquire(f.name)).toThrow("not allocated");
  expect(f.service.runtime(f.workspace.id).reset).toBeDefined();
  coordinator.close();
  f.service.close();
});

it("retries confirmed local cleanup without a second provider deletion", async () => {
  const f = fixture();
  const finish = vi.spyOn(f.service, "finishSpriteDeletion").mockImplementationOnce(() => {
    throw Error("storage unavailable");
  });
  try {
    expect(unwrap(await f.action("delete")).failures).toBe(1);
    expect(f.service.runtime(f.workspace.id).deletion?.state).toBe("deleted");
    expect(f.service.wakeWorkspace(actor, f.workspace.id).ok).toBe(false);
    expect(unwrap(await f.action("delete")).failures).toBe(0);
    expect(f.runtime.destroy).toHaveBeenCalledTimes(1);
    expect(f.service.runtime(f.workspace.id).reset).toBeDefined();
  } finally {
    finish.mockRestore();
    f.coordinator.close();
    f.service.close();
  }
});

it("does not let a late ordinary preparation callback restore the deleted identity", async () => {
  const f = fixture();
  f.coordinator.close();
  unwrap(f.service.setSprite(f.workspace.id, f.name, "error", "retry"));
  const client = new SpriteClient();
  let release!: () => void;
  const exec = vi.spyOn(client, "exec").mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return ok(Buffer.alloc(0));
  });
  const upload = vi.spyOn(client, "uploadBundle").mockResolvedValue(ok(Buffer.alloc(0)));
  const provisioning = new WorkspaceProvisioning(f.service, f.path, client);
  const coordinator = new WorkspaceLifecycle(
    f.service,
    f.runtime,
    vi.fn(),
    () => false,
    () => false,
    (id) => provisioning.wait(id),
  );
  try {
    unwrap(await provisioning.start(f.current()));
    await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce());
    const pending = coordinator.changeSprite(actor, f.event.id, f.workspace.id, "delete", 0);
    await Promise.resolve();
    expect(f.runtime.destroy).not.toHaveBeenCalled();
    release();
    expect(unwrap(await pending).failures).toBe(0);
    expect(upload).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({
      spriteName: null,
      spriteStatus: "local",
      spriteError: null,
    });
    await provisioning.wait(f.workspace.id);
    expect(f.current().spriteName).toBeNull();
  } finally {
    await provisioning.close();
    coordinator.close();
    f.service.close();
  }
});

it("drains a complete HTTP operation before provider deletion, including delayed command completion", async () => {
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "fixture-org");
  const runtime = provider();
  const origin = "http://127.0.0.1:4310";
  const { service, app, authentication } = await createApp(
    root(),
    true,
    origin,
    undefined,
    "email",
    undefined,
    runtime,
  );
  let release!: () => void;
  const files = vi.spyOn(SpriteClient.prototype, "files").mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return ok(["README.md"]);
  });
  try {
    const owner = await testIdentity(authentication, "Drain owner");
    if (!owner.actor) throw Error("Fixture actor");
    const event = unwrap(service.createEvent(owner.actor, input));
    const workspace = unwrap(
      service.createTeam(owner.actor, {
        eventId: event.id,
        name: "HTTP drain",
        projectId: "data-starter",
      }),
    ).workspace;
    unwrap(service.setSprite(workspace.id, `civic-spark-${workspace.id}`, "ready", null));
    const headers = { cookie: owner.cookie, origin };
    const reading = app
      .inject({ url: `/api/workspaces/${workspace.id}/files`, headers })
      .then((result) => result);
    await vi.waitFor(() => expect(files).toHaveBeenCalledOnce());
    const deleting = app
      .inject({
        method: "POST",
        url: `/api/events/${event.id}/sprites/${workspace.id}`,
        headers,
        payload: { action: "delete", generation: 0 },
      })
      .then((result) => result);
    await vi.waitFor(() => expect(service.runtime(workspace.id).deletion?.state).toBe("pending"));
    expect(runtime.destroy).not.toHaveBeenCalled();
    release();
    await reading;
    expect((await deleting).json()).toEqual({ failures: 0 });
    expect(runtime.destroy).toHaveBeenCalledOnce();
    expect(service.runtime(workspace.id).reset).toBeDefined();
  } finally {
    await app.close();
  }
});
