import type { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { assignWorker } from "../apps/server/src/relay/pool.ts";
import type { FromWorker, ToWorker } from "../apps/server/src/relay/protocol.ts";
import { RelayWorkerHost } from "../apps/server/src/relay/worker-host.ts";

// The worker side of the relay with fake children: no `sprite` CLI, PTY or
// IPC channel is real here. Frames must leave batched per tick and in order.
type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  kill(signal?: string): boolean;
  exit(code: number | null, signal?: string | null): void;
};
const spawned = vi.hoisted(() => [] as { args: string[]; child: FakeChild }[]);
const oneShot = vi.hoisted(() => ({
  handler: (_args: string[], _input: string): Buffer | Error => Buffer.from(""),
  hang: false,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { promisify } = await import("node:util");
  const make = (): FakeChild => {
    let finished = false;
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as string | null,
      killed: false,
      kill(this: FakeChild, signal = "SIGTERM") {
        this.killed = true;
        this.exit(null, signal);
        return true;
      },
      exit(this: FakeChild, code: number | null, signal: string | null = null) {
        if (finished) return;
        finished = true;
        this.exitCode = code;
        this.signalCode = signal;
        this.stdout.end();
        this.stderr.end();
        setImmediate(() => this.emit("close", code, signal));
      },
    });
  };
  const execFile = Object.assign(
    () => {
      throw new Error("callback execFile is not used");
    },
    {
      [promisify.custom]: (_file: string, args: string[], options: { signal?: AbortSignal }) => {
        const child = make();
        let input = "";
        child.stdin.on("data", (chunk: Buffer) => {
          input += chunk.toString();
        });
        const promise = new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            child.exit(null, "SIGTERM");
            reject(
              Object.assign(new Error("aborted"), {
                code: "ABORT_ERR",
                killed: true,
                stderr: Buffer.from(""),
              }),
            );
          });
          child.stdin.on("finish", () => {
            if (oneShot.hang) return;
            const output = oneShot.handler(args, input);
            if (output instanceof Error) {
              child.exit(1);
              reject(Object.assign(output, { code: 1, stderr: Buffer.from("PRIVATE stderr") }));
            } else {
              child.exit(0);
              resolve({ stdout: output, stderr: Buffer.alloc(0) });
            }
          });
        });
        return Object.assign(promise, { child });
      },
    },
  );
  return {
    ...original,
    execFile,
    spawn: (_file: string, args: string[]) => {
      const child = make();
      spawned.push({ args, child });
      return child;
    },
  };
});
const ptys = vi.hoisted(
  () =>
    [] as {
      data?: (data: string) => void;
      exit?: () => void;
      kill: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      resize: ReturnType<typeof vi.fn>;
    }[],
);
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const session = {
      data: undefined as ((data: string) => void) | undefined,
      exit: undefined as (() => void) | undefined,
      kill: vi.fn(() => queueMicrotask(() => session.exit?.())),
      write: vi.fn(),
      resize: vi.fn(),
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
    };
  }),
}));

function channel() {
  const sent: FromWorker[] = [];
  const state = { congested: false, flushes: [] as (() => void)[], handler: (_: ToWorker) => {} };
  const exit = vi.fn();
  const host = new RelayWorkerHost(
    {
      send(message, flushed) {
        sent.push(message);
        if (state.congested) {
          state.flushes.push(flushed);
          return false;
        }
        flushed();
        return true;
      },
      onMessage(handler) {
        state.handler = handler;
      },
      onDisconnect() {},
      exit,
    },
    3,
  );
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { host, sent, state, exit, tick, to: (message: ToWorker) => state.handler(message) };
}
const lines = (stream: PassThrough) => {
  const received: string[] = [];
  let partial = "";
  stream.on("data", (chunk: Buffer) => {
    partial += chunk.toString();
    const parts = partial.split("\n");
    partial = parts.pop() ?? "";
    received.push(...parts);
  });
  return received;
};
afterEach(() => {
  spawned.length = 0;
  ptys.length = 0;
  oneShot.handler = () => Buffer.from("");
  oneShot.hang = false;
  vi.restoreAllMocks();
});

