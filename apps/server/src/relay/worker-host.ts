import { monitorEventLoopDelay } from "node:perf_hooks";
import { diagnostic } from "../../../../packages/diagnostics/src/index.ts";
import { CommandBusy } from "../../../../packages/sprites/src/command-queue.ts";
import {
  type HelperReply,
  type HelperSessionLike,
  HelperSessionLost,
} from "../../../../packages/sprites/src/helper-session.ts";
import {
  localSpriteTransport,
  type SpriteTransport,
} from "../../../../packages/sprites/src/transport.ts";
import { AgentRunner } from "./agent-runner.ts";
import { IntegrationRunner } from "./integration-runner.ts";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { TerminalRunner } from "./terminal-runner.ts";

/** The worker's side of the IPC channel; `process` in a real worker, a fake in tests. */
export type WorkerChannel = {
  /** Returns false when the channel is congested; `flushed` fires once the message left. */
  send(message: FromWorker, flushed: () => void): boolean;
  onMessage(handler: (message: ToWorker) => void): void;
  /** The main process went away. */
  onDisconnect(handler: () => void): void;
  exit(code: number): void;
};
const terminalBacklogLimit = 1024 * 1024;
const stderrLimit = 65536;

/**
 * Hosts the Sprite CLI children for one relay worker: agent runners, terminal
 * PTYs, agent integration relays, helper sessions and one-shot commands.
 * Everything it sends is already batched or compact: agent frames are merged
 * per session per tick, terminal output is one frame per tick and merged
 * further while the channel is congested, integration traffic is one
 * validated request or reply per message, and only bounded classification
 * fields leave for failed commands.
 */
