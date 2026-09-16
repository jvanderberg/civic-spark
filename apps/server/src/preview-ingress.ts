import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

export type IngressSettings = { origin: string; target: string; secret: string };
export function ingressSettings(env: NodeJS.ProcessEnv = process.env): IngressSettings {
  const origin = env.CIVIC_SPARK_PREVIEW_INGRESS_ORIGIN ?? "";
  const target = env.CIVIC_SPARK_PREVIEW_INGRESS_TARGET ?? "";
  for (const value of [origin, target]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value)
      throw new Error("Ingress requires exact HTTPS origins");
  }
  if (new URL(origin).hostname === new URL(target).hostname)
    throw new Error("Ingress must have a separate hostname");
  const secret = env.CIVIC_SPARK_PREVIEW_RELAY_SECRET ?? "";
  if (secret.length < 32 || /[\r\n\0]/.test(secret))
    throw new Error("Ingress requires a private relay credential");
  return { origin, target, secret };
}
export function relayAuthorized(
  provided: string | string[] | undefined,
  expected: string | undefined,
) {
  if (!expected || typeof provided !== "string") return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
/** Remove both fixed and Connection-nominated hop headers before another proxy sees them. */
export function stripProxyHeaders(
  headers: IncomingHttpHeaders,
  websocket = false,
): IncomingHttpHeaders {
  const result = { ...headers };
  const nominated = String(headers.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((name) => name.trim());
  for (const key of Object.keys(result)) {
    if (
      [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
      ].includes(key) ||
      nominated.includes(key) ||
      /^(fly-|x-civic-spark-|proxy-)/.test(key)
    )
      delete result[key];
  }
  if (websocket) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}
export function createPreviewIngress(settings: IngressSettings, request = httpsRequest) {
  const target = new URL(settings.target);
  const external = new URL(settings.origin);
  const valid = (req: IncomingMessage) =>
    req.headers.host === external.host &&
    new URL(req.url ?? "/", settings.origin).origin === settings.origin;
  const headers = (req: IncomingMessage, websocket = false): IncomingHttpHeaders => {
    const result: IncomingHttpHeaders = {
      ...stripProxyHeaders(req.headers, websocket),
      host: target.host,
    };
    for (const key of Object.keys(result)) {
      if (
        ["authorization", "forwarded", "x-real-ip", "via"].includes(key) ||
        /^(x-forwarded-|x-civic-spark-|fly-|proxy-)/.test(key)
      )
        delete result[key];
    }
    // The ingress never forwards portal or application cookies.
    result.cookie =
      req.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith("__Host-civic-spark-preview="))
        .join("; ") || undefined;
    if (!result.cookie) delete result.cookie;
    result["x-civic-spark-preview-origin"] = settings.origin;
    result["x-civic-spark-preview-auth"] = settings.secret;
    return result;
  };
  const server = createServer((req, res) => {
    try {
      if (!valid(req)) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === "GET" && req.url === "/__civic_spark_ingress_health") {
        res
          .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
          .end('{"ok":true}');
        return;
      }
      const upstream = request(
        {
          hostname: target.hostname,
          port: target.port || 443,
          method: req.method,
          path: req.url,
          headers: headers(req),
          timeout: 30000,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, stripProxyHeaders(response.headers));
          response.pipe(res);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent)
          res.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        res.end("Preview connection unavailable. Reopen Preview from your workspace.");
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });
      req.pipe(upstream);
    } catch {
      res.writeHead(403).end();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    try {
      if (!valid(req) || req.headers.upgrade?.toLowerCase() !== "websocket") {
        socket.destroy();
        return;
      }
      const upstream = request({
        hostname: target.hostname,
        port: target.port || 443,
        path: req.url,
        headers: headers(req, true),
        timeout: 30000,
      });
      upstream.on("upgrade", (response, remote, extra) => {
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(
            stripProxyHeaders(response.headers, true),
          )
            .map(([key, value]) => `${key}: ${value}`)
            .join("\r\n")}\r\n\r\n`,
        );
        if (head.length) remote.write(head);
        if (extra.length) socket.write(extra);
        socket.pipe(remote).pipe(socket);
        remote.on("error", () => socket.destroy());
        remote.on("close", () => socket.destroy());
        socket.on("close", () => remote.destroy());
      });
      upstream.on("response", (response) => {
        response.resume();
        socket.destroy();
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.end();
    } catch {
      socket.destroy();
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = createPreviewIngress(ingressSettings());
    const port = Number(process.env.CIVIC_SPARK_PORT ?? 4312);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid ingress port");
    server.listen(port, "0.0.0.0", () => console.log("Civic Spark preview ingress ready"));
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        server.closeAllConnections();
        server.close();
        setTimeout(() => process.exit(0), 1000).unref();
      });
  } catch {
    console.error("Preview ingress configuration is invalid");
    process.exitCode = 1;
  }
}
