import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../apps/server/src/app.ts";
import { type Fingerprints, WorkspaceEvents } from "../apps/server/src/events.ts";
import type { Identity } from "../packages/domain/src/access-types.ts";
import { testIdentity } from "./auth-fixture.ts";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: { type: string; scope: string; at: string }[] = [];
  closed?: number;
  send(data: string) {
    this.frames.push(JSON.parse(data));
  }
  close(code = 1000) {
    if (this.closed !== undefined) return;
    this.closed = code;
    this.readyState = 3;
    this.emit("close", code);
  }
  scopes() {
    return this.frames.map((frame) => frame.scope);
  }
}
const owner: Identity = {
  id: "owner",
  name: "Owner",
  email: "owner@example.test",
  emailVerified: true,
};
const other: Identity = { ...owner, id: "other", email: "other@example.test" };
let events: WorkspaceEvents | undefined;
afterEach(() => {
  events?.close();
  events = undefined;
  vi.useRealTimers();
});

it("fans out scope notifications to the workspace's sockets only, coalesces bursts and counts pushes", () => {
  vi.useFakeTimers();
  events = new WorkspaceEvents();
  const first = new Socket();
  const second = new Socket();
  const stranger = new Socket();
  const authorized = async () => true;
  events.attach("A", owner, first as unknown as WebSocket, authorized);
  events.attach("A", owner, second as unknown as WebSocket, authorized);
  events.attach("B", other, stranger as unknown as WebSocket, authorized);
  expect(events.open).toBe(3);
  expect(events.subscribers("A")).toBe(2);
  events.publish("A", "files");
  expect(first.frames).toEqual([{ type: "changed", scope: "files", at: expect.any(String) }]);
  expect(second.scopes()).toEqual(["files"]);
  expect(stranger.frames).toEqual([]);
  expect(events.pushed).toBe(2);
  expect(JSON.stringify(first.frames)).not.toMatch(/owner|example\.test/);
  // Tool steps arrive in bursts: one leading frame, one trailing frame per window.
  events.publish("A", "preview", 5000);
  events.publish("A", "preview", 5000);
  events.publish("A", "preview", 5000);
  expect(first.scopes()).toEqual(["files", "preview"]);
  vi.advanceTimersByTime(4999);
  expect(first.scopes()).toEqual(["files", "preview"]);
  vi.advanceTimersByTime(1);
  expect(first.scopes()).toEqual(["files", "preview", "preview"]);
  vi.advanceTimersByTime(10000);
  expect(first.scopes()).toEqual(["files", "preview", "preview"]);
  // An immediate publish supersedes a pending trailing frame.
  events.publish("A", "team", 5000);
  events.publish("A", "team", 5000);
  events.publish("A", "team");
  vi.advanceTimersByTime(10000);
  expect(first.scopes().filter((scope) => scope === "team")).toEqual(["team", "team"]);
  events.publish("unknown", "files");
  first.close();
  expect(events.open).toBe(2);
  events.publish("A", "agent-git");
  expect(first.scopes()).not.toContain("agent-git");
  expect(second.scopes()).toContain("agent-git");
});

