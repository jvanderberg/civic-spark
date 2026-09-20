import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type WebSocketRoute } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import { runtimeSchema } from "../packages/domain/src/lifecycle.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { readEditor, writeEditor } from "./browser-editor.ts";
import { openPortalMenu } from "./browser-portal-menu.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw Error(result.error);
  return result.value;
};

// Shipped UI and real isolated account/file APIs. Runtime state/credentials/sockets
// are injected; no provider, shell or model is contacted.
export async function verifyRuntimeIdentity() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-runtime-identity-"));
  const artifacts = resolve("artifacts/sprite-delete-reset/runtime-identity");
  mkdirSync(artifacts, { recursive: true });
  const port = await new Promise<number>((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      server.close(() => done(address.port));
    });
  });
  const address = `http://127.0.0.1:${port}`;
  const { app, service } = await createApp(root, false, address, undefined, "prototype");
  await app.listen({ host: "127.0.0.1", port });
  const actor = {
    id: "identity@example.test",
    email: "identity@example.test",
    name: "Identity owner",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(actor, {
      name: "Runtime identity fixture",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(actor, event.id, "registration"));
  const { workspace } = unwrap(
    service.createTeam(actor, {
      eventId: event.id,
      name: "Identity team",
      projectId: "data-starter",
    }),
  );
  const browser = await chromium.launch();
  try {
    for (const theme of ["light", "dark"] as const) {
      for (const [width, height, skipped] of [
        [360, 780, false],
        [390, 844, true],
        [1440, 900, false],
        [360, 430, true],
      ] as const) {
        const page = await browser.newPage({
          viewport: { width, height },
          hasTouch: true,
          colorScheme: theme,
        });
        page.setDefaultTimeout(10000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        const oldName = `civic-spark-${workspace.id}`;
        const freshName = `civic-spark-fresh-${width}-${height}`;
        let name: string | null = oldName;
        let held = false;
        let generation = 0;
        let savedKeys = true;
        let connects = 0;
        const sockets = { agent: [] as WebSocketRoute[], terminal: [] as WebSocketRoute[] };
        const closes = { agent: 0, terminal: 0 };
        const sent: { type: string }[] = [];
        await page.route("**/api/state", async (route) => {
          const response = await route.fetch({
            headers: { ...route.request().headers(), "if-none-match": "" },
          });
          const state = (await response.json()) as PortalState;
          for (const item of state.myWorkspaces) {
            item.spriteName = name;
            item.spriteStatus = name ? "ready" : "local";
            item.runtime = runtimeSchema.parse({
              held,
              generation,
              ...(name === null
                ? {
                    reset: {
                      name: freshName,
                      org: "fixture-org",
                      apiOrigin: "https://api.sprites.dev",
                    },
                  }
                : {}),
            });
          }
          await route.fulfill({ response, json: state });
        });
        await page.route("**/wake", async (route) => {
          if (name === null) {
            assert.deepEqual(route.request().postDataJSON(), { action: "connect-new", generation });
            connects++;
            name = freshName;
            held = false;
            generation++;
          }
          await route.fulfill({ json: { awake: true } });
        });
        await page.route("**/activity", (route) => route.fulfill({ json: {} }));
        await page.route("**/preview*", (route) =>
          route.fulfill({
            json: { port: 5173, command: ["npm", "run", "dev"], ready: false, running: false },
          }),
        );
        await page.route("**/agent-git", (route) => route.fulfill({ json: { pending: null } }));
        await page.route("**/agent/credentials", (route) =>
          route.fulfill({ json: { savedProviders: savedKeys ? ["claude", "opencode"] : [] } }),
        );
        await page.route("**/agent/prepare", (route) => route.fulfill({ json: { ready: true } }));
        for (const kind of ["agent", "terminal"] as const) {
          await page.routeWebSocket(`**/api/workspaces/*/${kind}`, (socket) => {
            sockets[kind].push(socket);
            socket.onClose(() => closes[kind]++);
            socket.onMessage((data) => sent.push(JSON.parse(data.toString())));
            if (kind === "agent") {
              socket.send(
                JSON.stringify({
                  type: "text",
                  id: "old-private",
                  text: "Private transcript from retired Sprite",
                }),
              );
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
            } else
              socket.send(
                JSON.stringify({
                  type: "output",
                  data: name === oldName ? "OLD-PRIVATE-SHELL\r\n$ " : "FRESH-SHELL\r\n$ ",
                }),
              );
          });
        }
        const view = (label: string) =>
          page.getByRole("button", { name: label, exact: true }).click();
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
        try {
          await page.goto(address);
          await page.getByLabel("Email address").fill(actor.email);
          await page.getByLabel("Name (optional, for your first visit)").fill(actor.name);
          await view("Enter prototype");
          await page.getByRole("heading", { name: event.name, exact: true }).waitFor();
          await openPortalMenu(page);
          await page.getByRole("button", { name: /My teams/ }).click();
          await view("Open my workspace");
          await page.getByRole("dialog").waitFor({ state: "hidden" });
          await writeEditor(page, "Unsaved editor draft survives Sprite replacement");
          await view("Agent");
          await ready();
          assert.equal(await page.locator(".agent-panel").count(), 1, "Exactly one Agent panel");
          assert.equal(
            await page.locator(".terminal-panel").count(),
            1,
            "Exactly one Terminal panel",
          );
          await page.getByText("Private transcript from retired Sprite", { exact: true }).waitFor();
          await page.getByLabel("Message to agent").fill("Same Sprite composer draft");
          await view("Terminal");
          await connected();
          await page.getByText("OLD-PRIVATE-SHELL", { exact: false }).waitFor();
          await page.evaluate(() => {
            (window as unknown as { identityNodes: (Element | null)[] }).identityNodes = [
              document.querySelector(".workspace-screen"),
              document.querySelector(".agent-panel"),
              document.querySelector(".terminal-panel"),
            ];
          });
          // Actual transport reconnect on the same Sprite retains panels and drafts.
          sockets.agent.at(-1)?.close({ code: 1011, reason: "Fixture reconnect" });
          sockets.terminal.at(-1)?.close({ code: 1011, reason: "Fixture reconnect" });
          await waitFor(
            () => sockets.agent.length === 2 && sockets.terminal.length === 2,
            "Same identity reconnect",
          );
          await connected();
          await view("Agent");
          await ready();
          assert.equal(
            await page.getByLabel("Message to agent").inputValue(),
            "Same Sprite composer draft",
          );
          assert(
            await page.evaluate(() => {
              const old = (window as unknown as { identityNodes: (Element | null)[] })
                .identityNodes;
              return (
                old[0] === document.querySelector(".workspace-screen") &&
                old[1] === document.querySelector(".agent-panel") &&
                old[2] === document.querySelector(".terminal-panel")
              );
            }),
            "Same identity must preserve Workspace/Agent/Terminal nodes",
          );
          await view("Files");
          assert.equal(await readEditor(page), "Unsaved editor draft survives Sprite replacement");
          await view("Agent");
          await page.screenshot({
            path: join(artifacts, `${theme}-${width}-${height}-same-identity.png`),
          });
          savedKeys = false;
          generation++;
          if (skipped) {
            // Another tab completed Delete and Connect between this tab's polls.
            name = freshName;
          } else {
            name = null;
            held = true;
            // Another session deleted the Sprite; this tab learns it on its 15 s poll.
            await page
              .getByRole("dialog", { name: "Connect a new Sprite" })
              .waitFor({ timeout: 25000 });
            await page.getByRole("button", { name: "Connect new Sprite", exact: true }).tap();
          }
          await page.getByLabel("Agent API key").waitFor({ timeout: 25000 });
          await page.getByRole("dialog").waitFor({ state: "hidden" });
          assert.equal(connects, skipped ? 0 : 1);
          assert.equal(sockets.agent.length, 2, "No new agent connection without a new key");
          assert.equal(
            await page.getByText("Private transcript from retired Sprite", { exact: true }).count(),
            0,
            "Retired private transcript must disappear without reload or socket replay",
          );
          assert.equal(await page.getByLabel("Message to agent").inputValue(), "");
          assert(
            await page.evaluate(() => {
              const old = (window as unknown as { identityNodes: (Element | null)[] })
                .identityNodes;
              return (
                old[0] === document.querySelector(".workspace-screen") &&
                old[1] !== document.querySelector(".agent-panel") &&
                old[2] !== document.querySelector(".terminal-panel")
              );
            }),
            "Only runtime panels remount when actual Sprite identity changes",
          );
          await page.screenshot({
            path: join(artifacts, `${theme}-${width}-${height}-fresh-no-key.png`),
          });
          await view("Terminal");
          await connected();
          await page.getByText("FRESH-SHELL", { exact: false }).waitFor();
          assert.equal(await page.getByText("OLD-PRIVATE-SHELL", { exact: false }).count(), 0);
          await page.screenshot({
            path: join(artifacts, `${theme}-${width}-${height}-fresh-terminal.png`),
          });
          await view("Files");
          assert.equal(await readEditor(page), "Unsaved editor draft survives Sprite replacement");
          await page.screenshot({
            path: join(artifacts, `${theme}-${width}-${height}-retained-editor.png`),
          });
          assert(closes.agent >= 1 && closes.terminal >= 1, "Retired connections close");
          assert.deepEqual(
            sent.filter((message) => message.type !== "resize"),
            [],
            "No prompt, key configuration or shell input is sent automatically",
          );
          assert.deepEqual(errors, []);
        } catch (error) {
          await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
          console.error({
            theme,
            width,
            height,
            skipped,
            errors,
            body: await page.locator("body").innerText(),
          });
          throw error;
        } finally {
          await page.unrouteAll({ behavior: "wait" });
          await page.close();
        }
      }
    }
    console.log(
      "PASS: no-reload runtime identity reset, seeded private transcript/terminal removed before fresh-key entry, fast Connect and skipped-other-tab preparation, same-Sprite reconnect preserves nodes/composer/editor drafts; 360/390/desktop/short, both themes, clean consoles; mocked runtime only.",
    );
  } finally {
    await browser.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifyRuntimeIdentity();