it("batches agent frames per session per tick in order with busy and activity signals, replays on attach, and reports the end", async () => {
  const c = channel();
  await c.tick();
  expect(c.sent).toEqual([{ type: "ready" }]);
  c.to({ type: "agent.start", session: "a", workspaceId: "w", sprite: "civic-spark-x" });
  const child = spawned[0]?.child as FakeChild;
  const stdin = lines(child.stdin);
  c.to({ type: "agent.input", session: "a", line: '{"type":"prompt","text":"hi"}', prompt: true });
  await c.tick();
  expect(stdin).toEqual(['{"type":"prompt","text":"hi"}']);
  expect(c.sent.slice(1)).toEqual([{ type: "agent.busy", session: "a", busy: true }]);
  child.stdout.write(
    `${[
      JSON.stringify({ type: "user", id: "u1", text: "hi" }),
      JSON.stringify({ type: "status", id: "s1", text: "Working" }),
      JSON.stringify({ type: "done", id: "d1", text: "Ready", outcome: "success" }),
    ].join("\n")}\n`,
  );
  await c.tick();
  await c.tick();
  const after = c.sent.slice(2).filter((m) => m.type !== "agent.changed");
  expect(after.map((m) => m.type)).toEqual(["agent.activity", "agent.frames", "agent.busy"]);
  // A finished turn announces probable file and team changes to the main process.
  expect(
    c.sent.filter((m) => m.type === "agent.changed").map((m) => (m as { scope: string }).scope),
  ).toEqual(["files", "team"]);
  expect((after[1] as { frames: string[] }).frames.map((f) => JSON.parse(f).type)).toEqual([
    "user",
    "status",
    "done",
  ]);
  expect(after[2]).toEqual({ type: "agent.busy", session: "a", busy: false });
  c.to({ type: "agent.attach", session: "a", client: 7 });
  await c.tick();
  const replay = c.sent.at(-1) as { type: string; client: number; frames: string[] };
  expect(replay.type).toBe("agent.replay");
  expect(replay.client).toBe(7);
  expect(replay.frames.map((f) => [JSON.parse(f).type, JSON.parse(f).replayed])).toEqual([
    ["user", true],
    ["status", true],
    ["done", true],
    ["state", undefined],
  ]);
  c.to({ type: "agent.stop", session: "a" });
  await c.tick();
  await c.tick();
  expect(stdin.at(-1)).toBe('{"type":"stop"}');
  expect(child.killed).toBe(true);
  expect(c.sent.at(-1)).toEqual({ type: "agent.ended", session: "a" });
  // Unknown or ended sessions are ignored rather than crashing the worker.
  c.to({ type: "agent.input", session: "a", line: "{}", prompt: false });
  c.to({ type: "agent.attach", session: "gone", client: 1 });
  await c.tick();
  expect(c.sent.at(-1)).toEqual({ type: "agent.ended", session: "a" });
});

it("relays terminal history and coalesced output, and merges output while the channel is congested without unbounded growth", async () => {
  const c = channel();
  c.to({ type: "terminal.start", session: "t", workspaceId: "w", sprite: "civic-spark-x" });
  const pty = ptys[0];
  if (!pty) throw new Error("PTY not spawned");
  pty.data?.("before attach\x1b[6n");
  c.to({ type: "terminal.attach", session: "t", client: 1 });
  await c.tick();
  expect(c.sent.at(-1)).toEqual({
    type: "terminal.history",
    session: "t",
    client: 1,
    data: "before attach",
  });
  pty.data?.("a");
  pty.data?.("b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(c.sent.at(-1)).toEqual({
    type: "terminal.output",
    session: "t",
    frame: JSON.stringify({ type: "output", data: "ab" }),
  });
  const before = c.sent.length;
  c.state.congested = true;
  pty.data?.("c");
  await new Promise((resolve) => setTimeout(resolve, 30));
  pty.data?.("d");
  await new Promise((resolve) => setTimeout(resolve, 30));
  pty.data?.("e".repeat(1024 * 1024));
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The first frame reached the channel and reported congestion; later frames
  // merged into one bounded frame that keeps the newest bytes.
  expect(c.sent.length).toBe(before + 1);
  c.state.congested = false;
  for (const flushed of c.state.flushes.splice(0)) flushed();
  await c.tick();
  expect(c.sent.length).toBe(before + 2);
  const merged = JSON.parse((c.sent.at(-1) as { frame: string }).frame).data as string;
  expect(merged.length).toBe(1024 * 1024);
  expect(merged.startsWith("e")).toBe(true);
  c.to({ type: "terminal.input", session: "t", data: "ls\r" });
  c.to({ type: "terminal.resize", session: "t", cols: 80, rows: 24 });
  expect(pty.write).toHaveBeenCalledWith("ls\r");
  expect(pty.resize).toHaveBeenCalledWith(80, 24);
  c.to({ type: "terminal.detach", session: "t" });
  pty.data?.("silent");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(c.sent.length).toBe(before + 2);
  c.to({ type: "terminal.kill", session: "t" });
  await c.tick();
  await c.tick();
  expect(c.sent.at(-1)).toEqual({ type: "terminal.ended", session: "t", startFailed: false });
});

