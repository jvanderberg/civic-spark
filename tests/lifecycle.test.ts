import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspaceLifecycle } from "../apps/server/src/lifecycle.ts";
import { EventService } from "../packages/domain/src/service.ts";
import { ok, type Result } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import type { SpriteLifecycleProvider } from "../packages/sprites/src/lifecycle.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const eventInput = {
  name: "Lifecycle fixture",
  date: "2026-10-03",
  timezone: "America/Chicago",
  location: "Test",
  capacity: 20,
  budget: 0,
  templateId: "blank" as const,
};
const observation = {
  status: "running",
  observedAt: "2026-09-16T12:00:00Z",
  createdAt: "2026-09-16T01:00:00Z",
  updatedAt: null,
  error: null,
};
const provider = () => ({
  inspect: vi.fn<SpriteLifecycleProvider["inspect"]>().mockResolvedValue(observation),
  destroy: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn<SpriteLifecycleProvider["stop"]>().mockResolvedValue(undefined),
});
afterEach(() => vi.restoreAllMocks());

it("authorizes event inventory and pause, blocks every workspace route and keeps only shared exports available after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-lifecycle-"));
  const runtime = provider();
  const setup = await createApp(
    root,
    true,
    "http://127.0.0.1:4310",
    undefined,
    "email",
    undefined,
    undefined,
    runtime,
  );
  let closed = false;
  try {
    const { app, service, authentication } = setup;
    const admin = await testIdentity(authentication, "Lifecycle admin");
    const member = await testIdentity(authentication, "Lifecycle member");
    const stranger = await testIdentity(authentication, "Other event admin");
    if (!member.actor || !stranger.actor) throw new Error("Missing fixture actor");
    if (!admin.actor) throw new Error("Missing fixture actor");
    const event = unwrap(service.createEvent(admin.actor, eventInput));
    unwrap(service.transition(admin.actor, event.id, "registration"));
    const team = unwrap(
      service.createTeam(admin.actor, {
        eventId: event.id,
        name: "Shared team",
        projectId: "data-starter",
      }),
    );
    const own = unwrap(service.joinTeam(member.actor, team.team.id));
    service.setSprite(own.id, `civic-spark-${own.id}`, "ready", null);
    const another = unwrap(
      service.createEvent(stranger.actor, { ...eventInput, name: "Unrelated event" }),
    );
    const unrelated = unwrap(
      service.createTeam(stranger.actor, {
        eventId: another.id,
        name: "Another team",
        projectId: "data-starter",
      }),
    );
    service.setSprite(
      unrelated.workspace.id,
      `civic-spark-${unrelated.workspace.id}`,
      "ready",
      null,
    );
    const headers = { cookie: admin.cookie, origin: "http://127.0.0.1:4310" };
    const memberHeaders = { ...headers, cookie: member.cookie };
    const url = `/api/events/${event.id}/execution`;
    expect((await app.inject({ url: `/api/events/${event.id}/sprites` })).statusCode).toBe(401);
    for (const cookie of [member.cookie, stranger.cookie]) {
      expect(
        (
          await app.inject({
            url: `/api/events/${event.id}/sprites`,
            headers: { ...headers, cookie },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { ...headers, cookie },
            payload: { action: "pause-event", userId: admin.actor.id },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { ...headers, cookie },
            payload: { action: "pause-event" },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...headers, origin: "https://attacker.example" },
          payload: { action: "pause-event" },
        })
      ).statusCode,
    ).toBe(403);
    const inventory = (
      await app.inject({ url: `/api/events/${event.id}/sprites`, headers })
    ).json();
    expect(inventory.sprites).toHaveLength(1);
    expect(runtime.inspect).toHaveBeenCalledExactlyOnceWith(`civic-spark-${own.id}`);
    runtime.stop.mockImplementation(async () => {
      expect(service.execution(event.id).paused).toBe(true);
    });
    expect(
      (await app.inject({ method: "POST", url, headers, payload: { action: "pause-event" } }))
        .statusCode,
    ).toBe(200);
    for (const route of [
      "files",
      "file?path=README.md",
      "manifest",
      "changes",
      "blob?path=README.md",
      "team-status",
      "preview",
      "agent-git",
      "agent/credentials",
    ]) {
      expect(
        (await app.inject({ url: `/api/workspaces/${own.id}/${route}`, headers: memberHeaders }))
          .statusCode,
        route,
      ).toBe(423);
    }
    for (const route of ["files", "manifest", "changes", "preview", "team-status"]) {
      expect(
        (
          await app.inject({
            url: `/api/workspaces/${own.id}/${route}`,
            headers: { ...memberHeaders, upgrade: "websocket" },
          })
        ).statusCode,
      ).toBe(423);
    }
    for (const route of [
      "sprite",
      "wake",
      "agent/prepare",
      "preview",
      "share",
      "team-update",
      "agent-git/confirm",
      "activity",
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/workspaces/${own.id}/${route}`,
            headers: memberHeaders,
            payload: {},
          })
        ).statusCode,
        route,
      ).toBe(423);
    }
    expect((await app.inject({ url: `/api/workspaces/${own.id}/files`, headers })).statusCode).toBe(
      404,
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    for (const path of ["agent", "terminal"]) {
      const code = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(
          `${address.replace("http", "ws")}/api/workspaces/${own.id}/${path}`,
          { headers: memberHeaders },
        );
        socket.once("close", resolve);
        socket.once("error", reject);
      });
      expect(code).toBe(1008);
    }
    const zip = await app.inject({
      url: `/api/teams/${team.team.id}/export`,
      headers: memberHeaders,
    });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers["content-type"]).toContain("application/zip");
    expect(
      (
        await app.inject({
          url: `/api/teams/${team.team.id}/export`,
          headers: { ...headers, cookie: stranger.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(service.joinTeam(stranger.actor, team.team.id)).toMatchObject({
      ok: false,
      status: 423,
    });
    await app.close();
    closed = true;
    const restored = new EventService(root);
    expect(restored.execution(event.id).paused).toBe(true);
    expect(restored.executionAllowed(own.id)).toMatchObject({ ok: false, status: 423 });
    expect(restored.runtime(own.id).held).toBe(true);
    restored.close();
  } finally {
    if (!closed) await setup.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("pause-all is distinct from event pause, retains failures, and wakes the same reservation only on owner request", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-pause-all-"));
  const runtime = provider();
  const { app, service, authentication } = await createApp(
    root,
    true,
    "http://127.0.0.1:4310",
    undefined,
    "email",
    undefined,
    undefined,
    runtime,
  );
  const exec = vi.spyOn(SpriteClient.prototype, "exec").mockResolvedValue(ok(Buffer.alloc(0)));
  const create = vi.spyOn(SpriteClient.prototype, "create");
  try {
    const admin = await testIdentity(authentication, "Pause owner");
    if (!admin.actor) throw new Error("Missing fixture actor");
    const event = unwrap(service.createEvent(admin.actor, eventInput));
    const own = unwrap(
      service.createTeam(admin.actor, {
        eventId: event.id,
        name: "Pause team",
        projectId: "data-starter",
      }),
    ).workspace;
    const sprite = `civic-spark-${own.id}`;
    service.setSprite(own.id, sprite, "ready", null);
    const headers = { cookie: admin.cookie, origin: "http://127.0.0.1:4310" };
    const change = (action: string) =>
      app.inject({
        method: "POST",
        url: `/api/events/${event.id}/execution`,
        headers,
        payload: { action },
      });
    runtime.stop.mockRejectedValueOnce(new Error("private provider detail"));
    expect((await change("pause-sprites")).json()).toMatchObject({ paused: false, failures: 1 });
    expect(service.runtime(own.id)).toMatchObject({ held: true, stopState: "failed" });
    expect((await change("pause-sprites")).json()).toMatchObject({ paused: false, failures: 0 });
    await app.inject({ url: `/api/workspaces/${own.id}/sprite`, headers });
    await app.inject({ url: `/api/events/${event.id}/sprites`, headers });
    expect(exec).not.toHaveBeenCalled();
    expect(
      (await app.inject({ method: "POST", url: `/api/workspaces/${own.id}/wake`, headers }))
        .statusCode,
    ).toBe(200);
    expect(exec).toHaveBeenCalledExactlyOnceWith(sprite, ["true"]);
    expect(create).not.toHaveBeenCalled();
    expect(service.provisioningRecords().find((w) => w.id === own.id)?.spriteName).toBe(sprite);
    await change("pause-event");
    exec.mockClear();
    expect((await change("unpause-event")).statusCode).toBe(200);
    expect(exec).not.toHaveBeenCalled();
    expect(service.runtime(own.id).held).toBe(true);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("commits gates before draining in-flight operations and preserves pending pause across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-pause-race-"));
  const service = new EventService(root);
  const actor = {
    id: "fixture",
    name: "Admin",
    email: "fixture@example.test",
    emailVerified: true as const,
  };
  const event = unwrap(service.createEvent(actor, eventInput));
  const own = unwrap(
    service.createTeam(actor, {
      eventId: event.id,
      name: "Racing team",
      projectId: "data-starter",
    }),
  ).workspace;
  service.setSprite(own.id, `civic-spark-${own.id}`, "ready", null);
  const runtime = provider();
  const disconnect = vi.fn();
  const coordinator = new WorkspaceLifecycle(service, runtime, disconnect, () => false);
  try {
    const lease = coordinator.acquire(`civic-spark-${own.id}`);
    const pause = coordinator.change(actor, event.id, "pause-event");
    expect(lease.signal.aborted).toBe(true);
    expect(service.execution(event.id).paused).toBe(true);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(() => coordinator.acquire(`civic-spark-${own.id}`)).toThrow("paused");
    expect(await coordinator.change(actor, event.id, "unpause-event")).toMatchObject({
      ok: false,
      status: 409,
    });
    lease.release();
    await pause;
    expect(disconnect).toHaveBeenCalledWith(own.id);
    service.setRuntime(own.id, { stopState: "pending" });
    coordinator.close();
    service.close();
    const reopened = new EventService(root);
    const reconciled = new WorkspaceLifecycle(reopened, runtime, disconnect, () => false);
    expect(reopened.execution(event.id).paused).toBe(true);
    expect(reopened.runtime(own.id)).toMatchObject({ held: true, stopState: "failed" });
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    reconciled.close();
    reopened.close();
  } finally {
    coordinator.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("releases idle polling without stopping active turns or protected terminal/preview work", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-idle-"));
  const service = new EventService(root);
  const actor = {
    id: "fixture",
    name: "Admin",
    email: "fixture@example.test",
    emailVerified: true as const,
  };
  const event = unwrap(service.createEvent(actor, eventInput));
  const own = unwrap(
    service.createTeam(actor, { eventId: event.id, name: "Idle team", projectId: "data-starter" }),
  ).workspace;
  service.setSprite(own.id, `civic-spark-${own.id}`, "ready", null);
  const runtime = provider();
  const disconnect = vi.fn();
  let working = true;
  let protectedUse = false;
  const coordinator = new WorkspaceLifecycle(
    service,
    runtime,
    disconnect,
    () => working,
    () => protectedUse,
  );
  try {
    coordinator.touch(own.id);
    const before = service.runtime(own.id).lastUsedAt;
    expect(coordinator.idleMinutes).toBe(5);
    const future = Date.parse(before as string) + 5 * 60000;
    const agentLease = coordinator.acquire(`civic-spark-${own.id}`, true);
    const terminalLease = coordinator.acquire(`civic-spark-${own.id}`, true);
    coordinator.releaseIdle(future);
    expect(service.runtime(own.id).held).toBe(false);
    working = false;
    protectedUse = true;
    coordinator.releaseIdle(future);
    expect(service.runtime(own.id).held).toBe(false);
    protectedUse = false;
    // A provider command does not extend participant activity.
    coordinator.acquire(`civic-spark-${own.id}`).release();
    expect(service.runtime(own.id).lastUsedAt).toBe(before);
    coordinator.releaseIdle(future - 1);
    expect(service.runtime(own.id).held).toBe(false);
    coordinator.releaseIdle(future);
    agentLease.release();
    terminalLease.release();
    expect(service.runtime(own.id)).toMatchObject({ held: true, reason: "idle" });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.inspect).not.toHaveBeenCalled();
  } finally {
    coordinator.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
