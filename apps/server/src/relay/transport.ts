import { randomUUID } from "node:crypto";
import { spriteWorkspaceId } from "../../../../packages/diagnostics/src/index.ts";
import { CommandBusy } from "../../../../packages/sprites/src/command-queue.ts";
import {
  type HelperReply,
  type HelperSessionEnd,
  type HelperSessionLike,
  HelperSessionLost,
  type HelperSessionOptions,
  type HelperSessionOutcome,
} from "../../../../packages/sprites/src/helper-session.ts";
import type { SpriteTransport } from "../../../../packages/sprites/src/transport.ts";
import type { RelayPool, RelayWorker } from "./pool.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";

const lost = () => new HelperSessionLost("Helper session ended");
type Pending = {
  resolve: (reply: HelperReply) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

/**
 * The main-process view of a helper session whose child runs in a relay
 * worker. Request correlation, cancellation and the `ended`/`closed` contract
 * match `HelperSession`; per-request deadlines, line limits and in-flight
 * caps are enforced by the real session inside the worker.
 */
class RelayHelperSession implements HelperSessionLike {
  readonly ready: Promise<void>;
  readonly closed: Promise<HelperSessionEnd>;
  readonly startedAt = performance.now();
  lastUsedAt = Date.now();
  private readonly session = randomUUID();
  private pending = new Map<string, Pending>();
  private outcome: HelperSessionOutcome | undefined;
  private finished = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveClosed!: (end: HelperSessionEnd) => void;
  constructor(
    private worker: RelayWorker,
    args: string[],
    options: HelperSessionOptions,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.closed = new Promise<HelperSessionEnd>((resolve) => {
      this.resolveClosed = resolve;
    });
    worker.register(this.session, {
      message: (message) => this.handle(message),
      lost: () =>
        this.finish({ outcome: "process_failed", exitCode: null, signal: null, stderr: "" }),
    });
    worker.send({ type: "session.start", session: this.session, args, options });
  }
  get ended() {
    return this.outcome !== undefined;
  }
  private handle(message: FromWorker) {
    switch (message.type) {
      case "session.ready":
        return this.resolveReady();
      case "session.reply":
        return this.settle(message.id)?.resolve(message.reply);
      case "session.rejected":
        return this.settle(message.id)?.reject(
          message.reason === "busy"
            ? new CommandBusy(message.message)
            : message.reason === "lost"
              ? lost()
              : new Error(message.message),
        );
      case "session.closed":
        return this.finish(message.end);
    }
  }
  private settle(id: string) {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    if (entry.abort) entry.signal?.removeEventListener("abort", entry.abort);
    this.lastUsedAt = Date.now();
    return entry;
  }
  private send(
    message: Extract<ToWorker, { type: "session.request" | "session.ping" }>,
    signal?: AbortSignal,
  ): Promise<HelperReply> {
    if (this.ended) return Promise.reject(lost());
    if (signal?.aborted) return Promise.reject(new Error("Workspace operation cancelled"));
    return new Promise<HelperReply>((resolve, reject) => {
      const abort = () =>
        this.settle(message.id)?.reject(new Error("Workspace operation cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(message.id, { resolve, reject, signal, abort });
      this.lastUsedAt = Date.now();
      this.worker.send(message);
    });
  }
  request(
    script: string,
    payload: unknown,
    timeoutMs: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    return this.send(
      {
        type: "session.request",
        session: this.session,
        id: randomUUID(),
        script,
        payload,
        timeoutMs,
        limit,
      },
      signal,
    );
  }
  async ping(timeoutMs: number, signal?: AbortSignal) {
    const reply = await this.send(
      { type: "session.ping", session: this.session, id: randomUUID(), timeoutMs },
      signal,
    );
    if ("error" in reply) throw lost();
  }
  end(outcome: HelperSessionOutcome) {
    if (this.outcome !== undefined) return;
    this.outcome = outcome;
    this.rejectReady(lost());
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(lost());
    this.worker.send({ type: "session.end", session: this.session, outcome });
  }
  private finish(end: HelperSessionEnd) {
    if (this.finished) return;
    this.finished = true;
    this.outcome ??= end.outcome;
    this.rejectReady(lost());
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(lost());
    this.worker.unregister(this.session);
    this.resolveClosed({ ...end, outcome: this.outcome ?? end.outcome });
  }
}

/** Which worker runs a command: the Sprite named by `-s`, or the target of `create`. */
function commandKey(args: string[]) {
  const name = args.includes("-s")
    ? args[args.indexOf("-s") + 1]
    : args.includes("create")
      ? args.at(-1)
      : undefined;
  return name ? (spriteWorkspaceId(name) ?? name) : "";
}

/** Runs one-shot `sprite` commands and helper sessions inside relay workers. */
export function relaySpriteTransport(pool: RelayPool): SpriteTransport {
  return {
    execute(args, { timeout, maxBuffer, input, signal }) {
      const worker = pool.for(commandKey(args));
      const id = randomUUID();
      return new Promise<Buffer>((resolve, reject) => {
        const abort = () => worker.send({ type: "command.abort", id });
        const settle = () => {
          worker.unregister(id);
          signal?.removeEventListener("abort", abort);
        };
        worker.register(id, {
          message(message) {
            if (message.type === "command.done") {
              settle();
              resolve(Buffer.from(message.stdout));
            } else if (message.type === "command.failed") {
              settle();
              reject(Object.assign(new Error("Sprite command failed"), message.error));
            }
          },
          lost() {
            settle();
            reject(Object.assign(new Error("Relay worker ended"), { stderr: "" }));
          },
        });
        signal?.addEventListener("abort", abort, { once: true });
        worker.send({ type: "command.run", id, args, timeout, maxBuffer, input });
        if (signal?.aborted) abort();
      });
    },
    session(name, args, options) {
      return new RelayHelperSession(pool.for(spriteWorkspaceId(name) ?? name), args, options);
    },
  };
}
