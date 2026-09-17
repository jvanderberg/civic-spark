import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspacePreviews } from "../apps/server/src/preview.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { testIdentity } from "../tests/auth-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "civic-spark-environment-browser-"));
const artifacts = resolve("artifacts");
mkdirSync(artifacts, { recursive: true });
const port = await new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    assert(a && typeof a !== "string");
    server.close(() => resolve(a.port));
  });
});
const address = `http://127.0.0.1:${port}`;
const { app, service, authentication } = await createApp(root, false, address, undefined, "email");
await app.listen({ host: "127.0.0.1", port });
const upstream = httpServer((_req, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><h1>Private browser preview</h1>");
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const upstreamAddress = upstream.address();
assert(upstreamAddress && typeof upstreamAddress !== "string");
const previews = new WorkspacePreviews(address, async () => ({
  port: upstreamAddress.port,
  close() {},
}));
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  hasTouch: true,
});
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
try {
  const identity = await testIdentity(authentication, "Environment Browser");
  assert(identity.actor);
  const event = unwrap(
    service.createEvent(identity.actor, {
      name: "Environment test",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 4,
      budget: 0,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    service.createTeam(identity.actor, {
      eventId: event.id,
      name: "Environment team",
      projectId: "data-starter",
    }),
  );
  const id = team.workspace.id;
  const opened = await previews.open(id, "civic-spark-test", 5173, async () => true);
  let running = false;
  let phase = "stopped";
  let failNext = false;
  let generation = 0;
  let conflict = false;
  let approved = false;
  const actions: string[] = [];
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const state = (await response.json()) as PortalState;
    for (const workspace of state.myWorkspaces) workspace.spriteStatus = "ready";
    await route.fulfill({ response, json: state });
  });
  await page.route("**/preview*", async (route) => {
    if (!route.request().url().includes("/api/")) {
      await route.continue();
      return;
    }
    const action =
      route.request().method() === "POST" ? route.request().postDataJSON().action : "status";
    actions.push(action);
    if (action === "open") {
      await route.fulfill({ json: opened });
      return;
    }
    if (action === "start" || action === "restart") {
      running = true;
      phase = "installing";
      const current = ++generation;
      await new Promise((resolve) => setTimeout(resolve, 1400));
      if (current === generation) phase = "starting";
      await new Promise((resolve) => setTimeout(resolve, 1400));
      if (current === generation) phase = failNext ? "error" : "ready";
      if (failNext) {
        running = false;
        failNext = false;
      }
    }
    if (action === "stop") {
      generation++;
      running = false;
      phase = "stopped";
    }
    await route.fulfill({
      json: {
        running,
        ready: phase === "ready",
        phase,
        ...(phase === "error"
          ? { error: "Dependency installation failed. Check registry access, then retry Launch." }
          : {}),
        port: 5173,
        command: [
          "npm",
          "run",
          "dev",
          "--",
          "--host",
          "127.0.0.1",
          "--port",
          "5173",
          "--strictPort",
        ],
        logs:
          phase === "installing"
            ? "Installing project dependencies (npm ci)."
            : phase === "ready"
              ? "VITE ready\nLocal server verified"
              : "Starting server",
      },
    });
  });
  await page.route("**/agent-git", (route) =>
    route.fulfill({
      json: {
        pending: conflict
          ? {
              id: "a1d3f500-8923-4256-a994-0694af2e3f5f",
              head: "a".repeat(40),
              remote: "b".repeat(40),
              status: "confirmation",
              conflicts: ["src/chart.tsx"],
            }
          : null,
      },
    }),
  );
  await page.route("**/agent-git/confirm", async (route) => {
    approved = route.request().postDataJSON().allow;
    conflict = false;
    await route.fulfill({ json: { status: "resolving" } });
  });
  await page.route("**/agent/credentials", (route) =>
    route.fulfill({ json: { savedProviders: ["claude", "opencode"] } }),
  );
  await page.route("**/agent/prepare", (route) => route.fulfill({ json: { ready: true } }));
  await page.routeWebSocket("**/api/workspaces/*/agent", (socket) => {
    socket.send(
      JSON.stringify({
        type: "state",
        id: "runtime-state",
        text: "Ready",
        runtimeReady: true,
        working: false,
        configuredProviders: ["opencode"],
      }),
    );
    socket.onMessage((message) => {
      const input = JSON.parse(message.toString());
      if (input.type === "prompt") {
        assert(approved);
        assert.match(input.text, /explicitly approve/);
      }
    });
  });
  await context.addCookies([identity.browserCookie]);
  await page.goto(`${address}/#workspace=${id}`);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [360, 780],
      [390, 844],
      [1280, 800],
      [844, 360],
    ]) {
      assert(width && height);
      await page.setViewportSize({ width, height });
      const menu = page.getByRole("button", { name: "Workspace controls", exact: true });
      if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) !== "true")
        await menu.click();
      const launch = page.getByRole("button", { name: "Launch", exact: true });
      if (width < 500) await launch.tap();
      else {
        await launch.focus();
        await page.keyboard.press("Enter");
      }
      await page.getByRole("button", { name: "Installing…", exact: true }).waitFor();
      const region = page.getByRole("region", { name: "Web server and publishing" });
      const bounds = await region.boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
      await page.screenshot({
        path: join(artifacts, `environment-installing-${width}-${theme}.png`),
      });
      await page.getByRole("button", { name: "Starting…", exact: true }).waitFor();
      await page.getByRole("button", { name: "Open preview", exact: true }).waitFor();
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await stop.scrollIntoViewIfNeeded();
      const stopBounds = await stop.boundingBox();
      assert(stopBounds && stopBounds.y >= 0 && stopBounds.y + stopBounds.height <= height);
      await page.screenshot({ path: join(artifacts, `environment-ready-${width}-${theme}.png`) });
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await page.getByRole("button", { name: "Launch", exact: true }).waitFor();
    }
  }
  failNext = true;
  await page.getByRole("button", { name: "Launch", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Dependency installation failed" }).waitFor();
  await page.getByRole("button", { name: "Launch", exact: true }).click();
  await page.getByRole("button", { name: "Installing…", exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Launch", exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Launch", exact: true }).click();
  await page.getByRole("button", { name: "Restart", exact: true }).waitFor();
  assert(actions.includes("start"));
  const popupEvent = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open preview", exact: true }).click();
  const popup = await popupEvent;
  await popup
    .getByRole("heading", { name: "Private browser preview" })
    .waitFor({ timeout: 5000 })
    .catch(async (error) => {
      console.log("Preview popup diagnostics", await popup.locator("body").innerText());
      throw error;
    });
  assert.equal(new URL(popup.url()).hostname, "localhost");
  assert.equal(new URL(popup.url()).search, "");
  await popup.close();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  assert(actions.includes("restart"));
  if (!(await page.getByRole("region", { name: "Web server and publishing" }).isVisible()))
    await page.getByRole("button", { name: "Web server details" }).click();
  await page.getByRole("button", { name: "Refresh logs", exact: true }).click();
  await page.getByText("VITE ready", { exact: false }).waitFor();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({ path: join(artifacts, `environment-${theme}.png`) });
  }
  await page.getByRole("button", { name: "Open preview", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole("button", { name: "Workspace controls", exact: true });
  if ((await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
  const panel = await page.getByRole("region", { name: "Web server and publishing" }).boundingBox();
  assert(panel && panel.x >= 0 && panel.x + panel.width <= 390);
  await page.screenshot({ path: join(artifacts, "environment-mobile.png") });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Launch", exact: true }).waitFor();
  conflict = true;
  await page.reload();
  await page.getByRole("button", { name: "Workspace controls", exact: true }).click();
  await page.getByRole("button", { name: "Confirm conflict resolution", exact: true }).click();
  assert.equal(approved, false);
  await page.getByRole("button", { name: "Resolve with agent", exact: true }).click();
  assert.equal(approved, true);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Launch/Restart/Stop, real isolated popup authentication, light/dark/mobile controls, explicit conflict confirmation and agent handoff; no model calls.",
  );
} finally {
  await browser.close();
  previews.close();
  upstream.closeAllConnections();
  upstream.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
