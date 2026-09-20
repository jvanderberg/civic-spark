import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { installDiagnostics } from "../apps/server/src/diagnostics.ts";
import {
  commandFailure,
  diagnostic,
  diagnosticContext,
} from "../packages/diagnostics/src/index.ts";
import { ok } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it("keeps concurrent HTTP/Sprite correlations isolated and excludes private inputs", async () => {
  vi.stubEnv("CIVIC_SPARK_DIAGNOSTICS", "1");
  const sink = vi.spyOn(console, "info").mockImplementation(() => {});
  const app = Fastify();
  installDiagnostics(app);
  app.get("/api/workspaces/:id/changes", async (request) => {
    await new Promise((resolve) =>
      setTimeout(resolve, request.headers["x-delay"] === "yes" ? 20 : 1),
    );
    diagnostic({ event: "sprite.command", outcome: "process_failed", status: 502 });
    return { error: "PRIVATE-BODY" };
  });
  try {
    const traces = [randomUUID(), randomUUID()];
    const responses = await Promise.all(
      traces.map((trace, index) =>
        app.inject({
          url: `/api/workspaces/${randomUUID()}/changes?key=PRIVATE-QUERY`,
          headers: {
            "x-civic-spark-test-trace": trace,
            authorization: "PRIVATE-AUTH",
            "x-delay": index === 0 ? "yes" : "no",
          },
        }),
      ),
    );
    const logs = sink.mock.calls.map((call) => JSON.parse(String(call[0])));
    for (const [index, response] of responses.entries()) {
      const requestId = response.headers["x-civic-spark-request-id"];
      expect(logs.filter((log) => log.traceId === traces[index])).toHaveLength(2);
      expect(
        logs
          .filter((log) => log.traceId === traces[index])
          .every((log) => log.requestId === requestId),
      ).toBe(true);
    }
    expect(JSON.stringify(logs)).not.toContain("PRIVATE");
    expect(
      logs
        .filter((log) => log.event === "http")
        .every((log) => log.route === "/api/workspaces/:id/changes"),
    ).toBe(true);
    const invalid = await app.inject({
      url: `/api/workspaces/${randomUUID()}/changes`,
      headers: { "x-civic-spark-test-trace": "PRIVATE-TRACE" },
    });
    expect(invalid.statusCode).toBe(200);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("PRIVATE-TRACE");
  } finally {
    await app.close();
  }
});
it("classifies command failures without exposing stdout, stderr, arguments or error messages", () => {
  const detail = commandFailure(
    {
      code: 1,
      stderr: Buffer.from("PRIVATE-KEY websocket connection reset"),
      stdout: "PRIVATE-SOURCE",
      message: "PRIVATE-ARGUMENTS",
    },
    500,
    30000,
    false,
  );
  expect(detail).toMatchObject({
    outcome: "process_failed",
    stderrKind: "connection",
    exitCode: 1,
  });
  expect(JSON.stringify(detail)).not.toContain("PRIVATE");
  expect(commandFailure({ killed: true, signal: "SIGTERM" }, 30001, 30000, false).outcome).toBe(
    "timeout",
  );
  expect(commandFailure({ killed: true }, 30001, 30000, true).outcome).toBe("lease_aborted");
  expect(
    commandFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, 1, 30000, false).outcome,
  ).toBe("buffer_limit");
  expect(commandFailure({ code: "ENOENT" }, 1, 30000, false).outcome).toBe("spawn_missing");
});
it("logs helper exception metadata but strips it from API results, and logging cannot break mutations", async () => {
  vi.stubEnv("CIVIC_SPARK_DIAGNOSTICS", "1");
  const sink = vi.spyOn(console, "info").mockImplementation(() => {});
  const client = new SpriteClient("test");
  const helper = { exception: "FileNotFoundError", line: 111, errno: 2, exitCode: null };
  vi.spyOn(client, "command").mockResolvedValue(
    ok(
      Buffer.from(
        JSON.stringify({ ok: false, error: "Files changed", status: 409, diagnostic: helper }),
      ),
    ),
  );
  const requestId = randomUUID();
  const result = await diagnosticContext.run({ requestId }, () =>
    client.changes(`civic-spark-${randomUUID()}`),
  );
  expect(result).toEqual({ ok: false, error: "Files changed", status: 409 });
  expect(JSON.parse(String(sink.mock.calls[0]?.[0]))).toMatchObject({
    event: "sprite.operation",
    requestId,
    status: 409,
    helper,
  });
  sink.mockImplementation(() => {
    throw new Error("log sink failure");
  });
  expect(await client.changes(`civic-spark-${randomUUID()}`)).toEqual(result);
});
it("logs connection lifecycle records with codes and durations only", () => {
  vi.stubEnv("CIVIC_SPARK_DIAGNOSTICS", "1");
  const sink = vi.spyOn(console, "info").mockImplementation(() => {});
  const workspaceId = randomUUID();
  diagnostic({
    event: "ws",
    channel: "agent",
    workspaceId,
    code: 1008,
    durationMs: 12,
    ...({ reason: "PRIVATE-REASON" } as object),
  });
  diagnostic({ event: "agent.runner", workspaceId, exitCode: 1, signal: "other", durationMs: 5 });
  diagnostic({ event: "lifecycle.idle", workspaceId, idleMs: 300000 });
  diagnostic({ event: "agent.prepare", workspaceId, attempt: 3, outcome: "process_failed" });
  diagnostic({ event: "ws", channel: "terminal", workspaceId: "not-a-workspace", code: 1000 });
  const logs = sink.mock.calls.map((call) => JSON.parse(String(call[0])));
  expect(logs.map((log) => log.event)).toEqual([
    "ws",
    "agent.runner",
    "lifecycle.idle",
    "agent.prepare",
  ]);
  expect(logs[0]).toMatchObject({ channel: "agent", code: 1008, workspaceId });
  expect(JSON.stringify(logs)).not.toContain("PRIVATE");
});
