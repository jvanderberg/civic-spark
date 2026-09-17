import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspaceLifecycle } from "../apps/server/src/lifecycle.ts";
import { WorkspaceProvisioning } from "../apps/server/src/provisioning.ts";
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
  const path = root();
  const service = new EventService(path);
  const event = unwrap(service.createEvent(actor, input));
  const workspace = unwrap(
    service.createTeam(actor, { eventId: event.id, name: "First team", projectId: "data-starter" }),
  ).workspace;
  const name = `civic-spark-${workspace.id}`;
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

it.each([204, 404])(
  "accepts only confirmed DELETE outcomes (%s), without exec or response body access",
  async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    const managed = vi.fn();
    const adapter = new SpriteLifecycle("fixture", "https://api.example", request, managed);
    await adapter.destroy("civic-spark-fixture");
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "https://api.example/v1/sprites/civic-spark-fixture",
      expect.objectContaining({ method: "DELETE", redirect: "error" }),
    );
    expect(managed).not.toHaveBeenCalled();
  },
);
it.each([200, 202, 401, 403, 429, 500, 503])(
  "does not report deletion success for HTTP %s",
  async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("PRIVATE", { status }));
    await expect(
      new SpriteLifecycle("fixture", "https://api.example", request).destroy("civic-spark-fixture"),
    ).rejects.toThrow(`(${status})`);
  },
);
it("treats network failure as unknown, and retries named DELETE without guessing existence", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockResolvedValueOnce(new Response(null, { status: 404 }));
  const adapter = new SpriteLifecycle("fixture", "https://api.example", request);
  await expect(adapter.destroy("civic-spark-fixture")).rejects.toThrow();
  await adapter.destroy("civic-spark-fixture");
  expect(request).toHaveBeenCalledTimes(2);
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
  const runtime = provider();
  const origin = "http://127.0.0.1:4310";
  const setup = await createApp(
    root(),
    true,
    origin,
    undefined,
    "email",
    undefined,
    undefined,
    runtime,
  );
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
    expect(service.runtime(own.id).deletion?.state).toBe("deleted");
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

it("reopens a deleted reservation only from shared main, preserving history/identity/origin and rejecting stale deletion after recreation", async () => {
  const f = fixture();
  const shared = f.service.sharedWorkspaceRepository(f.workspace.id);
  const head = git(shared, ["rev-parse", "main"]).toString();
  writeFileSync(join(f.service.workspacePath(f.workspace.id), "PRIVATE.txt"), "never share this");
  writeFileSync(
    join(f.path, "preview-origins.json"),
    JSON.stringify({ [f.workspace.id]: "https://permanent.example.test" }),
  );
  const client = new SpriteClient();
  const inspect = vi.fn().mockResolvedValue("missing" as const);
  const create = vi.spyOn(client, "create").mockResolvedValue(ok(f.name));
  vi.spyOn(client, "files").mockResolvedValue(ok(["README.md"]));
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
    const oldGeneration = f.service.runtime(f.workspace.id).generation;
    expect(provisioning.start(f.current())).toMatchObject({ ok: false, status: 423 });
    unwrap(f.service.setExecution(actor, f.event.id, true));
    expect(f.service.wakeWorkspace(actor, f.workspace.id)).toMatchObject({
      ok: false,
      status: 423,
    });
    expect(create).not.toHaveBeenCalled();
    unwrap(f.service.setExecution(actor, f.event.id, false));
    unwrap(f.service.wakeWorkspace(actor, f.workspace.id));
    unwrap(provisioning.start(f.current()));
    await provisioning.wait(f.workspace.id);
    expect(f.current()).toMatchObject({
      id: f.workspace.id,
      spriteName: f.name,
      spriteStatus: "ready",
    });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledExactlyOnceWith(f.name);
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
});

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
    unwrap(provisioning.start(another));
    await provisioning.wait(another.id);
    expect(create).toHaveBeenCalledExactlyOnceWith(`civic-spark-${another.id}`);
    unwrap(f.service.wakeWorkspace(actor, f.workspace.id));
    unwrap(provisioning.start(f.current()));
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
      unwrap(provisioning.start(f.current()));
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
      expect(f.runtime.stop).toHaveBeenCalledExactlyOnceWith(f.name);
      expect(f.service.runtime(f.workspace.id).deletion).toMatchObject({
        state: "deleted",
        replacementReserved: true,
      });
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
      unwrap(provisioning.start(f.current()));
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
    const runtime = provider();
    const origin = "http://127.0.0.1:4310";
    const setup = await createApp(
      root(),
      true,
      origin,
      undefined,
      "email",
      undefined,
      undefined,
      runtime,
    );
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
      const post = () =>
        app.inject({ method: "POST", url: `/api/workspaces/${own.id}/${route}`, headers });
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
