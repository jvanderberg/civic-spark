import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { EventService } from "../packages/domain/src/service.ts";
import { ok, type Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "./auth-fixture.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const unwrap = <T>(r: Result<T>) => {
  if (!r.ok) throw Error(r.error);
  return r.value;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  vi.stubEnv("SPRITE_TOKEN", "test-org/org-id/token-id/private-token");
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "test-org");
  vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", "https://provider.example.test");
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  const command = vi
    .spyOn(SpriteClient.prototype, "command")
    .mockRejectedValue(Error("No live CLI"));
  const files = vi.spyOn(SpriteClient.prototype, "files").mockResolvedValue(ok(["README.md"]));
  const uploaded: string[] = [];
  const upload = vi
    .spyOn(SpriteClient.prototype, "uploadBundle")
    .mockImplementation(async (_name, path) => {
      uploaded.push(git(root, ["bundle", "list-heads", path]).toString());
      return ok(Buffer.from(""));
    });
  const root = mkdtempSync(join(tmpdir(), "cs-owner-recover-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:4310";
  const { app, service, authentication } = await createApp(root, true, origin, undefined, "email");
  cleanup.push(() => app.close());
  const admin = await testIdentity(authentication, "Admin");
  const owner = await testIdentity(authentication, "Owner");
  if (!admin.actor || !owner.actor) throw Error("Fixture actor");
  const event = unwrap(
    service.createEvent(admin.actor, {
      name: "Missing recovery",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(admin.actor, event.id, "registration"));
  const team = unwrap(
    service.createTeam(admin.actor, {
      eventId: event.id,
      name: "Shared team",
      projectId: "data-starter",
    }),
  );
  const workspace = unwrap(service.joinTeam(owner.actor, team.team.id));
  const id = workspace.id;
  const name = `civic-spark-${id}`;
  unwrap(service.setSprite(id, name, "error", "The reserved Sprite is absent", "creating"));
  const record = () => service.provisioningRecords().find((w) => w.id === id);
  const body = () => ({
    action: "recover-missing",
    confirmSharedWork: true,
    name,
    generation: service.runtime(id).generation,
  });
  const post = (payload: unknown = body(), cookie = owner.cookie, requestOrigin = origin) =>
    app.inject({
      method: "POST",
      url: `/api/workspaces/${id}/sprite`,
      headers: { cookie, origin: requestOrigin },
      payload: payload as object,
    });
  const normalResponse = (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST")
      return Response.json({ name, organization: "test-org" }, { status: 201 });
    return new URL(String(url)).search
      ? Response.json({ sprites: [] })
      : new Response(null, { status: 404 });
  };
  request.mockImplementation(async (url, init) => normalResponse(url, init));
  const settle = () => expect.poll(() => record()?.spriteStatus).not.toBe("provisioning");
  return {
    root,
    app,
    service,
    authentication,
    admin,
    administrator: admin.actor,
    owner,
    event,
    team,
    id,
    name,
    request,
    command,
    files,
    upload,
    uploaded,
    record,
    body,
    post,
    normalResponse,
    settle,
  };
}

it("requires owner confirmation, correct origin/name/generation and current session; metadata never creates", async () => {
  const f = await fixture();
  expect((await f.post(f.body(), "")).statusCode).toBe(401);
  expect((await f.post(f.body(), f.admin.cookie)).statusCode).toBe(404);
  expect((await f.post(f.body(), f.owner.cookie, "https://attacker.test")).statusCode).toBe(403);
  for (const change of [{ confirmSharedWork: false }, { httpStatus: 404 }, { generation: -1 }])
    expect((await f.post({ ...f.body(), ...change })).statusCode).toBe(400);
  for (const change of [{ name: "civic-spark-other" }, { generation: 4 }])
    expect((await f.post({ ...f.body(), ...change })).statusCode).toBe(409);
  for (let i = 0; i < 2; i++) {
    const response = await f.app.inject({
      url: `/api/workspaces/${f.id}/sprite`,
      headers: { cookie: f.owner.cookie },
    });
    expect(response.json().preparationAction).toBe("recover-missing");
  }
  expect(f.request).not.toHaveBeenCalled();
  expect(f.service.runtime(f.id).deletion).toBeNull();
});

it("rebuilds a legacy reservation exactly once from shared Git, preserving identity and excluding private commits", async () => {
  const f = await fixture();
  const shared = git(f.service.sharedWorkspaceRepository(f.id), ["rev-parse", "HEAD"])
    .toString()
    .trim();
  const privateDir = f.service.workspacePath(f.id);
  writeFileSync(join(privateDir, "unshared.txt"), "Private fixture only");
  git(privateDir, ["add", "."]);
  git(privateDir, ["commit", "-m", "Unshared fixture"]);
  const privateHead = git(privateDir, ["rev-parse", "HEAD"]).toString().trim();
  const responses = await Promise.all([f.post(), f.post()]);
  expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
  await f.settle();
  expect(f.record()).toMatchObject({ id: f.id, spriteName: f.name, spriteStatus: "ready" });
  expect(f.service.initialCreation(f.id)).toBeNull();
  expect(f.service.runtime(f.id).deletion).toBeNull();
  expect(f.uploaded).toHaveLength(1);
  expect(f.uploaded[0]).toContain(shared);
  expect(f.uploaded[0]).not.toContain(privateHead);
  expect(git(privateDir, ["rev-parse", "HEAD"]).toString().trim()).toBe(privateHead);
  expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual([
    "GET",
    "GET",
    "GET",
    "GET",
    "POST",
  ]);
  expect(f.command).not.toHaveBeenCalled();
});

it.each([
  "present",
  "401",
  "403",
  "500",
  "redirect",
  "malformed",
  "wrong-org",
  "list-404",
  "list-null",
  "network",
])("fails closed for %s without durable permission, creation or checkout", async (kind) => {
  const f = await fixture();
  f.request.mockImplementation(async (url, init) => {
    const list = Boolean(new URL(String(url)).search);
    if (kind === "network") throw Error("private diagnostic");
    if (list) {
      if (kind === "list-404") return new Response(null, { status: 404 });
      if (kind === "list-null") return Response.json({ sprites: null });
      return f.normalResponse(url, init);
    }
    if (kind === "present") return Response.json({ name: f.name, organization: "test-org" });
    if (kind === "wrong-org") return Response.json({ name: f.name, organization: "wrong" });
    if (kind === "malformed") return Response.json(null);
    return new Response(null, { status: kind === "redirect" ? 302 : Number(kind) });
  });
  const before = f.service.runtime(f.id);
  expect((await f.post()).statusCode).toBe(409);
  expect(f.service.runtime(f.id)).toEqual(before);
  expect(f.request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.files).not.toHaveBeenCalled();
});

it.each([
  "signed-out",
  "revoked",
  "paused",
  "closed",
  "generation",
  "name",
  "account",
  "origin",
  "org",
])("revalidates %s after the initial delayed 404 without recording permission", async (change) => {
  const f = await fixture();
  const arrived = deferred();
  const gate = deferred();
  cleanup.push(gate.resolve);
  f.request.mockImplementation(async (url, init) => {
    if (!new URL(String(url)).search) {
      arrived.resolve();
      await gate.promise;
    }
    return f.normalResponse(url, init);
  });
  const pending = f.post();
  await arrived.promise;
  if (change === "signed-out") {
    const db = new DatabaseSync(join(f.root, "auth.sqlite"));
    db.prepare("DELETE FROM session WHERE userId=?").run(f.owner.user.id);
    db.close();
  } else if (change === "revoked")
    unwrap(f.service.removeMember(f.administrator, f.team.team.id, f.owner.user.id));
  else if (change === "paused") unwrap(f.service.setExecution(f.administrator, f.event.id, true));
  else if (change === "closed") {
    for (const stage of ["live", "closed"] as const)
      unwrap(f.service.transition(f.administrator, f.event.id, stage));
  } else if (change === "generation") f.service.setRuntime(f.id, { generation: 1, held: true });
  else if (change === "name") unwrap(f.service.setSprite(f.id, "civic-spark-other", "error", null));
  else if (change === "account")
    vi.stubEnv("SPRITE_TOKEN", "test-org/other-account/token-id/private-token");
  else if (change === "org") vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "wrong-org");
  else vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", "https://other.example.test");
  gate.resolve();
  expect((await pending).statusCode).toBeGreaterThanOrEqual(400);
  expect(f.service.runtime(f.id).deletion).toBeNull();
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});

it.each(["present", "uncertain", "conflict", "ambiguous-200", "pause", "signed-out"])(
  "preserves the durable marker and never uploads across the dispatch race: %s",
  async (race) => {
    const f = await fixture();
    let namedReads = 0;
    f.request.mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        if (race === "conflict") return Response.json({}, { status: 409 });
        if (race === "ambiguous-200")
          return Response.json({ name: f.name, organization: "test-org" });
      } else if (!new URL(String(url)).search && ++namedReads === 2) {
        if (race === "present") return Response.json({ name: f.name, organization: "test-org" });
        if (race === "uncertain") return new Response(null, { status: 503 });
        if (race === "pause") unwrap(f.service.setExecution(f.administrator, f.event.id, true));
        if (race === "signed-out") {
          const db = new DatabaseSync(join(f.root, "auth.sqlite"));
          db.prepare("DELETE FROM session WHERE userId=?").run(f.owner.user.id);
          db.close();
        }
      }
      return f.normalResponse(url, init);
    });
    expect((await f.post()).statusCode).toBe(202);
    await f.settle();
    expect(f.service.runtime(f.id).deletion).toMatchObject({
      state: "deleted",
      replacementReserved: true,
      ownerRecovery: { name: f.name },
    });
    expect(f.service.initialCreation(f.id)).toBeNull();
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.files).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
      ["conflict", "ambiguous-200"].includes(race) ? 1 : 0,
    );
  },
);

