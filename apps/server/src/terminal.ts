import type { WebSocket } from "ws";
import { z } from "zod";
import { count, diagnostic } from "../../../packages/diagnostics/src/index.ts";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";
import { TerminalRunner } from "./relay/terminal-runner.ts";

const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(32000) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(10).max(400),
    rows: z.number().int().min(3).max(150),
  }),
]);
export type TerminalSessionEvents = {
  /** One coalesced output frame to fan out to attached clients. */
  output(frame: string): void;
  /** The PTY is gone; `startFailed` when it never started (relay only). Called once. */
  ended(startFailed: boolean): void;
};
/** One terminal PTY as seen by the session manager, wherever its process lives. */
export interface TerminalHandle {
  /** Count one more attached client and deliver the retained history to it. */
  attach(deliver: (history: string) => void): void;
  detach(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export interface TerminalBackend {
  /** May throw synchronously when the PTY cannot be spawned in-process. */
  start(id: string, sprite: string, events: TerminalSessionEvents): TerminalHandle;
}
/** Spawns and reads the PTY in this process. */
export const localTerminalBackend: TerminalBackend = {
  start(_id, sprite, events) {
    const runner = new TerminalRunner(sprite, {
      output: events.output,
      ended: () => events.ended(false),
    });
    return {
      attach(deliver) {
        runner.clients += 1;
        deliver(runner.history());
      },
      detach() {
        runner.clients -= 1;
      },
      write: (data) => runner.write(data),
      resize: (cols, rows) => runner.resize(cols, rows),
      kill: () => runner.kill(),
    };
  },
};
type Session = {
  handle: TerminalHandle;
  detachTimer?: NodeJS.Timeout;
  /** Every attached socket, including those still waiting for history. */
  clients: Set<WebSocket>;
  /** Sockets that received history and now get live output. */
  live: Set<WebSocket>;
  lastUsedAt: number;
  /** Last PTY size applied; the runner starts at 100×28. */
  size: { cols: number; rows: number };
};
const redrawNudgeMs = 150;
const detachAfterMs = 180000; // Brief tab switches reattach to the live shell.
export class TerminalSessions {
  constructor(
    private allowed: (id: string) => boolean = () => true,
    private client = new SpriteClient(),
    private touch: (id: string) => void = () => {},
    private backend: TerminalBackend = localTerminalBackend,
  ) {}
  private sessions = new Map<string, Session>();
  attach(id: string, sprite: string, socket: WebSocket, authorized: () => Promise<boolean>) {
    if (!this.allowed(id)) throw new Error("Workspace execution is paused");
    if (!/^civic-spark-[a-z0-9-]{1,45}$/.test(sprite)) throw new Error("Invalid Sprite");
    let session = this.sessions.get(id);
    if (!session) {
      const lease = this.client.lease(sprite, true);
      const clients = new Set<WebSocket>();
      const live = new Set<WebSocket>();
      let started: Session | undefined;
      let ended = false;
      const abort = () => started?.handle.kill();
      let handle: TerminalHandle;
      try {
        handle = this.backend.start(id, sprite, {
          output: (frame) => {
            for (const client of live) {
              if (client.bufferedAmount > 1024 * 1024) {
                client.close(1013, "Reconnect to catch up");
                continue;
              }
              if (client.readyState === 1) {
                client.send(frame);
                count("terminalFrames");
              }
            }
          },
          ended: (startFailed) => {
            ended = true;
            lease?.signal.removeEventListener("abort", abort);
            lease?.release();
            if (started?.detachTimer) clearTimeout(started.detachTimer);
            if (started && this.sessions.get(id) === started) this.sessions.delete(id);
            for (const client of clients)
              if (startFailed) client.close(1011, "Sprite terminal could not start");
              else client.close(1000, "Terminal detached; reconnect to resume");
          },
        });
      } catch (error) {
        lease?.release();
        throw error;
      }
      if (ended) throw new Error("Sprite terminal could not start");
      started = { handle, clients, live, lastUsedAt: Date.now(), size: { cols: 100, rows: 28 } };
      lease?.signal.addEventListener("abort", abort, { once: true });
      session = started;
      this.sessions.set(id, started);
    }
    const active = session;
    if (active.detachTimer) {
      clearTimeout(active.detachTimer);
      active.detachTimer = undefined;
    }
    active.clients.add(socket);
    const attachedAt = Date.now();
    socket.once("close", (code: number) =>
      diagnostic({
        event: "ws",
        channel: "terminal",
        workspaceId: id,
        code,
        durationMs: Date.now() - attachedAt,
      }),
    );
    active.handle.attach((history) => {
      if (!active.clients.has(socket)) return;
      socket.send(JSON.stringify({ type: "output", data: history }));
      active.live.add(socket);
    });
    const check = async () => {
      try {
        if (
          socket.readyState === 1 &&
          active.clients.has(socket) &&
          (await authorized()) &&
          socket.readyState === 1 &&
          active.clients.has(socket) &&
          this.sessions.get(id) === active &&
          this.allowed(id)
        )
          return true;
        socket.close(1008, "Workspace access ended");
        return false;
      } catch {
        socket.close(1011, "Cannot verify session");
        return false;
      }
    };
    // Local checks every 5 s; the session lookup only every 30 s.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks % 6 === 0) void check();
      else if (
        !(
          socket.readyState === 1 &&
          active.clients.has(socket) &&
          this.sessions.get(id) === active &&
          this.allowed(id)
        )
      )
        socket.close(1008, "Workspace access ended");
    }, 5000);
    let queue = Promise.resolve();
    let firstResize = true;
    socket.on("message", (raw) => {
      if (Buffer.byteLength(raw.toString()) > 65536) {
        socket.close(1009, "Terminal message too large");
        return;
      }
      queue = queue
        .then(async () => {
          const input = inputSchema.parse(JSON.parse(raw.toString()));
          if (!(await check())) return;
          if (input.type === "input") {
            active.lastUsedAt = Date.now();
            this.touch(id);
            active.handle.write(input.data);
            return;
          }
          const { cols, rows } = input;
          const unchanged = active.size.cols === cols && active.size.rows === rows;
          active.size = { cols, rows };
          if (firstResize && unchanged) {
            // A reattached client rebuilt its screen from the history ring, which
            // starts mid-stream. tmux repaints the whole screen only on a size
            // change, so nudge the size and restore it.
            active.handle.resize(Math.max(10, cols - 1), rows);
            setTimeout(() => {
              if (
                this.sessions.get(id) === active &&
                active.size.cols === cols &&
                active.size.rows === rows
              )
                active.handle.resize(cols, rows);
            }, redrawNudgeMs);
          } else active.handle.resize(cols, rows);
          firstResize = false;
        })
        .catch(() => socket.close(1008, "Invalid terminal message"));
    });
    // With nobody attached, the host-side PTY only pumps tmux redraws through
    // the loop. Detach after a grace period; tmux keeps the shell for reattach.
    const detached = () => {
      clearInterval(timer);
      if (active.clients.delete(socket)) active.handle.detach();
      active.live.delete(socket);
      if (active.clients.size || active.detachTimer) return;
      active.detachTimer = setTimeout(() => {
        active.detachTimer = undefined;
        if (active.clients.size || this.sessions.get(id) !== active) return;
        this.sessions.delete(id);
        active.handle.kill();
      }, detachAfterMs);
    };
    socket.on("close", detached);
    socket.on("error", detached);
  }
  /** A PTY session exists for the workspace, including the detach grace period. */
  hasSession(id: string) {
    return this.sessions.has(id);
  }
  recentlyUsed(id: string, within: number, now = Date.now()) {
    const session = this.sessions.get(id);
    return Boolean(session && now - session.lastUsedAt < within);
  }
  stop(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const socket of session.clients) socket.close(1008, "Sprite paused; reload to resume");
    session.handle.kill();
    this.sessions.delete(id);
  }
  close() {
    for (const session of this.sessions.values()) {
      for (const socket of session.clients) socket.close();
      session.handle.kill();
    }
    this.sessions.clear();
  }
}
