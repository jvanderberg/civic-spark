import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspacePreviews } from "../apps/server/src/preview.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "./auth-fixture.ts";

const transports = vi.hoisted(() => ({
  agents: [] as { stdout: PassThrough }[],
  terminals: [] as ((data: string) => void)[],
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...original,
    spawn: (command: string) => {
      if (command !== "sprite") throw new Error("Only mocked Sprite streams are allowed");
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
          this.stdout.end();
          this.stderr.end();
          child.emit("close", 0);
        },
      });
      child.stdin.resume();
      transports.agents.push(child);
      return child;
    },
  };
});
vi.mock("node-pty", () => ({
  spawn: () => ({
    write() {},
    resize() {},
    kill() {},
    onExit() {},
    onData(callback: (data: string) => void) {
      transports.terminals.push(callback);
    },
  }),
}));
const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
// Preserve virtual Host routing; Node fetch normalizes Host to the connection URL.
async function previewFetch(url: string, headers: Record<string, string>) {
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers))
          if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

it.skipIf(process.env.CIVIC_SPARK_CAPACITY_STREAMS !== "1")(
  "loads 60 authenticated agent/terminal bridges plus private preview assets and WebSockets with local transport doubles",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "civic-spark-stream-load-"));
    const block = vi.spyOn(SpriteClient.prototype, "command").mockImplementation(async () => {
      throw new Error("Live provider operations forbidden");
    });
    const { app, service, authentication } = await createApp(
      root,
      true,
      "http://127.0.0.1:4310",
      undefined,
      "email",
    );
    const sockets: WebSocket[] = [];
    const asset = Buffer.alloc(128 * 1024, 120);
    const upstream = createServer((_req, res) => res.end(asset));
    const wsUpstream = new WebSocketServer({ server: upstream });
    wsUpstream.on("connection", (socket) =>
      socket.on("message", (message) => socket.send(message)),
    );
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const target = upstream.address();
    if (!target || typeof target === "string") throw new Error("Missing upstream");
    const previews = new WorkspacePreviews(
      "https://portal.example.test",
      async () => ({ port: target.port, close() {} }),
      "https://{workspace}.preview.example.test",
    );
    const gateway = createServer((_req, res) => res.writeHead(404).end());
    previews.attach(gateway);
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const ingress = gateway.address();
    if (!ingress || typeof ingress === "string") throw new Error("Missing gateway");
    let agentMessages = 0;
    let terminalMessages = 0;
    let previewMessages = 0;
    let assetBytes = 0;
    const lag = monitorEventLoopDelay({ resolution: 10 });
    try {
      const people = await Promise.all(
        Array.from({ length: 60 }, (_, i) => testIdentity(authentication, `Stream Person ${i}`)),
      );
      const owner = people[0]?.actor;
      if (!owner) throw new Error("Missing owner");
      const event = unwrap(
        service.createEvent(owner, {
          name: "Stream fixture",
          date: "2026-10-03",
          timezone: "America/Chicago",
          location: "Local",
          capacity: 60,
          budget: 0,
          templateId: "blank",
        }),
      );
      const team = unwrap(
        service.createTeam(owner, {
          eventId: event.id,
          name: "Stream team",
          projectId: "data-starter",
        }),
      );
      unwrap(service.transition(owner, event.id, "registration"));
      const participants = people.map((person) => {
        if (!person.actor) throw new Error("Missing actor");
        const workspace = unwrap(service.joinTeam(person.actor, team.team.id));
        unwrap(
          service.setSprite(workspace.id, `civic-spark-${workspace.id}`, "ready", null, "ready"),
        );
        return { ...person, actor: person.actor, workspace };
      });
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Missing app");
      const previewRequests = await Promise.all(
        participants.map(async (person) => {
          for (const type of ["agent", "terminal"] as const) {
            const socket = new WebSocket(
              `ws://127.0.0.1:${address.port}/api/workspaces/${person.workspace.id}/${type}`,
              { headers: { cookie: person.cookie, origin: "http://127.0.0.1:4310" } },
            );
            sockets.push(socket);
            socket.on("message", () => {
              if (type === "agent") agentMessages++;
              else terminalMessages++;
            });
            await once(socket, "open");
          }
          const opened = await previews.open(
            person.workspace.id,
            `civic-spark-${person.workspace.id}`,
            5173,
            async () => service.workspace(person.actor, person.workspace.id).ok,
          );
          const url = new URL(opened.url);
          const grant = await previewFetch(
            `http://127.0.0.1:${ingress.port}${url.pathname}${url.search}`,
            { host: url.host },
          );
          expect(grant.status).toBe(303);
          const cookie = grant.headers.get("set-cookie")?.split(";")[0];
          expect(cookie).toBeTruthy();
          const headers = { host: url.host, cookie: cookie as string, origin: url.origin };
          const socket = new WebSocket(`ws://127.0.0.1:${ingress.port}/hmr`, { headers });
          sockets.push(socket);
          socket.on("message", () => previewMessages++);
          await once(socket, "open");
          return { headers, socket };
        }),
      );
      expect(transports.agents).toHaveLength(60);
      expect(transports.terminals).toHaveLength(60);
      lag.enable();
      const started = performance.now();
      let peakRss = process.memoryUsage().rss;
      const ticks = setInterval(() => {
        const text = JSON.stringify({ type: "text", id: "active-turn", text: "x".repeat(1024) });
        for (const agent of transports.agents) agent.stdout.write(`${text}\n`);
        for (const terminal of transports.terminals) terminal("output ".repeat(150));
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 100);
      try {
        for (let round = 0; round < 10; round++) {
          await Promise.all(
            previewRequests.map(async ({ headers, socket }) => {
              socket.send("hmr-fixture");
              const response = await previewFetch(
                `http://127.0.0.1:${ingress.port}/asset.js`,
                headers,
              );
              expect(response.status).toBe(200);
              assetBytes += (await response.arrayBuffer()).byteLength;
            }),
          );
          await delay(1000);
        }
      } finally {
        clearInterval(ticks);
        lag.disable();
      }
      expect(agentMessages).toBeGreaterThan(600);
      expect(terminalMessages).toBeGreaterThan(600);
      expect(previewMessages).toBe(600);
      const report = {
        participants: 60,
        agentSockets: 60,
        terminalSockets: 60,
        previewSockets: 60,
        elapsedMs: performance.now() - started,
        agentMessages,
        terminalMessages,
        previewMessages,
        assetBytes,
        peakRssBytes: peakRss,
        eventLoopMs: {
          p95: lag.percentile(95) / 1e6,
          p99: lag.percentile(99) / 1e6,
          max: lag.max / 1e6,
        },
        limitation:
          "Actual server bridges/HTTP/WS; in-process provider transport doubles, no Sprite CLI, TLS edge, WAN or model.",
      };
      mkdirSync(resolve("artifacts/capacity"), { recursive: true });
      writeFileSync(
        resolve("artifacts/capacity/streams.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      console.log(report);
    } finally {
      for (const socket of sockets) socket.terminate();
      previews.close();
      wsUpstream.close();
      gateway.closeAllConnections();
      gateway.close();
      upstream.closeAllConnections();
      upstream.close();
      await app.close();
      block.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);
