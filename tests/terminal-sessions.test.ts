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

it("counts typed input as use but never shell output, and records workspace activity on input", async () => {
  const touch = vi.fn();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  sessions = new TerminalSessions(
    () => true,
    { lease: () => undefined } as unknown as SpriteClient,
    touch,
  );
  const socket = new Socket();
  sessions.attach(
    "workspace",
    "civic-spark-isolated-test",
    socket as unknown as WebSocket,
    async () => true,
  );
  const idle = 5 * 60000;
  // A tmux status line or TUI redraw keeps producing output while nobody is typing.
  now += 4 * 60000;
  proc.onData.mock.calls[0]?.[0]("status line refresh");
  now += 2 * 60000;
  proc.onData.mock.calls[0]?.[0]("another refresh");
  expect(sessions.recentlyUsed("workspace", idle, now)).toBe(false);
  expect(touch).not.toHaveBeenCalled();
  socket.emit("message", Buffer.from(JSON.stringify({ type: "input", data: "ls\r" })));
  await vi.waitFor(() => expect(proc.write).toHaveBeenCalledWith("ls\r"));
  expect(touch).toHaveBeenCalledWith("workspace");
  expect(sessions.recentlyUsed("workspace", idle, now + idle - 1)).toBe(true);
  expect(sessions.recentlyUsed("workspace", idle, now + idle)).toBe(false);
  vi.restoreAllMocks();
});

it("nudges a full tmux redraw when a reattached client reports an unchanged size", async () => {
  sessions = new TerminalSessions(() => true, {
    lease: () => undefined,
  } as unknown as SpriteClient);
  const resize = (socket: Socket, cols: number, rows: number) =>
    socket.emit("message", Buffer.from(JSON.stringify({ type: "resize", cols, rows })));
  const first = new Socket();
  sessions.attach(
    "workspace",
    "civic-spark-isolated-test",
    first as unknown as WebSocket,
    async () => true,
  );
  resize(first, 120, 40);
  await vi.waitFor(() => expect(proc.resize).toHaveBeenCalledWith(120, 40));
  await new Promise((resolve) => setTimeout(resolve, 200));
  // A real size change already repaints; no nudge.
  expect(proc.resize.mock.calls).toEqual([[120, 40]]);
  first.close();
  const second = new Socket();
  sessions.attach(
    "workspace",
    "civic-spark-isolated-test",
    second as unknown as WebSocket,
    async () => true,
  );
  resize(second, 120, 40);
  await vi.waitFor(() => expect(proc.resize).toHaveBeenCalledWith(119, 40));
  await vi.waitFor(() => expect(proc.resize.mock.calls.length).toBe(3));
  expect(proc.resize.mock.calls.slice(1)).toEqual([
    [119, 40],
    [120, 40],
  ]);
  // Later resizes from the same client pass straight through.
  resize(second, 90, 30);
  await vi.waitFor(() => expect(proc.resize).toHaveBeenCalledWith(90, 30));
  expect(proc.resize.mock.calls.length).toBe(4);
});

it("replays a truncated history ring from an escape or line boundary", async () => {
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
  const feed = proc.onData.mock.calls[0]?.[0] as (data: string) => void;
  feed("x".repeat(150000));
  feed("8;2;60m tail\x1b[31mred\r\n");
  feed("y".repeat(60000));
  first.close();
  const second = new Socket();
  sessions.attach(
    "workspace",
    "civic-spark-isolated-test",
    second as unknown as WebSocket,
    async () => true,
  );
  const replay = JSON.parse(String(second.send.mock.calls[0]?.[0])) as { data: string };
  expect(replay.data.startsWith("\x1b[31mred\r\n")).toBe(true);
  expect(replay.data.endsWith("y".repeat(60000))).toBe(true);
});
