import type { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { BLOB_BODY_LIMIT, TEXT_BODY_LIMIT } from "../packages/workspace/src/types.ts";

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
const oneShots = vi.hoisted(() => [] as { args: string[]; input: string; child: FakeChild }[]);
const oneShot = vi.hoisted(() => ({
  handler: (_args: string[], _input: string): Buffer | Error => Buffer.from(""),
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
      [promisify.custom]: (_file: string, args: string[]) => {
        const child = make();
        const entry = { args, input: "", child };
        oneShots.push(entry);
        child.stdin.on("data", (chunk: Buffer) => {
          entry.input += chunk.toString();
        });
        const promise = new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
          child.stdin.on("finish", () => {
            const output = oneShot.handler(args, entry.input);
            if (output instanceof Error) {
              child.exit(1);
              reject(Object.assign(output, { code: 1, stderr: Buffer.from("") }));
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

type Lease = { name: string; passive: boolean; released: boolean; controller: AbortController };
const leases: Lease[] = [];
const acquire = (name: string, passive = false) => {
  const controller = new AbortController();
  const lease: Lease = { name, passive, released: false, controller };
  leases.push(lease);
  return {
    signal: controller.signal,
    release: () => {
      lease.released = true;
    },
  };
};
const name = "civic-spark-11111111-2222-4333-8444-555555555555";
const helper = (value: unknown) => Buffer.from(JSON.stringify({ ok: true, value }));
function lines(stream: PassThrough) {
  const received: string[] = [];
  let partial = "";
  stream.on("data", (chunk: Buffer) => {
    partial += chunk.toString();
    const parts = partial.split("\n");
    partial = parts.pop() ?? "";
    received.push(...parts);
  });
  return received;
}
async function openSession(client: SpriteClient, reachable = false) {
  // The first read goes one-shot and proves the Sprite reachable; the next read
  // starts the session and waits for its ready handshake.
  oneShot.handler = () => helper(["README.md"]);
  const before = spawned.length;
  if (!reachable) {
    expect(await client.files(name)).toEqual({ ok: true, value: ["README.md"] });
    expect(spawned).toHaveLength(before);
  }
  const pending = client.files(name);
  await vi.waitFor(() => expect(spawned.length).toBe(before + 1));
  const session = spawned.at(-1) as { args: string[]; child: FakeChild };
  const requests = lines(session.child.stdin);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const hello = JSON.parse(requests[0] as string);
  expect(hello.type).toBe("hello");
  expect(Object.keys(hello.scripts).sort()).toEqual([
    "files.py",
    "preview.py",
    "team_git.py",
    "workspace.py",
  ]);
  session.child.stdout.write('{"type":"ready"}\n');
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  const first = JSON.parse(requests[1] as string);
  session.child.stdout.write(
    `${JSON.stringify({ type: "response", id: first.id, stdout: helper(["a.txt"]).toString() })}\n`,
  );
  expect(await pending).toEqual({ ok: true, value: ["a.txt"] });
  return { child: session.child, args: session.args, requests };
}
const records = () =>
  (console.info as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => JSON.parse(String(call[0])))
    .filter((record) => record.kind === "civic-spark.diagnostic");
let client: SpriteClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  spawned.length = 0;
  oneShots.length = 0;
  leases.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("multiplexes reads over one passive session per Sprite and keeps writes and uploads one-shot", async () => {
  vi.stubEnv("CIVIC_SPARK_DIAGNOSTICS", "1");
  vi.spyOn(console, "info").mockImplementation(() => {});
  client = new SpriteClient("test-org", acquire, undefined, undefined, { idleMs: 60000 });
  const { child, args, requests } = await openSession(client);
  expect(args.slice(0, 8)).toEqual([
    "-o",
    "test-org",
    "-s",
    name,
    "exec",
    "--no-port-forward",
    "--",
    "python3",
  ]);
  expect(args[9]).toContain("Read-only helper dispatcher");
  expect(args.join(" ")).not.toContain("/home/sprite/project");
  const sessionLease = leases.find((lease) => lease.passive);
  expect(sessionLease).toMatchObject({ name, passive: true, released: false });
  expect(leases.filter((lease) => !lease.passive).every((lease) => lease.released)).toBe(true);
  const files = client.files(name);
  const changes = client.changes(name);
  const status = client.teamStatus(name, "a".repeat(40));
  const preview = client.preview(name, "status");
  await vi.waitFor(() => expect(requests).toHaveLength(6));
  const sent = requests.slice(2).map((line) => JSON.parse(line));
  expect(sent.map((r) => [r.script, r.payload.operation, r.limit, r.timeoutMs])).toEqual([
    ["files.py", "list", 16 * 1024 * 1024, 30000],
    ["workspace.py", "changes", 16 * 1024 * 1024, 30000],
    ["team_git.py", "status", 16 * 1024 * 1024, 30000],
    ["preview.py", "status", 16 * 1024 * 1024, 30000],
  ]);
  expect(new Set(sent.map((r) => r.id)).size).toBe(4);
  // Replies arrive out of order and are matched by id, not position.
  const reply = (index: number, value: unknown) =>
    child.stdout.write(
      `${JSON.stringify({ type: "response", id: sent[index].id, stdout: helper(value).toString() })}\n`,
    );
  reply(3, { port: 5173, command: ["npm", "run", "dev"], running: false, ready: false });
  reply(1, { base: "b".repeat(40), revision: "c".repeat(64), files: [] });
  reply(0, ["x.ts"]);
  reply(2, {
    head: "d".repeat(40),
    remote: "a".repeat(40),
    incoming: false,
    outgoing: false,
    dirty: false,
    merging: false,
    conflicts: [],
  });
  expect(await files).toEqual({ ok: true, value: ["x.ts"] });
  expect((await changes).ok && (await status).ok && (await preview).ok).toBe(true);
  expect(spawned).toHaveLength(1);
  expect(oneShots).toHaveLength(1);
  // Writes, blob writes and uploads never enter the session.
  oneShot.handler = () => helper({ path: "a.txt", content: "hi", revision: "r" });
  await client.saveFile(name, { path: "a.txt", content: "hi", revision: "r" });
  oneShot.handler = () => helper({ revision: null });
  await client.mutateBlob(name, { path: "a.txt", revision: null, data: null });
  oneShot.handler = () => helper({ imported: "a".repeat(40) });
  await client.importTeam(name, "/tmp/bundle", "a".repeat(40));
  oneShot.handler = () => helper({ head: "e".repeat(40) });
  await client.agentGit(name, { operation: "head" });
  expect(oneShots).toHaveLength(5);
  expect(oneShots[3]?.args).toContain("--file");
  expect(requests).toHaveLength(6);
  // Text and blob reads carry their transfer limits into the session.
  const read = client.readFile(name, "a.txt");
  const blob = client.readBlob(name, "a.txt");
  await vi.waitFor(() => expect(requests).toHaveLength(8));
  const [text, binary] = requests.slice(6).map((line) => JSON.parse(line));
  expect([text.limit, text.timeoutMs, binary.limit]).toEqual([
    TEXT_BODY_LIMIT,
    120000,
    BLOB_BODY_LIMIT,
  ]);
  child.stdout.write(
    `${JSON.stringify({ type: "response", id: text.id, stdout: helper({ path: "a.txt", content: "hi", revision: "r" }).toString() })}\n`,
  );
  child.stdout.write(
    `${JSON.stringify({ type: "response", id: binary.id, stdout: helper({ path: "a.txt", data: "aGk=", revision: "r" }).toString() })}\n`,
  );
  expect((await read).ok && (await blob).ok).toBe(true);
  const commands = records().filter((record) => record.event === "sprite.command");
  expect(commands.filter((record) => record.transport === "session")).toHaveLength(7);
  expect(commands.filter((record) => record.transport === "process")).toHaveLength(5);
  expect(commands.every((record) => record.outcome === "ok")).toBe(true);
  expect(commands[1]).toMatchObject({
    transport: "session",
    workspaceId: "11111111-2222-4333-8444-555555555555",
  });
  expect(typeof commands[1]?.queueMs).toBe("number");
  expect(typeof commands[1]?.executionMs).toBe("number");
  expect(records().filter((record) => record.event === "sprite.session")).toEqual([
    expect.objectContaining({
      phase: "start",
      outcome: "ok",
      workspaceId: "11111111-2222-4333-8444-555555555555",
    }),
  ]);
  expect(JSON.stringify(records())).not.toContain("README.md");
});

it("reports oversize or failed helper replies as errors, and ends a session whose output breaks the protocol", async () => {
  vi.stubEnv("CIVIC_SPARK_DIAGNOSTICS", "1");
  vi.spyOn(console, "info").mockImplementation(() => {});
  client = new SpriteClient("test-org", acquire, undefined, undefined, { maxLine: 4096 });
  const { child, requests } = await openSession(client);
  const big = client.readFile(name, "big.txt");
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  const request = JSON.parse(requests[2] as string);
  child.stdout.write(
    `${JSON.stringify({ type: "response", id: request.id, error: "buffer_limit" })}\n`,
  );
  expect(await big).toEqual({
    ok: false,
    status: 502,
    error:
      "Sprite command failed. Check your CLI login and connectivity; no account credentials were logged.",
  });
  const crashed = client.files(name);
  await vi.waitFor(() => expect(requests).toHaveLength(4));
  const second = JSON.parse(requests[3] as string);
  child.stdout.write(
    `${JSON.stringify({ type: "response", id: second.id, error: "process_failed", exitCode: 3 })}\n`,
  );
  expect((await crashed).ok).toBe(false);
  expect(child.killed).toBe(false);
  // A line above the host limit is a protocol failure: the session ends, the
  // in-flight read falls back once, and nothing was buffered beyond the limit.
  oneShot.handler = () => helper(["fallback.txt"]);
  const oversize = client.files(name);
  await vi.waitFor(() => expect(requests).toHaveLength(5));
  child.stdout.write(`${"x".repeat(5000)}\n`);
  expect(await oversize).toEqual({ ok: true, value: ["fallback.txt"] });
  await vi.waitFor(() => expect(child.killed).toBe(true));
  const outcomes = records()
    .filter((record) => record.event === "sprite.command" && record.transport === "session")
    .map((record) => record.outcome);
  expect(outcomes).toEqual(["ok", "buffer_limit", "process_failed", "session_lost"]);
  expect(
    records().find((record) => record.event === "sprite.command" && record.exitCode === 3),
  ).toBeDefined();
});

it("falls back once when the session dies mid-request, backs off, then starts a fresh session", async () => {
  vi.stubEnv("CIVIC_SPARK_DIAGNOSTICS", "1");
  vi.spyOn(console, "info").mockImplementation(() => {});
  client = new SpriteClient("test-org", acquire, undefined, undefined, { retryMs: 150 });
  const { child, requests } = await openSession(client);
  oneShot.handler = (_args, input) =>
    JSON.parse(input).operation === "changes"
      ? helper({ base: "b".repeat(40), revision: "c".repeat(64), files: [] })
      : helper(["recovered.txt"]);
  const a = client.files(name);
  const b = client.changes(name);
  await vi.waitFor(() => expect(requests).toHaveLength(4));
  child.stderr.write("websocket: close 1006 (abnormal closure)");
  child.exit(1);
  expect(await a).toEqual({ ok: true, value: ["recovered.txt"] });
  expect((await b).ok).toBe(true);
  expect(oneShots).toHaveLength(3);
  const passive = leases.filter((lease) => lease.passive);
  expect(passive).toHaveLength(1);
  await vi.waitFor(() => expect(passive[0]?.released).toBe(true));
  const end = records().find(
    (record) => record.event === "sprite.session" && record.phase === "end",
  );
  expect(end).toMatchObject({ outcome: "process_failed", exitCode: 1, stderrKind: "connection" });
  expect(typeof end?.durationMs).toBe("number");
  expect(JSON.stringify(records())).not.toContain("abnormal closure");
  // Inside the retry window reads stay one-shot; afterwards a new session starts.
  await client.files(name);
  expect(spawned).toHaveLength(1);
  expect(oneShots).toHaveLength(4);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const again = client.files(name);
  await vi.waitFor(() => expect(spawned).toHaveLength(2));
  const fresh = spawned[1]?.child as FakeChild;
  const freshRequests = lines(fresh.stdin);
  await vi.waitFor(() => expect(freshRequests).toHaveLength(1));
  fresh.stdout.write('{"type":"ready"}\n');
  await vi.waitFor(() => expect(freshRequests).toHaveLength(2));
  const request = JSON.parse(freshRequests[1] as string);
  fresh.stdout.write(
    `${JSON.stringify({ type: "response", id: request.id, stdout: helper(["fresh.txt"]).toString() })}\n`,
  );
  expect(await again).toEqual({ ok: true, value: ["fresh.txt"] });
  expect(oneShots).toHaveLength(4);
});

it("ends idle sessions, honors disconnect and lease aborts, and never keeps a session for a held workspace", async () => {
  vi.stubEnv("CIVIC_SPARK_DIAGNOSTICS", "1");
  vi.spyOn(console, "info").mockImplementation(() => {});
  client = new SpriteClient("test-org", acquire, undefined, undefined, { idleMs: 150 });
  const first = await openSession(client);
  const sessionLease = leases.find((lease) => lease.passive) as Lease;
  await vi.waitFor(() => expect(first.child.killed).toBe(true));
  await vi.waitFor(() => expect(sessionLease.released).toBe(true));
  expect(records().filter((r) => r.event === "sprite.session" && r.phase === "end")).toEqual([
    expect.objectContaining({ outcome: "ok" }),
  ]);
  // Idle end is not a failure: the next read starts a session immediately.
  const second = await openSession(client, true);
  expect(spawned).toHaveLength(2);
  expect(oneShots).toHaveLength(1);
  // Lifecycle disconnect ends the session; the next read proves reachability again first.
  client.closeSession(name);
  await vi.waitFor(() => expect(second.child.killed).toBe(true));
  expect(await client.files(name)).toEqual({ ok: true, value: ["README.md"] });
  expect(spawned).toHaveLength(2);
  expect(oneShots).toHaveLength(2);
  // A lifecycle abort (pause, delete, shutdown) kills the session and rejects
  // in-flight reads with a retryable error that falls back once.
  const third = await openSession(client, true);
  const lease = leases.filter((l) => l.passive).at(-1) as Lease;
  oneShot.handler = () => helper(["after-abort.txt"]);
  const inflight = client.files(name);
  await vi.waitFor(() => expect(third.requests).toHaveLength(3));
  lease.controller.abort();
  expect(await inflight).toEqual({ ok: true, value: ["after-abort.txt"] });
  await vi.waitFor(() => expect(lease.released).toBe(true));
  expect(
    records()
      .filter((r) => r.event === "sprite.session" && r.phase === "end")
      .at(-1),
  ).toMatchObject({ outcome: "lease_aborted" });
  // A held workspace refuses leases: no session starts and the read reports failure as before.
  const blocked = new SpriteClient(
    "test-org",
    () => {
      throw new Error("Workspace is paused");
    },
    undefined,
    undefined,
    {},
  );
  oneShot.handler = () => helper([]);
  expect(await blocked.files(name)).toMatchObject({ ok: false, status: 502 });
  expect(spawned).toHaveLength(3);
  await blocked.close();
});

it("stays on the one-shot path when sessions are disabled or the Sprite has not answered a command yet", async () => {
  vi.stubEnv("CIVIC_SPARK_HELPER_SESSIONS", "0");
  client = new SpriteClient("test-org", acquire);
  oneShot.handler = () => helper(["one.txt"]);
  await client.files(name);
  await client.files(name);
  expect(oneShots).toHaveLength(2);
  expect(spawned).toHaveLength(0);
  vi.unstubAllEnvs();
  const fresh = new SpriteClient("test-org", acquire);
  oneShot.handler = () => new Error("unreachable");
  expect((await fresh.files(name)).ok).toBe(false);
  await fresh.files(name);
  expect(spawned).toHaveLength(0);
  await fresh.close();
});
