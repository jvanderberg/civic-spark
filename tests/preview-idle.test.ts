import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { WorkspaceLifecycle } from "../apps/server/src/lifecycle.ts";
import { WorkspacePreviews } from "../apps/server/src/preview.ts";
import { EventService } from "../packages/domain/src/service.ts";
import type { Result } from "../packages/domain/src/types.ts";

function unwrap<T>(value: Result<T>) {
  if (!value.ok) throw new Error(value.error);
  return value.value;
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return address.port;
}
async function get(port: number, host: string, path: string, cookie = "") {
  return new Promise<{ status: number; cookie: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host, cookie } }, (res) => {
      res.resume();
      res.once("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "",
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}
it("expires stale real preview sockets despite HMR/ping traffic, protects real use and retains the same Sprite/origin on reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-preview-idle-"));
  const service = new EventService(root);
  const actor = {
    id: "owner",
    email: "owner@example.test",
    name: "Owner",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(actor, {
      name: "Idle preview",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  const w = unwrap(
    service.createTeam(actor, {
      eventId: event.id,
      name: "Preview team",
      projectId: "data-starter",
    }),
  ).workspace;
  const name = `civic-spark-${w.id}`;
  service.setSprite(w.id, name, "ready", null);
  const upstream = createServer((_req, res) => res.end("preview"));
  const upstreamPort = await listen(upstream);
  const ws = new WebSocketServer({ server: upstream });
  ws.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
  const closeTunnel = vi.fn();
  const transport = vi.fn(async () => ({ port: upstreamPort, close: closeTunnel }));
  const origin = "https://preview.example.test";
  const previews = new WorkspacePreviews("https://portal.example.test", transport, undefined, {
    root,
    pool: [origin],
    relaySecret: "isolated-preview-idle-secret".repeat(3),
  });
  const gateway = createServer((_req, res) => res.end("portal"));
  previews.attach(gateway);
  const port = await listen(gateway);
  const provider = { inspect: vi.fn(), stop: vi.fn() };
  const lifecycle = new WorkspaceLifecycle(
    service,
    provider,
    (id) => previews.stop(id),
    () => false,
    (id) => previews.inUse(id, 5 * 60000),
  );
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const sockets: WebSocket[] = [];
  const authorized = async () => service.executionAllowed(w.id).ok;
  try {
    lifecycle.touch(w.id);
    const opened = await previews.open(w.id, name, 5173, authorized);
    const ticket = new URL(opened.url);
    const authenticated = await get(port, ticket.host, ticket.pathname + ticket.search);
    expect(authenticated.status).toBe(303);
    const cookie = authenticated.cookie;
    for (const protocol of [undefined, "vite-hmr"]) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`, protocol ? [protocol] : [], {
        headers: { host: ticket.host, origin, cookie },
      });
      sockets.push(socket);
      await once(socket, "open");
    }
    now += 4 * 60000;
    const app = sockets[0] as WebSocket;
    app.send(JSON.stringify({ type: "save", value: "synthetic application action" }));
    await once(app, "message");
    now += 2 * 60000;
    lifecycle.releaseIdle(now);
    expect(service.runtime(w.id).held).toBe(false);
    expect(closeTunnel).not.toHaveBeenCalled();
    now += 2 * 60000;
    app.ping();
    await once(app, "pong");
    app.send(JSON.stringify({ type: "ping" }));
    await once(app, "message");
    const hmr = sockets[1] as WebSocket;
    hmr.send(JSON.stringify({ type: "update", updates: [] }));
    await once(hmr, "message");
    now += 2 * 60000;
    const closed = sockets.map((socket) => once(socket, "close"));
    lifecycle.releaseIdle(now);
    await Promise.all(closed);
    expect(service.runtime(w.id)).toMatchObject({ held: true, reason: "idle" });
    expect(closeTunnel).toHaveBeenCalledOnce();
    expect(provider.stop).not.toHaveBeenCalled();
    expect((await get(port, ticket.host, "/", cookie)).status).not.toBe(200);
    await expect(previews.open(w.id, name, 5173, authorized)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    unwrap(service.wakeWorkspace(actor, w.id));
    const reopened = await previews.open(w.id, name, 5173, authorized);
    expect(new URL(reopened.url).origin).toBe(origin);
    expect(reopened.url).not.toBe(opened.url);
    expect(transport).toHaveBeenLastCalledWith(name, 5173);
    expect(JSON.parse(readFileSync(join(root, "preview-origins.json"), "utf8"))).toEqual({
      [w.id]: origin,
    });
  } finally {
    clock.mockRestore();
    lifecycle.close();
    previews.close();
    for (const socket of sockets) socket.terminate();
    for (const socket of ws.clients) socket.terminate();
    ws.close();
    upstream.closeAllConnections();
    upstream.close();
    gateway.closeAllConnections();
    gateway.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
