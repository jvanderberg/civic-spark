import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function gitAsync(cwd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  try {
    const { stdout } = await execute(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args],
      {
        cwd,
        signal,
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "buffer",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
    return stdout;
  } catch {
    throw new Error("Git operation failed. Your existing project has been preserved.");
  }
}

/** Per-repository FIFO, bounded pending work and wait. No participant allocation quota. */
export class GitQueue {
  private tails = new Map<string, Promise<void>>();
  private pending = 0;
  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.pending >= 120)
      throw new Error("Git is busy. Retry shortly; your local commit is preserved.");
    this.pending++;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => next);
    this.tails.set(key, tail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        previous,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Git queue wait expired. Retry; your local commit is preserved.")),
            120000,
          );
        }),
      ]);
      clearTimeout(timer);
      return await work();
    } finally {
      clearTimeout(timer);
      this.pending--;
      release();
      // An expired waiter must not remove the ordering barrier while its
      // predecessor still runs; subsequent work must stay behind that writer.
      void tail.then(() => {
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    }
  }
}