it("runs one-shot commands with execFile-shaped results, honors aborts, and relays helper sessions by id", async () => {
  const c = channel();
  oneShot.handler = (_args, input) => Buffer.from(`out:${input}`);
  c.to({
    type: "command.run",
    id: "c1",
    args: ["-s", "civic-spark-x", "exec", "--", "true"],
    timeout: 1000,
    maxBuffer: 1024,
    input: "payload",
  });
  await vi.waitFor(() => expect(c.sent.at(-1)?.type).toBe("command.done"));
  const done = c.sent.at(-1) as { stdout: Buffer };
  expect(Buffer.from(done.stdout).toString()).toBe("out:payload");
  oneShot.handler = () => new Error("boom");
  c.to({ type: "command.run", id: "c2", args: [], timeout: 1000, maxBuffer: 1024 });
  await vi.waitFor(() => expect(c.sent.at(-1)?.type).toBe("command.failed"));
  expect(c.sent.at(-1)).toEqual({
    type: "command.failed",
    id: "c2",
    error: { code: 1, stderr: "PRIVATE stderr" },
  });
  oneShot.hang = true;
  c.to({ type: "command.run", id: "c3", args: [], timeout: 1000, maxBuffer: 1024 });
  await c.tick();
  c.to({ type: "command.abort", id: "c3" });
  await vi.waitFor(() =>
    expect(c.sent.find((m) => m.type === "command.failed" && m.id === "c3")).toMatchObject({
      error: { code: "ABORT_ERR", killed: true },
    }),
  );

  const options = {
    scripts: { "files.py": "print(1)" },
    readyTimeoutMs: 5000,
    idleMs: 5000,
    maxLine: 4096,
    maxInFlight: 2,
  };
  c.to({ type: "session.start", session: "h", args: ["-s", "civic-spark-x"], options });
  const helper = spawned.at(-1)?.child as FakeChild;
  const requests = lines(helper.stdin);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(JSON.parse(requests[0] as string)).toEqual({ type: "hello", scripts: options.scripts });
  helper.stdout.write('{"type":"ready"}\n');
  await vi.waitFor(() => expect(c.sent.at(-1)).toEqual({ type: "session.ready", session: "h" }));
  c.to({
    type: "session.request",
    session: "h",
    id: "r1",
    script: "files.py",
    payload: { operation: "list" },
    timeoutMs: 1000,
    limit: 100,
  });
  c.to({ type: "session.ping", session: "h", id: "p1", timeoutMs: 1000 });
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  const request = JSON.parse(requests[1] as string);
  expect(request).toMatchObject({ type: "request", script: "files.py", limit: 100 });
  helper.stdout.write(
    `${JSON.stringify({ type: "pong", id: JSON.parse(requests[2] as string).id })}\n`,
  );
  helper.stdout.write(`${JSON.stringify({ type: "response", id: request.id, stdout: "[]" })}\n`);
  await vi.waitFor(() =>
    expect(
      c.sent
        .filter((m) => m.type === "session.reply")
        .sort((a, b) => ("id" in a && "id" in b ? a.id.localeCompare(b.id) : 0)),
    ).toEqual([
      { type: "session.reply", session: "h", id: "p1", reply: { stdout: "" } },
      { type: "session.reply", session: "h", id: "r1", reply: { stdout: "[]" } },
    ]),
  );
  c.to({ type: "session.ping", session: "missing", id: "p2", timeoutMs: 1000 });
  await c.tick();
  expect(c.sent.at(-1)).toMatchObject({ type: "session.rejected", id: "p2", reason: "lost" });
  c.to({ type: "session.end", session: "h", outcome: "ok" });
  await vi.waitFor(() => expect(c.sent.at(-1)?.type).toBe("session.closed"));
  expect(c.sent.at(-1)).toMatchObject({ session: "h", end: { outcome: "ok", stderr: "" } });
  expect(helper.killed).toBe(true);
});

