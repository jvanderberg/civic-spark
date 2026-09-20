import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

// The dispatcher itself runs here with trusted fixture scripts only; no
// participant code or real helper is executed on the test host.
const dispatcher = fileURLToPath(
  new URL("../packages/sprites/src/helper_session.py", import.meta.url),
);
const echo = [
  "import json, sys, time",
  "request = json.loads(sys.stdin.read())",
  "time.sleep(request.get('sleep', 0))",
  "if request.get('size'):",
  "    sys.stdout.write('x' * request['size'])",
  "elif request.get('crash'):",
  "    sys.exit(3)",
  "else:",
  "    print(json.dumps({'ok': True, 'value': request['operation']}))",
  "",
].join("\n");
let child: ChildProcessWithoutNullStreams | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
});

it("answers correlated requests as they finish, enforces per-request limits, and stops helpers at EOF", async () => {
  child = spawn("python3", [dispatcher], { stdio: "pipe" });
  const process = child;
  const replies: Record<string, unknown>[] = [];
  createInterface({ input: process.stdout }).on("line", (line) => replies.push(JSON.parse(line)));
  process.stderr.resume();
  const send = (message: object) => process.stdin.write(`${JSON.stringify(message)}\n`);
  send({ type: "hello", scripts: { "echo.py": echo } });
  await vi.waitFor(() => expect(replies[0]).toEqual({ type: "ready" }), 5000);
  const request = (id: string, payload: object, extra: object = {}) =>
    send({
      type: "request",
      id,
      script: "echo.py",
      payload,
      timeoutMs: 30000,
      limit: 1000,
      ...extra,
    });
  request("slow", { operation: "slow", sleep: 0.8 });
  request("fast", { operation: "fast" });
  request("big", { operation: "big", size: 2000 });
  request("late", { operation: "late", sleep: 5 }, { timeoutMs: 1000 });
  request("crash", { operation: "crash", crash: true });
  send({ type: "request", id: "none", script: "missing.py", payload: {} });
  send({ type: "ping", id: "p" });
  await vi.waitFor(() => expect(replies).toHaveLength(8), 8000);
  const byId = Object.fromEntries(replies.slice(1).map((reply) => [reply.id, reply]));
  expect(replies.findIndex((r) => r.id === "fast")).toBeLessThan(
    replies.findIndex((r) => r.id === "slow"),
  );
  expect(JSON.parse(String(byId.slow?.stdout))).toEqual({ ok: true, value: "slow" });
  expect(JSON.parse(String(byId.fast?.stdout))).toEqual({ ok: true, value: "fast" });
  expect(byId.big).toEqual({ type: "response", id: "big", error: "buffer_limit" });
  expect(byId.late).toEqual({ type: "response", id: "late", error: "timeout" });
  expect(byId.crash).toEqual({
    type: "response",
    id: "crash",
    error: "process_failed",
    exitCode: 3,
  });
  expect(byId.none).toEqual({ type: "response", id: "none", error: "unknown_script" });
  expect(byId.p).toEqual({ type: "pong", id: "p" });
  // A helper still running when the host disconnects is killed rather than awaited.
  request("hung", { operation: "hung", sleep: 60 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = Date.now();
  const closed = new Promise<number | null>((resolve) => process.once("close", resolve));
  process.stdin.end();
  expect(await closed).toBe(0);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(replies).toHaveLength(9);
  expect(replies[8]).toMatchObject({ id: "hung", error: "process_failed" });
});
