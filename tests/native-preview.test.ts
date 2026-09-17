import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { ok, type Result } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { SpriteLifecycle } from "../packages/sprites/src/lifecycle.ts";
import { testIdentity } from "./auth-fixture.ts";

const name = "civic-spark-native-fixture";
const metadata = { name, url: `https://${name}-org.sprites.app`, url_settings: { auth: "public" } };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const unwrap = <T>(r: Result<T>) => {
  if (!r.ok) throw Error(r.error);
  return r.value;
};
it("gets provider URL, publishes only explicitly, preserves identity and never returns credentials", async () => {
  vi.stubEnv("SPRITE_TOKEN", "fixture-secret");
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...metadata, url_settings: { auth: "sprite" } }))
    .mockResolvedValueOnce(Response.json({ ...metadata, secret: "private" }))
    .mockResolvedValueOnce(Response.json(metadata));
  const client = new SpriteClient("fixture", undefined, request);
  expect(await client.previewUrl(name, "publish")).toEqual(ok({ url: metadata.url }));
  expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "PUT"]);
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    redirect: "error",
    body: '{"url_settings":{"auth":"public"}}',
  });
  expect(await client.previewUrl(name)).toEqual(ok({ url: metadata.url }));
  expect(request.mock.calls[2]?.[1]?.method).toBe("GET");
});
it.each([
  { ...metadata, name: "another" },
  { ...metadata, url: "https://portal.example" },
  { ...metadata, url: "https://secret@fixture.sprites.app" },
  { ...metadata, url: "https://fixture.sprites.app/?token=secret" },
  { ...metadata, url: "http://fixture.sprites.app" },
  { ...metadata, url_settings: { auth: "sprite" } },
])("rejects unsafe, mismatched or private provider URL metadata", async (value) => {
  vi.stubEnv("SPRITE_TOKEN", "fixture-secret");
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
  expect((await new SpriteClient("fixture", undefined, request).previewUrl(name)).ok).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});
it("provider auth/network failure stays explicit and cannot create or replace a resource", async () => {
  vi.stubEnv("SPRITE_TOKEN", "fixture-secret");
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("PRIVATE", { status: 403 }));
  const result = await new SpriteClient("fixture", undefined, request).previewUrl(name, "publish");
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(request).toHaveBeenCalledTimes(1);
});
it.each(["revoke", "pause", "signout", "generation"])(
  "HTTP native launch/open preserves tombstones and revalidates deferred %s",
  async (change) => {
    const root = mkdtempSync(join(tmpdir(), "civic-spark-native-api-"));
    const ready = { port: 5173, command: ["npm", "run", "dev"], running: true, ready: true };
    const preview = vi.spyOn(SpriteClient.prototype, "preview").mockResolvedValue(ok(ready));
    const url = vi
      .spyOn(SpriteClient.prototype, "previewUrl")
      .mockResolvedValue(ok({ url: metadata.url }));
    const { app, service, authentication } = await createApp(root, true, "http://127.0.0.1:4310");
    try {
      const owner = await testIdentity(authentication, "Native owner");
      const other = await testIdentity(authentication, "Native other");
      if (!owner.actor || !other.actor) throw Error();
      const event = unwrap(
        service.createEvent(owner.actor, {
          name: "Native",
          date: "2026-10-03",
          timezone: "America/Chicago",
          location: "Test",
          capacity: 60,
          budget: 0,
          templateId: "blank",
        }),
      );
      const team = unwrap(
        service.createTeam(owner.actor, {
          eventId: event.id,
          name: "Native",
          projectId: "data-starter",
        }),
      );
      const id = team.workspace.id;
      service.setSprite(id, name, "ready", null);
      const ledger = join(root, "preview-origins.json");
      writeFileSync(ledger, '{"historical":"retired origin tombstones"}');
      const request = (action: string, cookie = owner.cookie) =>
        app.inject({
          method: "POST",
          url: `/api/workspaces/${id}/preview`,
          headers: { cookie, origin: "http://127.0.0.1:4310" },
          payload: { action },
        });
      expect((await request("start")).statusCode).toBe(200);
      expect(url).toHaveBeenCalledWith(name, "publish", expect.any(Function));
      expect((await request("open")).json()).toEqual({ url: metadata.url });
      expect((await request("open")).json()).toEqual({ url: metadata.url });
      expect((await request("open", other.cookie)).statusCode).toBe(404);
      expect((await request("open", "")).statusCode).toBe(401);
      expect(readFileSync(ledger, "utf8")).toBe('{"historical":"retired origin tombstones"}');
      let finish: (() => void) | undefined;
      preview.mockImplementation(async (_name, operation) => {
        if (operation === "start")
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        if (operation === "stop") finish?.();
        return ok(ready);
      });
      url.mockClear();
      const pending = request("start").then((r) => r);
      await vi.waitFor(() => expect(finish).toBeDefined());
      if (change === "revoke")
        unwrap(service.removeMember(owner.actor, team.team.id, owner.actor.id));
      else if (change === "pause") unwrap(service.setExecution(owner.actor, event.id, true));
      else if (change === "signout")
        await authentication.auth.api.signOut({ headers: new Headers({ cookie: owner.cookie }) });
      else
        service.setRuntime(id, {
          ...service.runtime(id),
          generation: service.runtime(id).generation + 1,
        });
      finish?.();
      expect((await pending).statusCode).toBe(409);
      expect(url).toHaveBeenCalledExactlyOnceWith(name, "inspect");
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it("lifecycle pause stops an active public service and retains its HTTP definition", async () => {
  let running = true;
  const definition = { name: "civic-spark-web-preview", http_port: 5173 };
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    expect(init?.method).not.toBe("DELETE");
    if (path.endsWith("/services")) return Response.json([definition]);
    if (path.endsWith("/stop")) {
      running = false;
      return new Response('{"type":"complete"}\n');
    }
    if (path.endsWith("/exec")) return Response.json([]);
    return Response.json({ status: "running" });
  });
  await new SpriteLifecycle("fixture", "https://api.example", request, async () => {}).stop(name);
  expect(running).toBe(false);
  expect(definition.http_port).toBe(5173);
  expect(
    request.mock.calls.some(([url]) => String(url).endsWith("/civic-spark-web-preview/stop")),
  ).toBe(true);
});

it("revalidates immediately before public authentication update after deferred metadata", async () => {
  vi.stubEnv("SPRITE_TOKEN", "fixture-secret");
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ...metadata, url_settings: { auth: "sprite" } }));
  const validate = vi.fn(async () => {
    throw Error("Session revoked");
  });
  const result = await new SpriteClient("fixture", undefined, request).previewUrl(
    name,
    "publish",
    validate,
  );
  expect(result.ok).toBe(false);
  expect(validate).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledOnce();
});

