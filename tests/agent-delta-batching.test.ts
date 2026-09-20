import { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { AgentSessions } from "../apps/server/src/agents.ts";
import type { AgentEvent } from "../packages/agents/src/protocol.ts";
import type { SpriteClient } from "../packages/sprites/src/client.ts";

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
    this.frames.push(JSON.parse(data));
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

it("merges streamed text deltas per message before replay and fan-out, preserving order", async () => {
  const touches: string[] = [];
  sessions = new AgentSessions(
    { lease: () => undefined } as unknown as SpriteClient,
    () => true,
    (id) => touches.push(id),
  );
  const socket = new Socket();
  sessions.attach(
    "workspace-1",
    "civic-spark-isolated-test",
    socket as unknown as WebSocket,
    async () => true,
  );
  const child = children[0];
  if (!child) throw new Error("runner not spawned");
  const line = (event: object) => child.stdout.write(`${JSON.stringify(event)}\n`);
  line({ type: "user", id: "u1", text: "Hello" });
  for (const piece of ["WE'", "RE ", "ALL ", "GOOD"]) line({ type: "text", id: "m1", text: piece });
  line({ type: "tool", id: "t1", text: "ls" });
  for (const piece of ["Second ", "message"]) line({ type: "text", id: "m2", text: piece });
  line({ type: "done", id: "d1", text: "Ready", outcome: "success" });
  await tick();
  const live = socket.frames.filter((event) => !event.replayed && event.type !== "state");
  expect(live.map((event) => [event.type, event.id, event.text])).toEqual([
    ["user", "u1", "Hello"],
    ["text", "m1", "WE'RE ALL GOOD"],
    ["tool", "t1", "ls"],
    ["text", "m2", "Second message"],
    ["done", "d1", "Ready"],
  ]);
  // Replay carries the same merged transcript for reconnecting clients.
  const late = new Socket();
  sessions.attach(
    "workspace-1",
    "civic-spark-isolated-test",
    late as unknown as WebSocket,
    async () => true,
  );
  const replayed = late.frames.filter((event) => event.replayed && event.type === "text");
  expect(replayed.map((event) => event.text)).toEqual(["WE'RE ALL GOOD", "Second message"]);
  // Activity is touched at most about once per second, not once per token.
  expect(touches.length).toBeLessThanOrEqual(2);
  // Deltas that arrive slowly still flush on their own after the merge window.
  line({ type: "text", id: "m3", text: "late " });
  await tick();
  line({ type: "text", id: "m3", text: "delta" });
  await tick();
  expect(socket.frames.filter((event) => event.id === "m3").map((event) => event.text)).toEqual([
    "late ",
    "delta",
  ]);
});