it("probes only while subscribed and allowed, pushes on changed fingerprints and re-baselines after explicit publishes", async () => {
  vi.useFakeTimers();
  let observed: Fingerprints = { preview: "stopped", team: "aaa" };
  const probe = vi.fn(async (_id: string, _owner: Identity, _previous: Fingerprints) => observed);
  events = new WorkspaceEvents(() => true, probe, 30000);
  const socket = new Socket();
  events.attach("A", owner, socket as unknown as WebSocket, async () => true);
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(probe.mock.calls[0]?.[2]).toEqual({});
  expect(socket.frames).toEqual([]);
  // A second tab does not add a second probe loop.
  const tab = new Socket();
  events.attach("A", owner, tab as unknown as WebSocket, async () => true);
  await vi.advanceTimersByTimeAsync(30000);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(probe.mock.calls[1]?.[2]).toEqual({ preview: "stopped", team: "aaa" });
  expect(socket.frames).toEqual([]);
  observed = { preview: "running", team: "aaa" };
  await vi.advanceTimersByTimeAsync(30000);
  expect(socket.scopes()).toEqual(["preview"]);
  expect(tab.scopes()).toEqual(["preview"]);
  // The host announced a change itself; the next observation is a new baseline.
  events.publish("A", "preview");
  observed = { preview: "stopped", team: "aaa" };
  await vi.advanceTimersByTimeAsync(30000);
  expect(socket.scopes()).toEqual(["preview", "preview"]);
  observed = { preview: "stopped", team: "bbb" };
  await vi.advanceTimersByTimeAsync(30000);
  expect(socket.scopes()).toEqual(["preview", "preview", "team"]);
  // A failed check keeps the previous observation.
  probe.mockRejectedValueOnce(new Error("Sprite busy"));
  await vi.advanceTimersByTimeAsync(30000);
  await vi.advanceTimersByTimeAsync(30000);
  expect(socket.scopes()).toEqual(["preview", "preview", "team"]);
  const calls = probe.mock.calls.length;
  socket.close();
  tab.close();
  await vi.advanceTimersByTimeAsync(120000);
  expect(probe).toHaveBeenCalledTimes(calls);
  expect(events.open).toBe(0);
});

it("closes sockets when execution, generation or the session ends and on explicit stop", async () => {
  vi.useFakeTimers();
  let allowed = true;
  let generation = 1;
  let session = true;
  const probe = vi.fn(async () => ({}));
  events = new WorkspaceEvents(
    () => allowed,
    probe,
    30000,
    () => generation,
  );
  const authorized = vi.fn(async () => session);
  const paused = new Socket();
  events.attach("A", owner, paused as unknown as WebSocket, authorized);
  allowed = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(paused.closed).toBe(1008);
  // A paused workspace is never probed, and a closed channel stops probing.
  await vi.advanceTimersByTimeAsync(60000);
  expect(probe).not.toHaveBeenCalled();
  allowed = true;
  expect(() =>
    new WorkspaceEvents(() => false).attach(
      "A",
      owner,
      new Socket() as unknown as WebSocket,
      authorized,
    ),
  ).toThrow("paused");
  const replaced = new Socket();
  events.attach("A", owner, replaced as unknown as WebSocket, authorized);
  generation = 2;
  await vi.advanceTimersByTimeAsync(5000);
  expect(replaced.closed).toBe(1008);
  // A new socket for the new generation starts a fresh channel.
  const fresh = new Socket();
  events.attach("A", owner, fresh as unknown as WebSocket, authorized);
  await vi.advanceTimersByTimeAsync(25000);
  expect(fresh.closed).toBeUndefined();
  session = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(authorized).toHaveBeenCalled();
  expect(fresh.closed).toBe(1008);
  session = true;
  const held = new Socket();
  const sibling = new Socket();
  events.attach("A", owner, held as unknown as WebSocket, authorized);
  events.attach("B", other, sibling as unknown as WebSocket, authorized);
  events.stop("A");
  expect(held.closed).toBe(1008);
  expect(sibling.closed).toBeUndefined();
  expect(events.subscribers("A")).toBe(0);
  events.publish("A", "files");
  expect(held.frames).toEqual([]);
  // Inbound frames are ignored, never echoed or executed.
  sibling.emit("message", Buffer.from('{"type":"changed","scope":"files"}'));
  expect(sibling.frames).toEqual([]);
  expect(sibling.closed).toBeUndefined();
  // Another owner attaching to the same id replaces the channel.
  const owned = new Socket();
  events.attach("A", owner, owned as unknown as WebSocket, authorized);
  const hijack = new Socket();
  events.attach("A", other, hijack as unknown as WebSocket, authorized);
  expect(owned.closed).toBe(1008);
  expect(events.subscribers("A")).toBe(1);
});

