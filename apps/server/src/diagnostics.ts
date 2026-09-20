import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
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
      ...(Number.isFinite(Number(reply.getHeader("content-length")))
        ? { bytes: Number(reply.getHeader("content-length")) }
        : {}),
    });
  });
  installLoopTelemetry();
}

// Every ten seconds: event-loop delay percentiles, process CPU share, and
// handle counts. This is what shows a saturated loop while handlers look fast.
function installLoopTelemetry() {
  if (process.env.CIVIC_SPARK_DIAGNOSTICS !== "1") return;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let cpu = process.cpuUsage();
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const usage = process.cpuUsage(cpu);
    cpu = process.cpuUsage();
    const elapsedMs = now - last;
    last = now;
    const handles = (
      process as unknown as { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.();
    const names = (handles ?? []).map((handle) => handle?.constructor?.name ?? "");
    diagnostic({
      event: "loop",
      loopP50Ms: Math.round(histogram.percentile(50) / 1e4) / 100,
      loopP99Ms: Math.round(histogram.percentile(99) / 1e4) / 100,
      loopMaxMs: Math.round(histogram.max / 1e4) / 100,
      cpuPercent: Math.round(((usage.user + usage.system) / 1000 / elapsedMs) * 1000) / 10,
      handles: names.length,
      children: names.filter((name) => name === "ChildProcess").length,
      sockets: names.filter((name) => name === "Socket" || name === "TLSSocket").length,
      rssMb: Math.round(process.memoryUsage.rss() / 1048576),
    });
    histogram.reset();
  }, 10000);
  timer.unref();
}
