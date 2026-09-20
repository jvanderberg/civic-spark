import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { diagnostic } from "../../../../packages/diagnostics/src/index.ts";
import { type FromWorker, routingKey, type ToWorker } from "./protocol.ts";

/** Receives the messages routed to one session or command on a worker. */
export type RelayHandler = {
  message(message: FromWorker): void;
  /** The worker exited; the session or command is gone. */
  lost(): void;
};
export type RelayPoolOptions = {
  /** Worker entry module; tests may point at a fixture. */
  entry?: string;
  /** First restart delay after an exit; doubles per rapid crash up to 30 s. */
  restartDelayMs?: number;
};
const workerEntry = fileURLToPath(new URL("./worker.ts", import.meta.url));

/** Stable worker index for a workspace id (or Sprite name), independent of process. */
export function assignWorker(key: string, size: number) {
  return createHash("sha256").update(key).digest().readUInt32BE(0) % size;
}

/**
 * One forked relay worker. Messages sent before the worker reports ready, or
 * while it restarts, wait in an outbox. When it exits every registered handler
 * is told `lost()`, the exit is logged as `relay.worker`, and a replacement is
 * forked after a delay that grows only for rapid repeated crashes.
 */
export class RelayWorker {
  child: ChildProcess | undefined;
  restarts = 0;
  private ready = false;
  private closing = false;
  private outbox: ToWorker[] = [];
  private handlers = new Map<string, RelayHandler>();
  private restartTimer: NodeJS.Timeout | undefined;
  private startedAt = 0;
  private delay: number;
  constructor(
    readonly index: number,
    private options: RelayPoolOptions = {},
  ) {
    this.delay = options.restartDelayMs ?? 1000;
    this.spawn();
  }
  private spawn() {
    this.startedAt = Date.now();
    const child = fork(this.options.entry ?? workerEntry, [String(this.index)], {
      execArgv: ["--import", "tsx"],
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.child = child;
    // Workers must not keep a failed or finished server alive; they exit on
    // their own when the channel disconnects. `close()` re-references them
    // while it waits for an orderly exit.
    child.unref();
    child.channel?.unref();
    child.on("message", (message) => this.receive(message as FromWorker));
    child.on("error", () => {
      /* Exit handling covers spawn failures. */
    });
    child.once("exit", (code, signal) => this.exited(child, code, signal));
    diagnostic({
      event: "relay.worker",
      worker: this.index,
      phase: "start",
      restarts: this.restarts,
    });
  }
  private receive(message: FromWorker) {
    if (message.type === "ready") {
      this.ready = true;
      const queued = this.outbox;
      this.outbox = [];
      for (const pending of queued) this.send(pending);
      return;
    }
    const key = routingKey(message);
    if (key !== undefined) this.handlers.get(key)?.message(message);
  }
  private exited(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
    if (this.child !== child) return;
    this.child = undefined;
    this.ready = false;
    diagnostic({
      event: "relay.worker",
      worker: this.index,
      phase: "end",
      restarts: this.restarts,
      ...(typeof code === "number" ? { exitCode: code } : {}),
      ...(signal
        ? {
            signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"].includes(signal)
              ? (signal as "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGABRT")
              : "other",
          }
        : {}),
    });
    const handlers = [...this.handlers.values()];
    this.handlers.clear();
    for (const handler of handlers) handler.lost();
    if (this.closing) return;
    // A worker that lived a minute restarts promptly; a crash loop backs off.
    if (Date.now() - this.startedAt > 60000) this.delay = this.options.restartDelayMs ?? 1000;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closing) return;
      this.restarts += 1;
      this.spawn();
    }, this.delay);
    this.restartTimer.unref();
    this.delay = Math.min(this.delay * 2, 30000);
  }
  get alive() {
    return this.child !== undefined;
  }
  send(message: ToWorker) {
    if (this.closing) return;
    if (!this.child || !this.ready) {
      this.outbox.push(message);
      return;
    }
    try {
      this.child.send(message);
    } catch {
      /* The exit handler reports the loss. */
    }
  }
  register(key: string, handler: RelayHandler) {
    this.handlers.set(key, handler);
  }
  unregister(key: string) {
    this.handlers.delete(key);
  }
  /** Ask the worker to stop its children and exit; force it after a bounded wait. */
  async close() {
    this.closing = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.outbox = [];
    const child = this.child;
    if (!child) return;
    child.ref();
    child.channel?.ref();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      if (this.ready) child.send({ type: "shutdown" } satisfies ToWorker);
      else child.kill();
    } catch {
      /* Already gone. */
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
    await exited;
    clearTimeout(timer);
  }
}

export class RelayPool {
  readonly workers: RelayWorker[];
  constructor(size: number, options: RelayPoolOptions = {}) {
    this.workers = Array.from({ length: size }, (_, index) => new RelayWorker(index, options));
  }
  /** The worker that owns a workspace; every session and command of a workspace shares it. */
  for(key: string) {
    return this.workers[assignWorker(key, this.workers.length)] as RelayWorker;
  }
  async close() {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
