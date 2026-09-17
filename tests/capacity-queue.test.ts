import { afterEach, expect, it, vi } from "vitest";
import { ok } from "../packages/domain/src/types.ts";
import { GitQueue } from "../packages/git/src/async.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { CommandQueue } from "../packages/sprites/src/command-queue.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps repository ordering when a waiting publication expires", async () => {
  vi.useFakeTimers();
  const queue = new GitQueue();
  let release!: () => void;
  const first = queue.run(
    "repo",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(0);
  const second = queue.run("repo", async () => {
    throw new Error("Expired work must not start");
  });
  const rejected = expect(second).rejects.toThrow("expired");
  await vi.advanceTimersByTimeAsync(120000);
  await rejected;
  let started = false;
  const third = queue.run("repo", async () => {
    started = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(started).toBe(false);
  release();
  await first;
  await third;
  expect(started).toBe(true);
});
it("bounds active operations, cancels queued work, reports retryable pressure and recovers slots", async () => {
  const queue = new CommandQueue(2, 25);
  const first = await queue.acquire();
  const second = await queue.acquire();
  const cancel = new AbortController();
  const pending = queue.acquire(cancel.signal);
  cancel.abort();
  await expect(pending).rejects.toThrow("cancelled");
  await expect(queue.acquire()).rejects.toThrow("busy");
  first();
  first();
  const recovered = await queue.acquire();
  let acquired = false;
  const next = queue.acquire().then((release) => {
    acquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(acquired).toBe(false);
  second();
  const last = await next;
  last();
  recovered();
  const fresh = await queue.acquire();
  fresh();
});
it("coalesces only matching in-flight workspace reads and never caches subsequent edits or other owners", async () => {
  const client = new SpriteClient();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const command = vi.spyOn(client, "command").mockImplementation(async () => {
    await gate;
    return ok(Buffer.from(JSON.stringify({ ok: true, value: ["README.md"] })));
  });
  const same = Array.from({ length: 60 }, () => client.files("civic-spark-one"));
  const other = client.files("civic-spark-two");
  expect(command).toHaveBeenCalledTimes(2);
  release();
  await Promise.all([...same, other]);
  await client.files("civic-spark-one");
  expect(command).toHaveBeenCalledTimes(3);
});
