import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspaceLifecycle } from "../apps/server/src/lifecycle.ts";
import { TerminalSessions } from "../apps/server/src/terminal.ts";
import { EventService } from "../packages/domain/src/service.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "./auth-fixture.ts";

const ptys = vi.hoisted(
  () =>
    [] as {
      data?: (data: string) => void;
      exit?: () => void;
      kill: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      args: string[];
    }[],
);
vi.mock("node-pty", () => ({
  spawn: vi.fn((_command: string, args: string[]) => {
    const session = {
      args,
      data: undefined as ((data: string) => void) | undefined,
      exit: undefined as (() => void) | undefined,
      kill: vi.fn(() => {
        queueMicrotask(() => session.exit?.());
      }),
      write: vi.fn(),
    };
    ptys.push(session);
    return {
      ...session,
      onData: (cb: (data: string) => void) => {
        session.data = cb;
      },
      onExit: (cb: () => void) => {
        session.exit = cb;
      },
      resize: vi.fn(),
    };
  }),
}));
const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const input = {
  name: "Lifecycle races",
  date: "2026-10-03",
  timezone: "America/Chicago",
  location: "Test",
  capacity: 10,
  budget: 0,
  templateId: "blank" as const,
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  ptys.length = 0;
});

it.each(["manifest", "changes"])(
  "pause aborts and drains an actual in-flight %s CLI before provider stop; existing agent/terminal WebSockets revoke",
  async (operation) => {
    const root = mkdtempSync(join(tmpdir(), "cs-races-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const started = join(root, "started");
    const exited = join(root, "exited");
    writeFileSync(
      join(bin, "sprite"),
      `#!${process.execPath}\nconst fs=require('node:fs');\nif (process.argv.some(a=>a.endsWith('/runner.ts'))) {\n console.log(JSON.stringify({type:'state',id:'fixture',text:'Ready',runtimeReady:true,working:false})); process.stdin.resume();\n} else {\n process.stdin.resume(); fs.writeFileSync(${JSON.stringify(started)},'started');\n process.on('SIGTERM',()=>{setTimeout(()=>{fs.writeFileSync(${JSON.stringify(exited)},'closed');process.exit(0);},80);});\n setInterval(()=>{},1000);\n}\n`,
    );
    chmodSync(join(bin, "sprite"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const stop = vi.fn(async () => {
      expect(existsSync(exited)).toBe(true);
    });
    const { app, service, authentication } = await createApp(
      root,
      true,
      "http://127.0.0.1:4310",
      undefined,
      "email",
      undefined,
      undefined,
      { inspect: vi.fn(), stop, destroy: vi.fn() },
    );
    const sockets: WebSocket[] = [];
    try {
      const identity = await testIdentity(authentication, "Race owner");
      if (!identity.actor) throw new Error("Missing actor");
      const event = unwrap(service.createEvent(identity.actor, input));
      const w = unwrap(
        service.createTeam(identity.actor, {
          eventId: event.id,
          name: "Race team",
          projectId: "data-starter",
        }),
      ).workspace;
      service.setSprite(w.id, `civic-spark-${w.id}`, "ready", null);
      const headers = { cookie: identity.cookie, origin: "http://127.0.0.1:4310" };
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      for (const route of ["agent", "terminal"]) {
        const socket = new WebSocket(
          `${address.replace("http", "ws")}/api/workspaces/${w.id}/${route}`,
          { headers },
        );
        sockets.push(socket);
        await new Promise<void>((done, reject) => {
          socket.once("open", done);
          socket.once("error", reject);
        });
      }
      const closes = sockets.map(
        (socket) => new Promise<number>((done) => socket.once("close", done)),
      );
      const request = app
        .inject({ url: `/api/workspaces/${w.id}/${operation}`, headers })
        .then((value) => value);
      await vi.waitFor(() => expect(existsSync(started)).toBe(true));
      const pause = await app.inject({
        method: "POST",
        url: `/api/events/${event.id}/execution`,
        headers,
        payload: { action: "pause-event" },
      });
      expect(pause.json()).toMatchObject({ paused: true, failures: 0 });
      expect((await request).statusCode).toBe(502);
      expect(await Promise.all(closes)).toEqual([1008, 1008]);
      expect(stop).toHaveBeenCalledOnce();
      expect(ptys[0]?.kill).toHaveBeenCalled();
      expect(
        (
          await app.inject({
            url: `/api/workspaces/${w.id}/${operation}`,
            headers: { ...headers, upgrade: "websocket" },
          })
        ).statusCode,
      ).toBe(423);
    } finally {
      for (const socket of sockets) socket.terminate();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("a disconnected retained terminal releases idle polling without killing remote tmux, and reconnects the same reservation", async () => {
  const root = mkdtempSync(join(tmpdir(), "cs-idle-terminal-"));
  const service = new EventService(root);
  const actor = {
    id: "owner",
    email: "owner@example.test",
    name: "Owner",
    emailVerified: true as const,
  };
  const event = unwrap(service.createEvent(actor, input));
  const w = unwrap(
    service.createTeam(actor, {
      eventId: event.id,
      name: "Terminal team",
      projectId: "data-starter",
    }),
  ).workspace;
  const sprite = `civic-spark-${w.id}`;
  service.setSprite(w.id, sprite, "ready", null);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const provider = {
    inspect: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  };
  const client: SpriteClient = new SpriteClient(undefined, (name, passive) =>
    lifecycle.acquire(name, passive),
  );
  const terminals: TerminalSessions = new TerminalSessions(
    () => service.executionAllowed(w.id).ok,
    client,
  );
  const lifecycle: WorkspaceLifecycle = new WorkspaceLifecycle(
    service,
    provider,
    (id) => terminals.stop(id),
    () => false,
    (id) => terminals.recentlyUsed(id, 5 * 60000),
  );
  const sockets: WebSocket[] = [];
  // Real WebSocket event emitter behavior without a network handshake is enough for this unit;
  // network revocation is exercised in the API test above.
  const socket = () => {
    const ws = new WebSocket(null as unknown as string, undefined, {});
    sockets.push(ws);
    vi.spyOn(ws, "send").mockImplementation(() => {});
    vi.spyOn(ws, "close").mockImplementation(() => {
      ws.emit("close", 1000);
    });
    return ws;
  };
  try {
    lifecycle.touch(w.id);
    const first = socket();
    terminals.attach(w.id, sprite, first, async () => true);
    first.emit("close", 1000);
    now += 4 * 60000;
    ptys[0]?.data?.("A running command produced output\n");
    now += 2 * 60000;
    lifecycle.releaseIdle(now);
    expect(service.runtime(w.id).held).toBe(false);
    expect(ptys[0]?.kill).not.toHaveBeenCalled();
    now += 6 * 60000;
    lifecycle.releaseIdle(now);
    expect(service.runtime(w.id)).toMatchObject({ held: true, reason: "idle" });
    expect(ptys[0]?.kill).toHaveBeenCalledOnce();
    expect(provider.stop).not.toHaveBeenCalled(); // Remote processes remain for provider idle detection.
    const command = ptys[0]?.args.at(-1) ?? "";
    expect(command).toContain("tmux new-session -A -s civic-spark-workspace");
    expect(command).not.toContain("kill-session");
    await Promise.resolve();
    unwrap(service.wakeWorkspace(actor, w.id));
    terminals.attach(w.id, sprite, socket(), async () => true);
    expect(ptys[1]?.args).toEqual(ptys[0]?.args);
    expect(service.provisioningRecords().find((row) => row.id === w.id)?.spriteName).toBe(sprite);
  } finally {
    terminals.close();
    lifecycle.close();
    await Promise.resolve();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
