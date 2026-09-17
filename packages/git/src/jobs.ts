import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const gitJobSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("commit"),
    root: z.string(),
    title: z.string(),
    revision: z.string(),
  }),
  z.object({
    operation: z.literal("prepare"),
    source: z.string(),
    repo: z.string(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    ref: z.string().regex(/^refs\/civic-spark\/prepared\/[a-f0-9-]{36}$/),
  }),
]);
export type GitJob = z.infer<typeof gitJobSchema>;
export const gitJobResultSchema = z.object({
  commit: z.string().optional(),
  main: z.string().optional(),
  diff: z.string().optional(),
});
let active = 0;
const waiting: (() => void)[] = [];

// Fixed trusted repository code, never project scripts, hooks or SQLite. The two
// workers bound CPU/memory pressure; queued jobs are transient work, not allocations.
export async function gitJob(input: GitJob, signal?: AbortSignal) {
  const immutable = JSON.stringify(gitJobSchema.parse(input));
  if (waiting.length >= 120) throw new Error("Git is busy. Retry shortly.");
  signal?.throwIfAborted();
  if (active >= 2)
    await new Promise<void>((resolve, reject) => {
      const remove = () => {
        const i = waiting.indexOf(resume);
        if (i >= 0) waiting.splice(i, 1);
      };
      const abort = () => {
        remove();
        clearTimeout(timer);
        reject(new Error("Git preparation cancelled"));
      };
      const resume = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(() => {
        remove();
        signal?.removeEventListener("abort", abort);
        reject(new Error("Git queue wait expired. Retry shortly."));
      }, 120000);
      waiting.push(resume);
      signal?.addEventListener("abort", abort, { once: true });
    });
  else active++;
  try {
    signal?.throwIfAborted();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./job-worker.ts", import.meta.url))],
      {
        detached: process.platform !== "win32",
        stdio: "pipe",
        // Do not hand service/provider credentials to a Git worker.
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          SYSTEMROOT: process.env.SYSTEMROOT,
        },
      },
    );
    // Kill and drain the whole worker process group, including in-flight Git.
    // Releasing its slot while a child still writes could corrupt a retry.
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* Already exited. */
      }
    };
    const timer = setTimeout(stop, 30000);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdin.end(immutable);
    child.stdin.on("error", () => {});
    const stdout = await new Promise<string>((resolve, reject) => {
      let output = "";
      let failed = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (Buffer.byteLength(output) > 1024 * 1024) {
          failed = true;
          stop();
        }
      });
      child.stderr.resume();
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        if (failed || code !== 0)
          reject(
            new Error(
              "Git preparation was interrupted. Your local commit is preserved; retry to inspect its state.",
            ),
          );
        else resolve(output);
      });
    });
    const result = z
      .discriminatedUnion("ok", [
        z.object({ ok: z.literal(true), value: gitJobResultSchema }),
        z.object({ ok: z.literal(false), error: z.string() }),
      ])
      .parse(JSON.parse(stdout));
    if (!result.ok) throw new Error(result.error);
    return result.value;
  } catch (error) {
    // Worker stdout/stderr may include paths. Never forward process diagnostics.
    if (error instanceof Error && !("cmd" in error) && !("stderr" in error)) throw error;
    throw new Error(
      "Git preparation was interrupted. Your local commit is preserved; retry to inspect its state.",
    );
  } finally {
    const resume = waiting.shift();
    if (resume) resume();
    else active--;
  }
}