export class RelayWorkerHost {
  private agents = new Map<string, AgentRunner>();
  private terminals = new Map<string, TerminalRunner>();
  private integrations = new Map<string, IntegrationRunner>();
  private helpers = new Map<string, HelperSessionLike>();
  private commands = new Map<string, AbortController>();
  private outbox: FromWorker[] = [];
  private flushScheduled = false;
  private congested = false;
  private stopping = false;
  private telemetry: NodeJS.Timeout | undefined;
  constructor(
    private channel: WorkerChannel,
    private index: number,
    private transport: SpriteTransport = localSpriteTransport,
  ) {
    channel.onMessage((message) => this.handle(message));
    channel.onDisconnect(() => this.shutdown());
    if (process.env.CIVIC_SPARK_DIAGNOSTICS === "1") this.installTelemetry();
    this.send({ type: "ready" });
  }
  // Every ten seconds: this worker's loop delay, CPU share, RSS and owned
  // sessions, so a load run can attribute time per process.
  private installTelemetry() {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    let cpu = process.cpuUsage();
    let last = performance.now();
    this.telemetry = setInterval(() => {
      const now = performance.now();
      const usage = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      const elapsedMs = now - last;
      last = now;
      diagnostic({
        event: "relay",
        worker: this.index,
        loopP50Ms: Math.round(histogram.percentile(50) / 1e4) / 100,
        loopP99Ms: Math.round(histogram.percentile(99) / 1e4) / 100,
        loopMaxMs: Math.round(histogram.max / 1e4) / 100,
        cpuPercent: Math.round(((usage.user + usage.system) / 1000 / elapsedMs) * 1000) / 10,
        rssMb: Math.round(process.memoryUsage.rss() / 1048576),
        agents: this.agents.size,
        terminals: this.terminals.size,
        integrations: this.integrations.size,
        helpers: this.helpers.size,
        commands: this.commands.size,
      });
      histogram.reset();
    }, 10000);
    this.telemetry.unref();
  }
  /** Queue one message; the queue flushes once per tick so bursts merge. */
  private send(message: FromWorker) {
    const last = this.outbox.at(-1);
    if (
      last &&
      message.type === "agent.frames" &&
      last.type === "agent.frames" &&
      last.session === message.session
    )
      last.frames.push(...message.frames);
    else if (
      last &&
      message.type === "terminal.output" &&
      last.type === "terminal.output" &&
      last.session === message.session
    ) {
      // Merge output that could not leave yet; keep the newest bytes when a
      // slow channel would otherwise grow this backlog without bound.
      const merged = JSON.stringify({
        type: "output",
        data: (
          (JSON.parse(last.frame) as { data: string }).data +
          (JSON.parse(message.frame) as { data: string }).data
        ).slice(-terminalBacklogLimit),
      });
      last.frame = merged;
    } else this.outbox.push(message);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => {
        this.flushScheduled = false;
        this.flush();
      });
    }
  }
  private flush() {
    while (this.outbox.length && !this.congested) {
      const message = this.outbox.shift() as FromWorker;
      const ok = this.channel.send(message, () => {
        if (!this.congested) return;
        this.congested = false;
        this.flush();
      });
      if (!ok) this.congested = true;
    }
  }
  private handle(message: ToWorker) {
    switch (message.type) {
      case "agent.start":
        return this.startAgent(message.session, message.workspaceId, message.sprite);
      case "agent.attach": {
        const runner = this.agents.get(message.session);
        if (runner)
          this.send({
            type: "agent.replay",
            session: message.session,
            client: message.client,
            frames: runner.replayFrames(),
          });
        return;
      }
      case "agent.input":
        return this.agents.get(message.session)?.send(message.line, message.prompt);
      case "agent.interrupt":
        return this.agents.get(message.session)?.interrupt();
      case "agent.queue":
        return this.agents.get(message.session)?.queue(message.prompt);
      case "agent.unqueue":
        return this.agents.get(message.session)?.unqueue();
      case "agent.stop":
        return this.agents.get(message.session)?.stop();
      case "agent.kill":
        return this.agents.get(message.session)?.kill();
      case "terminal.start":
        return this.startTerminal(message.session, message.sprite);
      case "terminal.attach": {
        const runner = this.terminals.get(message.session);
        if (!runner) return;
        runner.clients += 1;
        return this.send({
          type: "terminal.history",
          session: message.session,
          client: message.client,
          data: runner.history(),
        });
      }
      case "terminal.detach": {
        const runner = this.terminals.get(message.session);
        if (runner) runner.clients = Math.max(0, runner.clients - 1);
        return;
      }
      case "terminal.input":
        return this.terminals.get(message.session)?.write(message.data);
      case "terminal.resize":
        return this.terminals.get(message.session)?.resize(message.cols, message.rows);
      case "terminal.kill":
        return this.terminals.get(message.session)?.kill();
      case "integration.start":
        return this.startIntegration(message.session, message.sprite);
      case "integration.reply":
        return this.integrations.get(message.session)?.respond(message.id, message.response);
      case "integration.stop":
        return this.integrations.get(message.session)?.stop();
      case "command.run":
        return this.runCommand(message);
      case "command.abort":
        return this.commands.get(message.id)?.abort();
      case "session.start":
        return this.startSession(message.session, message.args, message.options);
      case "session.request":
      case "session.ping":
        return this.sessionRequest(message);
      case "session.end":
        return this.helpers.get(message.session)?.end(message.outcome);
      case "shutdown":
        return this.shutdown();
    }
  }
  private startAgent(session: string, workspaceId: string, sprite: string) {
    if (this.stopping) return this.send({ type: "agent.ended", session });
    try {
      const runner = new AgentRunner(workspaceId, sprite, {
        frame: (frame) => this.send({ type: "agent.frames", session, frames: [frame] }),
        activity: () => this.send({ type: "agent.activity", session }),
        changed: (scope, coalesceMs) =>
          this.send({ type: "agent.changed", session, scope, coalesceMs }),
        busy: (busy) => this.send({ type: "agent.busy", session, busy }),
        ended: () => {
          this.agents.delete(session);
          this.send({ type: "agent.ended", session });
        },
      });
      this.agents.set(session, runner);
    } catch {
      this.send({ type: "agent.ended", session });
    }
  }
  private startTerminal(session: string, sprite: string) {
    if (this.stopping) return this.send({ type: "terminal.ended", session, startFailed: true });
    try {
      const runner = new TerminalRunner(sprite, {
        output: (frame) => this.send({ type: "terminal.output", session, frame }),
        ended: () => {
          this.terminals.delete(session);
          this.send({ type: "terminal.ended", session, startFailed: false });
        },
      });
      this.terminals.set(session, runner);
    } catch {
      this.send({ type: "terminal.ended", session, startFailed: true });
    }
  }
  private startIntegration(session: string, sprite: string) {
    if (this.stopping) return this.send({ type: "integration.ended", session });
    try {
      const runner = new IntegrationRunner(sprite, {
        request: (request) => this.send({ type: "integration.request", session, request }),
        ended: () => {
          this.integrations.delete(session);
          this.send({ type: "integration.ended", session });
        },
      });
      this.integrations.set(session, runner);
    } catch {
      this.send({ type: "integration.ended", session });
    }
  }
  private async runCommand(message: Extract<ToWorker, { type: "command.run" }>) {
    const controller = new AbortController();
    this.commands.set(message.id, controller);
    try {
      const stdout = await this.transport.execute(message.args, {
        timeout: message.timeout,
        maxBuffer: message.maxBuffer,
        input: message.input,
        signal: controller.signal,
      });
      this.send({ type: "command.done", id: message.id, stdout });
    } catch (error) {
      const e = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
      const stderr = Buffer.isBuffer(e.stderr)
        ? e.stderr.subarray(0, stderrLimit).toString("utf8")
        : typeof e.stderr === "string"
          ? e.stderr.slice(0, stderrLimit)
          : "";
      this.send({
        type: "command.failed",
        id: message.id,
        error: {
          ...(typeof e.code === "string" || typeof e.code === "number" ? { code: e.code } : {}),
          ...(typeof e.killed === "boolean" ? { killed: e.killed } : {}),
          ...(typeof e.signal === "string" ? { signal: e.signal } : {}),
          stderr,
        },
      });
    } finally {
      this.commands.delete(message.id);
    }
  }
  private startSession(
    session: string,
    args: string[],
    options: Extract<ToWorker, { type: "session.start" }>["options"],
  ) {
    if (this.stopping)
      return this.send({
        type: "session.closed",
        session,
        end: { outcome: "process_failed", exitCode: null, signal: null, stderr: "" },
      });
    const helper = this.transport.session("", args, options);
    this.helpers.set(session, helper);
    helper.ready.then(
      () => this.send({ type: "session.ready", session }),
      () => {},
    );
    void helper.closed.then((end) => {
      this.helpers.delete(session);
      this.send({ type: "session.closed", session, end });
    });
  }
  private sessionRequest(message: Extract<ToWorker, { type: "session.request" | "session.ping" }>) {
    const { session, id } = message;
    const helper = this.helpers.get(session);
    const rejected = (reason: "lost" | "busy" | "failed", text: string) =>
      this.send({ type: "session.rejected", session, id, reason, message: text });
    if (!helper) return rejected("lost", "Helper session ended");
    const pending: Promise<HelperReply> =
      message.type === "session.ping"
        ? helper.ping(message.timeoutMs).then(() => ({ stdout: "" }))
        : helper.request(message.script, message.payload, message.timeoutMs, message.limit);
    pending.then(
      (reply) => this.send({ type: "session.reply", session, id, reply }),
      (error: unknown) =>
        rejected(
          error instanceof HelperSessionLost
            ? "lost"
            : error instanceof CommandBusy
              ? "busy"
              : "failed",
          error instanceof Error ? error.message : "Helper session request failed",
        ),
    );
  }
  /** Stop every child, wait briefly for them to close, then exit. */
  shutdown() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.telemetry) clearInterval(this.telemetry);
    for (const runner of this.agents.values()) runner.stop();
    for (const runner of this.terminals.values()) runner.kill();
    for (const runner of this.integrations.values()) runner.stop();
    for (const controller of this.commands.values()) controller.abort();
    const closing = [...this.helpers.values()].map((helper) => helper.closed);
    for (const helper of this.helpers.values()) helper.end("ok");
    void Promise.race([
      Promise.all(closing),
      new Promise((resolve) => setTimeout(resolve, 5000).unref()),
    ]).then(() => this.channel.exit(0));
  }
}
