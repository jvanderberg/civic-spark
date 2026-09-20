import type { EventEmitter } from "node:events";
import type { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  type IntegrationRequest,
  IntegrationRunner,
} from "../apps/server/src/relay/integration-runner.ts";

// The relay.py child owner with a fake process: no `sprite` CLI is spawned.
// It must launch only the fixed CLI, forward only valid request lines, write
// answers by id, and report its end exactly once.
type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill(signal?: string): boolean;
  exit(code: number | null, signal?: string | null): void;
};
const spawned = vi.hoisted(() => [] as { file: string; args: string[]; child: FakeChild }[]);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...original,
    spawn: (file: string, args: string[]) => {
      let finished = false;
      const child: FakeChild = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill(signal = "SIGTERM") {
          child.killed = true;
          child.exit(null, signal);
          return true;
        },
        exit(code: number | null, signal: string | null = null) {
          if (finished) return;
          finished = true;
          child.stdout.end();
          child.stderr.end();
          setImmediate(() => child.emit("close", code, signal));
        },
      });
      spawned.push({ file, args, child });
      return child;
    },
  };
});
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
const tick = () => new Promise((resolve) => setImmediate(resolve));
afterEach(() => {
  spawned.length = 0;
  vi.unstubAllEnvs();
});

it("launches the fixed sprite relay command, forwards only valid requests, answers by id and ends once", async () => {
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "org-fixture");
  const requests: IntegrationRequest[] = [];
  const ended = vi.fn();
  const runner = new IntegrationRunner("civic-spark-x", {
    request: (request) => requests.push(request),
    ended,
  });
  const entry = spawned[0];
  if (!entry) throw new Error("Not spawned");
  expect(entry.file).toBe("sprite");
  expect(entry.args.slice(0, 5)).toEqual(["-o", "org-fixture", "-s", "civic-spark-x", "exec"]);
  expect(entry.args).toContain("--no-port-forward");
  expect(entry.args.slice(-3)).toEqual([
    "--",
    "python3",
    "/home/sprite/.civic-spark-agent/relay.py",
  ]);
  const upload = entry.args[entry.args.indexOf("--file") + 1] ?? "";
  expect(upload.endsWith(":/home/sprite/.civic-spark-agent/relay.py")).toBe(true);
  expect(upload.split(":")[0]?.endsWith("packages/agents/runtime/relay.py")).toBe(true);
  const stdin = lines(entry.child.stdin);
  const id = "0f1e2d3c-4b5a-4697-8877-665544332211";
  entry.child.stdout.write(
    `${[
      "not json",
      JSON.stringify({ id: "short", operation: "git-status" }),
      JSON.stringify({ id, operation: "rm -rf" }),
      JSON.stringify({ id, operation: "git-status", extra: true }),
      JSON.stringify({ id, operation: "preview-start", port: 80 }),
      `{"id":"${id}","operation":"git-status","pad":"${"x".repeat(70000)}"}`,
      JSON.stringify({
        id,
        operation: "preview-start",
        port: 5173,
        command: ["npm", "run", "dev"],
      }),
    ].join("\n")}\n`,
  );
  await tick();
  // Unknown keys are dropped by validation; malformed, oversized and
  // out-of-range lines never reach the caller.
  expect(requests).toEqual([
    { id, operation: "git-status" },
    { id, operation: "preview-start", port: 5173, command: ["npm", "run", "dev"] },
  ]);
  runner.respond(id, { ok: true, value: { pending: null } });
  runner.respond(id, { ok: false, error: "Workspace access ended." });
  await tick();
  expect(stdin.map((line) => JSON.parse(line))).toEqual([
    { id, ok: true, value: { pending: null } },
    { id, ok: false, error: "Workspace access ended." },
  ]);
  expect(runner.ended).toBe(false);
  runner.stop();
  await tick();
  await tick();
  expect(entry.child.killed).toBe(true);
  expect(runner.ended).toBe(true);
  expect(ended).toHaveBeenCalledOnce();
  // After the end: replies are dropped, late lines are ignored, no second end.
  runner.respond(id, { ok: true, value: null });
  entry.child.emit("error", new Error("late"));
  await tick();
  expect(stdin).toHaveLength(2);
  expect(ended).toHaveBeenCalledOnce();
});

it("reports a spawn failure as an end without forwarding anything", async () => {
  const request = vi.fn();
  const ended = vi.fn();
  new IntegrationRunner("civic-spark-y", { request, ended });
  const entry = spawned[0];
  if (!entry) throw new Error("Not spawned");
  expect(entry.args).not.toContain("-o");
  entry.child.emit("error", Object.assign(new Error("spawn sprite ENOENT"), { code: "ENOENT" }));
  entry.child.exit(null);
  await tick();
  await tick();
  expect(ended).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
});
