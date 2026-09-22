import { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { AgentSessions } from "../apps/server/src/agents.ts";
import type { AgentEvent } from "../packages/agents/src/protocol.ts";
import type { SpriteClient } from "../packages/sprites/src/client.ts";

// The server side of Stop and of a message sent during a turn, with a fake
// runner child: no Sprite CLI, provider request or key is involved.
const children = vi.hoisted(
  () => [] as { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void }[],
);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...original,
    spawn: () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {
          this.stdout.end();
          this.stderr.end();
        },
      });
      children.push(child);
      return child;
    },
  };
});
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: AgentEvent[] = [];
  send(data: string) {
    this.frames.push(JSON.parse(data) as AgentEvent);
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
}
let sessions: AgentSessions | undefined;
afterEach(() => {
  sessions?.close();
  children.length = 0;
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 80));
const workspace = "workspace-stop";
const sprite = "civic-spark-isolated-test";

function start() {
  sessions = new AgentSessions({ lease: () => undefined } as unknown as SpriteClient);
  const socket = new Socket();
  sessions.attach(workspace, sprite, socket as unknown as WebSocket, async () => true);
  const child = children[0];
  if (!child) throw new Error("runner not spawned");
  const written: string[] = [];
  child.stdin.on("data", (chunk: Buffer) => written.push(...chunk.toString().trim().split("\n")));
  return {
    socket,
    written,
    attachLate() {
      const late = new Socket();
      sessions?.attach(workspace, sprite, late as unknown as WebSocket, async () => true);
      return late;
    },
    line: (event: object) => child.stdout.write(`${JSON.stringify(event)}\n`),
    input: (message: object) => socket.emit("message", JSON.stringify(message)),
    states: () => socket.frames.filter((event) => event.type === "state"),
  };
}

it("acknowledges a stop at once, drops the stopped turn's output and keeps the transcript", async () => {
  const runner = start();
  runner.input({ type: "prompt", provider: "opencode", text: "Summarize the data" });
  await tick();
  runner.line({ type: "user", id: "user-1", text: "Summarize the data" });
  runner.line({ type: "status", id: "working-1", text: "Working" });
  runner.line({ type: "text", id: "assistant-1", text: "Reading the file" });
  await tick();
  expect(runner.written).toEqual([
    JSON.stringify({ type: "prompt", provider: "opencode", text: "Summarize the data" }),
  ]);

  runner.input({ type: "stop" });
  await tick();
  // The stop is answered before the runner settles: a state frame reports the
  // turn as stopping, and the runner is told to stop.
  const acknowledged = runner.states().at(-1);
  expect(acknowledged).toMatchObject({ stopping: true, working: true });
  expect(runner.written.at(-1)).toBe('{"type":"stop"}');

  runner.line({ type: "text", id: "assistant-1", text: " and thinking more" });
  runner.line({ type: "tool", id: "tool-1", text: "bash" });
  await tick();
  expect(runner.socket.frames.some((event) => event.text.includes("thinking more"))).toBe(false);
  expect(runner.socket.frames.some((event) => event.type === "tool")).toBe(false);
  // A client attaching mid-stop sees the same conversation and stopping state.
  const late = runner.attachLate();
  expect(late.frames.filter((event) => event.type === "text").map((event) => event.text)).toEqual([
    "Reading the file",
  ]);
  expect(late.frames.at(-1)).toMatchObject({ stopping: true });

  runner.line({ type: "done", id: "done-1", text: "Ready", outcome: "stopped" });
  await tick();
  expect(runner.socket.frames.at(-1)).toMatchObject({ type: "done", outcome: "stopped" });
  expect(runner.attachLate().frames.at(-1)).toMatchObject({ working: false, stopping: false });
  // Later output belongs to the next turn and is delivered again.
  runner.line({ type: "status", id: "working-2", text: "Working" });
  runner.line({ type: "text", id: "assistant-2", text: "Next turn" });
  await tick();
  expect(runner.socket.frames.some((event) => event.text === "Next turn")).toBe(true);
});

it("holds a message sent during a turn, restores it on reattachment and delivers it once", async () => {
  const runner = start();
  runner.input({ type: "prompt", provider: "opencode", text: "First" });
  await tick();
  runner.line({ type: "status", id: "working-1", text: "Working" });
  await tick();
  const queued = {
    type: "prompt",
    provider: "opencode",
    text: "Also add a legend",
    id: "11111111-1111-4111-8111-111111111111",
    queue: true,
  };
  runner.input(queued);
  await tick();
  expect(runner.written).toHaveLength(1);
  expect(runner.states().at(-1)?.queued).toEqual({
    id: queued.id,
    text: "Also add a legend",
    images: undefined,
  });
  // A reload reattaches and finds the same message still waiting.
  expect(runner.attachLate().frames.at(-1)?.queued).toMatchObject({ text: "Also add a legend" });

  runner.line({ type: "done", id: "done-1", text: "Ready", outcome: "success" });
  await tick();
  expect(runner.written).toEqual([
    JSON.stringify({ type: "prompt", provider: "opencode", text: "First" }),
    JSON.stringify(queued),
  ]);
  expect(runner.states().at(-1)?.queued).toBeNull();
  // Repeated turn completions never resend it.
  runner.line({ type: "status", id: "working-2", text: "Working" });
  runner.line({ type: "done", id: "done-2", text: "Ready", outcome: "success" });
  await tick();
  expect(runner.written).toHaveLength(2);
});

it("takes back a queued message, and sends one immediately when no turn is running", async () => {
  const runner = start();
  runner.input({ type: "prompt", provider: "opencode", text: "First" });
  await tick();
  runner.line({ type: "status", id: "working-1", text: "Working" });
  await tick();
  runner.input({
    type: "prompt",
    provider: "opencode",
    text: "Cancel me",
    id: "22222222-2222-4222-8222-222222222222",
    queue: true,
  });
  await tick();
  expect(runner.states().at(-1)?.queued).toMatchObject({ text: "Cancel me" });
  runner.input({ type: "unqueue" });
  await tick();
  expect(runner.states().at(-1)?.queued).toBeNull();
  runner.line({ type: "done", id: "done-1", text: "Ready", outcome: "success" });
  await tick();
  expect(runner.written).toHaveLength(1);

  // Queueing when the runner is idle sends the message straight away.
  const direct = {
    type: "prompt",
    provider: "opencode",
    text: "Send now",
    id: "33333333-3333-4333-8333-333333333333",
    queue: true,
  };
  runner.input(direct);
  await tick();
  expect(runner.written.at(-1)).toBe(JSON.stringify(direct));
  expect(runner.states().at(-1)?.queued).toBeNull();
});
