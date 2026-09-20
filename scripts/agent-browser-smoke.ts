import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type WebSocketRoute } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { AgentEvent, AgentInput } from "../packages/agents/src/protocol.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import { checkAgentImages } from "./agent-images-browser.ts";
import { openPortalMenu } from "./browser-portal-menu.ts";

// Deterministic transport fixture: exercises the shipped React UI and real local
// session/event/file APIs. No Sprite, provider request, or real API key is used.
const root = mkdtempSync(join(tmpdir(), "civic-spark-agent-browser-"));
const artifacts = resolve("artifacts");
mkdirSync(artifacts, { recursive: true });
const port = await new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    server.close(() => resolve(address.port));
  });
});
const address = `http://127.0.0.1:${port}`;
const { app } = await createApp(root, false, address, undefined, "prototype");
await app.listen({ host: "127.0.0.1", port });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const requests: AgentInput[] = [];
let connection: WebSocketRoute | undefined;
let connections = 0;
let restoreOnConnect = false;
let rejectConnections = false;
const history: AgentEvent[] = [];
const teamHead = "a".repeat(40);
const teamRemote = "b".repeat(40);
const resolutionPrompt =
  "Resolve the team update conflict in PROJECT.md, preserve both intended changes, and commit the local merge.";
let teamIncoming = false;
let teamConflict = false;
let teamResolving = false;
let teamVerifications = 0;
const teamUpdateModes: string[] = [];
await page.route("**/team-status*", (route) =>
  route.fulfill({
    json: {
      head: teamHead,
      remote: teamIncoming ? teamRemote : teamHead,
      incoming: teamIncoming,
      outgoing: false,
      dirty: false,
      agentWorking: false,
      merging: teamConflict,
      conflicts: teamConflict ? ["PROJECT.md"] : [],
      ...(teamResolving ? { resolution: { head: teamHead, remote: teamRemote } } : {}),
    },
  }),
);
await page.route("**/team-update", async (route) => {
  const input = route.request().postDataJSON();
  assert.equal(input.head, teamHead);
  assert.equal(input.remote, teamRemote);
  teamUpdateModes.push(input.mode);
  if (input.mode === "pull") {
    teamConflict = true;
    await route.fulfill({
      json: { status: "conflict", head: teamHead, remote: teamRemote, conflicts: ["PROJECT.md"] },
    });
  } else {
    assert.equal(input.mode, "agent");
    teamResolving = true;
    await route.fulfill({
      json: {
        status: "agent",
        head: teamHead,
        remote: teamRemote,
        conflicts: ["PROJECT.md"],
        prompt: resolutionPrompt,
      },
    });
  }
});
await page.route("**/team-update/verify", async (route) => {
  assert.deepEqual(route.request().postDataJSON(), { head: teamHead, remote: teamRemote });
  teamVerifications += 1;
  teamConflict = false;
  teamIncoming = false;
  teamResolving = false;
  await route.fulfill({ json: { verified: true } });
});
const snapshot: AgentEvent = {
  type: "state",
  id: "runtime-state",
  text: "Working",
  runtimeReady: true,
  working: true,
  workingStartedAt: new Date(Date.now() - 65000).toISOString(),
  configuredProviders: ["opencode", "claude"],
  currentError: null,
};
await page.route("**/api/state", async (route) => {
  const response = await route.fetch({
    headers: { ...route.request().headers(), "if-none-match": "" },
  });
  const state = (await response.json()) as PortalState;
  for (const workspace of state.myWorkspaces) workspace.spriteStatus = "ready";
  await route.fulfill({ response, json: state });
});
await page.route("**/preview*", (route) =>
  route.fulfill({
    json: { port: 5173, command: ["npm", "run", "dev"], running: false, ready: false },
  }),
);
await page.route("**/agent/credentials", (route) =>
  route.fulfill({ json: { savedProviders: ["opencode"] } }),
);
await page.route("**/agent/prepare", (route) => route.fulfill({ json: { ready: true } }));
await page.routeWebSocket("**/api/workspaces/*/agent", (socket) => {
  connection = socket;
  connections += 1;
  if (rejectConnections) {
    setTimeout(() => socket.close({ code: 1011, reason: "Fixture runtime unavailable" }), 20);
    return;
  }
  socket.onMessage((message) => requests.push(JSON.parse(message.toString()) as AgentInput));
  if (restoreOnConnect) {
    for (const event of history) socket.send(JSON.stringify({ ...event, replayed: true }));
    socket.send(JSON.stringify(snapshot));
  }
});
function emit(event: AgentEvent) {
  assert(connection);
  if (["user", "text", "tool", "approval", "resolved", "error", "done"].includes(event.type))
    history.push(event);
  connection.send(JSON.stringify(event));
}
function activeSocket() {
  assert(connection);
  return connection;
}
async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
async function hasRequest(type: AgentInput["type"]) {
  await waitFor(() => requests.some((request) => request.type === type), type);
}
try {
  await page.goto(address);
  await page.getByLabel("Email address").fill("chat-test@example.test");
  await page.getByRole("button", { name: "Enter prototype" }).click();
  await page.getByRole("button", { name: "Create your first event" }).click();
  await page.getByLabel("Event name").fill("Data ideas open day");
  await page.getByLabel("Date", { exact: true }).fill("2026-10-03");
  await page.getByLabel("Location").fill("Oak Park");
  await page.getByRole("button", { name: "Create event", exact: true }).click();
  await page.getByRole("button", { name: "Open registration" }).click();
  await openPortalMenu(page);
  await page.getByRole("button", { name: "Explore projects", exact: true }).click();
  await page.getByRole("button", { name: "Create a team", exact: true }).click();
  await page.getByLabel("Team name").fill("Oak Park data explorers");
  await page.getByRole("button", { name: "Create and join team" }).click();
  await page.getByRole("button", { name: "Open my workspace" }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  assert.deepEqual(await page.locator(".workspace-screen").boundingBox(), {
    x: 0,
    y: 0,
    width: 1440,
    height: 1000,
  });
  assert.equal(await page.locator("dialog").count(), 0);
  assert.deepEqual(await page.getByLabel("Agent model").locator("option").allTextContents(), [
    "GLM",
    "Opus 5",
  ]);
  assert.equal(await page.locator(".agent-panel .lucide-sparkles").count(), 0);
  await page.getByText("Send a message to start the conversation.", { exact: true }).waitFor();
  await waitFor(() => !!connection, "automatic first connection");
  assert.equal(
    await page.getByLabel("Agent API key").count(),
    0,
    "Wait for saved credential state before asking for a key",
  );
  assert.equal(connections, 1);
  await page.screenshot({ animations: "disabled", path: join(artifacts, "agent-chat-empty.png") });
  assert.equal(await page.getByRole("button", { name: "Send to agent" }).isEnabled(), false);
  assert.equal(
    await page.locator(".agent-panel").getByRole("status").innerText(),
    "Starting runtime",
  );
  // Initial server snapshot precedes the Sprite's saved journal stream.
  // Historical errors must not flash as current connection failures.
  emit({
    type: "state",
    id: "starting-state",
    text: "Connecting",
    runtimeReady: false,
    working: false,
    configuredProviders: [],
  });
  emit({
    type: "error",
    id: "historical-provider-error",
    text: "Historical provider request failed",
    replayed: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await page.locator(".agent-panel").getByRole("alert").count(),
    0,
    "Saved provider errors must not appear during reconnect",
  );
  await page.screenshot({
    animations: "disabled",
    path: join(artifacts, "agent-reconnecting-clean.png"),
  });
  emit({
    type: "error",
    id: "live-startup-failure",
    provider: "opencode",
    credentialFailure: true,
    text: "The saved API key was rejected during startup.",
  });
  await page
    .locator(".agent-panel")
    .getByRole("alert")
    .filter({ hasText: "saved API key was rejected" })
    .waitFor();
  emit({ type: "ready", id: "runtime", text: "Agent runner ready" });
  assert.match(
    await page.locator(".agent-panel").getByRole("alert").innerText(),
    /saved API key was rejected/,
  );
  emit({
    type: "state",
    id: "current-failure-snapshot",
    text: "Ready",
    runtimeReady: true,
    working: false,
    configuredProviders: [],
    currentError: "The saved API key was rejected during startup.",
  });
  await page
    .locator(".agent-panel")
    .getByRole("alert")
    .filter({ hasText: "saved API key was rejected" })
    .waitFor();
  await page.getByLabel("Agent API key").fill("test-fixture-not-a-real-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await hasRequest("configure");
  assert.equal(
    await page.locator(".agent-panel").getByRole("status").innerText(),
    "Checking connection",
  );
  emit({ type: "configured", id: "opencode", text: "GLM ready" });
  await page
    .getByRole("status")
    .filter({ hasText: /^Ready$/ })
    .waitFor();
  assert.equal(await page.getByLabel("Agent API key").count(), 0);
  const composer = page.getByLabel("Message to agent");
  await composer.fill("Explore the data and build a useful chart of bike traffic.");
  await composer.press("Enter");
  await hasRequest("prompt");
  assert.equal(await composer.inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Stop generation" }).isVisible(), true);
  emit({
    type: "user",
    id: "user-1",
    text: "Explore the data and build a useful chart of bike traffic.",
  });
  emit({ type: "status", id: "working-1", text: "Working" });
  // T3's waiting state is a ticking turn header plus its actual spotlight
  // Thinking row, before the provider emits the first token.
  await page.locator(".chat-thinking").waitFor();
  await page.waitForFunction(() =>
    document.querySelector(".chat-working")?.textContent?.includes("Working for"),
  );
  const timerBefore = await page.locator(".chat-working").innerText();
  await page.waitForFunction(
    (before) => document.querySelector(".chat-working")?.textContent !== before,
    timerBefore,
  );
  const focus = page.locator(".chat-thinking .live-activity-focus");
  await page.waitForFunction(() => {
    const el = document.querySelector(".chat-thinking .live-activity-focus");
    return el && getComputedStyle(el).animationPlayState === "running";
  });
  const transform = await focus.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForFunction((previous) => {
    const el = document.querySelector(".chat-thinking .live-activity-focus");
    return el && getComputedStyle(el).transform !== previous;
  }, transform);
  await page.screenshot({ path: join(artifacts, "agent-working-thinking-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.screenshot({ path: join(artifacts, "agent-working-thinking-dark.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await focus.evaluate((el) => getComputedStyle(el).animationName), "none");
  assert.equal(await page.locator(".chat-thinking").isVisible(), true);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });

  emit({
    type: "text",
    id: "assistant-1",
    text: "I'll inspect the project, then summarize the traffic by location.\n\n",
  });
  await page
    .getByText("I'll inspect the project, then summarize the traffic by location.", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".chat-thinking").isVisible(),
    true,
    "Thinking remains during streaming, as upstream",
  );
  emit({
    type: "tool",
    id: "tool-1",
    text: "read",
    details: JSON.stringify({ status: "completed", input: { filePath: "PROJECT.md" } }),
  });
  emit({
    type: "tool",
    id: "tool-2",
    text: "bash",
    details: JSON.stringify({
      status: "completed",
      input: { command: "python summarize.py" },
      output: "Read 248 rows. Wrote chart.svg.",
    }),
  });
  const liveTool = page.locator('.chat-tool[data-active="true"] .live-tool-shine');
  await liveTool.waitFor();
  assert.match(await liveTool.innerText(), /python summarize.py/);
  assert.equal(await page.locator(".chat-thinking").count(), 0);
  await page.waitForFunction(() => {
    const el = document.querySelector('.chat-tool[data-active="true"] .live-tool-shine');
    return el && getComputedStyle(el).animationPlayState === "running";
  });
  await page.screenshot({ path: join(artifacts, "agent-working-tool.png") });
  emit({
    type: "text",
    id: "assistant-2",
    text: "### Traffic at a glance\n\nThe busiest counter was **Lake Street**, with 1,240 trips.\n\n| Location | Trips |\n| --- | ---: |\n| Lake Street | 1,240 |\n| Oak Park Avenue | 965 |\n\n",
  });
  await page.locator(".chat-thinking").waitFor();
  assert.equal(await page.locator('.chat-tool[data-active="true"]').count(), 0);
  emit({ type: "text", id: "assistant-2", text: "```sql\nSELECT location, SUM(" });
  await page.locator('.chat-markdown-shiki[data-highlighted="true"]').waitFor();
  assert.match(
    await page.locator(".chat-assistant pre code").innerText(),
    /SELECT location, SUM\(/,
  );
  emit({
    type: "text",
    id: "assistant-2",
    text: "trips) AS trips\nFROM bike_counts\nGROUP BY location\nORDER BY trips DESC;\n```\n\nSee the [project brief](PROJECT.md) for the data source.\n\n- Added a chart with labels and a source link.\n- Kept the original data unchanged.",
  });
  emit({ type: "status", id: "cost-1", text: "Turn complete", cost: 0.00127 });
  emit({ type: "done", id: "done-1", text: "Ready" });
  await page
    .getByRole("status")
    .filter({ hasText: /^Ready$/ })
    .waitFor();
  assert.equal(
    await page.locator(".chat-working, .chat-thinking, .live-tool-shine").count(),
    0,
    "Completion removes all activity",
  );
  assert.equal(await page.getByText(/Turn complete ·/).count(), 0);
  assert.equal(await page.getByText("$0.00127", { exact: false }).count(), 0);
  await page.getByRole("heading", { name: "Traffic at a glance" }).waitFor();
  assert.equal(await page.locator(".chat-assistant table").count(), 1);
  await page.locator('.chat-markdown-shiki[data-highlighted="true"]').waitFor();
  const keyword = page
    .locator(".chat-markdown-shiki .line span")
    .filter({ hasText: /^SELECT$/ })
    .first();
  await keyword.waitFor();
  const lightKeywordColor = await keyword.evaluate((element) => getComputedStyle(element).color);
  assert.equal(
    await page.locator(".chat-markdown-shiki").getAttribute("data-highlight-theme"),
    "pierre-light",
  );
  assert.equal(
    await page.locator(".chat-assistant pre code").innerText(),
    "SELECT location, SUM(trips) AS trips\nFROM bike_counts\nGROUP BY location\nORDER BY trips DESC;\n",
  );
  await page.getByRole("button", { name: "Copy code", exact: true }).click();
  await page
    .getByRole("button", { name: "Copy code", exact: true })
    .filter({ hasText: "Copied" })
    .waitFor();
  await page.getByRole("button", { name: "Enable line wrapping" }).click();
  assert.equal(await page.locator(".chat-markdown-codeblock").getAttribute("data-wrap"), "true");
  await page.getByRole("button", { name: "Disable line wrapping" }).click();
  await page.locator(".chat-assistant").last().hover();
  await page.getByRole("button", { name: "Copy response", exact: true }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Traffic at a glance/);
  await page.getByRole("button", { name: "Run python summarize.py", exact: true }).click();
  await page.locator(".chat-tool pre").filter({ hasText: "Read 248 rows" }).waitFor();
  assert.equal(
    await page.locator(".chat-tool pre").innerText(),
    "python summarize.py\n\nRead 248 rows. Wrote chart.svg.",
  );
  await page.getByRole("button", { name: "Run python summarize.py", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: join(artifacts, "agent-chat-conversation.png"),
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.locator('.chat-markdown-shiki[data-highlight-theme="pierre-dark"]').waitFor();
  await page.waitForFunction(
    (previous) =>
      Array.from(document.querySelectorAll(".chat-markdown-shiki .line span")).some(
        (element) =>
          element.textContent === "SELECT" && getComputedStyle(element).color !== previous,
      ),
    lightKeywordColor,
  );
  assert.notEqual(
    await keyword.evaluate((element) => getComputedStyle(element).color),
    lightKeywordColor,
  );
  const darkCanvas = await page
    .locator(".agent-panel")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert(!["rgb(255, 255, 255)", "rgb(252, 252, 252)"].includes(darkCanvas));
  await page.screenshot({ animations: "disabled", path: join(artifacts, "agent-chat-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.getByRole("button", { name: "project brief", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).waitFor();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  assert.equal(connections, 1);
  assert.equal(requests.filter((request) => request.type === "configure").length, 1);
  await composer.fill("Add a comparison");
  await composer.press("Shift+Enter");
  assert.equal(await composer.inputValue(), "Add a comparison\n");
  await composer.press("Enter");
  await waitFor(
    () => requests.filter((request) => request.type === "prompt").length === 2,
    "second prompt",
  );
  emit({
    type: "approval",
    id: "question-1",
    text: "Agent question",
    details: JSON.stringify([
      {
        question: "Which time period should the comparison show?",
        options: [
          { label: "Month", description: "Compare monthly totals" },
          { label: "Week", description: "Show the weekly pattern" },
        ],
      },
    ]),
  });
  await page.getByRole("region", { name: "Agent question" }).waitFor();
  await page.getByText("Which time period should the comparison show?", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Approve once" }).count(), 0);
  await page.screenshot({
    animations: "disabled",
    path: join(artifacts, "agent-chat-question.png"),
  });
  await page.getByLabel("Your answer to the agent").fill("Month");
  await page.getByRole("button", { name: "Send answer", exact: true }).click();
  await hasRequest("approval");
  const answer = requests.find((request) => request.type === "approval");
  assert(answer?.type === "approval" && answer.allow && answer.answer === "Month");
  emit({ type: "resolved", id: "question-1", text: "Answered" });
  emit({
    type: "approval",
    id: "question-2",
    text: "Agent question",
    details: JSON.stringify([
      {
        question: "Choose a comparison",
        options: [
          { label: "Monthly", description: "Monthly totals" },
          { label: "Weekly", description: "Weekly totals" },
        ],
      },
    ]),
  });
  await page.getByRole("button", { name: /Monthly Monthly totals/ }).click();
  await waitFor(
    () =>
      requests.some(
        (request) =>
          request.type === "approval" &&
          request.id === "question-2" &&
          request.answer === "Monthly",
      ),
    "T3 question option selection",
  );
  emit({ type: "resolved", id: "question-2", text: "Answered" });
  await page.getByRole("button", { name: "Stop generation" }).click();
  await hasRequest("stop");
  emit({ type: "done", id: "done-2", text: "Ready" });
  emit({
    type: "error",
    id: "error-1",
    text: "The API key was rejected. Check the selected model’s key and reconnect.",
  });
  await page
    .locator(".agent-panel")
    .getByRole("alert")
    .filter({ hasText: "API key was rejected" })
    .waitFor();
  await page.screenshot({ animations: "disabled", path: join(artifacts, "agent-chat-error.png") });
  await page.getByRole("button", { name: "Dismiss agent error" }).click();
  await page.getByLabel("Agent model").selectOption("claude");
  await page.getByPlaceholder("Anthropic API key").waitFor();
  assert.equal(await page.getByRole("button", { name: "Send to agent" }).isEnabled(), false);
  const configuredBeforeInvalid = requests.filter((request) => request.type === "configure").length;
  await page.getByLabel("Agent API key").fill("test-fixture-claude-key");
  await page.getByLabel("Anthropic workspace ID").fill("invalid workspace");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Enter a valid Anthropic workspace ID" })
    .waitFor();
  assert.equal(
    requests.filter((request) => request.type === "configure").length,
    configuredBeforeInvalid,
  );
  await page.getByRole("button", { name: "Dismiss agent error" }).click();
  await page.getByLabel("Anthropic workspace ID").fill("wrkspc_testfixture");
  await page.getByLabel("Agent API key").fill("test-claude-fixture-not-a-real-key");
  await page.screenshot({
    animations: "disabled",
    path: join(artifacts, "agent-claude-workspace.png"),
  });
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await waitFor(
    () =>
      requests.some(
        (request) =>
          request.type === "configure" &&
          request.provider === "claude" &&
          request.workspaceId === "wrkspc_testfixture",
      ),
    "Claude workspace configuration",
  );
  emit({
    type: "error",
    id: "workspace-error",
    text: "This Anthropic key cannot access the selected workspace. Check the workspace ID or use a workspace-scoped key.",
  });
  await page
    .getByRole("alert")
    .filter({ hasText: "cannot access the selected workspace" })
    .waitFor();
  assert.equal(
    await page.getByLabel("Agent API key").inputValue(),
    "test-claude-fixture-not-a-real-key",
  );
  await page.getByLabel("Anthropic workspace ID").fill("wrkspc_correctedfixture");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await waitFor(
    () =>
      requests.some(
        (request) =>
          request.type === "configure" &&
          request.workspaceId === "wrkspc_correctedfixture" &&
          request.key === "test-claude-fixture-not-a-real-key",
      ),
    "retry corrected workspace with key retained in memory",
  );
  emit({ type: "configured", id: "claude", text: "Opus 5 ready" });
  await page
    .locator(".agent-panel")
    .getByRole("status")
    .filter({ hasText: /^Ready$/ })
    .waitFor();
  await page.getByRole("button", { name: "Agent connection settings" }).click();
  assert.equal(await page.getByLabel("Agent API key").count(), 0);
  await page.getByText("API key saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Agent connection settings" }).click();
  await page.getByLabel("Agent model").selectOption("opencode");
  assert.equal(await page.getByLabel("Agent API key").count(), 0);
  // A failed saved connection reveals replacement only for that provider. Retry
  // reuses the private Sprite key; it never asks the browser to recover its value.
  emit({
    type: "state",
    id: "saved-failed",
    text: "Ready",
    runtimeReady: true,
    configuredProviders: ["claude"],
    savedProviders: ["opencode", "claude"],
    failedProviders: ["opencode"],
  });
  await page.getByLabel("Agent API key").waitFor();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await waitFor(
    () =>
      requests.some((request) => request.type === "reconnect" && request.provider === "opencode"),
    "retry saved key without resubmitting a secret",
  );
  emit({ type: "configured", id: "opencode", text: "GLM ready" });
  await page.getByLabel("Agent API key").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Agent connection settings" }).click();
  assert.equal(await page.getByLabel("Agent API key").count(), 0);
  await page.getByText("API key saved", { exact: true }).waitFor();
  await page.screenshot({ animations: "disabled", path: join(artifacts, "agent-saved-key.png") });
  await page.getByRole("button", { name: "Agent connection settings" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ animations: "disabled", path: join(artifacts, "agent-chat-mobile.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.screenshot({
    animations: "disabled",
    path: join(artifacts, "agent-chat-mobile-dark.png"),
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const composerBox = await composer.boundingBox();
  assert(composerBox && composerBox.y > 0 && composerBox.y + composerBox.height < 844);
  const beforeRetry = connections;
  await activeSocket().close({ code: 1011, reason: "Test runtime restart" });
  await page
    .locator(".agent-panel")
    .getByRole("status")
    .filter({ hasText: "Reconnecting (1/3)" })
    .waitFor();
  assert.equal(await page.locator(".agent-panel").getByRole("alert").count(), 0);
  assert.equal(
    await page.getByLabel("Agent API key").count(),
    0,
    "A socket disconnect does not lose saved credentials",
  );
  await waitFor(() => connections === beforeRetry + 1, "automatic bounded reconnect");
  assert.equal(await page.getByLabel("Agent API key").count(), 0);
  emit({
    type: "error",
    id: "reattached-old-error",
    text: "Old failed turn from the saved transcript",
    replayed: true,
  });
  emit({
    type: "state",
    id: "unresolved-error-snapshot",
    text: "Connecting",
    runtimeReady: false,
    working: false,
    configuredProviders: [],
    currentError: "The current API key is missing permission for this model.",
  });
  await page
    .locator(".agent-panel")
    .getByRole("alert")
    .filter({ hasText: "current API key is missing permission" })
    .waitFor();
  await page.screenshot({
    animations: "disabled",
    path: join(artifacts, "agent-reconnect-current-error.png"),
  });
  // A runner can restore the provider from private Sprite credentials before
  // announcing its final ready event. Neither event alone enables a prompt.
  emit({ type: "configured", id: "opencode", text: "GLM ready" });
  await page.locator(".agent-panel").getByRole("alert").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Send to agent" }).isEnabled(), false);
  emit({ type: "ready", id: "runtime-restored", text: "Agent runner ready" });
  await page
    .getByRole("status")
    .filter({ hasText: /^Ready$/ })
    .waitFor();
  assert.equal(requests.filter((request) => request.type === "configure").length, 3);
  // A real reload restores the same owned workspace and tab, resumes the saved
  // native provider, and reattaches to a currently running turn without a key.
  emit({ type: "configured", id: "claude", text: "Opus 5 ready" });
  await page.getByLabel("Agent model").selectOption("claude");
  emit({ type: "user", id: "user-restored", text: "Now add the monthly comparison." });
  emit({
    type: "text",
    id: "assistant-restored",
    text: "I am adding the monthly comparison to the chart.",
  });
  emit(snapshot);
  restoreOnConnect = true;
  const beforeReload = connections;
  await page.reload();
  await waitFor(() => connections === beforeReload + 1, "automatic reload reconnection");
  await page
    .getByText("I am adding the monthly comparison to the chart.", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Agent model").inputValue(), "claude");
  assert.equal(await page.getByLabel("Agent API key").count(), 0);
  await page.getByRole("button", { name: "Stop generation" }).waitFor();
  assert.equal(await page.locator(".agent-panel").getByRole("status").innerText(), "Working");
  assert.equal(requests.filter((request) => request.type === "configure").length, 3);
  assert.match(await page.locator(".chat-working").innerText(), /Working for [1-9]\d*m/);
  assert.equal(await page.locator(".chat-thinking").isVisible(), true);
  await page.screenshot({
    animations: "disabled",
    path: join(artifacts, "agent-chat-restored.png"),
  });
  if (await page.getByRole("button", { name: "Workspace controls" }).isVisible())
    await page.getByRole("button", { name: "Workspace controls" }).click();
  await page.getByRole("button", { name: "Back to teams" }).click();
  await openPortalMenu(page);
  await page.getByRole("button", { name: "My teams", exact: false }).click();
  await page.getByRole("button", { name: "Open my workspace" }).click();
  await waitFor(() => connections === beforeReload + 2, "automatic project reopen");
  await page.getByRole("button", { name: "Stop generation" }).waitFor();
  assert.equal(await page.getByLabel("Agent model").inputValue(), "claude");
  const stops = requests.filter((request) => request.type === "stop").length;
  await page.getByRole("button", { name: "Stop generation" }).click();
  await waitFor(
    () => requests.filter((request) => request.type === "stop").length === stops + 1,
    "cancel restored turn",
  );
  emit({ ...snapshot, working: false, text: "Ready" });
  await page
    .getByRole("status")
    .filter({ hasText: /^Ready$/ })
    .waitFor();
  assert.equal(
    await page.locator(".chat-working, .chat-thinking, .live-tool-shine").count(),
    0,
    "Stop acknowledgement clears activity",
  );
  // GLM refresh restores saved state without a key-entry flash, and failures
  // belong to one provider rather than whichever model the UI later selects.
  snapshot.working = false;
  snapshot.savedProviders = ["opencode", "claude"];
  snapshot.failedProviders = [];
  await page.getByLabel("Agent model").selectOption("opencode");
  const beforeGlmReload = connections;
  await page.reload();
  await waitFor(() => connections === beforeGlmReload + 1, "OpenRouter refresh");
  await page
    .getByRole("status")
    .filter({ hasText: /^Ready$/ })
    .waitFor();
  assert.equal(await page.getByLabel("Agent model").inputValue(), "opencode");
  await page.getByRole("button", { name: "Agent connection settings" }).click();
  assert.equal(await page.getByLabel("Agent API key").count(), 0);
  await page.getByText("API key saved", { exact: true }).waitFor();
  emit({
    type: "error",
    id: "network-only",
    text: "Provider timed out",
    provider: "opencode",
    credentialFailure: false,
  });
  await page.getByRole("alert").filter({ hasText: "Provider timed out" }).waitFor();
  assert.equal(await page.getByLabel("Agent API key").count(), 0);
  emit({
    type: "error",
    id: "router-auth",
    text: "The API key was rejected",
    provider: "opencode",
    credentialFailure: true,
  });
  await page.getByLabel("Agent API key").waitFor();
  await page.getByLabel("Agent model").selectOption("claude");
  assert.equal(await page.getByLabel("Agent API key").count(), 0);
  await page.getByLabel("Agent model").selectOption("opencode");
  await page.getByLabel("Agent API key").waitFor();
  emit({ type: "configured", id: "opencode", text: "GLM ready" });
  await page.getByLabel("Agent API key").waitFor({ state: "hidden" });
  await page.getByLabel("Agent model").selectOption("claude");
  snapshot.working = true;
  // A current failure is terminal even if transport drops the later done event.
  emit({
    type: "status",
    id: "error-working",
    text: "Working",
    workingStartedAt: new Date().toISOString(),
  });
  await page.locator(".chat-thinking").waitFor();
  emit({ type: "error", id: "error-without-done", text: "Fixture provider failure" });
  await page
    .locator(".agent-panel")
    .getByRole("alert")
    .filter({ hasText: "Fixture provider failure" })
    .waitFor();
  assert.equal(await page.locator(".chat-working, .chat-thinking, .live-tool-shine").count(), 0);
  emit({ ...snapshot, working: false, text: "Ready", currentError: null });
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  assert(!stored.includes("test-fixture-not-a-real-key"));
  assert(!stored.includes("test-claude-fixture-not-a-real-key"));
  assert(!stored.includes("monthly comparison"));
  // Real TeamUpdates -> Workspace -> Agent integration. Resolving is the
  // explicit authorization; Git preparation must release its busy flag before
  // handing off so an already-connected agent sends immediately, once.
  await page.setViewportSize({ width: 1440, height: 1000 });
  teamIncoming = true;
  const beforeResolution = requests.filter((request) => request.type === "prompt").length;
  await page.locator(".team-updates > button").click();
  await page.getByRole("button", { name: "Get updates", exact: true }).click();
  await page.getByRole("button", { name: "Resolve with agent", exact: true }).waitFor();
  assert.equal(requests.filter((request) => request.type === "prompt").length, beforeResolution);
  await page.getByRole("button", { name: "Resolve with agent", exact: true }).click();
  await waitFor(
    () => requests.filter((request) => request.type === "prompt").length === beforeResolution + 1,
    "ready team-resolution handoff after Git setup releases busy",
  );
  assert.deepEqual(requests.filter((request) => request.type === "prompt").at(-1), {
    type: "prompt",
    provider: "claude",
    text: resolutionPrompt,
  });
  assert.deepEqual(teamUpdateModes, ["pull", "agent"]);
  assert.equal(
    await page.getByRole("region", { name: "Pending team resolution request" }).count(),
    0,
  );
  assert.equal(teamVerifications, 0);
  emit({ type: "user", id: "user-team-resolution", text: resolutionPrompt });
  emit({ type: "status", id: "working-team-resolution", text: "Working" });
  await page.getByRole("button", { name: "Stop generation" }).waitFor();
  emit({ type: "done", id: "done-team-resolution", text: "Ready" });
  await waitFor(
    () => teamVerifications === 1,
    "verify completed agent merge using original Git hashes",
  );
  await page.locator(".team-updates > button").click();
  await page
    .getByText("Team updates merged locally. Review the changes, then Share when ready.", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({
    animations: "disabled",
    path: join(artifacts, "agent-team-resolution.png"),
  });
  await page.getByRole("button", { name: "Later", exact: true }).click();
  assert.equal(
    requests.filter((request) => request.type === "prompt").length,
    beforeResolution + 1,
  );
  assert.equal(teamVerifications, 1);
  await checkAgentImages(page, requests, emit, artifacts);
  const lastImage = requests
    .filter((request) => request.type === "prompt")
    .findLast((request) => request.images?.length)?.images?.[0];
  assert(lastImage);
  await page.getByLabel("Choose images").setInputFiles({
    name: "Reconnect.png",
    mimeType: lastImage.mime,
    buffer: Buffer.from(lastImage.data, "base64"),
  });
  await page.getByRole("button", { name: "Remove Reconnect.png" }).waitFor();
  await composer.fill("Reconnect draft");
  snapshot.working = false;
  snapshot.text = "Ready";
  const beforeImageReconnect = connections;
  const beforeImagePrompts = requests.filter((request) => request.type === "prompt").length;
  await activeSocket().close({ code: 1011, reason: "Image reconnect fixture" });
  await waitFor(() => connections === beforeImageReconnect + 1, "image reconnect");
  await page
    .getByRole("status")
    .filter({ hasText: /^Ready$/ })
    .waitFor();
  assert.equal(await composer.inputValue(), "Reconnect draft");
  await page.getByRole("button", { name: "Remove Reconnect.png" }).waitFor();
  assert((await page.locator(".chat-user .chat-images img").count()) > 0);
  assert.equal(requests.filter((request) => request.type === "prompt").length, beforeImagePrompts);
  await page.getByRole("button", { name: "Remove Reconnect.png" }).click();
  await composer.fill("");
  snapshot.working = true;
  snapshot.text = "Working";
  const beforeDenied = connections;
  await activeSocket().close({ code: 1008, reason: "Workspace access revoked" });
  await page
    .locator(".agent-panel")
    .getByRole("alert")
    .filter({ hasText: "no longer has workspace access" })
    .waitFor();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  for (const view of ["Files", "Changes", "Agent"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
  }
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(1200);
  assert.equal(connections, beforeDenied, "Access denial must not retry on navigation or online");
  // A manual retry can recover after signing back in; repeated transient
  // failures then stop after exactly three automatic attempts.
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await waitFor(() => connections === beforeDenied + 1, "manual reconnect");
  await page.getByRole("button", { name: "Stop generation" }).waitFor();
  rejectConnections = true;
  const beforeExhaustion = connections;
  await activeSocket().close({ code: 1011, reason: "Fixture runtime unavailable" });
  await page
    .locator(".agent-panel")
    .getByRole("alert")
    .filter({ hasText: "Could not reconnect to the agent" })
    .waitFor();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(1200);
  assert.equal(connections, beforeExhaustion + 3, "Navigation cannot reset exhausted retry budget");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: full-screen T3 chat, readiness, fixed models, streamed Markdown/code/table, copy, tools, files, questions, keyboard send/stop, errors, mobile, reload/project reopen restoring model/conversation/active turn without reentering a key, real team-resolution handoff and merge verification. Mock agent transport; no model requests or secrets.",
  );
} catch (error) {
  await page.screenshot({
    animations: "disabled",
    path: join(artifacts, "agent-chat-failure.png"),
  });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
