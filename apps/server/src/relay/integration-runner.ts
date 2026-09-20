import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** One request the in-Sprite `civic-spark` CLI spooled through relay.py. */
export const integrationRequestSchema = z.object({
  id: z.uuid(),
  operation: z.enum([
    "git-publish",
    "git-fetch",
    "git-status",
    "preview-start",
    "preview-restart",
    "preview-status",
    "preview-logs",
    "preview-stop",
  ]),
  port: z.number().int().min(1024).max(65535).optional(),
  command: z.array(z.string().min(1).max(4096)).min(1).max(40).optional(),
});
export type IntegrationRequest = z.infer<typeof integrationRequestSchema>;
/** The answer for one request; relay.py writes it to the CLI's response file by id. */
export type IntegrationResponse = { ok: true; value: unknown } | { ok: false; error: string };
export type IntegrationRunnerEvents = {
  /** One validated request line from relay.py. */
  request(request: IntegrationRequest): void;
  /** The relay process is gone; called once. */
  ended(): void;
};
const lineLimit = 65536;
const relayScript = fileURLToPath(
  new URL("../../../../packages/agents/runtime/relay.py", import.meta.url),
);

/**
 * Owns one agent integration relay child (`sprite exec … python3 relay.py`):
 * spawning, stdout line parsing and validation, response writes to stdin and
 * stderr suppression. Authorization, ticket state, Git execution on the host
 * and the reply content stay with the caller, which may be the main process
 * or a relay worker. Only the fixed `sprite` CLI is launched on the host.
 */
export class IntegrationRunner {
  private readonly child: ChildProcessWithoutNullStreams;
  private finished = false;
  constructor(
    sprite: string,
    private events: IntegrationRunnerEvents,
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
        `${relayScript}:/home/sprite/.civic-spark-agent/relay.py`,
        "--",
        "python3",
        "/home/sprite/.civic-spark-agent/relay.py",
      ],
      { stdio: "pipe" },
    );
    this.child = child;
    child.stderr.resume(); // CLI diagnostics are never forwarded or logged.
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.finished || line.length > lineLimit) return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }
      const input = integrationRequestSchema.safeParse(raw);
      if (input.success) this.events.request(input.data);
    });
    const end = () => {
      if (this.finished) return;
      this.finished = true;
      this.events.ended();
    };
    child.on("error", end);
    child.on("close", end);
  }
  get ended() {
    return this.finished;
  }
  /** Answer one request; dropped once the process is gone. */
  respond(id: string, response: IntegrationResponse) {
    const stdin = this.child.stdin;
    if (this.finished || stdin.destroyed || !stdin.writable) return;
    stdin.write(`${JSON.stringify({ id, ...response })}\n`);
  }
  stop() {
    this.child.kill();
  }
}
