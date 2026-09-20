import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AgentSessions } from "../apps/server/src/agents.ts";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspaceIntegrations } from "../apps/server/src/integrations.ts";
import type { AgentEvent } from "../packages/agents/src/protocol.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { testIdentity } from "./auth-fixture.ts";

// Real relay worker processes with a fake `sprite` executable: the fake plays
// the agent runner, the terminal shell, the real relay.py against a host-side
// spool directory, and the trusted Python adapters. No participant code, live
// Sprite or paid model is involved.
const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const eventInput = {
  name: "Relay fixture",
  date: "2026-10-03",
  timezone: "America/Chicago",
  location: "Test",
  capacity: 10,
  budget: 0,
  templateId: "blank" as const,
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture(workers: string) {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-relay-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const project = join(root, "project");
  const marks = join(root, "marks");
  const spool = join(root, "spool");
  for (const dir of [bin, project, marks]) mkdirSync(dir);
  writeFileSync(join(project, "README.md"), "# Fixture\n");
  // Every fake child records its parent pid so the test can prove which
  // process owns it: the main process (in-process mode) or a relay worker.
  // The relay branch runs the committed relay.py itself, pointed at a spool
  // directory on this host instead of the Sprite's.
  writeFileSync(
    join(bin, "sprite"),
    [
      "#!/usr/bin/env python3",
      "import json, os, subprocess, sys",
      `ROOT = ${JSON.stringify(project)}`,
      `MARKS = ${JSON.stringify(marks)}`,
      `SPOOL = ${JSON.stringify(spool)}`,
      "def mark(kind):",
      "    with open(os.path.join(MARKS, kind + '-' + str(os.getpid())), 'w') as f:",
      "        f.write(str(os.getppid()))",
      "args = sys.argv[1:]",
      "if '--tty' in args:",
      "    mark('terminal')",
      "    sys.stdout.write('Civic Spark terminal connected\\r\\n'); sys.stdout.flush()",
      "    while True:",
      "        data = os.read(0, 4096)",
      "        if not data: break",
      "        os.write(1, b'echo:' + data)",
      "    sys.exit(0)",
      "if any(a.endswith('/runner.ts') for a in args):",
      "    mark('runner')",
      "    def out(m):",
      "        sys.stdout.write(json.dumps(m) + '\\n'); sys.stdout.flush()",
      "    out({'type': 'state', 'id': 'fixture', 'text': 'Ready', 'runtimeReady': True, 'working': False})",
      "    for line in sys.stdin:",
      "        m = json.loads(line)",
      "        if m['type'] == 'prompt':",
      "            out({'type': 'user', 'id': m.get('id', 'u1'), 'text': m['text']})",
      "            out({'type': 'status', 'id': 's1', 'text': 'Working'})",
      "            for piece in ('Hel', 'lo ', 'relay'):",
      "                out({'type': 'text', 'id': 'm1', 'text': piece})",
      "            out({'type': 'done', 'id': 'd1', 'text': 'Ready', 'outcome': 'success'})",
      "        elif m['type'] == 'stop':",
      "            break",
      "    sys.exit(0)",
      "if args[-1].endswith('/relay.py'):",
      "    mark('relay')",
      "    source = [a for a in args if a.endswith(':/home/sprite/.civic-spark-agent/relay.py')][0].rsplit(':', 1)[0]",
      "    code = open(source).read().replace('/home/sprite/.civic-spark-agent/integration', SPOOL)",
      "    exec(compile(code, '<trusted-relay>', 'exec'))",
      "    sys.exit(0)",
      "mark('command')",
      "if args[-1] == 'true': sys.exit(0)",
      `fix = lambda s: s.replace('/home/sprite/project', ROOT).replace('/home/sprite/.civic-spark-file-lock', ${JSON.stringify(join(root, ".file-lock"))})`,
      "class Popen(subprocess.Popen):",
      "    def __init__(self, a, *rest, **options):",
      "        super().__init__([fix(x) if isinstance(x, str) else x for x in a], *rest, **options)",
      "subprocess.Popen = Popen",
      "exec(compile(fix(sys.argv[-1]), '<trusted-sprite-adapter>', 'exec'))",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "sprite"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("CIVIC_SPARK_RELAY_WORKERS", workers);
  // Tool setup inside the Sprite is not under test; the prepare route still
  // registers the workspace with the integration relay.
  vi.spyOn(AgentSessions.prototype, "prepare").mockResolvedValue(true);
  const provider = {
    inspect: vi.fn(async () => ({
      status: "running" as const,
      observedAt: new Date().toISOString(),
      createdAt: null,
      updatedAt: null,
      error: null,
    })),
    stop: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  };
  const created = await createApp(
    join(root, "data"),
    true,
    "http://127.0.0.1:4310",
    undefined,
    "email",
    undefined,
    provider,
  );
  const { app, service, authentication } = created;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  cleanups.push(close);
  const owner = await testIdentity(authentication, "Relay owner");
  if (!owner.actor) throw new Error("Missing actor");
  const event = unwrap(service.createEvent(owner.actor, eventInput));
  const workspace = unwrap(
    service.createTeam(owner.actor, {
      eventId: event.id,
      name: "Relay team",
      projectId: "data-starter",
    }),
  ).workspace;
  const sprite = `civic-spark-${workspace.id}`;
  service.setSprite(workspace.id, sprite, "ready", null);
  const headers = { cookie: owner.cookie, origin: "http://127.0.0.1:4310" };
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  // Marks are named by PID; order them by creation so "first, then replacement"
  // assertions do not depend on which process got the smaller number.
  const marksOf = (kind: string) =>
    readdirSync(marks)
      .filter((name) => name.startsWith(`${kind}-`))
      .map((name) => ({
        pid: Number(name.slice(kind.length + 1)),
        parent: Number(readFileSync(join(marks, name), "utf8")),
        created: statSync(join(marks, name)).birthtimeMs,
      }))
      .sort((a, b) => a.created - b.created)
      .map(({ pid, parent }) => ({ pid, parent }));
  const prepare = async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/agent/prepare`,
      headers,
    });
    expect(response.json()).toEqual({ ready: true });
  };
  // What the in-Sprite `civic-spark` CLI does: spool one request file and
  // wait for relay.py to write the response file with the same id.
  const cli = async (request: object, timeoutMs = 10000) => {
    const id = crypto.randomUUID();
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    writeFileSync(join(spool, `${id}.request`), JSON.stringify(request), { mode: 0o600 });
    const response = join(spool, `${id}.response`);
    try {
      const started = Date.now();
      while (!existsSync(response)) {
        if (Date.now() - started > timeoutMs) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return JSON.parse(readFileSync(response, "utf8")) as Record<string, unknown>;
    } finally {
      rmSync(join(spool, `${id}.request`), { force: true });
      rmSync(response, { force: true });
    }
  };
  const open = (channel: "agent" | "terminal") => {
    const socket = new WebSocket(
      `${address.replace("http", "ws")}/api/workspaces/${workspace.id}/${channel}`,
      { headers },
    );
    const frames: Record<string, unknown>[] = [];
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    cleanups.push(() => socket.terminate());
    return {
      socket,
      frames,
      closed,
      opened: new Promise<void>((r) => socket.once("open", () => r())),
    };
  };
  return {
    ...created,
    close,
    root,
    event,
    workspace,
    sprite,
    headers,
    address,
    marksOf,
    open,
    prepare,
    cli,
    provider,
  };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it("relays agent turns, terminal output with history, helper sessions and one-shot commands through worker processes, survives a worker crash and shuts down cleanly", async () => {
  const f = await fixture("2");
  const relay = f.relay;
  if (!relay) throw new Error("Relay expected");
  expect(relay.pool.workers).toHaveLength(2);
  const worker = relay.pool.for(f.workspace.id);
  const workerPid = worker.child?.pid;
  expect(workerPid).toBeDefined();

  // Integration relay: prepare registers the workspace but starts no child
  // until an agent or terminal session exists.
  await f.prepare();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(f.marksOf("relay")).toHaveLength(0);
  expect(f.integrations.active(f.workspace.id)).toBe(false);

  // Agent: the runner child belongs to the worker, replay arrives before live
  // frames, deltas of one message are merged, and a reconnect replays the turn.
  const agent = f.open("agent");
  await agent.opened;
  await vi.waitFor(() =>
    expect(agent.frames.some((e) => e.type === "state" && e.runtimeReady === true)).toBe(true),
  );
  expect(f.marksOf("runner").map((m) => m.parent)).toEqual([workerPid]);
  // The relay child started with the session, under the same worker, and a
  // CLI request spooled inside the "Sprite" is answered by the main process.
  await vi.waitFor(() => expect(f.marksOf("relay").map((m) => m.parent)).toEqual([workerPid]));
  expect(f.integrations.active(f.workspace.id)).toBe(true);
  const status = await f.cli({ operation: "git-status" });
  expect(status).toMatchObject({
    ok: true,
    value: { pending: null, instructions: expect.any(String) },
  });
  const relayPid = f.marksOf("relay")[0]?.pid as number;
  const promptId = crypto.randomUUID();
  agent.socket.send(
    JSON.stringify({ type: "prompt", provider: "claude", text: "hi", id: promptId }),
  );
  await vi.waitFor(() => expect(agent.frames.some((e) => e.type === "done")).toBe(true));
  const live = agent.frames.filter((e) => !e.replayed && e.type !== "state") as AgentEvent[];
  expect(live.slice(0, 2).map((e) => e.type)).toEqual(["user", "status"]);
  expect(live.at(-1)?.type).toBe("done");
  // Three deltas of one message left the runner; fewer frames reach the browser.
  const texts = live.filter((e) => e.type === "text");
  expect(texts.map((e) => e.text).join("")).toBe("Hello relay");
  expect(texts.length).toBeLessThan(3);
  const second = f.open("agent");
  await second.opened;
  await vi.waitFor(() => expect(second.frames.some((e) => e.type === "state")).toBe(true));
  const replayed = second.frames.filter((e) => e.replayed) as AgentEvent[];
  expect(replayed.map((e) => [e.type, e.text])).toEqual([
    ["user", "hi"],
    ["status", "Working"],
    ["text", "Hello relay"],
    ["done", "Ready"],
  ]);
  expect(f.marksOf("runner")).toHaveLength(1);
  const busy = await f.app.inject({
    url: `/api/events/${f.event.id}/sprites`,
    headers: f.headers,
  });
  expect(busy.json().sprites[0].working).toBe(false);

  // Terminal: PTY output relays, typed input echoes, and a reattach receives the history.
  const terminal = f.open("terminal");
  await terminal.opened;
  const output = () => terminal.frames.map((frame) => String(frame.data)).join("");
  await vi.waitFor(() => expect(output()).toContain("connected"));
  expect(f.marksOf("terminal").map((m) => m.parent)).toEqual([workerPid]);
  terminal.socket.send(JSON.stringify({ type: "input", data: "ls\r" }));
  await vi.waitFor(() => expect(output()).toContain("echo:ls"));
  terminal.socket.close();
  await terminal.closed;
  const again = f.open("terminal");
  await again.opened;
  await vi.waitFor(() => expect(again.frames.length).toBeGreaterThan(0));
  expect(String(again.frames[0]?.data)).toContain("connected");
  expect(String(again.frames[0]?.data)).toContain("echo:ls");
  expect(f.marksOf("terminal")).toHaveLength(1);

  // Helper reads: the first list is a one-shot command, the second starts the
  // per-Sprite helper session, and the third is answered by that session
  // without another child. All of them run under the worker.
  for (let i = 0; i < 3; i++) {
    const files = await f.app.inject({
      url: `/api/workspaces/${f.workspace.id}/files`,
      headers: f.headers,
    });
    expect(files.statusCode, `files ${i}`).toBe(200);
    expect(files.json()).toEqual(["README.md"]);
  }
  expect(f.marksOf("command")).toHaveLength(2);
  expect(f.marksOf("command").every((m) => m.parent === workerPid)).toBe(true);
  const runnerPid = f.marksOf("runner")[0]?.pid as number;

  // Worker crash: sockets close with the existing reconnect codes, leases are
  // released so a pause can drain, and the pool restarts the worker.
  process.kill(workerPid as number, "SIGKILL");
  expect(await Promise.all([agent.closed, second.closed, again.closed])).toEqual([
    1011, 1011, 1000,
  ]);
  // The relay child lost its worker: the main process drops the handle (a
  // request in flight can no longer be answered) and the orphan exits on its
  // closed pipe.
  await vi.waitFor(() => expect(f.integrations.active(f.workspace.id)).toBe(false));
  await vi.waitFor(() => expect(alive(relayPid)).toBe(false));
  const paused = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.event.id}/execution`,
    headers: f.headers,
    payload: { action: "pause-event" },
  });
  expect(paused.json()).toMatchObject({ paused: true, failures: 0 });
  await vi.waitFor(() => expect(worker.alive && worker.restarts === 1).toBe(true), {
    timeout: 5000,
  });
  expect(worker.child?.pid).not.toBe(workerPid);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `/api/events/${f.event.id}/execution`,
        headers: f.headers,
        payload: { action: "unpause-event" },
      })
    ).statusCode,
  ).toBe(200);
  const woke = await f.app.inject({
    method: "POST",
    url: `/api/workspaces/${f.workspace.id}/wake`,
    headers: f.headers,
  });
  expect(woke.json()).toEqual({ awake: true });
  const reconnected = f.open("agent");
  await reconnected.opened;
  await vi.waitFor(() =>
    expect(reconnected.frames.some((e) => e.type === "state" && e.runtimeReady === true)).toBe(
      true,
    ),
  );
  expect(f.marksOf("runner").map((m) => m.parent)).toEqual([workerPid, worker.child?.pid]);
  expect(f.marksOf("command").at(-1)?.parent).toBe(worker.child?.pid);
  // The orphaned runner from the crashed worker receives no more input; it is
  // not the main process's child and cannot keep the server loop busy.
  expect(runnerPid).not.toBe(process.pid);
  // The pause ended the relay registration, so the reconnect alone started no
  // relay child. The browser prepares again before it reconnects; with the
  // session already up the child starts at once, under the replacement
  // worker, and answers again.
  expect(f.marksOf("relay")).toHaveLength(1);
  await f.prepare();
  await vi.waitFor(() =>
    expect(
      f
        .marksOf("relay")
        .map((m) => m.parent)
        .sort(),
    ).toEqual([workerPid, worker.child?.pid].sort()),
  );
  expect((await f.cli({ operation: "git-status" }))?.ok).toBe(true);
  const newRelay = f.marksOf("relay").find((m) => m.pid !== relayPid)?.pid as number;

  // Shutdown: workers exit with the app and their children are gone.
  const pids = relay.pool.workers.map((w) => w.child?.pid as number);
  const newRunner = f.marksOf("runner")[1]?.pid as number;
  await f.close();
  for (const pid of pids) expect(alive(pid)).toBe(false);
  await vi.waitFor(() => expect(alive(newRunner)).toBe(false));
  await vi.waitFor(() => expect(alive(newRelay)).toBe(false));
  expect(relay.pool.workers.every((w) => !w.alive)).toBe(true);
}, 40000);

