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
const stopLine = JSON.stringify({ type: "stop" });
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

it("holds messages sent during a turn, restores them on reattachment and sends them in order once", async () => {
  const runner = start();
  runner.input({ type: "prompt", provider: "opencode", text: "First" });
  await tick();
  runner.line({ type: "status", id: "working-1", text: "Working" });
  await tick();
  const legend = {
    type: "prompt",
    provider: "opencode",
    text: "Also add a legend",
    id: "11111111-1111-4111-8111-111111111111",
    queue: true,
  };
  const labels = {
    type: "prompt",
    provider: "opencode",
    text: "Then label the axes",
    id: "22222222-2222-4222-8222-222222222222",
    queue: true,
  };
  runner.input(legend);
  runner.input(labels);
  await tick();
  expect(runner.written).toHaveLength(1);
  // Both wait, in the order they were sent.
  expect(runner.states().at(-1)?.queued).toEqual([
    { id: legend.id, text: "Also add a legend", images: undefined },
    { id: labels.id, text: "Then label the axes", images: undefined },
  ]);
  // A reload reattaches and finds the same messages still waiting.
  expect(runner.attachLate().frames.at(-1)?.queued).toMatchObject([
    { text: "Also add a legend" },
    { text: "Then label the axes" },
  ]);

  runner.line({ type: "done", id: "done-1", text: "Ready", outcome: "success" });
  await tick();
  expect(runner.written).toEqual([
    JSON.stringify({ type: "prompt", provider: "opencode", text: "First" }),
    JSON.stringify(legend),
  ]);
  expect(runner.states().at(-1)?.queued).toMatchObject([{ text: "Then label the axes" }]);
  // One message leaves per finished turn, and never twice.
  runner.line({ type: "status", id: "working-2", text: "Working" });
  runner.line({ type: "done", id: "done-2", text: "Ready", outcome: "success" });
  await tick();
  expect(runner.written.at(-1)).toBe(JSON.stringify(labels));
  expect(runner.states().at(-1)?.queued).toEqual([]);
  runner.line({ type: "status", id: "working-3", text: "Working" });
  runner.line({ type: "done", id: "done-3", text: "Ready", outcome: "success" });
  await tick();
  expect(runner.written).toHaveLength(3);
});

it("sends a chosen waiting message next by stopping the turn, once, and keeps the rest queued", async () => {
  const runner = start();
  runner.input({ type: "prompt", provider: "opencode", text: "First" });
  await tick();
  runner.line({ type: "status", id: "working-1", text: "Working" });
  await tick();
  const waiting = {
    type: "prompt",
    provider: "opencode",
    text: "Waits its turn",
    id: "66666666-6666-4666-8666-666666666666",
    queue: true,
  };
  const chosen = {
    type: "prompt",
    provider: "opencode",
    text: "Send this one now",
    id: "77777777-7777-4777-8777-777777777777",
    queue: true,
  };
  runner.input(waiting);
  runner.input(chosen);
  await tick();
  runner.input({ type: "steer", id: chosen.id });
  await tick();
  // Each harness turn is one request: Send now stops the running turn and moves
  // the chosen message to the front rather than injecting it mid-turn.
  expect(runner.written.at(-1)).toBe(stopLine);
  expect(runner.states().at(-1)).toMatchObject({ stopping: true, working: true });
  expect(runner.states().at(-1)?.queued).toMatchObject([
    { text: "Send this one now" },
    { text: "Waits its turn" },
  ]);

  runner.line({ type: "done", id: "done-1", text: "Ready", outcome: "stopped" });
  await tick();
  expect(runner.written).toEqual([
    JSON.stringify({ type: "prompt", provider: "opencode", text: "First" }),
    stopLine,
    JSON.stringify(chosen),
  ]);
  expect(runner.states().at(-1)?.queued).toMatchObject([{ text: "Waits its turn" }]);
  // The steered message is not sent again when its own turn finishes.
  runner.line({ type: "status", id: "working-2", text: "Working" });
  runner.line({ type: "done", id: "done-2", text: "Ready", outcome: "success" });
  await tick();
  expect(runner.written.at(-1)).toBe(JSON.stringify(waiting));
  expect(runner.written.filter((line) => line === JSON.stringify(chosen))).toHaveLength(1);
});

it("clears the queue on a stop so no waiting message starts a new turn", async () => {
  const runner = start();
  runner.input({ type: "prompt", provider: "opencode", text: "First" });
  await tick();
  runner.line({ type: "status", id: "working-1", text: "Working" });
  await tick();
  runner.input({
    type: "prompt",
    provider: "opencode",
    text: "Should not start a turn",
    id: "88888888-8888-4888-8888-888888888888",
    queue: true,
  });
  await tick();
  runner.input({ type: "stop" });
  await tick();
  // The client takes the drained content back into its composer; the runner
  // keeps nothing that could begin another turn by itself.
  expect(runner.states().at(-1)).toMatchObject({ stopping: true, queued: [] });
  expect(runner.attachLate().frames.at(-1)?.queued).toEqual([]);
  runner.line({ type: "done", id: "done-1", text: "Ready", outcome: "stopped" });
  await tick();
  expect(runner.written).toEqual([
    JSON.stringify({ type: "prompt", provider: "opencode", text: "First" }),
    stopLine,
  ]);
});

it("takes one waiting message back by id, and sends one immediately when no turn is running", async () => {
  const runner = start();
  runner.input({ type: "prompt", provider: "opencode", text: "First" });
  await tick();
  runner.line({ type: "status", id: "working-1", text: "Working" });
  await tick();
  const cancelled = {
    type: "prompt",
    provider: "opencode",
    text: "Cancel me",
    id: "33333333-3333-4333-8333-333333333333",
    queue: true,
  };
  const kept = {
    type: "prompt",
    provider: "opencode",
    text: "Keep me",
    id: "44444444-4444-4444-8444-444444444444",
    queue: true,
  };
  runner.input(cancelled);
  runner.input(kept);
  await tick();
  runner.input({ type: "unqueue", id: cancelled.id });
  await tick();
  expect(runner.states().at(-1)?.queued).toMatchObject([{ text: "Keep me" }]);
  runner.line({ type: "done", id: "done-1", text: "Ready", outcome: "success" });
  await tick();
  expect(runner.written).toEqual([
    JSON.stringify({ type: "prompt", provider: "opencode", text: "First" }),
    JSON.stringify(kept),
  ]);

  // Queueing when the runner is idle sends the message straight away.
  runner.line({ type: "done", id: "done-2", text: "Ready", outcome: "success" });
  await tick();
  const direct = {
    type: "prompt",
    provider: "opencode",
    text: "Nothing is running",
    id: "55555555-5555-4555-8555-555555555555",
    queue: true,
  };
  runner.input(direct);
  await tick();
  expect(runner.written.at(-1)).toBe(JSON.stringify(direct));
  expect(runner.states().at(-1)?.queued).toEqual([]);
});

it("answers liveness pings at once without forwarding them or counting them as work", async () => {
  const runner = start();
  runner.socket.emit("message", '{"type":"ping"}');
  expect(runner.socket.frames.at(-1)).toEqual({ type: "pong" });
  await tick();
  expect(runner.written).toEqual([]);
  expect(runner.socket.frames.some((event) => event.type === "error")).toBe(false);
});
