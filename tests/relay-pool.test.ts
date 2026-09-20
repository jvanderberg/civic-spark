import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { RelayPool } from "../apps/server/src/relay/pool.ts";
import type { FromWorker } from "../apps/server/src/relay/protocol.ts";

const fixture = fileURLToPath(new URL("./relay-fixture-worker.ts", import.meta.url));
let pool: RelayPool | undefined;
afterEach(async () => {
  await pool?.close();
  pool = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const records = (sink: { mock: { calls: unknown[][] } }) =>
  sink.mock.calls
    .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
    .filter((record) => record.event === "relay.worker");

it("queues messages until a forked worker is ready, reports a crash to every handler, restarts with diagnostics, and exits on close", async () => {
  vi.stubEnv("CIVIC_SPARK_DIAGNOSTICS", "1");
  const sink = vi.spyOn(console, "info").mockImplementation(() => {});
  pool = new RelayPool(1, { entry: fixture, restartDelayMs: 50 });
  const worker = pool.for("workspace");
  const received: FromWorker[] = [];
  const lost = vi.fn();
  worker.register("s", { message: (message) => received.push(message), lost });
  // Sent before the fork has reported ready: delivered once it is.
  worker.send({ type: "agent.input", session: "s", line: "first", prompt: false });
  await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10000 });
  expect(received[0]).toEqual({ type: "agent.frames", session: "s", frames: ["first"] });
  const firstPid = worker.child?.pid;
  worker.send({ type: "agent.kill", session: "s" });
  await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
  expect(worker.alive).toBe(false);
  // Handlers registered before the crash are gone; new work waits for the replacement.
  const late: FromWorker[] = [];
  worker.register("n", { message: (message) => late.push(message), lost: () => {} });
  worker.send({ type: "agent.input", session: "n", line: "after", prompt: false });
  await vi.waitFor(() => expect(late).toHaveLength(1), { timeout: 10000 });
  expect(worker.restarts).toBe(1);
  expect(worker.child?.pid).not.toBe(firstPid);
  expect(records(sink)).toEqual([
    expect.objectContaining({ worker: 0, phase: "start", restarts: 0 }),
    expect.objectContaining({ worker: 0, phase: "end", restarts: 0, exitCode: 3 }),
    expect.objectContaining({ worker: 0, phase: "start", restarts: 1 }),
  ]);
  const pid = worker.child?.pid as number;
  await pool.close();
  expect(worker.alive).toBe(false);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(records(sink).at(-1)).toEqual(
    expect.objectContaining({ phase: "end", restarts: 1, exitCode: 0 }),
  );
  // No replacement after close.
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(worker.alive).toBe(false);
}, 20000);