it("keeps every Sprite child in the server process when CIVIC_SPARK_RELAY_WORKERS=0, ends the integration relay a grace period after the last session, and stops it on lifecycle disconnect", async () => {
  const defaults = [WorkspaceIntegrations.checkIntervalMs, WorkspaceIntegrations.idleGraceMs];
  WorkspaceIntegrations.checkIntervalMs = 100;
  WorkspaceIntegrations.idleGraceMs = 200;
  cleanups.push(() => {
    [WorkspaceIntegrations.checkIntervalMs, WorkspaceIntegrations.idleGraceMs] = defaults as [
      number,
      number,
    ];
  });
  const f = await fixture("0");
  expect(f.relay).toBeUndefined();
  await f.prepare();
  const agent = f.open("agent");
  await agent.opened;
  await vi.waitFor(() =>
    expect(agent.frames.some((e) => e.type === "state" && e.runtimeReady === true)).toBe(true),
  );
  agent.socket.send(JSON.stringify({ type: "prompt", provider: "claude", text: "hi" }));
  await vi.waitFor(() => expect(agent.frames.some((e) => e.type === "done")).toBe(true));
  expect(agent.frames.find((e) => e.type === "text")?.text).toBe("Hello relay");
  const files = await f.app.inject({
    url: `/api/workspaces/${f.workspace.id}/files`,
    headers: f.headers,
  });
  expect(files.json()).toEqual(["README.md"]);
  expect(f.marksOf("runner").map((m) => m.parent)).toEqual([process.pid]);
  expect(f.marksOf("command").map((m) => m.parent)).toEqual([process.pid]);
  await vi.waitFor(() => expect(f.marksOf("relay").map((m) => m.parent)).toEqual([process.pid]));
  expect((await f.cli({ operation: "git-status" }))?.ok).toBe(true);

  // The runner exits: the agent session ends and, one grace period later, so
  // does the relay child. The registration survives, so the next attach
  // starts a new child without another prepare.
  const first = f.marksOf("relay")[0]?.pid as number;
  process.kill(f.marksOf("runner")[0]?.pid as number);
  expect(await agent.closed).toBe(1011);
  await vi.waitFor(() => expect(alive(first)).toBe(false), { timeout: 5000 });
  expect(f.integrations.active(f.workspace.id)).toBe(false);
  const again = f.open("agent");
  await again.opened;
  await vi.waitFor(() =>
    expect(again.frames.some((e) => e.type === "state" && e.runtimeReady === true)).toBe(true),
  );
  await vi.waitFor(() => expect(f.marksOf("relay")).toHaveLength(2));
  const second = f.marksOf("relay").find((m) => m.pid !== first)?.pid as number;
  expect(f.integrations.active(f.workspace.id)).toBe(true);
  expect((await f.cli({ operation: "git-status" }))?.ok).toBe(true);

  // Lifecycle disconnect (pause) ends the child and forgets the registration.
  const paused = await f.app.inject({
    method: "POST",
    url: `/api/events/${f.event.id}/execution`,
    headers: f.headers,
    payload: { action: "pause-event" },
  });
  expect(paused.json()).toMatchObject({ paused: true, failures: 0 });
  expect(await again.closed).toBe(1008);
  await vi.waitFor(() => expect(alive(second)).toBe(false));
  expect(f.integrations.active(f.workspace.id)).toBe(false);
}, 30000);
