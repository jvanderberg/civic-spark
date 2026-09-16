import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  request,
  type Server,
} from "node:http";
import type { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { WorkspacePreviews } from "../apps/server/src/preview.ts";
import { validatePreviewOriginTemplate } from "../apps/server/src/preview-config.ts";
import { createPreviewIngress, ingressSettings } from "../apps/server/src/preview-ingress.ts";
import { PreviewOriginPool } from "../apps/server/src/preview-origins.ts";

// Node fetch normalizes Host; use the raw HTTP client to exercise virtual-host routing.
async function fetch(
  url: string,
  options: { headers?: Record<string, string>; redirect?: string } = {},
) {
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { headers: options.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers))
          if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const third = "33333333-3333-4333-8333-333333333333";
const portal = "https://portal.example.test";
const origins = ["https://preview-one.example.test", "https://preview-two.example.test"];
const secret = "dedicated-test-relay-credential-".repeat(3);
function temporary() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-preview-test-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen");
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return address.port;
}

it("assigns future workspaces automatically, persists bindings and never recycles removed origins", () => {
  const root = temporary();
  const pool = new PreviewOriginPool(origins, root, portal);
  expect(pool.assign(id)).toBe(origins[0]);
  const restarted = new PreviewOriginPool(origins, root, portal);
  expect(restarted.assign(id)).toBe(origins[0]);
  expect(restarted.assign(other)).toBe(origins[1]);
  expect(() => restarted.assign(third)).toThrow("capacity");
  const reduced = new PreviewOriginPool([origins[1] as string], root, portal);
  expect(() => reduced.assign(id)).toThrow("unavailable");
  expect(() => reduced.assign(third)).toThrow("capacity");
  const expanded = new PreviewOriginPool(
    [...origins, "https://preview-three.example.test"],
    root,
    portal,
  );
  expect(expanded.assign(third)).toBe("https://preview-three.example.test");
  expect(JSON.parse(readFileSync(join(root, "preview-origins.json"), "utf8"))).toEqual({
    [id]: origins[0],
    [other]: origins[1],
    [third]: "https://preview-three.example.test",
  });
});
it("recovers the same origin after gateway restart without reviving cookies or calling a provider for denied opens", async () => {
  const root = temporary();
  const upstream = createServer((_req, res) => res.end("ok"));
  const port = await listen(upstream);
  let connections = 0;
  const transport = async () => {
    connections++;
    return { port, close() {} };
  };
  const routing = { root, pool: origins, relaySecret: secret };
  const first = new WorkspacePreviews(portal, transport, undefined, routing);
  cleanup.push(() => first.close());
  await expect(first.open(id, "civic-spark-test", 5173, async () => false)).rejects.toThrow(
    "access",
  );
  expect(connections).toBe(0);
  const opened = await first.open(id, "civic-spark-test", 5173, async () => true);
  first.close();
  const restarted = new WorkspacePreviews(portal, transport, undefined, routing);
  cleanup.push(() => restarted.close());
  const reopened = await restarted.open(id, "civic-spark-test", 5173, async () => true);
  expect(new URL(reopened.url).origin).toBe(new URL(opened.url).origin);
  expect(reopened.url).not.toBe(opened.url);
  const server = createServer((_req, res) => res.end("management"));
  restarted.attach(server);
  const gatewayPort = await listen(server);
  const stale = await fetch(
    `http://127.0.0.1:${gatewayPort}${new URL(opened.url).pathname}${new URL(opened.url).search}`,
    { headers: { host: new URL(opened.url).host }, redirect: "manual" },
  );
  expect(stale.status).toBe(401);
  expect(connections).toBe(2);
});

