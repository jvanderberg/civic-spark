import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type WebSocketRoute } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import { executionSchema, runtimeSchema } from "../packages/domain/src/lifecycle.ts";
import { readEditor, writeEditor } from "./browser-editor.ts";
import { openPortalMenu } from "./browser-portal-menu.ts";

// Real local account/file APIs, isolated data and mocked runtime transports only.
const root = mkdtempSync(join(tmpdir(), "civic-spark-connections-"));
const artifacts = resolve("artifacts/persistent-connections");
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
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const sockets = { agent: [] as WebSocketRoute[], terminal: [] as WebSocketRoute[] };
const closes = { agent: 0, terminal: 0 };
const sent: { type: string; cols?: number; rows?: number }[] = [];
let prepares = 0;
let savedKeys = false;
let credentialChecks = 0;
let wakes = 0;
let polls = 0;
let held = false;
let paused = false;
let revoked = false;
let release: (() => void) | undefined;
let preparationGate: Promise<void> | undefined;
await page.route("**/api/state", async (route) => {
  const response = await route.fetch();
  const state = (await response.json()) as PortalState;
  polls++;
  for (const workspace of state.myWorkspaces) {
    workspace.spriteStatus = "ready";
    workspace.spriteName = `civic-spark-${workspace.id}`;
    workspace.runtime = runtimeSchema.parse({ ...workspace.runtime, held });
  }
  for (const event of state.events)
    event.execution = executionSchema.parse({ ...event.execution, paused });
  if (revoked) state.myWorkspaces = [];
  await route.fulfill({ response, json: state });
});
await page.route("**/wake", (route) => {
  wakes++;
  held = false;
  return route.fulfill({ json: { ready: true } });
});
await page.route("**/preview*", (route) =>
  route.fulfill({
    json: { port: 5173, command: ["npm", "run", "dev"], running: false, ready: false },
  }),
);
await page.route("**/activity", (route) => route.fulfill({ json: {} }));
await page.route("**/agent/credentials", (route) => {
  credentialChecks++;
  return route.fulfill({ json: { savedProviders: savedKeys ? ["claude", "opencode"] : [] } });
});
await page.route("**/agent/prepare", async (route) => {
  prepares++;
  await preparationGate;
  await route.fulfill({ json: { ready: true } });
});
for (const kind of ["agent", "terminal"] as const) {
  await page.routeWebSocket(`**/api/workspaces/*/${kind}`, (socket) => {
    sockets[kind].push(socket);
    socket.onClose(() => closes[kind]++);
    socket.onMessage((data) => {
      const message = JSON.parse(data.toString());
      sent.push(message);
      if (message.type === "configure") {
        savedKeys = true;
        socket.send(
          JSON.stringify({ type: "configured", id: message.provider, text: "Connected" }),
        );
      }
    });
    if (kind === "agent") {
      socket.send(JSON.stringify({ type: "text", id: "retained", text: "Retained transcript" }));
      socket.send(
        JSON.stringify({
          type: "state",
          id: "state",
          text: "Ready",
          runtimeReady: true,
          working: false,
          configuredProviders: ["claude", "opencode"],
          savedProviders: ["claude", "opencode"],
        }),
      );
    } else socket.send(JSON.stringify({ type: "output", data: "retained-shell-buffer\r\n$ " }));
  });
}
const view = (name: string) => page.getByRole("button", { name, exact: true }).click();
const waitFor = async (predicate: () => boolean, message: string) => {
  const end = Date.now() + 10000;
  while (!predicate()) {
    assert(Date.now() < end, message);
    await page.waitForTimeout(25);
  }
};
const ready = () =>
  page
    .locator(".agent-panel")
    .getByRole("status")
    .filter({ hasText: /^Ready$/ })
    .waitFor();
const connected = () =>
  page
    .locator(".terminal-panel")
    .getByRole("status")
    .filter({ hasText: /^Connected$/ })
    .waitFor();
