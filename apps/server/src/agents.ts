import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { z } from "zod";
import { agentWireByteLimit } from "../../../packages/agents/src/images.ts";
import {
  type AgentInput,
  type AgentPrompt,
  agentInputSchema,
} from "../../../packages/agents/src/protocol.ts";
import { count, diagnostic, spriteWorkspaceId } from "../../../packages/diagnostics/src/index.ts";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";
import { AgentRunner } from "./relay/agent-runner.ts";

export type AgentSessionEvents = {
  /** One serialized, batched live event to fan out to attached clients. */
  frame(frame: string): void;
  /** Throttled participant use. */
  activity(): void;
  /** Workspace state the turn probably changed: files after tool steps, team after a turn. */
  changed?(scope: "files" | "team", coalesceMs?: number): void;
  /** The runner is gone (exit, spawn failure or relay worker loss); called once. */
  ended(): void;
};
/** One agent runner as seen by the session manager, wherever its process lives. */
export interface AgentHandle {
  /** A prompt is pending or a turn is running. */
  readonly busy: boolean;
  /**
   * Deliver the replay (retained transcript plus state) for a newly attached
   * client. Synchronous in-process; asynchronous through a relay worker, where
   * the client only joins live fan-out once its replay has been sent.
   */
  replay(deliver: (frames: string[]) => void): void;
  send(message: AgentInput): void;
  /** Acknowledge a participant stop at once, then forward it to the runner. */
  interrupt(): void;
  /** Hold one prompt for the running turn and deliver it exactly once. */
  queue(prompt: AgentPrompt): void;
  unqueue(): void;
  /** Stop the turn and end the runner. */
  stop(): void;
  kill(): void;
}
export interface AgentBackend {
  start(id: string, sprite: string, events: AgentSessionEvents): AgentHandle;
}
/** Spawns and reads the runner in this process. */
export const localAgentBackend: AgentBackend = {
  start(id, sprite, events) {
    const runner = new AgentRunner(id, sprite, events);
    return {
      get busy() {
        return runner.busy;
      },
      replay: (deliver) => deliver(runner.replayFrames()),
      send: (message) => runner.send(JSON.stringify(message), message.type === "prompt"),
      interrupt: () => runner.interrupt(),
      queue: (prompt) => runner.queue(prompt),
      unqueue: () => runner.unqueue(),
      stop: () => runner.stop(),
      kill: () => runner.kill(),
    };
  },
};
type Session = {
  handle: AgentHandle;
  /** Every attached socket, including those still waiting for their replay. */
  clients: Set<WebSocket>;
  /** Sockets that received their replay and now get live frames. */
  live: Set<WebSocket>;
};
export class AgentSessions {
  constructor(
    private client = new SpriteClient(),
    private allowed: (id: string) => boolean = () => true,
    private activity: (id: string) => void = () => {},
    private backend: AgentBackend = localAgentBackend,
    private changed: (id: string, scope: "files" | "team", coalesceMs?: number) => void = () => {},
  ) {}
  private sessions = new Map<string, Session>();
  private preparing = new Map<string, Promise<boolean>>();
  private gitUpdates = new Set<string>();
  setGitUpdating(id: string, value: boolean) {
    if (value) this.gitUpdates.add(id);
    else this.gitUpdates.delete(id);
  }
  isPreparing(sprite: string) {
    return this.preparing.has(sprite);
  }
  isWorking(id: string) {
    return Boolean(this.sessions.get(id)?.handle.busy);
  }
  /** A runner session exists for the workspace, attached clients or not. */
  hasSession(id: string) {
    return this.sessions.has(id);
  }
  async credentials(sprite: string) {
    const result = await this.client.exec(sprite, [
      "python3",
      "-c",
      readFileSync(
        new URL("../../../packages/agents/runtime/credential-presence.py", import.meta.url),
        "utf8",
      ),
    ]);
    if (!result.ok) throw new Error("Could not check saved agent keys. Retry to check again.");
    return z
      .object({ savedProviders: z.array(z.enum(["claude", "opencode"])) })
      .strict()
      .parse(JSON.parse(result.value.toString()));
  }
  // A just-woken Sprite can time out the first upload/setup command at the CLI.
  // Retry bounded times with backoff before reporting failure; the preparing
  // marker stays set throughout so idle release and provisioning wait for it.
  static readonly prepareAttempts = 3;
  static readonly prepareBackoffMs = 2000;
  // Runtime files persist on the Sprite disk, so a Sprite prepared once in this
  // process reconnects without the 10–25 s upload and verification. A runner
  // that fails to start forgets the Sprite so the next attach prepares again.
  private prepared = new Set<string>();
  forget(sprite: string) {
    this.prepared.delete(sprite);
  }
  async prepare(sprite: string) {
    if (this.prepared.has(sprite)) return true;
    const existing = this.preparing.get(sprite);
    if (existing) return existing;
    const work = (async () => {
      const started = Date.now();
      for (let attempt = 1; ; attempt++) {
        const result = await this.setup(sprite);
        if (result.ok || attempt >= AgentSessions.prepareAttempts) {
          diagnostic({
            event: "agent.prepare",
            workspaceId: spriteWorkspaceId(sprite),
            attempt,
            outcome: result.ok ? "ok" : "process_failed",
            durationMs: Date.now() - started,
          });
          if (result.ok) this.prepared.add(sprite);
          return result.ok;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, AgentSessions.prepareBackoffMs * 2 ** (attempt - 1)),
        );
      }
    })().finally(() => this.preparing.delete(sprite));
    this.preparing.set(sprite, work);
    return work;
  }
  private setup(sprite: string) {
    return this.client.exec(
      sprite,
      ["bash", "/home/sprite/.civic-spark-agent/setup.sh"],
      [
        `${fileURLToPath(new URL("../../../packages/agents/runtime/environment.json", import.meta.url))}:/home/sprite/.civic-spark-agent/environment.defaults.json`,
        ...["package.json", "package-lock.json", "setup.sh", "relay.py"].map(
          (name) =>
            `${fileURLToPath(new URL(`../../../packages/agents/runtime/${name}`, import.meta.url))}:/home/sprite/.civic-spark-agent/${name}`,
        ),
        ...[
          "cli.ts",
          "cli-config.ts",
          "credentials.ts",
          "protocol.ts",
          "images.ts",
          "context.ts",
          "integration-cli.ts",
        ].map(
          (name) =>
            `${fileURLToPath(new URL(`../../../packages/agents/src/${name}`, import.meta.url))}:/home/sprite/.civic-spark-agent/${name}`,
        ),
      ],
    );
  }
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
      let handle: AgentHandle;
      try {
        handle = this.backend.start(id, sprite, {
          frame: (frame) => {
            for (const client of live) {
              if (client.bufferedAmount > 2 * agentWireByteLimit)
                client.close(1013, "Reconnect to catch up");
              else if (client.readyState === 1) {
                client.send(frame);
                count("agentFrames");
              }
            }
          },
          activity: () => this.activity(id),
          changed: (scope, coalesceMs) => this.changed(id, scope, coalesceMs),
          ended: () => {
            ended = true;
            lease?.signal.removeEventListener("abort", abort);
            lease?.release();
            if (started && this.sessions.get(id) === started) this.sessions.delete(id);
            for (const client of clients) client.close(1011, "Agent runner ended; reconnect");
          },
        });
      } catch (error) {
        lease?.release();
        throw error;
      }
      if (ended) {
        this.forget(sprite);
        throw new Error("Agent runner could not start");
      }
      started = { handle, clients, live };
      lease?.signal.addEventListener("abort", abort, { once: true });
      session = started;
      this.sessions.set(id, started);
    }
    const active = session;
    active.clients.add(socket);
    const attachedAt = Date.now();
    socket.once("close", (code: number) =>
      diagnostic({
        event: "ws",
        channel: "agent",
        workspaceId: id,
        code,
        durationMs: Date.now() - attachedAt,
      }),
    );
    active.handle.replay((frames) => {
      if (!active.clients.has(socket)) return;
      for (const frame of frames) socket.send(frame);
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
      } catch {
        /* Fail closed. */
      }
      socket.close(1008, "Workspace access ended");
      return false;
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
    let queuedBytes = 0;
    socket.on("message", (raw) => {
      const bytes = Buffer.byteLength(raw.toString());
      if (bytes > agentWireByteLimit || queuedBytes + bytes > agentWireByteLimit) {
        socket.close(1009, "Agent request too large");
        return;
      }
      queuedBytes += bytes;
      queue = queue
        .then(async () => {
          const parsed = agentInputSchema.safeParse(JSON.parse(raw.toString()));
          if (!parsed.success) {
            socket.send(
              JSON.stringify({
                type: "error",
                id: crypto.randomUUID(),
                text: "Invalid message or images. Attach up to 4 PNG, JPEG or WebP images, at most 2 MiB each and 4 MiB total.",
              }),
            );
            return;
          }
          const message = parsed.data;
          if (await check()) {
            if (message.type === "prompt" && this.gitUpdates.has(id)) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  id: crypto.randomUUID(),
                  text: "Wait for the team update to finish, then send your message again.",
                }),
              );
              return;
            }
            // A message sent during a turn waits for it instead of being lost.
            // The queue lives with the runner, so it survives a reload and is
            // delivered once even with several browsers attached.
            if (message.type === "prompt" && message.queue) {
              active.handle.queue(message);
              return;
            }
            if (message.type === "unqueue") {
              active.handle.unqueue();
              return;
            }
            if (message.type === "prompt" && active.handle.busy) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  id: crypto.randomUUID(),
                  requestId: message.id,
                  text: "A turn is already running. Wait or stop it before sending another message.",
                }),
              );
              return;
            }
            if (message.type === "stop") {
              active.handle.interrupt();
              return;
            }
            active.handle.send(message);
          }
        })
        .catch(() => socket.close(1008, "Invalid agent request"))
        .finally(() => {
          queuedBytes -= bytes;
        });
    });
    const detached = () => {
      clearInterval(timer);
      active.clients.delete(socket);
      active.live.delete(socket);
    };
    socket.on("close", detached);
    socket.on("error", detached);
  }
  stop(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.handle.stop();
    for (const socket of session.clients) socket.close(1008, "Sprite paused; reload to resume");
    this.sessions.delete(id);
  }
  close() {
    for (const session of this.sessions.values()) {
      session.handle.stop();
      for (const client of session.clients) client.close();
    }
    this.sessions.clear();
  }
}
