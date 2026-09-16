import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Locator, webkit } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { AgentEvent, AgentInput } from "../packages/agents/src/protocol.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";

export async function verifyKeyboardViewport(engine: "chromium" | "webkit" = "chromium") {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-keyboard-"));
  const artifacts = resolve(`artifacts/keyboard-${engine}`);
  mkdirSync(artifacts, { recursive: true });
  const port = await new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      server.close(() => resolve(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const { app } = await createApp(root, false, origin, undefined, "prototype");
  await app.listen({ host: "127.0.0.1", port });
  const browser = await (engine === "webkit" ? webkit : chromium).launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  const requests: AgentInput[] = [];
  let connections = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // Model keyboard occlusion independently of the layout viewport. Native desktop
  // WebKit is useful coverage, but this does not reproduce a physical iOS keyboard.
  await page.addInitScript(() => {
    // tsx names functions inside the serialized fixture.
    Reflect.set(window, "__name", (value: unknown) => value);
    const native = window.visualViewport;
    let metrics: { height?: number; offsetTop?: number; scale?: number } = {};
    const viewport = new EventTarget();
    for (const key of ["height", "offsetTop", "scale", "width"] as const) {
      Object.defineProperty(viewport, key, {
        get: () =>
          key === "width"
            ? innerWidth
            : (metrics[key] ??
              native?.[key] ??
              (key === "scale" ? 1 : key === "height" ? innerHeight : 0)),
      });
    }
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    Reflect.set(window, "setKeyboardViewport", (next: typeof metrics, event = "resize") => {
      metrics = next;
      viewport.dispatchEvent(new Event(event));
    });
  });
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const state = (await response.json()) as PortalState;
    for (const workspace of state.myWorkspaces) workspace.spriteStatus = "ready";
    await route.fulfill({ response, json: state });
  });
  await page.route("**/preview*", (route) =>
    route.fulfill({
      json: { port: 5173, command: ["npm", "run", "dev"], ready: true, running: true },
    }),
  );
  await page.route("**/agent-git", (route) => route.fulfill({ json: { pending: null } }));
  await page.route("**/agent/prepare", (route) => route.fulfill({ json: { ready: true } }));
  await page.routeWebSocket("**/api/workspaces/*/agent", (socket) => {
    connections++;
    socket.onMessage((message) => requests.push(JSON.parse(message.toString()) as AgentInput));
    socket.send(
      JSON.stringify({
        type: "state",
        id: "keyboard-state",
        text: "Ready",
        runtimeReady: true,
        working: false,
        configuredProviders: ["opencode"],
        currentError: null,
      } satisfies AgentEvent),
    );
    socket.send(
      JSON.stringify({
        type: "text",
        id: "keyboard-history",
        text:
          "## Current findings\n\n" +
          "Review the neighborhood data and preserve its source context.\n\n".repeat(40),
      } satisfies AgentEvent),
    );
  });
  const terminalRequests: { type: string; cols?: number; rows?: number }[] = [];
  await page.routeWebSocket("**/api/workspaces/*/terminal", (socket) => {
    socket.onMessage((message) => terminalRequests.push(JSON.parse(message.toString())));
    socket.send(JSON.stringify({ type: "output", data: "Local terminal fixture\r\n$ " }));
  });
  async function viewport(height: number, offsetTop: number, scale = 1, event = "resize") {
    await page.evaluate(
      ({ height, offsetTop, scale, event }) => {
        Reflect.get(window, "setKeyboardViewport")({ height, offsetTop, scale }, event);
      },
      { height, offsetTop, scale, event },
    );
    if (scale === 1)
      await page.waitForFunction(
        ({ height, offsetTop }) => {
          const box = document.querySelector(".workspace-screen")?.getBoundingClientRect();
          return box && Math.abs(box.height - height) < 1 && Math.abs(box.top - offsetTop) < 1;
        },
        { height, offsetTop },
      );
  }
  async function inside(locator: Locator, height: number, offset: number) {
    const box = await locator.boundingBox();
    assert(
      box && box.y >= offset - 1 && box.y + box.height <= offset + height + 1,
      `Control outside visible viewport: ${await locator.getAttribute("aria-label")} ${JSON.stringify(box)}`,
    );
    assert(box.x >= 0 && box.x + box.width <= (page.viewportSize()?.width ?? 0) + 1);
  }
  try {
    await page.goto(origin);
    await page.getByLabel("Email address").fill("keyboard@example.test");
    await page.getByRole("button", { name: "Enter prototype" }).tap();
    await page.getByRole("button", { name: "Create your first event" }).tap();
    await page.getByLabel("Event name").fill("Mobile typing fixture");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-03");
    await page.getByLabel("Location").fill("Library");
    await page.getByRole("button", { name: "Create event", exact: true }).tap();
    await page.getByRole("button", { name: "Explore projects", exact: true }).tap();
    await page.getByRole("button", { name: "Create a team", exact: true }).tap();
    await page.getByLabel("Team name").fill("Neighborhood research and data team");
    await page.getByRole("button", { name: "Create and join team" }).tap();
    await page.getByRole("button", { name: "Open my workspace" }).tap();
    await page.getByRole("button", { name: "Agent", exact: true }).tap();
    const composer = page.getByRole("textbox", { name: "Message to agent" });
    const send = page.getByRole("button", { name: "Send to agent" });
    await page
      .getByRole("status")
      .filter({ hasText: /^Ready$/ })
      .waitFor();
    await composer.fill("Keep this draft");
    const initialConnections = connections;
    for (const theme of ["light", "dark"] as const) {
      for (const width of [360, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: theme });
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
        for (const [height, offset] of [
          [350, 40],
          [300, 100],
        ]) {
          assert(height && offset);
          await composer.focus();
          await viewport(height, offset);
          await composer.pressSequentially(".");
          await inside(composer, height, offset);
          await inside(send, height, offset);
          const transcript = await page.getByRole("log").boundingBox();
          assert(
            transcript && transcript.height >= 24,
            `Transcript squeezed out: ${JSON.stringify(transcript)}`,
          );
          assert(await page.getByRole("log").evaluate((el) => el.scrollHeight > el.clientHeight));
          assert(await composer.evaluate((el) => getComputedStyle(el).fontSize === "16px"));
          assert(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth && window.scrollY === 0,
            ),
          );
          await page.screenshot({
            path: join(artifacts, `${width}-${height}-${offset}-${theme}.png`),
            clip: { x: 0, y: offset, width, height },
          });
          // A pan without resize must move the whole frame, not hide its header.
          await viewport(height, offset + 15, 1, "scroll");
          await inside(composer, height, offset + 15);
          await inside(send, height, offset + 15);
          const draft = await composer.inputValue();
          await page.getByRole("button", { name: "Workspace controls" }).tap();
          await inside(page.getByRole("button", { name: "Back to teams" }), height, offset + 15);
          await page.getByRole("button", { name: "Workspace controls" }).press("Escape");
          assert.equal(await composer.inputValue(), draft);
          assert.equal(connections, initialConnections);
          // Existing multiline draft must shrink with the panel, without losing text.
          await composer.fill("Line of a longer draft\n".repeat(15));
          await inside(composer, height, offset + 15);
          await inside(send, height, offset + 15);
          assert(await composer.evaluate((el) => el.scrollHeight > el.clientHeight));
          await composer.fill(draft);
        }
        await viewport(844, 0);
        await inside(composer, 844, 0);
        const beforeZoom = await page.locator(".workspace-screen").boundingBox();
        await viewport(422, 100, 2);
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        assert.deepEqual(
          await page.locator(".workspace-screen").boundingBox(),
          beforeZoom,
          "Zoom must not reflow or chase the pinched viewport",
        );
        await viewport(844, 0);
      }
    }
    await page.setViewportSize({ width: 740, height: 390 });
    await viewport(300, 40);
    await inside(composer, 300, 40);
    await inside(send, 300, 40);
    await page.setViewportSize({ width: 390, height: 844 });
    await viewport(300, 70);
    await composer.fill("Keyboard regression prompt");
    await send.tap();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to agent"]')
          ?.value === "",
    );
    assert.deepEqual(
      requests.filter((r) => r.type === "prompt"),
      [{ type: "prompt", provider: "opencode", text: "Keyboard regression prompt" }],
    );
    assert.equal(
      requests.filter((r) => ["stop", "cancel", "configure"].includes(r.type)).length,
      0,
    );
    assert.equal(connections, initialConnections);
    await page.getByRole("button", { name: "Terminal", exact: true }).tap();
    await page.locator(".xterm-screen").waitFor();
    await viewport(350, 40);
    await inside(page.locator(".sprite-terminal"), 350, 40);
    await viewport(300, 100);
    await inside(page.locator(".sprite-terminal"), 300, 100);
    await page.waitForFunction(() => {
      const host = document.querySelector(".sprite-terminal")?.getBoundingClientRect();
      const screen = document.querySelector(".xterm-screen")?.getBoundingClientRect();
      return host && screen && screen.bottom <= host.bottom;
    });
    await page.screenshot({
      path: join(artifacts, "terminal-390-300-100-dark.png"),
      clip: { x: 0, y: 100, width: 390, height: 300 },
    });
    assert(terminalRequests.some((request) => request.type === "resize"));
    await page.setViewportSize({ width: 1440, height: 900 });
    await viewport(900, 0);
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await composer.fill("Desktop remains usable");
    await inside(composer, 900, 0);
    await inside(page.getByRole("button", { name: "Stop generation" }), 900, 0);
    assert.equal(await page.getByRole("button", { name: "Workspace controls" }).isVisible(), false);
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${engine}: independent visual viewport height/offset, resize/scroll, focused typing + Send + transcript at 300/350px, multiline/keyboard hide/rotation/native zoom, menu draft/socket preservation, terminal resize bounds, desktop; clean console. Simulated keyboard metrics, not physical iOS verification.`,
    );
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure.png") });
    console.error({ errors });
    throw error;
  } finally {
    await browser.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyKeyboardViewport(
    process.env.CIVIC_SPARK_KEYBOARD_BROWSER === "webkit" ? "webkit" : "chromium",
  );
}
