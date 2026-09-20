import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessions } from "../apps/server/src/agents.ts";
import { fail, ok } from "../packages/domain/src/types.ts";
import type { SpriteClient } from "../packages/sprites/src/client.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it("retries agent preparation with backoff, keeps the preparing marker, and bounds attempts", async () => {
  vi.useFakeTimers();
  vi.stubEnv("CIVIC_SPARK_DIAGNOSTICS", "1");
  const sink = vi.spyOn(console, "info").mockImplementation(() => {});
  const sprite = `civic-spark-${randomUUID()}`;
  const exec = vi
    .fn()
    .mockResolvedValueOnce(fail("PRIVATE-STDERR timed out", 502))
    .mockResolvedValueOnce(ok(Buffer.from("")));
  const sessions = new AgentSessions({ exec, lease: () => undefined } as unknown as SpriteClient);
  const pending = sessions.prepare(sprite);
  await vi.advanceTimersByTimeAsync(0);
  expect(exec).toHaveBeenCalledTimes(1);
  expect(sessions.isPreparing(sprite)).toBe(true);
  await vi.advanceTimersByTimeAsync(1999);
  expect(exec).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toBe(true);
  expect(exec).toHaveBeenCalledTimes(2);
  expect(sessions.isPreparing(sprite)).toBe(false);
  const logged = sink.mock.calls.map((call) => JSON.parse(String(call[0])));
  expect(logged).toEqual([
    expect.objectContaining({ event: "agent.prepare", attempt: 2, outcome: "ok" }),
  ]);
  expect(JSON.stringify(logged)).not.toContain("PRIVATE");

  exec.mockReset();
  exec.mockResolvedValue(fail("still failing", 502));
  const failing = sessions.prepare(sprite);
  void sessions.prepare(sprite); // Concurrent callers share the in-flight preparation.
  await vi.advanceTimersByTimeAsync(0);
  expect(exec).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000 + 4000);
  await expect(failing).resolves.toBe(false);
  expect(exec).toHaveBeenCalledTimes(3);
  expect(sessions.isPreparing(sprite)).toBe(false);
});
