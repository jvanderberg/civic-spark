import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { z } from "zod";
import { AgentReplay } from "../../../packages/agents/src/history.ts";
import { agentImagesSchema, agentWireByteLimit } from "../../../packages/agents/src/images.ts";
import { agentInputSchema } from "../../../packages/agents/src/protocol.ts";
import { diagnostic, spriteWorkspaceId } from "../../../packages/diagnostics/src/index.ts";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";

const eventSchema = z.object({
  type: z.enum([
    "state",
    "ready",
    "configured",
    "user",
    "text",
    "tool",
    "approval",
    "resolved",
    "status",
    "done",
    "error",
  ]),
  id: z.string(),
  text: z.string().max(200000),
  details: z.string().max(20000).optional(),
  images: agentImagesSchema.optional(),
  requestId: z.uuid().optional(),
  outcome: z.enum(["success", "failed", "stopped"]).optional(),
  cost: z.number().optional(),
  runtimeReady: z.boolean().optional(),
  working: z.boolean().optional(),
  workingStartedAt: z.iso.datetime().optional(),
  configuredProviders: z.array(z.enum(["claude", "opencode"])).optional(),
  savedProviders: z.array(z.enum(["claude", "opencode"])).optional(),
  failedProviders: z.array(z.enum(["claude", "opencode"])).optional(),
  provider: z.enum(["claude", "opencode"]).optional(),
  credentialFailure: z.boolean().optional(),
  replayed: z.boolean().optional(),
});
type Session = {
  process: ChildProcessWithoutNullStreams;
  replay: AgentReplay;
  clients: Set<WebSocket>;
  pendingPrompt: boolean;
};
export class AgentSessions {
  constructor(
    private client = new SpriteClient(),
    private allowed: (id: string) => boolean = () => true,
    private activity: (id: string) => void = () => {},
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
    const session = this.sessions.get(id);
    return Boolean(session?.pendingPrompt || session?.replay.snapshot().working);
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
  async prepare(sprite: string) {
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
      const org = process.env.CIVIC_SPARK_SPRITE_ORG;
      const runner = fileURLToPath(
        new URL("../../../packages/agents/src/runner.ts", import.meta.url),
      );
      const protocol = fileURLToPath(
        new URL("../../../packages/agents/src/protocol.ts", import.meta.url),
      );
      const lease = this.client.lease(sprite, true);
      const child = spawn(
        "sprite",
        [
          ...(org ? ["-o", org] : []),
          "-s",
          sprite,
          "exec",
          "--no-port-forward",
          "--file",
          `${runner}:/home/sprite/.civic-spark-agent/runner.ts`,
          "--file",
          `${protocol}:/home/sprite/.civic-spark-agent/protocol.ts`,
          "--file",
          `${fileURLToPath(new URL("../../../packages/agents/src/credentials.ts", import.meta.url))}:/home/sprite/.civic-spark-agent/credentials.ts`,
          ...[
            "history.ts",
            "journal.ts",
            "provider.ts",
            "context.ts",
            "activity.ts",
            "images.ts",
            "multimodal.ts",
            "opencode-turn.ts",
          ].flatMap((name) => [
            "--file",
            `${fileURLToPath(new URL(`../../../packages/agents/src/${name}`, import.meta.url))}:/home/sprite/.civic-spark-agent/${name}`,
          ]),
          "--",
          "node",
          "--experimental-strip-types",
          "/home/sprite/.civic-spark-agent/runner.ts",
        ],
        { stdio: "pipe" },
      );
      const spawnedAt = Date.now();
      const abort = () => child.kill();
      lease?.signal.addEventListener("abort", abort, { once: true });
      child.once("error", () => lease?.release());
      child.once("close", (code, signal) => {
        lease?.signal.removeEventListener("abort", abort);
        lease?.release();
        diagnostic({
          event: "agent.runner",
          workspaceId: id,
          durationMs: Date.now() - spawnedAt,
          ...(typeof code === "number" ? { exitCode: code } : {}),
          ...(signal
            ? {
                signal: ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"].includes(signal)
                  ? (signal as "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGABRT")
                  : "other",
              }
            : {}),
        });
      });
      const active: Session = {
        process: child,
        replay: new AgentReplay(),
        clients: new Set(),
        pendingPrompt: false,
      };
      session = active;
      this.sessions.set(id, active);
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (this.sessions.get(id) !== active || line.length > agentWireByteLimit) return;
        try {
          const event = eventSchema.parse(JSON.parse(line));
          active.replay.accept(event);
          if (!event.replayed && ["user", "text", "tool", "done"].includes(event.type))
            this.activity(id);
          if (
            event.type === "done" ||
            event.type === "error" ||
            (event.type === "status" && event.text === "Working")
          )
            active.pendingPrompt = false;
          for (const client of active.clients) {
            if (client.bufferedAmount > 2 * agentWireByteLimit)
              client.close(1013, "Reconnect to catch up");
            else if (client.readyState === 1) client.send(JSON.stringify(event));
          }
        } catch {
          /* Only structured events go to the browser. */
        }
      });
      child.stderr.resume(); // Provider diagnostics may contain secrets; never forward or log them.
      const end = () => {
        if (this.sessions.get(id) === active) this.sessions.delete(id);
        for (const client of active.clients) client.close(1011, "Agent runner ended; reconnect");
      };
      child.on("error", end);
      child.on("close", end);
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
    for (const event of active.replay.events)
      socket.send(JSON.stringify({ ...event, replayed: true }));
    socket.send(JSON.stringify(active.replay.snapshot()));
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
    const timer = setInterval(() => void check(), 5000);
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
            if (message.type === "prompt") {
              if (active.pendingPrompt || active.replay.snapshot().working) {
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
              active.pendingPrompt = true;
            }
            active.process.stdin.write(`${JSON.stringify(message)}\n`);
          }
        })
        .catch(() => socket.close(1008, "Invalid agent request"))
        .finally(() => {
          queuedBytes -= bytes;
        });
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
  stop(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    if (!session.process.stdin.destroyed) session.process.stdin.write('{"type":"stop"}\n');
    for (const socket of session.clients) socket.close(1008, "Sprite paused; reload to resume");
    session.process.kill();
    this.sessions.delete(id);
  }
  close() {
    for (const session of this.sessions.values()) {
      session.process.stdin.write('{"type":"stop"}\n');
      session.process.kill();
      for (const client of session.clients) client.close();
    }
    this.sessions.clear();
  }
}
