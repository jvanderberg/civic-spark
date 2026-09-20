import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AgentReplay } from "../../../../packages/agents/src/history.ts";
import { agentImagesSchema, agentWireByteLimit } from "../../../../packages/agents/src/images.ts";
import { count, diagnostic } from "../../../../packages/diagnostics/src/index.ts";

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
type Event = z.infer<typeof eventSchema>;
export type AgentRunnerEvents = {
  /** One already-serialized, already-batched live event for fan-out. */
  frame(frame: string): void;
  /** Throttled participant use (user/text/tool/done events). */
  activity(): void;
  /** `busy` (pending prompt or working turn) changed. */
  busy?(busy: boolean): void;
  /** Workspace state the turn probably changed: files after tool steps, team after a finished turn. */
  changed?(scope: "files" | "team", coalesceMs?: number): void;
  /** The runner process is gone; called once. */
  ended(): void;
};
const agentSources = [
  "history.ts",
  "journal.ts",
  "provider.ts",
  "context.ts",
  "activity.ts",
  "images.ts",
  "multimodal.ts",
  "opencode-turn.ts",
];
const source = (name: string) =>
  fileURLToPath(new URL(`../../../../packages/agents/src/${name}`, import.meta.url));

/**
 * Owns one agent runner child (`sprite exec … node runner.ts`): spawning,
 * stdout line parsing and validation, replay bookkeeping, text-delta batching,
 * stderr suppression and the exit diagnostic. Socket fan-out, leases and
 * authorization stay with the caller, which may be the main process or a
 * relay worker.
 */
export class AgentRunner {
  readonly replay = new AgentReplay();
  private readonly child: ChildProcessWithoutNullStreams;
  private pendingPrompt = false;
  private lastBusy = false;
  private stopped = false;
  private finished = false;
  constructor(
    workspaceId: string,
    sprite: string,
    private events: AgentRunnerEvents,
  ) {
    const org = process.env.CIVIC_SPARK_SPRITE_ORG;
    const child = spawn(
      "sprite",
      [
        ...(org ? ["-o", org] : []),
        "-s",
        sprite,
        "exec",
        "--no-port-forward",
        "--file",
        `${source("runner.ts")}:/home/sprite/.civic-spark-agent/runner.ts`,
        "--file",
        `${source("protocol.ts")}:/home/sprite/.civic-spark-agent/protocol.ts`,
        "--file",
        `${source("credentials.ts")}:/home/sprite/.civic-spark-agent/credentials.ts`,
        ...agentSources.flatMap((name) => [
          "--file",
          `${source(name)}:/home/sprite/.civic-spark-agent/${name}`,
        ]),
        "--",
        "node",
        "--experimental-strip-types",
        "/home/sprite/.civic-spark-agent/runner.ts",
      ],
      { stdio: "pipe" },
    );
    this.child = child;
    const spawnedAt = Date.now();
    child.once("close", (code, signal) => {
      diagnostic({
        event: "agent.runner",
        workspaceId,
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
    // Streamed text arrives one delta per token chunk. Deltas of the same
    // message are merged for up to 50 ms before replay bookkeeping and
    // fan-out, which cuts loop work and socket frames by an order of
    // magnitude on long turns without changing what clients accumulate.
    let pendingText: Event | undefined;
    let pendingTimer: NodeJS.Timeout | undefined;
    let lastActivity = 0;
    const deliver = (event: Event) => {
      this.replay.accept(event);
      if (
        !event.replayed &&
        ["user", "text", "tool", "done"].includes(event.type) &&
        Date.now() - lastActivity >= 1000
      ) {
        lastActivity = Date.now();
        this.events.activity();
      }
      if (
        event.type === "done" ||
        event.type === "error" ||
        (event.type === "status" && event.text === "Working")
      )
        this.pendingPrompt = false;
      this.events.frame(JSON.stringify(event));
      // Tool steps usually write files; announce them at most every 5 s. A
      // finished turn may also have committed, so team status is stale too.
      // After the frame, so a notification never splits a frame batch.
      if (!event.replayed && event.type === "tool") this.events.changed?.("files", 5000);
      if (!event.replayed && event.type === "done") {
        this.events.changed?.("files");
        this.events.changed?.("team");
      }
      this.publishBusy();
    };
    const flushText = () => {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = undefined;
      if (!pendingText) return;
      const event = pendingText;
      pendingText = undefined;
      deliver(event);
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      count("agentLines");
      if (this.stopped || line.length > agentWireByteLimit) return;
      try {
        const event = eventSchema.parse(JSON.parse(line));
        if (event.type === "text" && !event.replayed) {
          if (pendingText && pendingText.id === event.id) {
            pendingText = { ...pendingText, text: pendingText.text + event.text };
          } else {
            flushText();
            pendingText = event;
          }
          if (!pendingTimer) pendingTimer = setTimeout(flushText, 50);
          return;
        }
        flushText();
        deliver(event);
      } catch {
        /* Only structured events go to the browser. */
      }
    });
    child.stdout.once("close", flushText);
    child.stderr.resume(); // Provider diagnostics may contain secrets; never forward or log them.
    const end = () => {
      if (this.finished) return;
      this.finished = true;
      this.events.ended();
    };
    child.on("error", end);
    child.on("close", end);
  }
  /** A prompt was forwarded or a turn is running. */
  get busy(): boolean {
    return this.pendingPrompt || Boolean(this.replay.snapshot().working);
  }
  private publishBusy() {
    const busy = this.busy;
    if (busy === this.lastBusy) return;
    this.lastBusy = busy;
    this.events.busy?.(busy);
  }
  /** Replay for a newly attached client: retained transcript plus the current state. */
  replayFrames(): string[] {
    return [
      ...this.replay.events.map((event) => JSON.stringify({ ...event, replayed: true })),
      JSON.stringify(this.replay.snapshot()),
    ];
  }
  /** Forward one validated input line; a prompt marks the session busy until the runner answers. */
  send(line: string, prompt: boolean) {
    if (prompt) {
      this.pendingPrompt = true;
      this.publishBusy();
    }
    this.write(line);
  }
  private write(line: string) {
    const stdin = this.child.stdin;
    if (stdin.destroyed || !stdin.writable) return;
    stdin.write(`${line}\n`);
  }
  /** Ask the runner to stop its turn and end the process; later output is dropped. */
  stop() {
    this.stopped = true;
    this.write('{"type":"stop"}');
    this.child.kill();
  }
  kill() {
    this.child.kill();
  }
}
