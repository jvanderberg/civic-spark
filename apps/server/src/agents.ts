import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { z } from "zod";
import { AgentReplay } from "../../../packages/agents/src/history.ts";
import { agentInputSchema } from "../../../packages/agents/src/protocol.ts";
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
  private sessions = new Map<string, Session>();
  private preparing = new Map<string, Promise<boolean>>();
  private gitUpdates = new Set<string>();
  setGitUpdating(id: string, value: boolean) {
    if (value) this.gitUpdates.add(id);
    else this.gitUpdates.delete(id);
  }
  isWorking(id: string) {
    const session = this.sessions.get(id);
    return Boolean(session?.pendingPrompt || session?.replay.snapshot().working);
  }
  async prepare(sprite: string) {
    const existing = this.preparing.get(sprite);
    if (existing) return existing;
    const work = new SpriteClient()
      .exec(sprite, [
        "-file",
        `${fileURLToPath(new URL("../../../packages/agents/runtime/environment.json", import.meta.url))}:/home/sprite/.vibehack-agent/environment.defaults.json`,
        ...["package.json", "package-lock.json", "setup.sh", "relay.py"].flatMap((name) => [
          "-file",
          `${fileURLToPath(new URL(`../../../packages/agents/runtime/${name}`, import.meta.url))}:/home/sprite/.vibehack-agent/${name}`,
        ]),
        ...[
          "cli.ts",
          "cli-config.ts",
          "credentials.ts",
          "protocol.ts",
          "context.ts",
          "integration-cli.ts",
        ].flatMap((name) => [
          "-file",
          `${fileURLToPath(new URL(`../../../packages/agents/src/${name}`, import.meta.url))}:/home/sprite/.vibehack-agent/${name}`,
        ]),
        "bash",
        "/home/sprite/.vibehack-agent/setup.sh",
      ])
      .then((r) => r.ok)
      .finally(() => this.preparing.delete(sprite));
    this.preparing.set(sprite, work);
    return work;
  }
  attach(id: string, sprite: string, socket: WebSocket, authorized: () => Promise<boolean>) {
    if (!/^vibehack-[a-z0-9-]{1,45}$/.test(sprite)) throw new Error("Invalid Sprite");
    let session = this.sessions.get(id);
    if (!session) {
      const org = process.env.VIBEHACK_SPRITE_ORG;
      const runner = fileURLToPath(
        new URL("../../../packages/agents/src/runner.ts", import.meta.url),
      );
      const protocol = fileURLToPath(
        new URL("../../../packages/agents/src/protocol.ts", import.meta.url),
      );
      const child = spawn(
        "sprite",
        [
          ...(org ? ["-o", org] : []),
          "-s",
          sprite,
          "exec",
          "-file",
          `${runner}:/home/sprite/.vibehack-agent/runner.ts`,
          "-file",
          `${protocol}:/home/sprite/.vibehack-agent/protocol.ts`,
          "-file",
          `${fileURLToPath(new URL("../../../packages/agents/src/credentials.ts", import.meta.url))}:/home/sprite/.vibehack-agent/credentials.ts`,
          ...["history.ts", "journal.ts", "provider.ts", "context.ts"].flatMap((name) => [
            "-file",
            `${fileURLToPath(new URL(`../../../packages/agents/src/${name}`, import.meta.url))}:/home/sprite/.vibehack-agent/${name}`,
          ]),
          "node",
          "--experimental-strip-types",
          "/home/sprite/.vibehack-agent/runner.ts",
        ],
        { stdio: "pipe" },
      );
      const active: Session = {
        process: child,
        replay: new AgentReplay(),
        clients: new Set(),
        pendingPrompt: false,
      };
      session = active;
      this.sessions.set(id, active);
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (line.length > 250000) return;
        try {
          const event = eventSchema.parse(JSON.parse(line));
          active.replay.accept(event);
          if (
            event.type === "done" ||
            event.type === "error" ||
            (event.type === "status" && event.text === "Working")
          )
            active.pendingPrompt = false;
          for (const client of active.clients) {
            if (client.bufferedAmount > 1024 * 1024) client.close(1013, "Reconnect to catch up");
            else if (client.readyState === 1) client.send(JSON.stringify(event));
          }
        } catch {
          /* Only structured events go to the browser. */
        }
      });
      child.stderr.resume(); // Provider diagnostics may contain secrets; never forward or log them.
      const end = () => {
        this.sessions.delete(id);
        for (const client of active.clients) client.close(1011, "Agent runner ended; reconnect");
      };
      child.on("error", end);
      child.on("close", end);
    }
    const active = session;
    active.clients.add(socket);
    for (const event of active.replay.events)
      socket.send(JSON.stringify({ ...event, replayed: true }));
    socket.send(JSON.stringify(active.replay.snapshot()));
    const check = async () => {
      try {
        if (await authorized()) return true;
      } catch {
        /* Fail closed. */
      }
      socket.close(1008, "Workspace access ended");
      return false;
    };
    const timer = setInterval(() => void check(), 5000);
    let queue = Promise.resolve();
    socket.on("message", (raw) => {
      queue = queue
        .then(async () => {
          const message = agentInputSchema.parse(JSON.parse(raw.toString()));
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
            if (message.type === "prompt") active.pendingPrompt = true;
            active.process.stdin.write(`${JSON.stringify(message)}\n`);
          }
        })
        .catch(() => socket.close(1008, "Invalid agent request"));
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
  close() {
    for (const session of this.sessions.values()) {
      session.process.stdin.write('{"type":"stop"}\n');
      session.process.kill();
      for (const client of session.clients) client.close();
    }
    this.sessions.clear();
  }
}
