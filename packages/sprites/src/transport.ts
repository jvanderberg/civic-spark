import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  HelperSession,
  type HelperSessionLike,
  type HelperSessionOptions,
} from "./helper-session.ts";

const execute = promisify(execFile);

export type SpriteExecution = {
  timeout: number;
  maxBuffer: number;
  input?: string;
  signal?: AbortSignal;
};

/**
 * How `SpriteClient` reaches the fixed `sprite` CLI. The local transport owns
 * the child processes in this process; the relay transport forwards the same
 * calls to a relay worker so the pipes leave the main event loop. Queue limits,
 * coalescing, result parsing and diagnostics stay in `SpriteClient` either way.
 */
export interface SpriteTransport {
  /** Resolves with stdout after the child has closed; rejects with execFile-shaped errors. */
  execute(args: string[], options: SpriteExecution): Promise<Buffer>;
  /** Starts one helper-session process for a Sprite. */
  session(name: string, args: string[], options: HelperSessionOptions): HelperSessionLike;
}

export const localSpriteTransport: SpriteTransport = {
  async execute(args, { timeout, maxBuffer, input, signal }) {
    const pending = execute("sprite", args, { timeout, maxBuffer, encoding: "buffer", signal });
    const closed = new Promise<void>((resolve) => pending.child.once("close", () => resolve()));
    pending.child.stdin?.end(input);
    try {
      return (await pending).stdout;
    } finally {
      await closed;
    }
  },
  session(_name, args, options) {
    return new HelperSession(spawn("sprite", args, { stdio: "pipe" }), options);
  },
};
