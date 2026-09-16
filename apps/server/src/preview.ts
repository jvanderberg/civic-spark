import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, createServer as portServer } from "node:net";
import type { Duplex } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { previewActivity } from "./preview-activity.ts";
import { validatePreviewOriginTemplate } from "./preview-config.ts";
import { relayAuthorized, stripProxyHeaders } from "./preview-ingress.ts";
import { PreviewOriginPool } from "./preview-origins.ts";

export type PreviewTransport = { port: number; close(): void; alive?(): boolean };
export type PreviewTransportFactory = (sprite: string, port: number) => Promise<PreviewTransport>;
export async function spritePreviewTransport(
  sprite: string,
  port: number,
  signal?: AbortSignal,
): Promise<PreviewTransport> {
  const probe = portServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate preview tunnel");
  const local = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  signal?.throwIfAborted();
  const child = spawn(
    "sprite",
    [
      ...(process.env.CIVIC_SPARK_SPRITE_ORG ? ["-o", process.env.CIVIC_SPARK_SPRITE_ORG] : []),
      "-s",
      sprite,
      "proxy",
      `${local}:${port}`,
    ],
    { stdio: "ignore" },
  );
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  let alive = true;
  child.on("error", () => {
    alive = false;
  });
  child.on("exit", () => {
    signal?.removeEventListener("abort", abort);
    alive = false;
  });
  for (let attempt = 0; attempt < 50 && alive; attempt++) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect(local, "127.0.0.1");
      socket.setTimeout(100);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready && !signal?.aborted)
      return {
        port: local,
        close: () => {
          alive = false;
          signal?.removeEventListener("abort", abort);
          child.kill();
        },
        alive: () => alive,
      };
    await setTimeout(100);
  }
  child.kill();
  throw new Error("Could not start the Sprite preview tunnel");
}

type Grant = { expires: number; authorized: () => Promise<boolean> };
type Preview = {
  lastUse: number;
  port: number;
  sprite: string;
  url: string;
  cookie: string;
  server?: Server;
  transport: PreviewTransport;
  tickets: Map<string, Grant>;
  sessions: Map<string, Grant>;
  sockets: Set<Duplex>;
};
const SESSION_MS = 60 * 60 * 1000;
const TICKET_MS = 60 * 1000;
const randomToken = () => randomBytes(32).toString("base64url");
function reject(
  res: ServerResponse,
  status = 401,
  message = "Reopen Preview from your Civic Spark workspace.",
) {
  res
    .writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    .end(message);
}
function boundedSet(map: Map<string, Grant>, key: string, value: Grant) {
  if (map.size >= 32) {
    const oldest = map.keys().next().value;
    if (oldest) map.delete(oldest);
  }
  map.set(key, value);
}
function requestHeaders(
  req: IncomingMessage,
  preview: Preview,
  websocket = false,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {
    ...stripProxyHeaders(req.headers, websocket),
    host: `127.0.0.1:${preview.port}`,
  };
  for (const key of Object.keys(headers)) {
    if (
      ["cookie", "authorization", "forwarded", "x-real-ip", "via"].includes(key) ||
      /^(x-forwarded-|x-civic-spark-|fly-|proxy-)/.test(key)
    )
      delete headers[key];
  }
  if (headers.origin) headers.origin = `http://127.0.0.1:${preview.port}`;
  return headers;
}
function responseHeaders(
  headers: IncomingHttpHeaders,
  preview: Preview,
  portal: string,
  websocket = false,
): IncomingHttpHeaders {
  const outgoing = stripProxyHeaders(headers, websocket);
  delete outgoing["set-cookie"];
  delete outgoing.authorization;
  delete outgoing["proxy-authenticate"];
  if (outgoing.location) {
    try {
      const location = new URL(outgoing.location, preview.url);
      if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname))
        outgoing.location = `${preview.url}${location.pathname}${location.search}${location.hash}`;
    } catch {
      delete outgoing.location;
    }
  }
  outgoing["content-security-policy"] = `frame-ancestors ${portal};`;
  outgoing["referrer-policy"] = "no-referrer";
  outgoing["cache-control"] = "no-store";
  return outgoing;
}

