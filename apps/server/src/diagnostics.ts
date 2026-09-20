import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type DiagnosticRecord,
  diagnostic,
  diagnosticContext,
} from "../../../packages/diagnostics/src/index.ts";

export function installDiagnostics(app: FastifyInstance) {
  const requests = new WeakMap<
    FastifyRequest,
    { requestId: string; traceId?: string; started: number }
  >();
  app.addHook("onRequest", (request, reply, done) => {
    const trace = z.uuid().safeParse(request.headers["x-civic-spark-test-trace"]);
    const context = {
      requestId: randomUUID(),
      ...(trace.success ? { traceId: trace.data } : {}),
      started: performance.now(),
    };
    requests.set(request, context);
    reply.header("x-civic-spark-request-id", context.requestId);
    diagnosticContext.run(context, done);
  });
  app.addHook("onResponse", async (request, reply) => {
    const context = requests.get(request);
    if (!context) return;
    const params = z.object({ id: z.uuid().optional() }).safeParse(request.params);
    const route = request.routeOptions.url ?? "unmatched";
    diagnostic({
      event: "http",
      requestId: context.requestId,
      traceId: context.traceId,
      method: request.method as DiagnosticRecord["method"],
      route,
      ...(route.startsWith("/api/workspaces/") && params.success
        ? { workspaceId: params.data.id }
        : {}),
      status: reply.statusCode,
      durationMs: Math.round(performance.now() - context.started),
    });
  });
}
