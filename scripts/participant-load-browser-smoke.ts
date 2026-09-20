import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { AgentEvent, AgentInput } from "../packages/agents/src/protocol.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { runParticipant } from "./participant-load.ts";
import { scenarioSchema } from "./participant-scenario.ts";

// Real sign-in, React UI, file service, Git Share and downloaded ZIP. Only
// Sprite preparation/terminal/agent are doubles; no model or cloud calls.
const root = mkdtempSync(join(tmpdir(), "civic-spark-participant-browser-"));
const port = await new Promise<number>((done) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert(address && typeof address !== "string");
    server.close(() => done(address.port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const { app, service } = await createApp(root, false, origin, undefined, "prototype");
const value = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const admin = {
  id: "scenario-admin@example.test",
  name: "Scenario admin",
  email: "scenario-admin@example.test",
  emailVerified: true as const,
};
const event = value(
  service.createEvent(admin, {
    name: "Scripted rehearsal",
    date: "2026-10-03",
    timezone: "America/Chicago",
    location: "Fixture",
    capacity: 20,
    budget: 0,
    templateId: "blank",
  }),
);
value(service.transition(admin, event.id, "registration"));
value(
  service.createProject(admin, event.id, {
    name: "Scripted project",
    brief: "Create a simple React view for this trusted synthetic fixture.",
  }),
);
await app.listen({ host: "127.0.0.1", port });
const browser = await chromium.launch();
try {
  for (const theme of ["light", "dark"] as const) {
    for (const [width, height] of [
      [1440, 900],
      [360, 780],
      [390, 844],
      [360, 430],
    ] as const) {
      const id = `fixture-${theme}-${width}-${height}`;
      const output = resolve("artifacts", "participant-load-browser", id);
      mkdirSync(output, { recursive: true });
      const context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width, height },
        colorScheme: theme,
        hasTouch: true,
      });
      const page = await context.newPage();
      const injectShareFailures = theme === "light" && width === 1440;
      let shareRequests = 0;
      if (injectShareFailures) {
        await page.route("**/share", async (route) => {
          shareRequests++;
          if (shareRequests === 1) {
            await route.fulfill({
              status: 503,
              json: { error: "Temporary Share failure; retry." },
            });
          } else if (shareRequests === 3) {
            // The MVP reached shared main, but its HTTP response was lost.
            const response = await route.fetch({
              headers: { ...route.request().headers(), "if-none-match": "" },
            });
            assert(response.ok());
            await route.abort("failed");
          } else await route.continue();
        });
      }
      // Dark desktop: the workspace starts unprepared, the first preparation
      // request is refused by the busy limit, and the client must retry on its
      // own without an error or a Retry button.
      const injectBusyPreparation = theme === "dark" && width === 1440;
      let preparationRequests = 0;
      let prepared = !injectBusyPreparation;
      await page.route("**/api/state", async (route) => {
        const response = await route.fetch({
          headers: { ...route.request().headers(), "if-none-match": "" },
        });
        const state = (await response.json()) as PortalState;
        for (const workspace of state.myWorkspaces)
          workspace.spriteStatus = prepared ? "ready" : "local";
        state.capabilities.sprites = true;
        await route.fulfill({ response, json: state });
      });
      // Dark desktop also gets one stale-preview Share rejection: the client must
      // refresh the preview and retry on its own when the file list is unchanged.
      let staleShareRequests = 0;
      if (injectBusyPreparation)
        await page.route("**/share", async (route) => {
          staleShareRequests++;
          if (staleShareRequests === 1)
            return route.fulfill({
              status: 409,
              json: {
                error:
                  "Files changed since the preview. Refresh Changes and review them before sharing.",
              },
            });
          return route.continue();
        });
      if (injectBusyPreparation)
        await page.route("**/api/workspaces/*/sprite", async (route) => {
          if (route.request().method() === "POST") {
            preparationRequests++;
            if (preparationRequests === 1)
              return route.fulfill({
                status: 429,
                json: { error: "Workspace preparation is busy. Retry shortly." },
              });
            prepared = true;
            return route.fulfill({ json: { preparing: true } });
          }
          const response = await route.fetch({
            headers: { ...route.request().headers(), "if-none-match": "" },
          });
          const workspace = (await response.json()) as PortalState["myWorkspaces"][number];
          await route.fulfill({
            response,
            json: { ...workspace, spriteStatus: prepared ? "ready" : "local" },
          });
        });
      await page.route("**/agent/credentials", (route) =>
        route.fulfill({ json: { savedProviders: [] } }),
      );
      // Light desktop: the first agent preparation fails upstream once; the client
      // retries it quietly while still showing the preparing state.
      let prepareRequests = 0;
      await page.route("**/agent/prepare", (route) => {
        prepareRequests++;
        if (injectShareFailures && prepareRequests === 1)
          return route.fulfill({
            status: 502,
            json: { error: "The Sprite tools could not be installed or verified." },
          });
        return route.fulfill({ json: { ready: true } });
      });
      await page.route("**/preview*", (route) =>
        route.fulfill({
          json: { running: false, ready: false, port: 5173, command: ["npm", "run", "dev"] },
        }),
      );
      await page.routeWebSocket("**/terminal", (socket) => {
        let input = "";
        socket.send(JSON.stringify({ type: "output", data: "$ " }));
        socket.onMessage((raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type !== "input") return;
          input += message.data;
          if (input.endsWith("\r")) {
            assert.equal(input, "ls\r");
            socket.send(
              JSON.stringify({
                type: "output",
                data: "ls\r\nPROJECT.md README.md hello.txt\r\n$ ",
              }),
            );
            input = "";
          }
        });
      });
      let prompts = 0;
      await page.routeWebSocket("**/agent", (socket) => {
        const emit = (event: AgentEvent) => socket.send(JSON.stringify(event));
        emit({
          type: "state",
          id: "state",
          text: "Ready",
          runtimeReady: true,
          working: false,
          configuredProviders: [],
        });
        socket.onMessage((raw) => {
          const input = JSON.parse(raw.toString()) as AgentInput;
          if (input.type === "configure") {
            assert.equal(input.key, "fixture-key");
            emit({
              type: "configured",
              id: "opencode",
              text: "Configured",
              provider: "opencode",
              configuredProviders: ["opencode"],
            });
          }
          if (input.type !== "prompt") return;
          prompts++;
          emit({ type: "user", id: `user-${prompts}`, text: input.text });
          emit({
            type: "state",
            id: "working",
            text: "Working",
            runtimeReady: true,
            working: true,
            configuredProviders: ["opencode"],
          });
          if (prompts === 1) {
            const workspaceId = new URL(socket.url()).pathname.split("/")[3];
            assert(workspaceId);
            const dir = service.workspacePath(workspaceId);
            // Trusted static fixture only. Never execute generated participant code.
            writeFileSync(
              join(dir, "package.json"),
              JSON.stringify({
                dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
                scripts: { build: "vite build" },
              }),
            );
            writeFileSync(
              join(dir, "index.html"),
              '<div id="root"></div><script type="module" src="/main.tsx"></script>',
            );
            writeFileSync(
              join(dir, "main.tsx"),
              'import { createRoot } from "react-dom/client"; createRoot(document.getElementById("root")!).render(<h1>Fixture</h1>);',
            );
          }
          // First check deliberately lacks completion; second check succeeds.
          // The question echo contains the sentinel in both cases.
          for (const text of prompts >= 3
            ? ["WE'RE ", "ALL GOOD"]
            : ["Still checking the project."])
            emit({ type: "text", id: `text-${prompts}`, text });
          emit({ type: "done", id: `done-${prompts}`, text: "Done", outcome: "success" });
          emit({
            type: "state",
            id: "idle",
            text: "Ready",
            runtimeReady: true,
            working: false,
            configuredProviders: ["opencode"],
          });
        });
      });
      const scenario = scenarioSchema.parse({
        version: 1,
        id,
        baseUrl: origin,
        authMode: "prototype",
        eventName: event.name,
        projectName: "Scripted project",
        participant: { name: id, email: `${id}@example.test` },
        teamName: id,
        timing: {
          completionWaitMs: 10,
          completionChecks: 2,
          thinkMs: 10,
          pollMs: 50,
          retryMs: 10,
          actionMs: 10000,
        },
        browser: { width, height, theme },
      });
      const result = await runParticipant(scenario, "fixture-key", output, page);
      assert.equal(result.checks, 2);
      assert.equal(prompts, 3);
      if (injectShareFailures) {
        assert.equal(
          shareRequests,
          3,
          "One transient retry, with no duplicate Share after a lost success response",
        );
        // Terminal and Agent each prepare once; the injected failure adds one retry.
        assert.equal(prepareRequests, 3, "Preparation retried once without a Retry click");
        assert.equal(result.browserErrors.length, 3);
        assert(result.browserErrors.every((message) => /502|503|ERR_FAILED/.test(message)));
      } else if (injectBusyPreparation) {
        assert.equal(preparationRequests, 2, "Busy preparation retried automatically");
        // hello: stale 409 + transparent retry; MVP: one request.
        assert.equal(staleShareRequests, 3, "Stale preview Share retried by the client");
        assert.equal(result.browserErrors.length, 2);
        assert(result.browserErrors.every((message) => /429|409/.test(message)));
        const steps = readFileSync(join(output, "steps.jsonl"), "utf8");
        assert(!steps.includes("Preparation retry"), "No manual preparation retry was needed");
        assert(!steps.includes("Preview refreshed"), "The runner never had to refresh the preview");
      } else assert.deepEqual(result.browserErrors, []);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await context.close();
    }
  }
  console.log(
    "PASS: JSON participant script, real UI/file/Git/ZIP, bounded completion loop and echo rejection at desktop/360/390/short widths in both themes; no cloud/model calls.",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
