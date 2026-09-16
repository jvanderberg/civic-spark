import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type WebSocketRoute, webkit } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import { verifyTerminalInput } from "./browser-terminal-input.ts";

const root = mkdtempSync(join(tmpdir(), "civic-spark-terminal-browser-"));
const browserType = process.env.TERMINAL_BROWSER === "webkit" ? webkit : chromium;
const artifacts = resolve("artifacts", `terminal-${browserType.name()}`);
mkdirSync(artifacts, { recursive: true });
const port = await new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    server.close(() => resolve(address.port));
  });
});
const address = `http://127.0.0.1:${port}`;
const { app } = await createApp(root, false, address, undefined, "prototype");
await app.listen({ host: "127.0.0.1", port });
const browser = await browserType.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  hasTouch: true,
  isMobile: true,
});
const errors: string[] = [];
const sizes: { cols: number; rows: number }[] = [];
const inputs: string[] = [];
let connections = 0;
let preparations = 0;
let failPreparation = false;
let preparationGate: Promise<void> | undefined;
let available = true;
const sockets: WebSocketRoute[] = [];
page.setDefaultTimeout(10000);
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  const expectedDenial =
    failPreparation &&
    message.location().url.endsWith("/agent/prepare") &&
    message.text().includes("403 (Forbidden)");
  if (message.type() === "error" && !expectedDenial) errors.push(message.text());
});
await page.route("**/api/state", async (route) => {
  const response = await route.fetch();
  const state = (await response.json()) as PortalState;
  for (const workspace of state.myWorkspaces)
    workspace.spriteStatus = available ? "ready" : "local";
  await route.fulfill({ response, json: state });
});
await page.route("**/preview*", (route) =>
  route.fulfill({
    json: { port: 5173, command: ["npm", "run", "dev"], running: false, ready: false },
  }),
);
await page.route("**/agent/prepare", async (route) => {
  preparations += 1;
  await preparationGate;
  return route.fulfill(
    failPreparation
      ? { status: 403, json: { error: "Terminal preparation access denied" } }
      : { json: { ready: true } },
  );
});
await page.routeWebSocket("**/api/workspaces/*/terminal", (socket) => {
  connections += 1;
  sockets.push(socket);
  socket.onMessage((data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "resize") sizes.push(message);
    if (message.type === "input") inputs.push(message.data);
  });
  socket.send(
    JSON.stringify({
      type: "output",
      data: `${Array.from({ length: 100 }, (_, n) => `Output line ${n}`).join("\r\n")}\r\nsprite:~/project$ `,
    }),
  );
});
try {
  await page.goto(address);
  await page.getByLabel("Email address").fill("terminal-layout@example.test");
  await page.getByRole("button", { name: "Enter prototype" }).click();
  await page.getByRole("button", { name: "Create your first event" }).click();
  await page.getByLabel("Event name").fill("Terminal layout test");
  await page.getByLabel("Date", { exact: true }).fill("2026-10-03");
  await page.getByLabel("Location").fill("Oak Park");
  await page.getByRole("button", { name: "Create event", exact: true }).click();
  await page.getByRole("button", { name: "Open registration" }).click();
  await page.getByRole("button", { name: "Explore projects", exact: true }).click();
  await page.getByRole("button", { name: "Create a team", exact: true }).click();
  await page.getByLabel("Team name").fill("Terminal team");
  await page.getByRole("button", { name: "Create and join team" }).click();
  await page.getByRole("button", { name: "Open my workspace" }).click();
  assert.equal(connections, 0, "Hidden terminal must not connect");
  assert.equal(preparations, 0, "Hidden terminal must not prepare tools");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Connected$/ })
    .waitFor();
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator(`html[data-theme="${scheme}"]`).waitFor();
    await page.waitForFunction(
      (background) => {
        const viewport = document.querySelector(".xterm-scrollable-element");
        return viewport && getComputedStyle(viewport).backgroundColor === background;
      },
      scheme === "dark" ? "rgb(30, 30, 30)" : "rgb(255, 255, 255)",
    );
    assert.equal(connections, 1, "Theme changes must retain the shell connection");
    await page.screenshot({
      path: join(artifacts, `terminal-theme-${scheme}.png`),
      animations: "disabled",
    });
  }
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1280, height: 480 },
    { width: 390, height: 844 },
    { width: 360, height: 780 },
    { width: 360, height: 430 },
    { width: 740, height: 360 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => {
      const host = document.querySelector(".sprite-terminal");
      const screen = host?.querySelector(".xterm-screen");
      return (
        host &&
        screen &&
        screen.getBoundingClientRect().bottom <= host.getBoundingClientRect().bottom
      );
    });
    const bounds = await page.locator(".sprite-terminal").boundingBox();
    assert(bounds && bounds.height > 60);
    assert(bounds.y + bounds.height <= viewport.height);
    assert(
      await page
        .locator(".terminal-panel")
        .evaluate((panel) => panel.scrollHeight <= panel.clientHeight),
    );
    await page.screenshot({
      path: join(artifacts, `terminal-${viewport.width}-${viewport.height}.png`),
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(inputs, [], "Opening, theming and resizing never send shell commands");
  await verifyTerminalInput(page, inputs, artifacts);
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Connected$/ })
    .waitFor();
  assert.equal(connections, 1, "Reopening a healthy terminal reuses the socket");
  await page.getByRole("button", { name: "Type in terminal", exact: true }).tap();
  const beforeReopenInput = inputs.length;
  await page.keyboard.insertText("reopened");
  await page.waitForTimeout(50);
  assert.equal(inputs.slice(beforeReopenInput).join(""), "reopened");
  assert.equal(preparations, 1);
  const status = page.locator(".terminal-panel").getByRole("status");
  const waitConnected = () => status.filter({ hasText: /^Connected$/ }).waitFor();
  const reopen = async () => {
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
  };
  await page.reload();
  await waitConnected();
  assert.equal(connections, 2, "Refresh reconnects automatically to the same workspace endpoint");
  sockets.at(-1)?.close({ code: 1011, reason: "Transient transport failure" });
  await status.filter({ hasText: "Reconnecting (1/3)" }).waitFor();
  await waitConnected();
  assert.equal(connections, 3);
  await page.getByRole("button", { name: "Type in terminal", exact: true }).tap();
  const beforeReconnectInput = inputs.length;
  await page.keyboard.insertText("resumed");
  await page.waitForTimeout(50);
  assert.equal(inputs.slice(beforeReconnectInput).join(""), "resumed");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  sockets.at(-1)?.close({ code: 1011, reason: "Hidden transport failure" });
  await page.waitForTimeout(1200);
  assert.equal(connections, 3, "A hidden terminal must defer reconnect until opened");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await waitConnected();
  assert.equal(connections, 4);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.waitForTimeout(1200);
  assert.equal(connections, 4, "Explicit disconnect must remain disconnected");
  await reopen();
  await waitConnected();
  assert.equal(connections, 5, "Reopening after explicit disconnect resumes the shell");
  sockets.at(-1)?.close({ code: 1008, reason: "Workspace access ended" });
  await status.filter({ hasText: "no longer has workspace access" }).waitFor();
  await page.waitForTimeout(1200);
  await reopen();
  await page.waitForTimeout(200);
  assert.equal(connections, 5, "Access denial must not retry, including tab reopening");
  failPreparation = true;
  await page.getByRole("button", { name: "Reconnect terminal", exact: true }).click();
  await status.filter({ hasText: "Terminal preparation access denied" }).waitFor();
  await page.waitForTimeout(1200);
  assert.equal(connections, 5, "Preparation failures must preserve the actual error");
  failPreparation = false;
  await page.getByRole("button", { name: "Reconnect terminal", exact: true }).click();
  await waitConnected();
  assert.equal(connections, 6);
  for (let retry = 1; retry <= 3; retry += 1) {
    sockets.at(-1)?.close({ code: 1011, reason: "Repeated transport failure" });
    await status.filter({ hasText: `Reconnecting (${retry}/3)` }).waitFor();
    await waitConnected();
  }
  sockets.at(-1)?.close({ code: 1011, reason: "Retry limit" });
  await status.filter({ hasText: "Could not reconnect to the terminal" }).waitFor();
  await page.waitForTimeout(1200);
  assert.equal(connections, 9, "Rapid reconnect failures stop after three attempts");
  await page.getByRole("button", { name: "Reconnect terminal", exact: true }).click();
  await waitConnected();
  assert.equal(connections, 10, "Manual retry resets the bounded retry budget");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  let releasePreparation = () => {};
  preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  await page.getByRole("button", { name: "Reconnect terminal", exact: true }).click();
  await status.filter({ hasText: "Preparing tools" }).waitFor();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  preparationGate = undefined;
  releasePreparation();
  await page.waitForTimeout(200);
  assert.equal(connections, 10, "Preparation completing after hiding must not connect");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await waitConnected();
  assert.equal(connections, 11);
  available = false;
  await page.reload();
  await status.filter({ hasText: "running Sprite" }).waitFor();
  await page.waitForTimeout(1200);
  assert.equal(connections, 11, "Unavailable terminal must not connect");
  assert(sizes.length >= 3 && sizes.every((size) => size.cols > 0 && size.rows > 0));
  assert.deepEqual(errors, []);
  console.log(
    `PASS (${browserType.name()}): terminal fits desktop, short windows and mobile; trusted touch focus, keyboard action, native text input, exact-once IME, input-only Return/Backspace, uncanceled touch gestures; output scrolls internally; auto-connect on open/refresh, healthy tab reuse, deferred hidden reconnect, manual disconnect, bounded retry, auth failure and unavailable guards. Mock transport; no Sprite/model calls. Physical phone keyboard unverified.`,
  );
} catch (error) {
  await page.screenshot({ path: join(artifacts, "terminal-failure.png") });
  throw error;
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
