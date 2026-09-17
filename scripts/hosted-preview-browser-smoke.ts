import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createServer as createVite } from "vite";
import { createApp } from "../apps/server/src/app.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "../tests/auth-fixture.ts";

// Trusted synthetic fixture only: no participant project or live Sprite is executed.
const root = mkdtempSync(join(tmpdir(), "civic-spark-hosted-preview-"));
const fixture = join(root, "fixture");
const artifacts = resolve("artifacts/hosted-preview");
mkdirSync(fixture);
mkdirSync(artifacts, { recursive: true });
writeFileSync(
  join(fixture, "index.html"),
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>:root{color-scheme:light dark}body{font:18px system-ui;padding:20px}h1{font-size:24px}</style></head><body><h1>Public Vite preview</h1><p id="value"></p><script type="module" src="/main.js"></script></body></html>`,
);
writeFileSync(
  join(fixture, "main.js"),
  `import { value } from '/value.js'; document.querySelector('#value').textContent=value; if(import.meta.hot) import.meta.hot.accept('/value.js',m=>document.querySelector('#value').textContent=m.value);`,
);
writeFileSync(join(fixture, "value.js"), "export const value='Initial asset';");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "key.pem"),
    "-out",
    join(root, "cert.pem"),
    "-days",
    "1",
    "-subj",
    "/CN=portal.test",
  ],
  { stdio: "ignore" },
);
const vite = await createVite({
  root: fixture,
  configFile: false,
  server: { host: "127.0.0.1", port: 0, allowedHosts: ["preview-one.test"] },
  logLevel: "error",
});
await vite.listen();
const viteAddress = vite.httpServer?.address();
assert(viteAddress && typeof viteAddress !== "string");
let targetPort = 0;

const backendPort = (host?: string) =>
  host?.startsWith("preview-one.test:") ? viteAddress.port : targetPort;
const edge = createServer(
  { key: readFileSync(join(root, "key.pem")), cert: readFileSync(join(root, "cert.pem")) },
  (req, res) => {
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: backendPort(req.headers.host),
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  },
);
edge.on("upgrade", (req, socket, head) => {
  const upstream = connect(backendPort(req.headers.host), "127.0.0.1", () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n")}\r\n\r\n`,
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
});
edge.listen(0, "127.0.0.1");
await once(edge, "listening");
const edgeAddress = edge.address();
assert(edgeAddress && typeof edgeAddress !== "string");
const portal = `https://portal.test:${edgeAddress.port}`;
const previewOrigin = `https://preview-one.test:${edgeAddress.port}`;
const originalPreview = SpriteClient.prototype.preview;
const originalExec = SpriteClient.prototype.exec;
const originalUrl = SpriteClient.prototype.previewUrl;
SpriteClient.prototype.previewUrl = async () => ({ ok: true, value: { url: previewOrigin } });
SpriteClient.prototype.exec = async (_sprite, command) => {
  assert.deepEqual(command, ["true"], "Only the explicit owner wake is mocked");
  return { ok: true, value: Buffer.from("") };
};
let running = false;
let starts = 0;
SpriteClient.prototype.preview = async (_sprite, operation) => {
  if (["start", "restart"].includes(operation)) {
    running = true;
    starts++;
  }
  if (operation === "stop") running = false;
  return {
    ok: true,
    value: { running, ready: running, port: 5173, command: ["fixture"], logs: "Ready" },
  };
};
const { app, service, authentication } = await createApp(
  root,
  true,
  portal,
  undefined,
  "email",
  undefined,
);
await app.listen({ host: "127.0.0.1", port: 0 });
const appAddress = app.server.address();
assert(appAddress && typeof appAddress !== "string");
targetPort = appAddress.port;
const browser = await chromium.launch({
  args: ["--host-resolver-rules=MAP *.test 127.0.0.1", "--no-proxy-server"],
});
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
try {
  const owner = await testIdentity(authentication, "Preview Owner");
  const other = await testIdentity(authentication, "Preview Other");
  assert(owner.actor && other.actor);
  const event = unwrap(
    service.createEvent(owner.actor, {
      name: "Preview browser",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    service.createTeam(owner.actor, {
      eventId: event.id,
      name: "Preview team",
      projectId: "data-starter",
    }),
  );
  const id = team.workspace.id;
  service.setSprite(id, "civic-spark-fixture", "ready", null, "ready");
  for (const theme of ["light", "dark"] as const) {
    for (const viewport of [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
      { width: 844, height: 320 },
    ]) {
      running = false;
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        ignoreHTTPSErrors: true,
        hasTouch: true,
      });
      context.setDefaultTimeout(15000);
      console.log(`Checking hosted preview ${theme} ${viewport.width}x${viewport.height}`);
      await context.addCookies([{ ...owner.browserCookie, domain: "portal.test", secure: true }]);
      const errors: string[] = [];
      let connected!: () => void;
      const hmrConnected = new Promise<void>((resolve) => {
        connected = resolve;
      });
      context.on("page", (page) =>
        page.on("websocket", (socket) =>
          socket.on("framereceived", ({ payload }) => {
            if (String(payload).includes('"type":"connected"')) connected();
          }),
        ),
      );
      context.on("page", (page) => {
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
      });
      const page = await context.newPage();
      await page.route("**/api/workspaces/*/files", (route) => route.fulfill({ json: [] }));
      await page.route("**/api/workspaces/*/changes", (route) =>
        route.fulfill({ json: { base: "fixture", files: [] } }),
      );
      await page.route("**/api/workspaces/*/team-status*", (route) =>
        route.fulfill({
          json: {
            head: "a",
            remote: "a",
            incoming: false,
            dirty: false,
            merging: false,
            conflicts: [],
          },
        }),
      );
      await page.goto(`${portal}/#workspace=${id}`);
      const menu = page.getByRole("button", {
        name: "Workspace controls",
        exact: true,
        includeHidden: true,
      });
      await menu.waitFor({ state: "attached" });
      if (await menu.isVisible()) await menu.tap();
      const launch = page.getByRole("button", { name: "Launch", exact: true });
      await launch.waitFor();
      await launch.scrollIntoViewIfNeeded();
      if (viewport.width < 500) await launch.tap();
      else {
        await launch.focus();
        await page.keyboard.press("Enter");
      }
      await page
        .getByText(
          "Previews are public and can wake on visits. After Stop or Pause, use Launch again.",
        )
        .waitFor();
      await page
        .getByRole("region", { name: "Web server and publishing" })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      const open = page.getByRole("button", { name: "Open preview", exact: true });
      await open.waitFor();
      await open.scrollIntoViewIfNeeded();
      const bounds = await open.boundingBox();
      assert(
        bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
        "Open preview must remain reachable",
      );
      await page.screenshot({
        path: join(artifacts, `controls-${theme}-${viewport.width}x${viewport.height}.png`),
      });
      const popupEvent = context.waitForEvent("page");
      if (viewport.width < 500) await open.tap();
      else {
        await open.focus();
        await page.keyboard.press("Enter");
      }
      const popup = await popupEvent;
      await popup.getByRole("heading", { name: "Public Vite preview" }).waitFor();
      assert.equal(new URL(popup.url()).origin, previewOrigin);
      assert.equal(new URL(popup.url()).search, "");
      await popup
        .locator("#value")
        .getByText(/Initial asset|Updated asset/)
        .waitFor();
      await popup.waitForFunction(() =>
        performance
          .getEntriesByType("resource")
          .some((entry) => entry.name.includes("/@vite/client")),
      );
      await Promise.race([
        hmrConnected,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("HMR did not connect")), 15000).unref(),
        ),
      ]);
      const updated = `Updated asset ${theme} ${viewport.width}`;
      writeFileSync(join(fixture, "value.js"), `export const value=${JSON.stringify(updated)};`);
      await popup.getByText(updated, { exact: true }).waitFor({ timeout: 15000 });
      await popup.screenshot({
        path: join(artifacts, `preview-${theme}-${viewport.width}x${viewport.height}.png`),
      });
      const cookies = await context.cookies(previewOrigin);
      assert.equal(cookies.length, 0, "Public previews need no Civic Spark ticket/cookie");
      assert(!cookies.some((cookie) => cookie.name === owner.browserCookie.name));
      await popup.evaluate(() => localStorage.setItem("preview-only", "private"));
      assert.equal(await page.evaluate(() => localStorage.getItem("preview-only")), null);
      assert.deepEqual(errors, []);
      if (theme === "dark" && viewport.height === 320) {
        await authentication.auth.api.signOut({ headers: new Headers({ cookie: owner.cookie }) });
        const revoked = await popup.reload();
        assert.equal(revoked?.status(), 200, "Public preview survives management signout");
      }
      await context.close();
    }
  }
  assert.equal(starts, 8);
  const publicContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const publicPage = await publicContext.newPage();
  await publicPage.goto(previewOrigin);
  await publicPage.getByRole("heading", { name: "Public Vite preview" }).waitFor();
  await publicContext.close();
  const headers = { host: new URL(portal).host, origin: portal };
  const unauthorized = await app.inject({
    method: "POST",
    url: `/api/workspaces/${id}/preview`,
    headers: { ...headers, cookie: other.cookie },
    payload: { action: "open" },
  });
  assert.equal(unauthorized.statusCode, 404);
  const anonymous = await app.inject({
    method: "POST",
    url: `/api/workspaces/${id}/preview`,
    headers,
    payload: { action: "open" },
  });
  assert.equal(anonymous.statusCode, 401);
  console.log(
    "PASS: native public Launch/Open preview in both themes at 360/390/desktop/short viewports, real Vite assets and WebSocket HMR, no portal cookies, isolated storage, public access after logout, owner-only API, anonymous direct public access, clean browser consoles; no live Sprite or model calls.",
  );
} finally {
  await browser.close();
  await app.close();
  await vite.close();
  edge.closeAllConnections();
  await new Promise<void>((resolve) => edge.close(() => resolve()));
  SpriteClient.prototype.preview = originalPreview;
  SpriteClient.prototype.exec = originalExec;
  SpriteClient.prototype.previewUrl = originalUrl;
  rmSync(root, { recursive: true, force: true });
}