const counts = () => [sockets.agent.length, sockets.terminal.length];
try {
  await page.goto(address);
  await page.getByLabel("Email address").fill("connections@example.test");
  await view("Enter prototype");
  await view("Create your first event");
  await page.getByLabel("Event name").fill("Connection fixture");
  await page.getByLabel("Date", { exact: true }).fill("2026-10-03");
  await page.getByLabel("Location").fill("Test");
  await view("Create event");
  await view("Open registration");
  await openPortalMenu(page);
  await view("Explore projects");
  await view("Create a team");
  await page.getByLabel("Team name").fill("Connection team");
  await view("Create and join team");
  await view("Open my workspace");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.locator(".monaco-editor").waitFor();
  await writeEditor(page, "Unsaved editor draft");
  assert.equal(wakes, 1);
  assert.equal(prepares, 0, "First activation stays lazy");
  assert.deepEqual(counts(), [0, 0]);
  await view("Agent");
  await page.getByLabel("Agent API key").waitFor();
  assert.equal(prepares, 0, "A fresh workspace must not prepare an agent without a key");
  assert.deepEqual(counts(), [0, 0]);
  assert.equal(await page.getByRole("button", { name: "Connect", exact: true }).isDisabled(), true);
  await page.screenshot({ path: join(artifacts, "new-workspace-no-key.png") });
  await view("Files");
  await view("Agent");
  await page.waitForTimeout(100);
  assert.equal(credentialChecks, 1, "Navigation cannot repeatedly probe missing keys");
  await page.getByLabel("Agent API key").fill("fake-local-key");
  await view("Connect");
  await ready();
  await waitFor(() => savedKeys, "Explicit key configuration");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, "configure");
  sent.length = 0;
  assert.deepEqual(counts(), [1, 0]);
  const composer = page.getByLabel("Message to agent");
  await composer.fill("Keep text and image draft");
  await page.getByLabel("Agent model").selectOption("claude");
  await page.getByLabel("Choose images").setInputFiles({
    name: "Draft.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.getByRole("button", { name: "Remove Draft.png" }).waitFor();
  await view("Terminal");
  await connected();
  await page.evaluate(() => {
    (window as unknown as { retainedNodes: Element[] }).retainedNodes = [
      document.querySelector(".agent-panel"),
      document.querySelector(".xterm"),
    ] as Element[];
  });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [360, 780],
      [390, 844],
      [1440, 1000],
      [390, 300],
    ] as const) {
      await view("Files");
      assert.equal(await readEditor(page), "Unsaved editor draft");
      const beforeResize = sent.filter((message) => message.type === "resize").length;
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(100);
      assert.equal(
        sent.filter((message) => message.type === "resize").length,
        beforeResize,
        "Hidden terminal must not send zero-sized resizes",
      );
      for (const tab of ["Changes", "Agent", "Files", "Terminal"]) await view(tab);
      await connected();
      await page.waitForTimeout(100);
      assert(sent.filter((message) => message.type === "resize").length > beforeResize);
      await page.screenshot({ path: join(artifacts, `terminal-${width}-${height}-${theme}.png`) });
      await view("Agent");
      await ready();
      if (await page.getByRole("button", { name: "Workspace controls" }).isVisible()) {
        await view("Workspace controls");
        await page.keyboard.press("Escape");
      }
      await view("Agent connection settings");
      await view("Agent connection settings");
      await composer.focus();
      assert.equal(await composer.inputValue(), "Keep text and image draft");
      assert.equal(await page.getByLabel("Agent model").inputValue(), "claude");
      assert.equal(await page.getByLabel("Agent API key").count(), 0);
      await page.getByRole("button", { name: "Remove Draft.png" }).waitFor();
      await page.getByText("Retained transcript", { exact: true }).waitFor();
      const box = await composer.boundingBox();
      assert(box && box.y >= 0 && box.y + box.height <= height);
      await page.screenshot({ path: join(artifacts, `agent-${width}-${height}-${theme}.png`) });
      assert.deepEqual(counts(), [1, 1], "Tabs, menus, themes and renders retain both sockets");
      assert.deepEqual(closes, { agent: 0, terminal: 0 });
      assert(
        await page.evaluate(() => {
          const nodes = (window as unknown as { retainedNodes: Element[] }).retainedNodes;
          return (
            nodes[0] === document.querySelector(".agent-panel") &&
            nodes[1] === document.querySelector(".xterm")
          );
        }),
      );
    }
  }
  const beforePolls = polls;
  await waitFor(() => polls >= beforePolls + 2, "Parent readiness polling did not run");
  assert.equal(wakes, 1, "Readiness polling must not repeat wake or toggle availability");
  assert.equal(prepares, 2);
  assert.deepEqual(counts(), [1, 1]);
  // A real transport failure retries while hidden. Switching and online events
  // during backoff cannot create another attempt or reset the retry budget.
  await view("Files");
  sockets.agent.at(-1)?.close({ code: 1011, reason: "Mock transport failure" });
  sockets.terminal.at(-1)?.close({ code: 1011, reason: "Mock transport failure" });
  await view("Agent");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await view("Files");
  await page.waitForTimeout(250);
  assert.deepEqual(counts(), [1, 1], "Navigation must not skip reconnect backoff");
  await waitFor(
    () => sockets.agent.length === 2 && sockets.terminal.length === 2,
    "Hidden reconnect",
  );
  await page.waitForTimeout(1200);
  assert.deepEqual(counts(), [2, 2]);
  await view("Agent");
  await ready();
  assert.equal(await composer.inputValue(), "Keep text and image draft");
  await page.getByRole("button", { name: "Remove Draft.png" }).waitFor();
  assert.deepEqual(
    sent.filter((message) => message.type !== "resize"),
    [],
    "No automatic prompt, stop or shell input",
  );
  // Intentional holds close both connections without navigation reviving them.
  held = true;
  await page.getByRole("dialog", { name: "Sprite paused" }).waitFor();
  await waitFor(() => closes.agent >= 1 && closes.terminal >= 1, "Hold cleanup");
  await page.waitForTimeout(1500);
  assert.deepEqual(counts(), [2, 2]);
  assert.equal(wakes, 1);
  // A held view cannot turn delayed preparation into a socket or prompt.
  preparationGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Resume/ })
    .click();
  await waitFor(() => prepares === 6, "Both activated views resume after explicit wake");
  paused = true;
  await page.getByRole("dialog", { name: "Hackathon paused" }).waitFor();
  release?.();
  preparationGate = undefined;
  await page.waitForTimeout(500);
  assert.deepEqual(counts(), [2, 2], "No late sockets after lifecycle gate");
  paused = false;
  await waitFor(
    () => sockets.agent.length === 3 && sockets.terminal.length === 3,
    "Explicit unpause",
  );
  revoked = true;
  await page.locator(".workspace-screen").waitFor({ state: "detached" });
  await page.waitForTimeout(1500);
  assert.deepEqual(counts(), [3, 3], "Revoked workspace must not reconnect");
  assert.deepEqual(
    sent.filter((message) => message.type !== "resize"),
    [],
  );
  revoked = false;
  await page.reload();
  await openPortalMenu(page);
  await page.getByRole("button", { name: /My teams/ }).click();
  await view("Open my workspace");
  await ready();
  await view("Terminal");
  await connected();
  const beforeSignout = counts();
  const signedOut = await page.request.post(`${address}/api/auth/sign-out`, {
    headers: { origin: address },
    data: {},
  });
  assert(signedOut.ok());
  await page.getByLabel("Email address").waitFor();
  await page.waitForTimeout(1200);
  assert.deepEqual(counts(), beforeSignout, "Signout closes active views without reconnecting");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: lazy activation, stable agent/terminal sockets across all tabs/menus and parent polling, both themes/phone/desktop/short, image/text/model/transcript retention, hidden resize, bounded transport retry, hold/unpause/revocation cleanup and no late sends. Isolated mocks only.",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
