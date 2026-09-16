import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { WorkspacePreviews } from "../apps/server/src/preview.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it("isolates preview origin, requires its capability, strips credentials, proxies assets/WebSockets and rechecks owner access", async () => {
  let observed: Record<string, string | string[] | undefined> = {};
  const upstream = createServer((req, res) => {
    observed = req.headers;
    res.setHeader("Set-Cookie", "project-cookie=untrusted");
    res.end(req.url === "/asset.js" ? "console.log('preview')" : "Private project");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("listen");
  const ws = new WebSocketServer({ server: upstream });
  ws.on("connection", (socket) => socket.on("message", (text) => socket.send(text)));
  cleanup.push(() => {
    for (const client of ws.clients) client.terminate();
    ws.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  let allowed = true;
  const previews = new WorkspacePreviews("http://127.0.0.1:4310", async () => ({
    port: address.port,
    close() {},
  }));
  cleanup.push(() => previews.close());
  const opened = await previews.open("alice", "vibehack-test", 5173, async () => allowed);
  const origin = new URL(opened.url).origin;
  expect(new URL(origin).hostname).toBe("localhost");
  expect((await fetch(origin)).status).toBe(401);
  expect(
    (await fetch(opened.url.replace(/token=.*/, "token=wrong"), { redirect: "manual" })).status,
  ).toBe(401);
  const auth = await fetch(opened.url, { redirect: "manual" });
  expect(auth.status).toBe(303);
  const cookie = auth.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeTruthy();
  const response = await fetch(`${origin}/asset.js`, {
    headers: { cookie: `${cookie}; portal-session=secret`, authorization: "Bearer secret" },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("console.log");
  expect(observed.cookie).toBeUndefined();
  expect(observed.authorization).toBeUndefined();
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(
    (
      await fetch(origin, {
        method: "POST",
        headers: { cookie: cookie ?? "", origin: "http://localhost:9999" },
      })
    ).status,
  ).toBe(403);
  const socket = new WebSocket(origin.replace("http:", "ws:"), {
    headers: { cookie: cookie ?? "", Origin: origin },
  });
  cleanup.push(() => socket.terminate());
  await once(socket, "open");
  socket.send("hmr-check");
  const [message] = await once(socket, "message");
  expect(message.toString()).toBe("hmr-check");
  allowed = false;
  expect((await fetch(origin, { headers: { cookie: cookie ?? "" } })).status).toBe(401);
  expect((await fetch(opened.url, { redirect: "manual" })).status).toBe(401);
});
it("one workspace preview capability cannot open another workspace preview", async () => {
  const upstream = createServer((_req, res) => res.end("ok"));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("listen");
  cleanup.push(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const previews = new WorkspacePreviews("http://127.0.0.1:4310", async () => ({
    port: address.port,
    close() {},
  }));
  cleanup.push(() => previews.close());
  const a = await previews.open("alice", "vibehack-a", 5173, async () => true);
  const b = await previews.open("bob", "vibehack-b", 5173, async () => true);
  const auth = await fetch(a.url, { redirect: "manual" });
  const cookie = auth.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect((await fetch(new URL(b.url).origin, { headers: { cookie } })).status).toBe(401);
  await expect(previews.open("denied", "vibehack-a", 5173, async () => false)).rejects.toThrow(
    "access ended",
  );
});
