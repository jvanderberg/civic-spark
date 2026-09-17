import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { TerminalSessions } from "../apps/server/src/terminal.ts";
import type { SpriteClient } from "../packages/sprites/src/client.ts";

const proc = vi.hoisted(() => ({
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
}));
vi.mock("node-pty", () => ({ spawn: vi.fn(() => proc) }));
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
let sessions: TerminalSessions;
afterEach(() => {
  sessions?.close();
  vi.clearAllMocks();
});
it.each(["disconnect", "pause", "revocation"])(
  "drops terminal input after %s while authorization is pending",
  async (action) => {
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const authorized = vi.fn(() => gate);
    let allowed = true;
    sessions = new TerminalSessions(() => allowed, {
      lease: () => undefined,
    } as unknown as SpriteClient);
    const socket = new Socket();
    sessions.attach(
      "workspace",
      "civic-spark-isolated-test",
      socket as unknown as WebSocket,
      authorized,
    );
    socket.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "do not send\r" })));
    await vi.waitFor(() => expect(authorized).toHaveBeenCalled());
    if (action === "disconnect") socket.close();
    if (action === "pause") sessions.stop("workspace");
    if (action === "revocation") allowed = false;
    release(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(proc.write).not.toHaveBeenCalled();
    expect(proc.resize).not.toHaveBeenCalled();
  },
);

it("reattaches the same shell and buffer without counting open sockets or resize as activity", async () => {
  sessions = new TerminalSessions(() => true, {
    lease: () => undefined,
  } as unknown as SpriteClient);
  const first = new Socket();
  sessions.attach(
    "workspace",
    "civic-spark-isolated-test",
    first as unknown as WebSocket,
    async () => true,
  );
  proc.onData.mock.calls[0]?.[0]("retained shell output");
  first.close();
  const second = new Socket();
  sessions.attach(
    "workspace",
    "civic-spark-isolated-test",
    second as unknown as WebSocket,
    async () => true,
  );
  expect(pty.spawn).toHaveBeenCalledOnce();
  expect(proc.kill).not.toHaveBeenCalled();
  expect(second.send).toHaveBeenCalledWith(
    JSON.stringify({ type: "output", data: "retained shell output" }),
  );
  second.emit("message", Buffer.from(JSON.stringify({ type: "resize", cols: 80, rows: 24 })));
  await vi.waitFor(() => expect(proc.resize).toHaveBeenCalledWith(80, 24));
  expect(sessions.recentlyUsed("workspace", 5 * 60000, Date.now() + 5 * 60000)).toBe(false);
});