it("rejects unsafe origins and malformed ingress settings", () => {
  const root = temporary();
  for (const value of [
    "http://{workspace}.preview.test",
    "https://{workspace}.portal.example.test",
    "https://x{workspace}.preview.test",
    "https://{workspace}.preview.test/path",
  ])
    expect(() => validatePreviewOriginTemplate(value, portal)).toThrow();
  for (const value of [
    [portal],
    ["http://preview.test"],
    ["https://child.portal.example.test"],
    [origins[0], origins[0]],
  ])
    expect(() => new PreviewOriginPool(value as string[], root, portal)).toThrow();
  expect(() =>
    ingressSettings({
      CIVIC_SPARK_PREVIEW_INGRESS_ORIGIN: origins[0],
      CIVIC_SPARK_PREVIEW_INGRESS_TARGET: portal,
      CIVIC_SPARK_PREVIEW_RELAY_SECRET: "short",
    }),
  ).toThrow("credential");
});
it("separates management HTTP/WS hosts, authenticates relay, proxies assets/HMR and revokes old sessions", async () => {
  const root = temporary();
  let observed: IncomingHttpHeaders = {};
  const upstream = createServer((req, res) => {
    observed = req.headers;
    res.setHeader("Set-Cookie", "application=untrusted");
    res.setHeader("fly-replay", "app=management");
    res.setHeader("x-civic-spark-preview-auth", "untrusted");
    res.setHeader("Connection", "x-private-hop");
    res.setHeader("x-private-hop", "remove-me");
    if (req.url === "/redirect") res.writeHead(302, { Location: "http://127.0.0.1:5173/asset.js" });
    res.end(req.url === "/asset.js" ? "export const privateAsset = true" : "participant app");
  });
  const upstreamPort = await listen(upstream);
  const ws = new WebSocketServer({ server: upstream });
  ws.on("headers", (headers) => {
    headers.push("fly-replay: app=management", "x-civic-spark-preview-auth: untrusted");
  });
  ws.on("connection", (socket, req) => {
    observed = req.headers;
    socket.on("message", (data) => socket.send(data));
  });
  cleanup.push(() => {
    for (const client of ws.clients) client.terminate();
    ws.close();
  });
  let managementRequests = 0;
  let managementUpgrades = 0;
  const management = createServer((_req, res) => {
    managementRequests++;
    res.end("management");
  });
  management.on("upgrade", (_req, socket) => {
    managementUpgrades++;
    socket.destroy();
  });
  const gateway = new WorkspacePreviews(
    portal,
    async () => ({ port: upstreamPort, close() {} }),
    undefined,
    { root, pool: origins, relaySecret: secret },
  );
  cleanup.push(() => gateway.close());
  gateway.attach(management);
  const managementPort = await listen(management);
  const relayRequest = (options: RequestOptions, callback?: (response: IncomingMessage) => void) =>
    request({ ...options, hostname: "127.0.0.1", port: managementPort }, callback);
  const ingress = createPreviewIngress(
    { origin: origins[0] as string, target: portal, secret },
    relayRequest as typeof httpsRequest,
  );
  const ingressPort = await listen(ingress);
  const edge = `http://127.0.0.1:${ingressPort}`;
  const direct = `http://127.0.0.1:${managementPort}`;
  const host = new URL(origins[0] as string).host;
  const portalHost = new URL(portal).host;
  let oldAllowed = true;
  const opened = await gateway.open(id, "civic-spark-fixture", 5173, async () => oldAllowed);
  const path = new URL(opened.url).pathname + new URL(opened.url).search;
  expect((await fetch(`${edge}/__civic_spark_ingress_health`, { headers: { host } })).status).toBe(
    200,
  );
  expect((await fetch(edge, { headers: { host } })).status).toBe(401);
  expect(
    (await fetch(`${direct}/api/auth/session`, { headers: { host: "unknown.example.test" } }))
      .status,
  ).toBe(403);
  expect((await fetch(`${direct}/api/auth/session`, { headers: { host } })).status).toBe(401);
  expect(
    (
      await fetch(direct, {
        headers: {
          host: portalHost,
          "x-civic-spark-preview-origin": origins[0] as string,
          "x-civic-spark-preview-auth": "wrong",
        },
      })
    ).status,
  ).toBe(403);
  expect(managementRequests).toBe(0);
  const responses = await Promise.all(
    [1, 2].map(() => fetch(`${edge}${path}`, { headers: { host }, redirect: "manual" })),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([303, 401]);
  const response = responses.find((value) => value.status === 303);
  const cookie = response?.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).toMatch(/^__Host-civic-spark-preview=/);
  expect(response?.headers.get("set-cookie")).toContain("; Secure");
  expect(response?.headers.get("set-cookie")).not.toContain("Domain=");
  const asset = await fetch(`${edge}/asset.js`, {
    headers: {
      host,
      cookie: `${cookie}; portal=secret`,
      authorization: "Bearer secret",
      "x-forwarded-host": "evil",
      "x-civic-spark-preview-origin": origins[1] as string,
    },
  });
  expect(await asset.text()).toContain("privateAsset");
  expect(asset.headers.get("set-cookie")).toBeNull();
  const gatewayAsset = await fetch(`${direct}/asset.js`, { headers: { host, cookie } });
  expect(gatewayAsset.headers.get("fly-replay")).toBeNull();
  expect(gatewayAsset.headers.get("x-civic-spark-preview-auth")).toBeNull();
  expect(gatewayAsset.headers.get("x-private-hop")).toBeNull();
  expect(observed.cookie).toBeUndefined();
  expect(observed.authorization).toBeUndefined();
  expect(observed["x-forwarded-host"]).toBeUndefined();
  expect(observed["x-civic-spark-preview-auth"]).toBeUndefined();
  expect(observed.host).toBe("127.0.0.1:5173");
  expect(
    (
      await fetch(`${edge}/redirect`, { headers: { host, cookie }, redirect: "manual" })
    ).headers.get("location"),
  ).toBe(`${origins[0]}/asset.js`);
  expect((await fetch(`${edge}/api/auth/session`, { headers: { host, cookie } })).status).toBe(200);
  expect(managementRequests).toBe(0);
  const socket = new WebSocket(edge.replace("http:", "ws:"), {
    headers: {
      host,
      cookie,
      Origin: origins[0] as string,
      "x-forwarded-for": "secret",
      Authorization: "Bearer secret",
    },
  });
  cleanup.push(() => socket.terminate());
  socket.on("upgrade", (response) => {
    expect(response.headers["fly-replay"]).toBeUndefined();
    expect(response.headers["x-civic-spark-preview-auth"]).toBeUndefined();
  });
  await once(socket, "open");
  socket.send("actual-hmr-frame");
  expect((await once(socket, "message"))[0].toString()).toBe("actual-hmr-frame");
  expect(observed.origin).toBe("http://127.0.0.1:5173");
  expect(observed["x-forwarded-for"]).toBeUndefined();
  expect(observed.authorization).toBeUndefined();
  expect(managementUpgrades).toBe(0);
  const renewed = await gateway.open(id, "civic-spark-fixture", 5173, async () => true);
  expect(renewed.url).not.toBe(opened.url);
  const newAuth = await fetch(
    `${edge}${new URL(renewed.url).pathname}${new URL(renewed.url).search}`,
    { headers: { host }, redirect: "manual" },
  );
  const newCookie = newAuth.headers.get("set-cookie")?.split(";")[0] ?? "";
  const closed = once(socket, "close");
  oldAllowed = false;
  expect((await fetch(edge, { headers: { host, cookie } })).status).toBe(401);
  expect((await fetch(edge, { headers: { host, cookie: newCookie } })).status).toBe(200);
  await closed;
  const otherOpened = await gateway.open(other, "civic-spark-second", 5173, async () => true);
  expect(new URL(otherOpened.url).origin).toBe(origins[1]);
  expect(
    (
      await fetch(direct, {
        headers: { host: new URL(origins[1] as string).host, cookie: newCookie },
      })
    ).status,
  ).toBe(401);
  const expires = await gateway.open(id, "civic-spark-fixture", 5173, async () => true);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 61000);
  expect(
    (
      await fetch(`${edge}${new URL(expires.url).pathname}${new URL(expires.url).search}`, {
        headers: { host },
        redirect: "manual",
      })
    ).status,
  ).toBe(401);
  expect((await fetch(direct, { headers: { host: portalHost } })).status).toBe(200);
  expect(managementRequests).toBe(1);
}, 15000);
