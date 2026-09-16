import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { createServer as portServer } from "node:net";
import { setTimeout } from "node:timers/promises";

export type PreviewTransport = { port: number; close(): void };
export async function spritePreviewTransport(
  sprite: string,
  port: number,
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
  const child = spawn(
    "sprite",
    [
      ...(process.env.VIBEHACK_SPRITE_ORG ? ["-o", process.env.VIBEHACK_SPRITE_ORG] : []),
      "-s",
      sprite,
      "proxy",
      `${local}:${port}`,
    ],
    { stdio: "ignore" },
  );
  let failed = false;
  child.on("error", () => {
    failed = true;
  });
  child.on("exit", () => {
    failed = true;
  });
  await setTimeout(700);
  if (failed) throw new Error("Could not start the Sprite preview tunnel");
  return { port: local, close: () => child.kill() };
}

type Preview = {
  port: number;
  token: string;
  url: string;
  server: Server;
  transport: PreviewTransport;
  expires: number;
  authorized: () => Promise<boolean>;
};
/** A separate loopback hostname prevents sharing portal cookies or app origins. */
export class WorkspacePreviews {
  private previews = new Map<string, Preview>();
  constructor(
    private portal: string,
    private transport = spritePreviewTransport,
  ) {}
  async open(id: string, sprite: string, port: number, authorized: () => Promise<boolean>) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid preview port");
    if (!(await authorized())) throw new Error("Workspace access ended");
    const existing = this.previews.get(id);
    if (existing && existing.port === port) {
      existing.expires = Date.now() + 60 * 60 * 1000;
      existing.authorized = authorized;
      return { url: `${existing.url}/__vibehack_open?token=${existing.token}`, port };
    }
    this.stop(id);
    const transport = await this.transport(sprite, port);
    const token = randomBytes(32).toString("base64url");
    const cookie = `vh_preview_${randomBytes(8).toString("hex")}`;
    let current: Preview;
    const valid = async (headers: { cookie?: string; host?: string }) =>
      Boolean(
        current &&
          headers.host === new URL(current.url).host &&
          current.expires > Date.now() &&
          headers.cookie?.split(";").some((part) => part.trim() === `${cookie}=${token}`) &&
          (await current.authorized()),
      );
    const hostname = new URL(this.portal).hostname === "localhost" ? "127.0.0.1" : "localhost";
    const server = createServer(async (req, res) => {
      try {
        if (!current || req.headers.host !== new URL(current.url).host) {
          res.writeHead(403).end();
          return;
        }
        const parsed = new URL(req.url ?? "/", current.url);
        if (
          parsed.pathname === "/__vibehack_open" &&
          req.method === "GET" &&
          parsed.searchParams.get("token") === token &&
          current.expires > Date.now() &&
          (await current.authorized())
        ) {
          res
            .writeHead(303, {
              Location: "/",
              "Set-Cookie": `${cookie}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
            })
            .end();
          return;
        }
        if (!(await valid(req.headers))) {
          res
            .writeHead(401, { "Content-Type": "text/plain" })
            .end("Reopen Preview from your VibeHack workspace.");
          return;
        }
        if (
          (req.headers.origin && req.headers.origin !== current.url) ||
          (req.headers["sec-fetch-site"] === "cross-site" &&
            !(
              req.method === "GET" &&
              req.headers["sec-fetch-mode"] === "navigate" &&
              req.headers["sec-fetch-dest"] === "document"
            ))
        ) {
          res.writeHead(403).end("Cross-origin preview requests are disabled");
          return;
        }
        const headers: IncomingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}` };
        delete headers.cookie;
        delete headers.authorization;
        delete headers["x-forwarded-host"];
        delete headers["x-forwarded-for"];
        // Apps cannot receive control-plane credentials or set cookies on portal's host.
        const upstream = httpRequest(
          {
            host: "127.0.0.1",
            port: transport.port,
            path: req.url,
            method: req.method,
            headers,
            timeout: 30000,
          },
          (response) => {
            const outgoing = { ...response.headers };
            delete outgoing["set-cookie"];
            outgoing["content-security-policy"] = `frame-ancestors ${this.portal};`;
            outgoing["referrer-policy"] = "no-referrer";
            outgoing["cache-control"] = "no-store";
            res.writeHead(response.statusCode ?? 502, outgoing);
            response.pipe(res);
          },
        );
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
          res.end("The web server is not responding. Check Preview logs in the workspace.");
        });
        req.pipe(upstream);
      } catch {
        res.writeHead(403).end("Workspace access ended");
      }
    });
    server.on("upgrade", async (req, socket, head) => {
      try {
        if (
          !(await valid(req.headers)) ||
          (req.headers.origin && req.headers.origin !== current.url)
        ) {
          socket.destroy();
          return;
        }
        const headers: IncomingHttpHeaders = { ...req.headers, host: `127.0.0.1:${port}` };
        delete headers.cookie;
        delete headers.authorization;
        const upstream = httpRequest({
          host: "127.0.0.1",
          port: transport.port,
          path: req.url,
          headers,
        });
        upstream.on("upgrade", (response, target, extra) => {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
              .filter(([key]) => !["set-cookie", "authorization"].includes(key))
              .map(([key, value]) => `${key}: ${value}`)
              .join("\r\n")}\r\n\r\n`,
          );
          if (head.length) target.write(head);
          if (extra.length) socket.write(extra);
          socket.pipe(target).pipe(socket);
          const timer = globalThis.setInterval(() => {
            void valid(req.headers)
              .then((ok) => {
                if (!ok) {
                  target.destroy();
                  socket.destroy();
                }
              })
              .catch(() => socket.destroy());
          }, 5000);
          socket.on("close", () => {
            clearInterval(timer);
            target.destroy();
          });
          target.on("error", () => socket.destroy());
        });
        upstream.on("error", () => socket.destroy());
        upstream.end();
      } catch {
        socket.destroy();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, hostname, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      transport.close();
      throw new Error("Cannot start private preview");
    }
    current = {
      port,
      token,
      url: `http://${hostname}:${address.port}`,
      server,
      transport,
      expires: Date.now() + 3600000,
      authorized,
    };
    this.previews.set(id, current);
    return { url: `${current.url}/__vibehack_open?token=${token}`, port };
  }
  stop(id: string) {
    const item = this.previews.get(id);
    if (item) {
      item.server.closeAllConnections();
      item.server.close();
      item.transport.close();
      this.previews.delete(id);
    }
  }
  close() {
    for (const id of this.previews.keys()) this.stop(id);
  }
}
