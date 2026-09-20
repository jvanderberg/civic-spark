import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { count } from "../../diagnostics/src/index.ts";
import { CommandBusy } from "./command-queue.ts";

/** The session died or was ended before answering; the caller may retry once without it. */
export class HelperSessionLost extends Error {}
export type HelperReply =
  | { stdout: string }
  | { error: "timeout" | "buffer_limit" | "process_failed" | "unknown_script"; exitCode?: number };
export type HelperSessionOutcome =
  | "ok"
  | "timeout"
  | "process_failed"
  | "spawn_missing"
  | "lease_aborted";
export type HelperSessionEnd = {
  outcome: HelperSessionOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};
export type HelperSessionOptions = {
  scripts: Record<string, string>;
  readyTimeoutMs: number;
  idleMs: number;
  maxLine: number;
  maxInFlight: number;
};
const replySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("pong"), id: z.string() }),
  z.object({
    type: z.literal("response"),
    id: z.string(),
    stdout: z.string().optional(),
    error: z.enum(["timeout", "buffer_limit", "process_failed", "unknown_script"]).optional(),
    exitCode: z.number().int().optional(),
  }),
]);
type Pending = {
  resolve: (reply: HelperReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
};
const lost = () => new HelperSessionLost("Helper session ended");

/**
 * One long-lived `sprite exec` running helper_session.py inside a Sprite.
 * Requests are JSON lines correlated by id; the dispatcher enforces per-request
 * time and byte limits and this side enforces a line limit and a deadline, so a
 * hung or oversized reply ends the session instead of blocking or growing memory.
 */
export class HelperSession {
  readonly ready: Promise<void>;
  readonly closed: Promise<HelperSessionEnd>;
  readonly startedAt = performance.now();
  lastUsedAt = Date.now();
  private pending = new Map<string, Pending>();
  private chunks: Buffer[] = [];
  private buffered = 0;
  private stderr: Buffer[] = [];
  private stderrBytes = 0;
  private outcome: HelperSessionOutcome | undefined;
  private finished = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private readyTimer: NodeJS.Timeout;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveClosed!: (end: HelperSessionEnd) => void;
  constructor(
    private child: ChildProcess,
    private options: HelperSessionOptions,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.closed = new Promise<HelperSessionEnd>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.readyTimer = setTimeout(() => this.end("timeout"), options.readyTimeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      // Kept only for failure classification; never relayed or logged raw.
      if (this.stderrBytes >= 4096) return;
      this.stderr.push(chunk.subarray(0, 4096 - this.stderrBytes));
      this.stderrBytes += chunk.length;
    });
    child.stdin?.on("error", () => this.end("process_failed"));
    child.once("error", (error: NodeJS.ErrnoException) => {
      this.end(error.code === "ENOENT" ? "spawn_missing" : "process_failed");
      this.finish(null, null);
    });
    child.once("close", (code, signal) => this.finish(code, signal));
    try {
      this.write({ type: "hello", scripts: options.scripts });
    } catch {
      this.end("process_failed");
    }
  }
  get ended() {
    return this.outcome !== undefined;
  }
  get inFlight() {
    return this.pending.size;
  }
  private write(message: object) {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw lost();
    if ((message as { type?: string }).type === "request") count("sessionRequests");
    stdin.write(`${JSON.stringify(message)}\n`);
  }
  private consume(chunk: Buffer) {
    if (this.ended) return;
    let start = 0;
    while (start <= chunk.length) {
      const newline = chunk.indexOf(10, start);
      if (newline === -1) {
        const rest = chunk.subarray(start);
        if (rest.length) {
          this.chunks.push(rest);
          this.buffered += rest.length;
          if (this.buffered > this.options.maxLine) this.end("process_failed");
        }
        return;
      }
      const head = chunk.subarray(start, newline);
      const line = this.chunks.length ? Buffer.concat([...this.chunks, head]) : head;
      this.chunks = [];
      this.buffered = 0;
      if (line.length > this.options.maxLine) {
        this.end("process_failed");
        return;
      }
      this.handle(line.toString("utf8"));
      start = newline + 1;
    }
  }
  private handle(line: string) {
    if (this.ended) return;
    let message: z.infer<typeof replySchema>;
    try {
      const parsed = replySchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error("Invalid helper session message");
      message = parsed.data;
    } catch {
      this.end("process_failed");
      return;
    }
    if (message.type === "ready") {
      clearTimeout(this.readyTimer);
      this.resolveReady();
      this.armIdle();
      return;
    }
    const entry = this.settle(message.id);
    if (!entry) return;
    if (message.type === "pong") entry.resolve({ stdout: "" });
    else if (message.error)
      entry.resolve({
        error: message.error,
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
      });
    else entry.resolve({ stdout: message.stdout ?? "" });
  }
  private settle(id: string) {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
    this.lastUsedAt = Date.now();
    if (!this.pending.size) this.armIdle();
    return entry;
  }
  private armIdle() {
    clearTimeout(this.idleTimer);
    if (this.ended || this.pending.size) return;
    this.idleTimer = setTimeout(() => this.end("ok"), this.options.idleMs);
    this.idleTimer.unref();
  }
  private send(
    message: { type: string; id: string; [key: string]: unknown },
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<HelperReply> {
    if (this.ended) return Promise.reject(lost());
    if (this.pending.size >= this.options.maxInFlight)
      return Promise.reject(new CommandBusy("Workspace operations are busy. Retry shortly."));
    if (signal?.aborted) return Promise.reject(new Error("Workspace operation cancelled"));
    return new Promise<HelperReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        // No answer within the helper's own limit plus grace: the session is unhealthy.
        this.settle(message.id)?.resolve({ error: "timeout" });
        this.end("timeout");
      }, deadlineMs);
      const abort = () =>
        this.settle(message.id)?.reject(new Error("Workspace operation cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(message.id, { resolve, reject, timer, signal, abort });
      clearTimeout(this.idleTimer);
      this.lastUsedAt = Date.now();
      try {
        this.write(message);
      } catch (error) {
        this.settle(message.id);
        reject(error instanceof Error ? error : lost());
        this.end("process_failed");
      }
    });
  }
  request(
    script: string,
    payload: unknown,
    timeoutMs: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<HelperReply> {
    return this.send(
      { type: "request", id: randomUUID(), script, payload, timeoutMs, limit },
      timeoutMs + 15000,
      signal,
    );
  }
  async ping(timeoutMs: number, signal?: AbortSignal) {
    const reply = await this.send({ type: "ping", id: randomUUID() }, timeoutMs, signal);
    if ("error" in reply) throw lost();
  }
  end(outcome: HelperSessionOutcome) {
    if (this.outcome !== undefined) return;
    this.outcome = outcome;
    this.chunks = [];
    this.buffered = 0;
    clearTimeout(this.readyTimer);
    clearTimeout(this.idleTimer);
    this.rejectReady(lost());
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(lost());
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin?.end();
      this.child.kill();
    }
  }
  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.finished) return;
    this.finished = true;
    this.end("process_failed");
    this.resolveClosed({
      outcome: this.outcome ?? "process_failed",
      exitCode: code,
      signal,
      stderr: Buffer.concat(this.stderr).toString("utf8"),
    });
  }
}