it("relays validated integration requests from relay.py, writes the main process's reply by id, and reports the end", async () => {
  const c = channel();
  await c.tick();
  c.to({ type: "integration.start", session: "i", workspaceId: "w", sprite: "civic-spark-x" });
  const child = spawned[0]?.child as FakeChild;
  expect(spawned[0]?.args.slice(-2)).toEqual([
    "python3",
    "/home/sprite/.civic-spark-agent/relay.py",
  ]);
  const stdin = lines(child.stdin);
  const id = "0f1e2d3c-4b5a-4697-8877-665544332211";
  child.stdout.write(
    `${["garbage", JSON.stringify({ id, operation: "shell" }), JSON.stringify({ id, operation: "git-publish" })].join("\n")}\n`,
  );
  await c.tick();
  await c.tick();
  // Only the validated request crosses the channel; nothing about the bad lines does.
  expect(c.sent.slice(1)).toEqual([
    { type: "integration.request", session: "i", request: { id, operation: "git-publish" } },
  ]);
  c.to({
    type: "integration.reply",
    session: "i",
    id,
    response: { ok: true, value: { status: "published", commit: "abc" } },
  });
  c.to({ type: "integration.reply", session: "gone", id, response: { ok: false, error: "x" } });
  await c.tick();
  expect(stdin.map((line) => JSON.parse(line))).toEqual([
    { id, ok: true, value: { status: "published", commit: "abc" } },
  ]);
  c.to({ type: "integration.stop", session: "i" });
  await c.tick();
  await c.tick();
  expect(child.killed).toBe(true);
  expect(c.sent.at(-1)).toEqual({ type: "integration.ended", session: "i" });
  c.to({ type: "integration.reply", session: "i", id, response: { ok: true, value: null } });
  await c.tick();
  expect(stdin).toHaveLength(1);
});

it("stops every child on shutdown, answers late start requests, and exits once helpers close", async () => {
  const c = channel();
  c.to({ type: "agent.start", session: "a", workspaceId: "w", sprite: "civic-spark-x" });
  c.to({ type: "terminal.start", session: "t", workspaceId: "w", sprite: "civic-spark-x" });
  c.to({ type: "integration.start", session: "i", workspaceId: "w", sprite: "civic-spark-x" });
  c.to({
    type: "session.start",
    session: "h",
    args: [],
    options: { scripts: {}, readyTimeoutMs: 5000, idleMs: 5000, maxLine: 4096, maxInFlight: 2 },
  });
  const [agent, integration, helper] = [
    spawned[0]?.child as FakeChild,
    spawned[1]?.child as FakeChild,
    spawned[2]?.child as FakeChild,
  ];
  c.to({ type: "shutdown" });
  c.to({ type: "agent.start", session: "late", workspaceId: "w", sprite: "civic-spark-y" });
  c.to({ type: "integration.start", session: "late-i", workspaceId: "w", sprite: "civic-spark-y" });
  await vi.waitFor(() => expect(c.exit).toHaveBeenCalledWith(0));
  expect(agent.killed && integration.killed && helper.killed).toBe(true);
  expect(ptys[0]?.kill).toHaveBeenCalled();
  expect(spawned).toHaveLength(3);
  expect(c.sent).toContainEqual({ type: "agent.ended", session: "late" });
  expect(c.sent).toContainEqual({ type: "integration.ended", session: "late-i" });
  expect(c.sent).toContainEqual({ type: "integration.ended", session: "i" });
});

it("emits per-worker relay telemetry with loop delay, CPU share and owned session counts", async () => {
  vi.stubEnv("CIVIC_SPARK_DIAGNOSTICS", "1");
  vi.useFakeTimers();
  const sink = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const c = channel();
    c.to({ type: "agent.start", session: "a", workspaceId: "w", sprite: "civic-spark-x" });
    c.to({ type: "integration.start", session: "i", workspaceId: "w", sprite: "civic-spark-x" });
    await vi.advanceTimersByTimeAsync(10000);
    const record = sink.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((log) => log.event === "relay");
    expect(record).toMatchObject({
      event: "relay",
      worker: 3,
      agents: 1,
      terminals: 0,
      integrations: 1,
      helpers: 0,
    });
    for (const key of ["loopP50Ms", "loopP99Ms", "loopMaxMs", "cpuPercent", "rssMb", "commands"])
      expect(typeof record[key]).toBe("number");
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

it("assigns workspaces to workers by a stable hash", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `workspace-${i}`);
  const first = ids.map((id) => assignWorker(id, 3));
  expect(ids.map((id) => assignWorker(id, 3))).toEqual(first);
  expect(new Set(first)).toEqual(new Set([0, 1, 2]));
  expect(assignWorker("anything", 1)).toBe(0);
});