it("events socket needs the owner session and portal origin, and announces saves and shares", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-events-route-"));
  const baseURL = "http://127.0.0.1:4310";
  const { app, service, authentication } = await createApp(
    root,
    false,
    baseURL,
    undefined,
    "email",
  );
  try {
    const admin = await testIdentity(authentication, "Events owner");
    const member = await testIdentity(authentication, "Events member");
    if (!admin.actor || !member.actor) throw new Error("identity");
    const event = service.createEvent(admin.actor, {
      name: "Events test",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 4,
      budget: 0,
      templateId: "blank",
    });
    if (!event.ok) throw new Error(event.error);
    service.transition(admin.actor, event.value.id, "registration");
    const team = service.createTeam(admin.actor, {
      eventId: event.value.id,
      name: "Team",
      projectId: "data-starter",
    });
    if (!team.ok) throw new Error(team.error);
    const joined = service.joinTeam(member.actor, team.value.team.id);
    if (!joined.ok) throw new Error(joined.error);
    const id = team.value.workspace.id;
    const address = (await app.listen({ host: "127.0.0.1", port: 0 })).replace("http", "ws");
    const outcome = (headers: Record<string, string>, workspace = id) =>
      new Promise<{ opened: boolean; code?: number }>((resolve) => {
        const socket = new WebSocket(`${address}/api/workspaces/${workspace}/events`, {
          headers,
        });
        let opened = false;
        socket.once("open", () => {
          opened = true;
        });
        socket.once("close", (code) => resolve({ opened, code }));
        socket.once("error", () => resolve({ opened }));
      });
    expect(await outcome({ origin: baseURL })).toEqual({ opened: false });
    expect(await outcome({ origin: "https://attacker.test", cookie: admin.cookie })).toEqual({
      opened: false,
    });
    // A teammate has a workspace of their own; the admin's workspace is private.
    expect(await outcome({ origin: baseURL, cookie: member.cookie })).toEqual({
      opened: true,
      code: 1008,
    });
    expect(await outcome({ origin: baseURL, cookie: admin.cookie }, joined.value.id)).toEqual({
      opened: true,
      code: 1008,
    });
    const socket = new WebSocket(`${address}/api/workspaces/${id}/events`, {
      headers: { origin: baseURL, cookie: admin.cookie },
    });
    const frames: { type: string; scope: string }[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const files = await app.inject({
      url: `/api/workspaces/${id}/files`,
      headers: { host: "127.0.0.1:4310", cookie: admin.cookie },
    });
    const path = (files.json() as string[])[0];
    const file = await app.inject({
      url: `/api/workspaces/${id}/file?path=${encodeURIComponent(path ?? "")}`,
      headers: { host: "127.0.0.1:4310", cookie: admin.cookie },
    });
    const saved = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${id}/file`,
      headers: { host: "127.0.0.1:4310", cookie: admin.cookie, origin: baseURL },
      payload: { path, content: "changed by test\n", revision: file.json().revision },
    });
    expect(saved.statusCode).toBe(200);
    await vi.waitFor(() => expect(frames.map((frame) => frame.scope)).toEqual(["files"]));
    expect(frames[0]).toEqual({ type: "changed", scope: "files", at: expect.any(String) });
    // The teammate's socket hears about a Share through the team scope.
    const teammate = new WebSocket(`${address}/api/workspaces/${joined.value.id}/events`, {
      headers: { origin: baseURL, cookie: member.cookie },
    });
    const heard: string[] = [];
    teammate.on("message", (data) => heard.push(JSON.parse(data.toString()).scope));
    await new Promise<void>((resolve, reject) => {
      teammate.once("open", () => resolve());
      teammate.once("error", reject);
    });
    const changes = await app.inject({
      url: `/api/workspaces/${id}/changes`,
      headers: { host: "127.0.0.1:4310", cookie: admin.cookie },
    });
    const shared = await app.inject({
      method: "POST",
      url: `/api/workspaces/${id}/share`,
      headers: { host: "127.0.0.1:4310", cookie: admin.cookie, origin: baseURL },
      payload: { title: "Test share", revision: changes.json().revision },
    });
    expect(shared.statusCode).toBe(200);
    await vi.waitFor(() => expect(heard).toEqual(["team"]));
    await vi.waitFor(() =>
      expect(frames.map((frame) => frame.scope)).toEqual(["files", "files", "team"]),
    );
    // Closing the app closes every events socket.
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    teammate.close();
    await app.close();
    expect(await closed).toBeGreaterThanOrEqual(1000);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
