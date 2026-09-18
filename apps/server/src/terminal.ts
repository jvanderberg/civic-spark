import * as pty from "node-pty";
import type { WebSocket } from "ws";
import { z } from "zod";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";

const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(32000) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(10).max(400),
    rows: z.number().int().min(3).max(150),
  }),
]);
type Session = { process: pty.IPty; history: string; clients: Set<WebSocket>; lastUsedAt: number };
export class TerminalSessions {
  constructor(
    private allowed: (id: string) => boolean = () => true,
    private client = new SpriteClient(),
    private touch: (id: string) => void = () => {},
  ) {}
  private sessions = new Map<string, Session>();
  attach(id: string, sprite: string, socket: WebSocket, authorized: () => Promise<boolean>) {
    if (!this.allowed(id)) throw new Error("Workspace execution is paused");
    if (!/^civic-spark-[a-z0-9-]{1,45}$/.test(sprite)) throw new Error("Invalid Sprite");
    let session = this.sessions.get(id);
    if (!session) {
      const org = process.env.CIVIC_SPARK_SPRITE_ORG;
      const args = [
        ...(org ? ["-o", org] : []),
        "-s",
        sprite,
        "exec",
        "--no-port-forward",
        "--tty",
        "--",
        "bash",
        "-lc",
        "export PATH=/home/sprite/.civic-spark-agent/bin:/home/sprite/.civic-spark-agent/node_modules/.bin:$PATH; cd /home/sprite/project && printf 'Civic Spark terminal connected\\r\\n' && exec tmux new-session -A -s civic-spark-workspace",
      ];
      // Only this fixed Sprite CLI is launched on the host. User input goes to the remote PTY.
      const lease = this.client.lease(sprite, true);
      let proc: pty.IPty;
      try {
        proc = pty.spawn("sprite", args, {
          name: "xterm-256color",
          cols: 100,
          rows: 28,
          env: { ...process.env, TERM: "xterm-256color" },
        });
      } catch (error) {
        lease?.release();
        throw error;
      }
      const abort = () => proc.kill();
      lease?.signal.addEventListener("abort", abort, { once: true });
      session = { process: proc, history: "", clients: new Set(), lastUsedAt: Date.now() };
      const active = session;
      this.sessions.set(id, active);
      proc.onData((data) => {
        // Output is not use: tmux status refreshes and TUIs emit forever, which
        // would block idle release and keep the Sprite in billed running state.
        active.history = (active.history + data)
          .slice(-200000)
          .replaceAll("\x1b[6n", "")
          .replaceAll("\x1b]11;?\x1b\\", "")
          .replaceAll("\x1b]11;?\x07", "");
        for (const client of active.clients) {
          if (client.bufferedAmount > 1024 * 1024) {
            client.close(1013, "Reconnect to catch up");
            continue;
          }
          if (client.readyState === 1) client.send(JSON.stringify({ type: "output", data }));
        }
      });
      proc.onExit(() => {
        lease?.signal.removeEventListener("abort", abort);
        lease?.release();
        if (this.sessions.get(id) === active) this.sessions.delete(id);
        for (const client of active.clients)
          client.close(1000, "Terminal detached; reconnect to resume");
      });
    }
    const active = session;
    active.clients.add(socket);
    socket.send(JSON.stringify({ type: "output", data: active.history }));
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
    const timer = setInterval(() => void check(), 5000);
    let queue = Promise.resolve();
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
            active.process.write(input.data);
          } else active.process.resize(input.cols, input.rows);
        })
        .catch(() => socket.close(1008, "Invalid terminal message"));
    });
    socket.on("close", () => {
      clearInterval(timer);
      active.clients.delete(socket);
    });
    socket.on("error", () => {
      clearInterval(timer);
      active.clients.delete(socket);
    });
  }
  recentlyUsed(id: string, within: number, now = Date.now()) {
    const session = this.sessions.get(id);
    return Boolean(session && now - session.lastUsedAt < within);
  }
  stop(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const socket of session.clients) socket.close(1008, "Sprite paused; reload to resume");
    session.process.kill();
    this.sessions.delete(id);
  }
  close() {
    for (const session of this.sessions.values()) {
      for (const socket of session.clients) socket.close();
      session.process.kill();
    }
    this.sessions.clear();
  }
}
