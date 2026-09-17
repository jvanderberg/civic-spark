import { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import { crc32 } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { AgentSessions } from "../apps/server/src/agents.ts";
import { agentWireByteLimit } from "../packages/agents/src/images.ts";
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
  events: AgentEvent[] = [];
  closed?: number;
  send(data: string) {
    this.events.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
    this.readyState = 3;
    this.emit("close");
  }
  input(data: object) {
    this.emit("message", Buffer.from(JSON.stringify(data)));
  }
}
let sessions: AgentSessions | undefined;
afterEach(() => {
  sessions?.close();
  children.length = 0;
});

it("forwards large validated images, replays only the same workspace, and checks authorization/lifecycle before inference", async () => {
  let allowed = true;
  let authorized = true;
  sessions = new AgentSessions(
    { lease: () => undefined } as unknown as SpriteClient,
    () => allowed,
  );
  const attach = (id: string) => {
    const socket = new Socket();
    sessions?.attach(
      id,
      "civic-spark-isolated-test",
      socket as unknown as WebSocket,
      async () => authorized,
    );
    return socket;
  };
  const owner = attach("owner-workspace");
  const child = children[0];
  expect(child).toBeDefined();
  const writes: string[] = [];
  child?.stdin.on("data", (chunk) => writes.push(chunk.toString()));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    "base64",
  );
  const chunk = Buffer.alloc(1100000);
  chunk.writeUInt32BE(chunk.length - 12);
  chunk.write("tEXt", 4);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const data = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]).toString("base64");
  const image = { id: crypto.randomUUID(), name: "Screenshot.png", mime: "image/png", data };
  const prompt = {
    type: "prompt",
    id: crypto.randomUUID(),
    provider: "claude",
    text: "",
    images: [image],
  };
  expect(Buffer.byteLength(JSON.stringify(prompt))).toBeGreaterThan(1024 * 1024);
  owner.input(prompt);
  await vi.waitFor(() => expect(writes).toHaveLength(1));
  expect(JSON.parse(writes[0] ?? "{}")).toEqual(prompt);
  child?.stdout.write(
    `${JSON.stringify({ type: "user", id: prompt.id, text: "", images: [image] })}\n`,
  );
  child?.stdout.write(
    `${JSON.stringify({ type: "done", id: "done", text: "Ready", outcome: "success" })}\n`,
  );
  await vi.waitFor(() =>
    expect(owner.events.some((event) => event.images?.[0]?.data === data)).toBe(true),
  );
  const reopened = attach("owner-workspace");
  expect(children).toHaveLength(1);
  expect(reopened.events.find((event) => event.type === "user")?.images?.[0]?.data).toBe(data);
  const stranger = attach("different-owner-workspace");
  expect(stranger.events.some((event) => event.images?.length)).toBe(false);
  authorized = false;
  reopened.input({ ...prompt, id: crypto.randomUUID() });
  await vi.waitFor(() => expect(reopened.closed).toBe(1008));
  expect(writes).toHaveLength(1);
  authorized = true;
  allowed = false;
  owner.input({ ...prompt, id: crypto.randomUUID() });
  await vi.waitFor(() => expect(owner.closed).toBe(1008));
  expect(writes).toHaveLength(1);
});

it("rejects malformed/oversized frames without forwarding bodies and bounds pending input", async () => {
  sessions = new AgentSessions({ lease: () => undefined } as unknown as SpriteClient);
  const socket = new Socket();
  sessions.attach(
    "workspace",
    "civic-spark-isolated-test",
    socket as unknown as WebSocket,
    async () => true,
  );
  const writes: string[] = [];
  children[0]?.stdin.on("data", (chunk) => writes.push(chunk.toString()));
  socket.input({
    type: "prompt",
    provider: "claude",
    text: "",
    images: [
      { id: crypto.randomUUID(), name: "bad", mime: "image/png", data: "private-invalid-payload" },
    ],
  });
  await vi.waitFor(() => expect(socket.events.some((event) => event.type === "error")).toBe(true));
  expect(JSON.stringify(socket.events)).not.toContain("private-invalid-payload");
  expect(writes).toEqual([]);
  socket.emit("message", Buffer.alloc(agentWireByteLimit + 1));
  expect(socket.closed).toBe(1009);
  expect(writes).toEqual([]);
});

it.each(["disconnect", "pause"])(
  "drops queued input after %s during authorization",
  async (action) => {
    let release!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    sessions = new AgentSessions({ lease: () => undefined } as unknown as SpriteClient);
    const socket = new Socket();
    const check = vi.fn(() => authorization);
    sessions.attach(
      "workspace",
      "civic-spark-isolated-test",
      socket as unknown as WebSocket,
      check,
    );
    const writes: string[] = [];
    children[0]?.stdin.on("data", (chunk) => writes.push(chunk.toString()));
    socket.input({ type: "prompt", provider: "claude", text: "Never send late" });
    await vi.waitFor(() => expect(check).toHaveBeenCalled());
    if (action === "disconnect") socket.close();
    else sessions.stop("workspace");
    release(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes.filter((value) => JSON.parse(value).type === "prompt")).toEqual([]);
  },
);
