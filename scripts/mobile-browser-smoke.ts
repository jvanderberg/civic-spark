import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Locator, type WebSocketRoute } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { AgentEvent, AgentInput } from "../packages/agents/src/protocol.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import { verifyAdminBackups } from "./admin-backups-browser-smoke.ts";
import { verifyAdminEventDetails } from "./admin-event-browser-smoke.ts";
import { verifyAdminProjects } from "./admin-projects-browser-smoke.ts";
import { verifyDemoOwnerSignIn } from "./browser-demo-owner.ts";
import { readEditor, waitEditorText, writeEditor } from "./browser-editor.ts";
import { openAdminSection, openPortalMenu } from "./browser-portal-menu.ts";
import {
  projectBriefFixture,
  verifyProjectBrief,
  watchBriefRequests,
} from "./browser-project-brief.ts";
import { verifySiteEventPortal } from "./browser-site-event.ts";
import { verifyKeyboardViewport } from "./keyboard-browser-smoke.ts";
import { verifyLifecyclePortal } from "./lifecycle-browser-smoke.ts";
import { verifyParticipantProjects } from "./participant-projects-browser-smoke.ts";
import { verifyProvisioning } from "./provisioning-browser-smoke.ts";
import { verifyTeamsPortal } from "./teams-browser-smoke.ts";