/** Each workspace gets its own browser origin; every cookie retains its original session check. */
export class WorkspacePreviews {
  private previews = new Map<string, Preview>();
  private opening = new Map<string, Promise<{ url: string; port: number }>>();
  private attached = new WeakSet<Server>();
  private maintenance: NodeJS.Timeout;
  private template?: string;
  private pool?: PreviewOriginPool;
  private relaySecret?: string;
  private closed = false;
  private revisions = new Map<string, number>();
  constructor(
    private portal: string,
    private transport: PreviewTransportFactory = spritePreviewTransport,
    template?: string,
    routing?: { pool: string[]; root: string; relaySecret: string },
  ) {
    if (routing) {
      if (template) throw new Error("Configure a preview pool or template, not both");
      if (routing.relaySecret.length < 32 || /[\r\n\0]/.test(routing.relaySecret))
        throw new Error("Preview pool requires a private relay credential");
      this.pool = new PreviewOriginPool(routing.pool, routing.root, portal);
      this.relaySecret = routing.relaySecret;
    }
    this.template =
      template === undefined ? undefined : validatePreviewOriginTemplate(template, portal);
    this.maintenance = globalThis.setInterval(() => {
      const now = Date.now();
      for (const [id, item] of this.previews) {
        for (const map of [item.tickets, item.sessions])
          for (const [token, grant] of map) if (grant.expires <= now) map.delete(token);
        if ((!item.tickets.size && !item.sessions.size) || item.transport.alive?.() === false)
          this.stop(id);
      }
    }, 30000);
    this.maintenance.unref();
  }
  get configured() {
    return (
      Boolean(this.template || this.pool) ||
      ["localhost", "127.0.0.1"].includes(new URL(this.portal).hostname)
    );
  }
  /** Called after Fastify plugins register their raw HTTP and upgrade listeners. */
  attach(server: Server) {
    if ((!this.template && !this.pool) || this.attached.has(server)) return;
    this.attached.add(server);
    const portalHost = new URL(this.portal).host;
    const requests = server.listeners("request") as ((
      req: IncomingMessage,
      res: ServerResponse,
    ) => void)[];
    const upgrades = server.listeners("upgrade") as ((
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => void)[];
    server.removeAllListeners("request");
    server.removeAllListeners("upgrade");
    server.on("request", (req, res) => {
      if (!this.acceptRelay(req)) {
        reject(res, 403);
        return;
      }
      if (req.headers.host === portalHost) {
        for (const listener of requests) listener.call(server, req, res);
        return;
      }
      const preview = this.forHost(req.headers.host);
      if (preview) void this.http(preview, req, res);
      else reject(res, this.matchesHost(req.headers.host) ? 401 : 403);
    });
    server.on("upgrade", (req, socket, head) => {
      socket.on("error", () => socket.destroy());
      if (!this.acceptRelay(req)) {
        socket.destroy();
        return;
      }
      if (req.headers.host === portalHost) {
        for (const listener of upgrades) listener.call(server, req, socket, head);
        return;
      }
      const preview = this.forHost(req.headers.host);
      if (preview) void this.upgrade(preview, req, socket, head);
      else socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    });
  }
  private acceptRelay(req: IncomingMessage) {
    const origin = req.headers["x-civic-spark-preview-origin"];
    const credential = req.headers["x-civic-spark-preview-auth"];
    if (origin === undefined && credential === undefined) return true;
    if (
      typeof origin !== "string" ||
      !this.pool?.origins.includes(origin) ||
      !relayAuthorized(credential, this.relaySecret) ||
      req.headers.host !== new URL(this.portal).host
    )
      return false;
    delete req.headers["x-civic-spark-preview-origin"];
    delete req.headers["x-civic-spark-preview-auth"];
    req.headers.host = new URL(origin).host;
    return true;
  }
  private matchesHost(host?: string) {
    if (this.pool?.origins.some((origin) => new URL(origin).host === host)) return true;
    if (!host || !this.template) return false;
    const parts = this.template.slice("https://".length).split("{workspace}");
    const suffix = parts[1];
    if (!suffix || !host.endsWith(suffix)) return false;
    return /^[a-f0-9-]{36}$/.test(host.slice(0, -suffix.length));
  }
  private forHost(host?: string) {
    return [...this.previews.values()].find((item) => new URL(item.url).host === host);
  }
  open(id: string, sprite: string, port: number, authorized: () => Promise<boolean>) {
    const previous = this.opening.get(id) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.openOne(id, sprite, port, authorized));
    this.opening.set(id, current);
    void current
      .finally(() => {
        if (this.opening.get(id) === current) this.opening.delete(id);
      })
      .catch(() => undefined);
    return current;
  }
  private async openOne(
    id: string,
    sprite: string,
    port: number,
    authorized: () => Promise<boolean>,
  ) {
    if (this.closed) throw new Error("Preview gateway is closed");
    if (!this.configured)
      throw new Error("Hosted preview is not configured for this installation.");
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid preview port");
    if ((this.template || this.pool) && !/^[a-f0-9-]{36}$/.test(id))
      throw new Error("Invalid preview workspace");
    let revision = this.revisions.get(id) ?? 0;
    if (!(await authorized()) || revision !== (this.revisions.get(id) ?? 0))
      throw new Error("Workspace access ended");
    let item = this.previews.get(id);
    if (
      item &&
      (item.port !== port || item.sprite !== sprite || item.transport.alive?.() === false)
    ) {
      this.stop(id);
      revision = this.revisions.get(id) ?? 0;
      item = undefined;
    }
    if (!item) {
      if (this.previews.size >= 1000)
        throw new Error("Preview capacity reached. Close an unused preview and retry.");
      const url = this.pool?.assign(id) ?? this.template?.replace("{workspace}", id) ?? "";
      const transport = await this.transport(sprite, port);
      item = {
        lastUse: Date.now(),
        port,
        sprite,
        transport,
        url,
        cookie:
          this.template || this.pool
            ? "__Host-civic-spark-preview"
            : `civic_spark_preview_${randomBytes(8).toString("hex")}`,
        tickets: new Map(),
        sessions: new Map(),
        sockets: new Set(),
      };
      const preview = item;
      try {
        if (this.closed || !(await authorized())) throw new Error("Workspace access ended");
        if (!this.template && !this.pool) {
          const hostname =
            new URL(this.portal).hostname === "localhost" ? "127.0.0.1" : "localhost";
          const server = createServer((req, res) => void this.http(preview, req, res));
          item.server = server;
          server.on(
            "upgrade",
            (req, socket, head) => void this.upgrade(preview, req, socket, head),
          );
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, hostname, resolve);
          });
          const address = server.address();
          if (!address || typeof address === "string")
            throw new Error("Cannot start private preview");
          item.url = `http://${hostname}:${address.port}`;
        }
        if (this.closed || revision !== (this.revisions.get(id) ?? 0))
          throw new Error("Preview was stopped. Reopen it from your workspace.");
        this.previews.set(id, item);
      } catch (error) {
        item.server?.close();
        transport.close();
        throw error;
      }
    }
    if (this.closed || this.previews.get(id) !== item)
      throw new Error("Preview was stopped. Reopen it from your workspace.");
    const token = randomToken();
    boundedSet(item.tickets, token, { expires: Date.now() + TICKET_MS, authorized });
    return { url: `${item.url}/__civic_spark_open?token=${token}`, port };
  }
  private async valid(item: Preview, req: IncomingMessage) {
    if (req.headers.host !== new URL(item.url).host) return false;
    const token = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${item.cookie}=`))
      ?.slice(item.cookie.length + 1);
    const grant = token ? item.sessions.get(token) : undefined;
    return Boolean(grant && grant.expires > Date.now() && (await grant.authorized()));
  }
  private async http(item: Preview, req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.headers.host !== new URL(item.url).host) {
        reject(res, 403);
        return;
      }
      const parsed = new URL(req.url ?? "/", item.url);
      if (parsed.origin !== item.url) {
        reject(res, 403);
        return;
      }
      if (parsed.pathname === "/__civic_spark_open") {
        const token = parsed.searchParams.get("token") ?? "";
        const ticket = item.tickets.get(token);
        // Consume before asynchronous authorization: concurrent requests cannot redeem twice.
        item.tickets.delete(token);
        if (
          req.method !== "GET" ||
          !ticket ||
          ticket.expires <= Date.now() ||
          !(await ticket.authorized())
        ) {
          reject(res);
          return;
        }
        const session = randomToken();
        boundedSet(item.sessions, session, {
          authorized: ticket.authorized,
          expires: Date.now() + SESSION_MS,
        });
        res
          .writeHead(303, {
            Location: "/",
            "Set-Cookie": `${item.cookie}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${this.template || this.pool ? "; Secure" : ""}`,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          })
          .end();
        return;
      }
      if (!(await this.valid(item, req))) {
        reject(res);
        return;
      }
      if (
        (req.headers.origin && req.headers.origin !== item.url) ||
        (req.headers["sec-fetch-site"] === "cross-site" &&
          !(
            req.method === "GET" &&
            req.headers["sec-fetch-mode"] === "navigate" &&
            req.headers["sec-fetch-dest"] === "document"
          ))
      ) {
        reject(res, 403, "Cross-origin preview requests are disabled");
        return;
      }
      item.lastUse = Date.now();
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: item.transport.port,
          path: req.url,
          method: req.method,
          headers: requestHeaders(req, item),
          timeout: 30000,
        },
        (response) => {
          res.writeHead(
            response.statusCode ?? 502,
            responseHeaders(response.headers, item, this.portal),
          );
          response.pipe(res);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent)
          reject(
            res,
            502,
            "The web server is not responding. Check Preview logs in the workspace.",
          );
        else res.destroy();
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) reject(res, 403, "Workspace access ended");
      else res.destroy();
    }
  }
  private async upgrade(item: Preview, req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    try {
      if (
        req.headers.upgrade?.toLowerCase() !== "websocket" ||
        !(await this.valid(item, req)) ||
        req.headers.origin !== item.url ||
        new URL(req.url ?? "/", item.url).origin !== item.url
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      if (socket.destroyed) return;
      item.lastUse = Date.now();
      const upstream = httpRequest({
        host: "127.0.0.1",
        port: item.transport.port,
        path: req.url,
        headers: requestHeaders(req, item, true),
        timeout: 30000,
      });
      item.sockets.add(socket);
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => {
        item.sockets.delete(socket);
        upstream.destroy();
      });
      upstream.on("upgrade", (response, target, extra) => {
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(
            responseHeaders(response.headers, item, this.portal, true),
          )
            .map(([key, value]) => `${key}: ${value}`)
            .join("\r\n")}\r\n\r\n`,
        );
        const activity = previewActivity(req.headers["sec-websocket-protocol"], () => {
          item.lastUse = Date.now();
        });
        socket.on("data", activity);
        if (head.length) {
          activity(head);
          target.write(head);
        }
        if (extra.length) socket.write(extra);
        socket.pipe(target).pipe(socket);
        const timer = globalThis.setInterval(() => {
          void this.valid(item, req)
            .then((ok) => {
              if (!ok) {
                target.destroy();
                socket.destroy();
              }
            })
            .catch(() => {
              target.destroy();
              socket.destroy();
            });
        }, 5000);
        timer.unref();
        socket.on("close", () => {
          clearInterval(timer);
          target.destroy();
        });
        target.on("error", () => socket.destroy());
        target.on("close", () => socket.destroy());
      });
      upstream.on("response", (response) => {
        response.resume();
        socket.destroy();
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      upstream.end();
    } catch {
      socket.destroy();
    }
  }
  inUse(id: string, idleMs: number) {
    const item = this.previews.get(id);
    return Boolean(item && Date.now() - item.lastUse < idleMs);
  }
  stop(id: string) {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    const item = this.previews.get(id);
    if (!item) return;
    item.tickets.clear();
    item.sessions.clear();
    for (const socket of item.sockets) socket.destroy();
    item.server?.closeAllConnections();
    item.server?.close();
    item.transport.close();
    this.previews.delete(id);
  }
  close() {
    this.closed = true;
    clearInterval(this.maintenance);
    for (const id of this.previews.keys()) this.stop(id);
  }
}
