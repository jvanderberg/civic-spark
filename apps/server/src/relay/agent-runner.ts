import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AgentReplay } from "../../../../packages/agents/src/history.ts";
import { agentImagesSchema, agentWireByteLimit } from "../../../../packages/agents/src/images.ts";
import { type AgentPrompt, agentQueueLimit } from "../../../../packages/agents/src/protocol.ts";
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
  billingFailure: z.boolean().optional(),
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
  /** A participant stop was acknowledged; the turn has not reported back yet. */
  private interrupting = false;
  /** Messages waiting for the running turn, oldest first. */
  private queued: AgentPrompt[] = [];
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
      // An acknowledged stop ends the visible turn immediately. Output the
      // stopping turn still produces is dropped from the transcript and from
      // live fan-out together, so reattaching clients see the same thing.
      if (this.interrupting && !event.replayed && ["text", "tool"].includes(event.type)) return;
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
      ) {
        this.pendingPrompt = false;
        this.interrupting = false;
      }
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
      if (!this.busy) {
        this.interrupting = false;
        this.flushQueued();
      }
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
  private publishState() {
    this.events.frame(JSON.stringify(this.replay.snapshot()));
  }
  /**
   * Acknowledge a participant stop at once and forward it. The runner can take
   * a moment to abandon provider work; clients must not wait for that to see
   * the turn end, and every later client attach must see the same state.
   * Stop also cancels the queue: waiting messages must not start a new turn by
   * themselves, so the client takes their content back into the composer.
   */
  interrupt() {
    if (this.stopped) return;
    this.queued = [];
    this.publishQueued();
    if (this.busy) {
      this.interrupting = true;
      this.replay.requestStop();
    }
    this.publishState();
    this.write('{"type":"stop"}');
  }
  /** Hold a prompt until the turns before it finish; deliver it exactly once. */
  queue(prompt: AgentPrompt) {
    if (this.stopped || this.queued.length >= agentQueueLimit) return;
    this.queued.push(prompt);
    this.publishQueued();
    if (!this.busy) this.flushQueued();
    else this.publishState();
  }
  unqueue(id: string) {
    const remaining = this.queued.filter((prompt) => prompt.id !== id);
    if (remaining.length === this.queued.length) return;
    this.queued = remaining;
    this.publishQueued();
    this.publishState();
  }
  /**
   * Send now. Each harness turn is one request, so a queued message cannot be
   * injected into the running turn: it moves to the front of the queue and the
   * turn is stopped, which flushes it as the next prompt. The rest stays queued.
   */
  steer(id: string) {
    const prompt = this.queued.find((entry) => entry.id === id);
    if (this.stopped || !prompt) return;
    this.queued = [prompt, ...this.queued.filter((entry) => entry !== prompt)];
    this.publishQueued();
    if (!this.busy) {
      this.flushQueued();
      return;
    }
    this.interrupting = true;
    this.replay.requestStop();
    this.publishState();
    this.write('{"type":"stop"}');
  }
  private publishQueued() {
    this.replay.setQueued(
      this.queued.map((prompt) => ({
        id: prompt.id ?? "",
        text: prompt.text,
        images: prompt.images,
      })),
    );
  }
  private flushQueued() {
    const prompt = this.queued[0];
    if (!prompt || this.stopped || this.busy) return;
    this.queued = this.queued.slice(1);
    this.publishQueued();
    this.send(JSON.stringify(prompt), true);
    this.publishState();
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
