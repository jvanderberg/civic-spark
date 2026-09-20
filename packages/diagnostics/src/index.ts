import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";

export const diagnosticContext = new AsyncLocalStorage<{
  requestId?: string;
  traceId?: string;
  operationId?: string;
}>();
export const helperDiagnosticSchema = z.object({
  exception: z.enum([
    "ValueError",
    "KeyError",
    "FileNotFoundError",
    "PermissionError",
    "OSError",
    "CalledProcessError",
    "TimeoutExpired",
    "UnicodeDecodeError",
    "other",
  ]),
  line: z.number().int().nonnegative(),
  errno: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
});
const recordSchema = z.object({
  event: z.enum([
    "http",
    "sprite.command",
    "sprite.operation",
    "sprite.coalesced",
    "sprite.session",
    "ws",
    "agent.runner",
    "agent.prepare",
    "lifecycle.idle",
    "loop",
  ]),
  bytes: z.number().int().nonnegative().optional(), // Response body bytes as sent.
  loopP50Ms: z.number().nonnegative().optional(),
  loopP99Ms: z.number().nonnegative().optional(),
  loopMaxMs: z.number().nonnegative().optional(),
  cpuPercent: z.number().nonnegative().optional(),
  handles: z.number().int().nonnegative().optional(),
  children: z.number().int().nonnegative().optional(),
  sockets: z.number().int().nonnegative().optional(),
  rssMb: z.number().nonnegative().optional(),
  channel: z.enum(["agent", "terminal"]).optional(),
  transport: z.enum(["process", "session"]).optional(), // How a Sprite command reached the Sprite.
  phase: z.enum(["start", "end"]).optional(), // Helper session lifecycle only.
  code: z.number().int().optional(), // WebSocket close code only; reasons are never logged.
  attempt: z.number().int().positive().optional(),
  idleMs: z.number().nonnegative().optional(),
  requestId: z.uuid().optional(),
  traceId: z.uuid().optional(),
  operationId: z.uuid().optional(),
  workspaceId: z.uuid().optional(),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).optional(),
  route: z.string().max(160).optional(), // Registered route template only, never request URL.
  status: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
  queueMs: z.number().nonnegative().optional(),
  executionMs: z.number().nonnegative().optional(),
  timeoutMs: z.number().nonnegative().optional(),
  outcome: z
    .enum([
      "ok",
      "queue_busy",
      "lease_aborted",
      "timeout",
      "buffer_limit",
      "spawn_missing",
      "process_failed",
      "helper_failed",
      "invalid_response",
      "session_lost",
    ])
    .optional(),
  stderrKind: z
    .enum(["empty", "timeout", "auth", "rate_limit", "provider_5xx", "connection", "unknown"])
    .optional(),
  stderrHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  exitCode: z.number().int().optional(),
  signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "other"]).optional(),
  script: z
    .enum(["files.py", "workspace.py", "team_git.py", "agent_git.py", "preview.py", "other"])
    .optional(),
  operation: z
    .enum([
      "list",
      "read",
      "save",
      "changes",
      "manifest",
      "mutate",
      "share",
      "adopt-share",
      "shared",
      "status",
      "logs",
      "start",
      "restart",
      "stop",
      "import",
      "apply",
      "verify",
      "other",
    ])
    .optional(),
  helper: helperDiagnosticSchema.optional(),
});
export type DiagnosticRecord = z.infer<typeof recordSchema>;
export function diagnostic(record: DiagnosticRecord) {
  if (process.env.CIVIC_SPARK_DIAGNOSTICS !== "1") return;
  try {
    const parsed = recordSchema.safeParse({ ...diagnosticContext.getStore(), ...record });
    if (parsed.success)
      console.info(
        JSON.stringify({
          kind: "civic-spark.diagnostic",
          at: new Date().toISOString(),
          ...parsed.data,
        }),
      );
  } catch {
    /* Logging must never change request or mutation results. */
  }
}
export function spriteWorkspaceId(name: string | undefined) {
  const parsed = z.uuid().safeParse(name?.replace(/^civic-spark-/, ""));
  return parsed.success ? parsed.data : undefined;
}
export function commandFailure(
  error: unknown,
  elapsed: number,
  timeout: number,
  aborted: boolean,
): Pick<DiagnosticRecord, "outcome" | "stderrKind" | "stderrHash" | "exitCode" | "signal"> {
  const e = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const stderr = Buffer.isBuffer(e.stderr)
    ? e.stderr.toString("utf8")
    : typeof e.stderr === "string"
      ? e.stderr
      : "";
  const outcome = aborted
    ? "lease_aborted"
    : e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? "buffer_limit"
      : e.code === "ENOENT"
        ? "spawn_missing"
        : e.killed === true && elapsed >= timeout - 100
          ? "timeout"
          : "process_failed";
  const stderrKind = !stderr
    ? "empty"
    : /timed? ?out|deadline exceeded/i.test(stderr)
      ? "timeout"
      : /unauthorized|forbidden|authentication|invalid token/i.test(stderr)
        ? "auth"
        : /429|rate limit/i.test(stderr)
          ? "rate_limit"
          : /\b50[0234]\b|bad gateway|service unavailable/i.test(stderr)
            ? "provider_5xx"
            : /EOF|connection|websocket|socket|network|TLS|dial tcp/i.test(stderr)
              ? "connection"
              : "unknown";
  return {
    outcome,
    stderrKind,
    ...(stderr ? { stderrHash: createHash("sha256").update(stderr).digest("hex") } : {}),
    ...(typeof e.code === "number" ? { exitCode: e.code } : {}),
    ...(typeof e.signal === "string"
      ? {
          signal: (["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT"].includes(e.signal)
            ? e.signal
            : "other") as DiagnosticRecord["signal"],
        }
      : {}),
  };
}
export function operationLabels(
  script: string,
  operation: string,
): Pick<DiagnosticRecord, "script" | "operation"> {
  const s = recordSchema.shape.script.safeParse(script);
  const op = recordSchema.shape.operation.safeParse(operation);
  return { script: s.success ? s.data : "other", operation: op.success ? op.data : "other" };
}