it("five-minute idle closes management polling without stopping the native public service; explicit Pause still stops it", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const root = mkdtempSync(join(tmpdir(), "civic-spark-native-idle-"));
  let running = true;
  const stop = vi.fn(async () => {
    running = false;
  });
  const provider = { inspect: vi.fn(), stop, destroy: vi.fn() };
  const preview = vi
    .spyOn(SpriteClient.prototype, "preview")
    .mockImplementation(async () =>
      ok({ port: 5173, command: ["fixture"], running, ready: running }),
    );
  const url = vi
    .spyOn(SpriteClient.prototype, "previewUrl")
    .mockResolvedValue(ok({ url: metadata.url }));
  const { app, service, authentication } = await createApp(
    root,
    true,
    "http://127.0.0.1:4310",
    undefined,
    "email",
    undefined,
    provider,
  );
  try {
    const owner = await testIdentity(authentication, "Native idle owner");
    if (!owner.actor) throw Error();
    const event = unwrap(
      service.createEvent(owner.actor, {
        name: "Idle",
        date: "2026-10-03",
        timezone: "America/Chicago",
        location: "Test",
        capacity: 60,
        budget: 0,
        templateId: "blank",
      }),
    );
    const team = unwrap(
      service.createTeam(owner.actor, {
        eventId: event.id,
        name: "Idle",
        projectId: "data-starter",
      }),
    );
    const id = team.workspace.id;
    service.setSprite(id, name, "ready", null);
    service.setRuntime(id, { lastUsedAt: new Date(Date.now() - 5 * 60000 - 1).toISOString() });
    const headers = { cookie: owner.cookie, origin: "http://127.0.0.1:4310" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/workspaces/${id}/preview`,
          headers,
          payload: { action: "open" },
        })
      ).statusCode,
    ).toBe(200);
    preview.mockClear();
    url.mockClear();
    vi.advanceTimersByTime(15000);
    expect(service.runtime(id)).toMatchObject({ held: true, reason: "idle" });
    expect(stop).not.toHaveBeenCalled();
    expect(running).toBe(true);
    for (let i = 0; i < 3; i++)
      expect(
        (await app.inject({ method: "GET", url: `/api/workspaces/${id}/preview`, headers }))
          .statusCode,
      ).toBe(423);
    expect(preview).not.toHaveBeenCalled();
    expect(url).not.toHaveBeenCalled();
    const paused = await app.inject({
      method: "POST",
      url: `/api/events/${event.id}/execution`,
      headers,
      payload: { action: "pause-event" },
    });
    expect(paused.statusCode).toBe(200);
    expect(stop).toHaveBeenCalledWith(name);
    expect(running).toBe(false);
  } finally {
    await app.close();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});