it("retains recovery across restart, ordinary reopen cannot recreate, and a confirmed retry rechecks absence", async () => {
  const f = await fixture();
  f.request.mockImplementation(async (url, init) =>
    init?.method === "POST" ? new Response(null, { status: 503 }) : f.normalResponse(url, init),
  );
  expect((await f.post()).statusCode).toBe(202);
  await f.settle();
  const marker = f.service.runtime(f.id).deletion;
  expect(marker?.ownerRecovery).toBeTruthy();
  const probe = new EventService(f.root);
  expect(probe.runtime(f.id).deletion).toEqual(marker);
  probe.close();
  f.request.mockClear();
  expect((await f.post({})).statusCode).toBe(409);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/api/workspaces/${f.id}/wake`,
        headers: { cookie: f.owner.cookie, origin: "http://127.0.0.1:4310" },
      })
    ).statusCode,
  ).toBe(409);
  expect(f.request).not.toHaveBeenCalled();
  f.request.mockImplementation(async (url, init) => f.normalResponse(url, init));
  expect((await f.post()).statusCode).toBe(202);
  await f.settle();
  expect(f.record()?.spriteStatus).toBe("ready");
  expect(f.service.runtime(f.id).deletion).toBeNull();
  expect(f.upload).toHaveBeenCalledTimes(1);
});

it.each(["revoked", "paused", "account"])(
  "does not upload after a delayed accepted POST when %s changes",
  async (change) => {
    const f = await fixture();
    const arrived = deferred();
    const gate = deferred();
    cleanup.push(gate.resolve);
    f.request.mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        arrived.resolve();
        await gate.promise;
      }
      return f.normalResponse(url, init);
    });
    expect((await f.post()).statusCode).toBe(202);
    await arrived.promise;
    if (change === "revoked")
      unwrap(f.service.removeMember(f.administrator, f.team.team.id, f.owner.user.id));
    else if (change === "paused") unwrap(f.service.setExecution(f.administrator, f.event.id, true));
    else vi.stubEnv("SPRITE_TOKEN", "test-org/other-account/token-id/private-token");
    gate.resolve();
    await f.settle();
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.files).not.toHaveBeenCalled();
    expect(f.service.runtime(f.id).deletion?.ownerRecovery).toBeTruthy();
  },
);

it("bounds preparation admission including metadata and succeeds with one available slot", async () => {
  vi.stubEnv("CIVIC_SPARK_MAX_PROVISIONING", "1");
  const f = await fixture();
  expect((await f.post()).statusCode).toBe(202);
  await f.settle();
  expect(f.record()?.spriteStatus).toBe("ready");
});

it("validates the service evidence boundary and never backfills initial-create evidence", async () => {
  const f = await fixture();
  const binding = new SpriteClient().provisioningBinding();
  const proof = {
    ...binding,
    name: f.name,
    generation: 0,
    eventGeneration: f.service.execution(f.event.id).generation,
    observedAt: new Date().toISOString(),
    httpStatus: 404,
  };
  for (const change of [
    { httpStatus: 500 },
    { observedAt: "2020-01-01T00:00:00.000Z" },
    { account: "invalid" },
    { generation: 1 },
    { name: "civic-spark-other" },
  ]) {
    expect(
      f.service.confirmMissingWorkspace(f.owner.actor as typeof f.administrator, f.id, {
        ...proof,
        ...change,
      }).ok,
    ).toBe(false);
    expect(f.service.runtime(f.id).deletion).toBeNull();
  }
  expect(f.service.confirmMissingWorkspace(f.administrator, f.id, proof).ok).toBe(false);
  expect(f.service.initialCreation(f.id)).toBeNull();
});

it.each(["present", "revoked", "lease-aborted"])(
  "checks again after real queue admission: %s",
  async (race) => {
    vi.stubEnv("CIVIC_SPARK_MAX_COMMANDS", "1");
    vi.stubEnv("SPRITE_TOKEN", "test-org/org-id/token-id/private-token");
    vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "test-org");
    vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", "https://provider.example.test");
    const gate = deferred();
    const arrived = deferred();
    cleanup.push(gate.resolve);
    let blocked = true;
    let authorized = true;
    const controller = new AbortController();
    const release = vi.fn();
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (blocked) {
        blocked = false;
        arrived.resolve();
        await gate.promise;
        return new Response(null, { status: 404 });
      }
      if (new URL(String(url)).search) return Response.json({ sprites: [] });
      return Response.json({ name: "civic-spark-fixture", organization: "test-org" });
    });
    const client = new SpriteClient(
      "test-org",
      () => ({ signal: controller.signal, release }),
      request,
    );
    const blocker = client.inspectReservation("civic-spark-blocker");
    await arrived.promise;
    const guard = vi.fn(async () => {
      if (!authorized) throw Error("Access revoked");
    });
    const pending = client.create("civic-spark-fixture", guard, true);
    if (race === "revoked") authorized = false;
    if (race === "lease-aborted") controller.abort();
    gate.resolve();
    await blocker;
    expect((await pending).ok).toBe(false);
    expect(request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  },
);

it("rechecks authorization when a bundle upload reaches its command slot", async () => {
  vi.stubEnv("CIVIC_SPARK_MAX_COMMANDS", "1");
  vi.stubEnv("SPRITE_TOKEN", "test-org/org-id/token-id/private-token");
  const gate = deferred();
  const arrived = deferred();
  cleanup.push(gate.resolve);
  const request = vi.fn<typeof fetch>().mockImplementation(async () => {
    arrived.resolve();
    await gate.promise;
    return new Response(null, { status: 404 });
  });
  const client = new SpriteClient("test-org", undefined, request);
  const blocker = client.inspectReservation("civic-spark-blocker");
  await arrived.promise;
  const guard = vi.fn(async () => {
    throw Error("Access revoked before upload dispatch");
  });
  const pending = client.uploadBundle("civic-spark-fixture", "/fixture.bundle", guard);
  gate.resolve();
  await blocker;
  expect((await pending).ok).toBe(false);
  expect(guard).toHaveBeenCalledOnce();
});

it("never dispatches create when the durable recovery write fails", async () => {
  const f = await fixture();
  const before = f.service.runtime(f.id);
  vi.spyOn(f.service, "setRuntime").mockImplementation(() => {
    throw Error("Fixture storage full");
  });
  expect((await f.post()).statusCode).toBe(503);
  expect(f.service.runtime(f.id)).toEqual(before);
  expect(f.service.initialCreation(f.id)).toBeNull();
  expect(f.request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
  expect(f.upload).not.toHaveBeenCalled();
});