// Disposable local APIs and deterministic Sprite transports; never runs participant
// code or contacts a paid agent. Touch emulation does not claim physical-device QA.
const root = mkdtempSync(join(tmpdir(), "civic-spark-mobile-browser-"));
const artifacts = resolve("artifacts/mobile");
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
const authMode = process.env.CIVIC_SPARK_MOBILE_DEMO === "1" ? "demo" : "prototype";
const { app } = await createApp(root, false, address, undefined, authMode);
await app.listen({ host: "127.0.0.1", port });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 360, height: 780 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const briefRequests = watchBriefRequests(page);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.addInitScript(() => {
  Reflect.deleteProperty(window, "showDirectoryPicker");
});
let remote = false;
let incompletePreview = false;
let connection: WebSocketRoute | undefined;
const requests: AgentInput[] = [];
await page.route("**/api/state", async (route) => {
  const response = await route.fetch({
    headers: { ...route.request().headers(), "if-none-match": "" },
  });
  if (!response.ok()) return route.fulfill({ response });
  const state = (await response.json()) as PortalState;
  if (remote) for (const workspace of state.myWorkspaces) workspace.spriteStatus = "ready";
  await route.fulfill({ response, json: state });
});
await page.route("**/preview*", (route) =>
  incompletePreview
    ? route.fulfill({ status: 200, body: "" })
    : route.fulfill({
        json: {
          port: 5173,
          command: ["npm", "run", "dev", "--", "--host", "0.0.0.0"],
          ready: true,
          running: true,
          logs: "Fixture preview ready\n".repeat(40),
        },
      }),
);
await page.route("**/agent-git", (route) => route.fulfill({ json: { pending: null } }));
await page.route("**/agent/credentials", (route) =>
  route.fulfill({ json: { savedProviders: ["claude", "opencode"] } }),
);
await page.route("**/agent/prepare", (route) => route.fulfill({ json: { ready: true } }));
await page.routeWebSocket("**/api/workspaces/*/agent", (socket) => {
  connection = socket;
  socket.onMessage((message) => requests.push(JSON.parse(message.toString()) as AgentInput));
  socket.send(
    JSON.stringify({
      type: "state",
      id: "fixture",
      text: "Ready",
      runtimeReady: true,
      working: false,
      configuredProviders: ["opencode"],
      currentError: null,
    } satisfies AgentEvent),
  );
});
async function capture(name: string, workspace = false) {
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `${name}: document overflow`,
  );
  if (workspace) {
    const frame = await page.locator(".workspace-screen").boundingBox();
    assert(
      frame && frame.x === 0 && frame.y === 0 && frame.height <= (page.viewportSize()?.height ?? 0),
      `${name}: workspace escaped viewport`,
    );
    assert(
      await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
      `${name}: page scrolls instead of workspace`,
    );
  }
  await page.screenshot({
    path: join(artifacts, `${name}.png`),
    animations: "disabled",
    fullPage: !workspace && !(await page.getByRole("dialog").count()),
  });
}
async function inViewport(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const size = page.viewportSize();
  assert(
    box &&
      size &&
      box.x >= 0 &&
      box.x + box.width <= size.width + 1 &&
      box.y >= 0 &&
      box.y + box.height <= size.height + 1,
    `Unreachable control: ${(await locator.getAttribute("aria-label")) ?? (await locator.innerText())}`,
  );
}
try {
  await page.goto(address);
  await page.getByLabel("Email address").fill("mobile@example.test");
  await page.getByLabel("Name (optional, for your first visit)").fill("Mobile Organizer");
  assert.equal(
    await page.getByLabel("Email address").evaluate((el) => getComputedStyle(el).fontSize),
    "16px",
  );
  if (authMode === "demo") {
    await page.getByText(/anyone entering the same email can access/).waitFor();
    for (const colorScheme of ["light", "dark"] as const) {
      for (const [width, height] of [
        [360, 780],
        [390, 844],
        [1440, 900],
        [360, 430],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme });
        await inViewport(page.getByRole("button", { name: "Enter demo" }));
        await capture(`${width}-${height}-demo-sign-in-${colorScheme}`);
      }
    }
    await page.setViewportSize({ width: 360, height: 780 });
    await page.emulateMedia({ colorScheme: "light" });
  }
  await capture("360-sign-in-light");
  await page
    .getByRole("button", { name: authMode === "demo" ? "Enter demo" : "Enter prototype" })
    .tap();
  await page.getByRole("button", { name: "Create your first event" }).tap();
  assert(
    (await context.cookies()).some(
      (cookie) => cookie.name === `civic-spark-${authMode}.session_token`,
    ),
    "Prototype sign-in must use the Civic Spark cookie namespace",
  );
  await page.getByLabel("Event name").fill("Community data and neighborhood connections");
  await page.getByLabel("Date", { exact: true }).fill("2026-10-03");
  await page.getByLabel("Location").fill("Community library");
  await inViewport(page.getByRole("button", { name: "Create event", exact: true }));
  await capture("360-create-event");
  await page.getByRole("button", { name: "Create event", exact: true }).tap();
  await page.getByRole("button", { name: "Open registration" }).tap();
  await capture("360-admin-overview");
  await openAdminSection(page, "Projects");
  await page.getByRole("button", { name: "Create project", exact: true }).tap();
  const projectDialog = page.getByRole("dialog", { name: "Create project", exact: true });
  await projectDialog.getByLabel("Project name", { exact: true }).fill("Neighborhood data");
  const projectBrief = projectBriefFixture;
  await projectDialog.getByLabel("Project brief (Markdown)").fill(projectBrief);
  for (const theme of ["light", "dark"] as const) {
    for (const [width, height] of [
      [360, 780],
      [390, 844],
      [1440, 900],
      [360, 430],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      const input = projectDialog.getByLabel("Project brief (Markdown)");
      await input.focus();
      // The long textarea can scroll; focus and its trailing input remain usable.
      await input.press("End");
      assert.equal(await input.inputValue(), projectBrief);
      if (width < 600)
        assert.equal(await input.evaluate((el) => getComputedStyle(el).fontSize), "16px");
      await inViewport(projectDialog.getByRole("button", { name: "Create project", exact: true }));
      await capture(`${width}-${height}-create-project-${theme}`);
      await inViewport(projectDialog.getByLabel("Project name", { exact: true }));
      await inViewport(projectDialog.getByRole("button", { name: "Close dialog" }));
    }
  }
  await page.setViewportSize({ width: 360, height: 780 });
  await page.emulateMedia({ colorScheme: "light" });
  await projectDialog.getByRole("button", { name: "Create project", exact: true }).tap();
  await page.getByRole("status").filter({ hasText: "Created Neighborhood data" }).waitFor();
  const projectState = (await (
    await context.request.get(`${address}/api/state`)
  ).json()) as PortalState;
  const createdProject = projectState.events[0]?.projects.find(
    (p) => p.name === "Neighborhood data",
  );
  assert(createdProject && projectState.events[0]);
  const createdDetail = (await (
    await context.request.get(
      `${address}/api/events/${projectState.events[0].id}/projects/${createdProject.id}`,
    )
  ).json()) as { description: string };
  assert.equal(createdDetail.description, projectBrief);
  await openPortalMenu(page);
  await page.getByRole("button", { name: "Explore projects", exact: true }).tap();
  await capture("360-discovery");
  const catalogCard = page
    .locator(".project-card")
    .filter({ has: page.getByRole("heading", { name: "Neighborhood data", exact: true }) });
  await verifyProjectBrief(page, catalogCard, "Start a team", artifacts, "catalog");
  await catalogCard.getByRole("button", { name: "Start a team", exact: true }).tap();
  await page.getByLabel("Team name").fill("Neighborhood access and community connections");
  assert.equal(
    await page.getByLabel("Project", { exact: true }).inputValue(),
    projectState.events[0]?.projects.find((p) => p.name === "Neighborhood data")?.id,
  );
  for (const [width, height] of [
    [390, 844],
    [900, 390],
    [360, 780],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.getByLabel("Team name").focus();
    assert.equal(
      await page.getByLabel("Team name").inputValue(),
      "Neighborhood access and community connections",
    );
    await inViewport(page.getByRole("button", { name: "Create and join team" }));
  }
  await capture("360-create-team");
  await page.getByRole("button", { name: "Create and join team" }).tap();
  await capture("360-my-teams");
  await verifyProjectBrief(
    page,
    page.locator(".team-card"),
    "Open my workspace",
    artifacts,
    "team",
  );
  assert.deepEqual(briefRequests, []);
  await page.getByRole("button", { name: "Open my workspace" }).tap();
  await page.getByRole("button", { name: "Show file explorer" }).tap();
  await capture("360-file-drawer", true);
  await page.getByRole("treeitem", { name: "README.md", exact: true }).tap();
  await page.getByRole("button", { name: "Show file explorer" }).waitFor();
  assert(
    await page
      .getByRole("button", { name: "Show file explorer" })
      .evaluate((el) => document.activeElement === el),
    "Phone drawer returns focus to its toggle",
  );
  await waitEditorText(page, "#");
  assert(
    ((await page.locator(".editor-area").boundingBox())?.width ?? 0) >= 310,
    "Phone editor should retain most of the screen width",
  );
  const saved = await readEditor(page);
  await writeEditor(page, `${saved}\nMobile contribution.\n`);
  await page.getByRole("button", { name: "Show file explorer" }).tap();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("treeitem", { name: "PROJECT.md", exact: true }).tap();
  assert.match(await readEditor(page), /Mobile contribution/);
  await page.getByRole("button", { name: "Collapse file explorer" }).tap();
  await page.getByRole("button", { name: "Save", exact: true }).tap();
  await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  await capture("360-editor-light", true);
  await page.getByRole("button", { name: /^Changes/ }).tap();
  await page.getByLabel("Commit message").fill("Mobile shared finding");
  await capture("360-changes-light", true);
  await page.getByRole("button", { name: "Share", exact: true }).tap();
  await page.getByRole("status").filter({ hasText: "Shared with your team" }).waitFor();
  await page.getByRole("button", { name: "Local folder", exact: true }).tap();
  await page.getByText("Folder sync needs desktop Chrome or Edge.", { exact: false }).waitFor();
  await capture("360-local-fallback", true);
  await page.getByRole("button", { name: "Terminal", exact: true }).tap();
  await page.getByRole("heading", { name: "Your Sprite terminal" }).waitFor();
  await capture("360-terminal-fallback", true);
  await page.getByRole("button", { name: "Workspace controls" }).tap();
  await page.getByRole("button", { name: "Back to teams" }).tap();
  await openPortalMenu(page);
  await page.getByRole("button", { name: "Admin", exact: true }).tap();
  await openAdminSection(page, "Teams");
  await page.getByRole("button", { name: "Repository", exact: true }).tap();
  const repository = page.getByRole("dialog");
  await repository.getByRole("heading", { name: "Mobile shared finding", exact: true }).waitFor();
  await repository
    .getByRole("region", { name: "File preview" })
    .getByText("+Mobile contribution.", { exact: false })
    .waitFor();
  for (const [width, height, theme] of [
    [360, 780, "light"],
    [390, 844, "dark"],
    [360, 430, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await inViewport(repository.getByRole("button", { name: "Files at this commit" }));
    await repository.getByRole("button", { name: "Files at this commit" }).tap();
    await repository
      .getByRole("navigation", { name: "Commit files" })
      .getByRole("button", { name: "PROJECT.md", exact: true })
      .tap();
    await repository
      .getByRole("region", { name: "File preview" })
      .getByText("# Neighborhood data", { exact: false })
      .waitFor();
    await inViewport(repository.getByRole("region", { name: "File preview" }));
    await capture(`${width}-${height}-repository-${theme}`);
    await repository.getByRole("button", { name: "Commit changes" }).tap();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await repository
    .getByRole("navigation", { name: "Repository commits" })
    .getByRole("button", { name: /Start the team project/ })
    .tap();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await repository.getByRole("button", { name: "Restore this version", exact: true }).tap();
  assert.equal(await repository.getByRole("status").count(), 0);
  await repository.getByRole("button", { name: "Close dialog" }).tap();
  await page.getByRole("button", { name: "Copy team", exact: true }).tap();
  await page.getByLabel("New team name").fill("Mobile project copy");
  await capture("390-copy-team-dark");
  await page.getByRole("button", { name: "Create copy", exact: true }).tap();
  const copied = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Mobile project copy", exact: true }) });
  await copied.getByText("0 members", { exact: true }).waitFor();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await copied.getByRole("button", { name: "Delete team" }).tap();
  assert.equal(await copied.count(), 1);
  page.once("dialog", (dialog) => void dialog.accept());
  await copied.getByRole("button", { name: "Delete team" }).tap();
  await copied.waitFor({ state: "detached" });
  remote = true;
  await page.reload();
  await openPortalMenu(page);
  await page.getByRole("button", { name: /My teams/ }).tap();
  await page.getByRole("button", { name: "Open my workspace" }).tap();
  await page.getByRole("button", { name: "Agent", exact: true }).tap();
  await page
    .getByRole("status")
    .filter({ hasText: /^Ready$/ })
    .waitFor();
  const state = (await (await context.request.get(`${address}/api/state`)).json()) as PortalState;
  const workspace = state.myWorkspaces[0];
  assert(workspace);
  assert.equal(
    await page.evaluate(
      (id) => localStorage.getItem(`civic-spark:workspace:${id}:tab`),
      workspace.id,
    ),
    "agent",
  );
  await page.reload();
  await page
    .getByRole("status")
    .filter({ hasText: /^Ready$/ })
    .waitFor();
  assert(connection);
  for (let index = 0; index < 12; index++)
    connection.send(
      JSON.stringify({
        type: "text",
        id: `answer-${index}`,
        text: `Finding ${index + 1}: community access improves when residents can see nearby resources.\n\n\`\`\`typescript\nconst neighborhoodResource = "${"resource".repeat(12)}";\n\`\`\``,
      } satisfies AgentEvent),
    );
  const composer = page.getByLabel("Message to agent");
  await composer.fill("Keep this draft while changing orientation.");
  for (const [width, height, theme] of [
    [390, 844, "dark"],
    [360, 780, "light"],
    [360, 430, "light"],
    [740, 360, "dark"],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme });
    await inViewport(composer);
    await inViewport(page.getByRole("button", { name: "Send message" }));
    assert.equal(await composer.inputValue(), "Keep this draft while changing orientation.");
    await capture(`${width}-${height}-agent-${theme}`, true);
    await page.getByRole("button", { name: "Agent connection settings" }).tap();
    await inViewport(page.getByRole("button", { name: "Reconnect", exact: true }));
    await capture(`${width}-${height}-connection-${theme}`, true);
    await inViewport(composer);
    await inViewport(page.getByRole("button", { name: "Send message" }));
    await page.getByRole("button", { name: "Agent connection settings" }).tap();
  }
  await page.setViewportSize({ width: 360, height: 430 });
  await page.getByRole("button", { name: "Workspace controls" }).tap();
  await page.getByRole("button", { name: "Web server details" }).tap();
  const environment = page.getByRole("region", { name: "Web server and publishing" });
  await inViewport(environment.getByRole("button", { name: "Refresh logs" }));
  await capture("360-short-preview-details", true);
  incompletePreview = true;
  await environment.getByRole("button", { name: "Refresh logs" }).tap();
  await environment
    .getByRole("alert")
    .filter({ hasText: "The Civic Spark server returned an incomplete response." })
    .waitFor();
  await inViewport(environment.getByRole("alert"));
  await capture("360-short-preview-error", true);
  incompletePreview = false;
  await environment.getByRole("button", { name: "Refresh logs" }).tap();
  await environment.getByRole("alert").waitFor({ state: "detached" });
  await environment.getByRole("button", { name: "Close", exact: true }).tap();
  await page.getByRole("button", { name: "Team updates", exact: true }).tap();
  await inViewport(page.getByRole("button", { name: "Later", exact: true }));
  await capture("360-short-team-updates", true);
  await page.getByRole("button", { name: "Later", exact: true }).tap();
  assert.deepEqual(
    requests.filter((request) => ["prompt", "cancel", "configure"].includes(request.type)),
    [],
    "Responsive checks must not submit or stop agent work",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: mobile 360/390 and short/landscape viewports, touch workflows, light/dark, sign-in/create event/project/team, project drafts across viewport/theme changes, discovery/admin, file drawer/save/draft protection, Share, repo commits/files/diffs/cancel restore, copy/delete confirmations, folder/terminal fallback, chat/connection/preview/update menus, no page overflow, clean console. Chromium emulation and mocked Sprite transports; physical keyboards/Safari/native terminal require device rehearsal.",
  );
} catch (error) {
  await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
  console.error({ errors, body: await page.locator("body").innerText() });
  throw error;
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}

await verifySiteEventPortal();

await verifyDemoOwnerSignIn();

await verifyKeyboardViewport();

await verifyLifecyclePortal();

await verifyAdminProjects();

await verifyTeamsPortal();

await verifyAdminEventDetails();

await verifyParticipantProjects();

await verifyProvisioning();

await verifyAdminBackups();
