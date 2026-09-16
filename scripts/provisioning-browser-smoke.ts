import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { PortalState, Workspace } from "../packages/domain/src/access-types.ts";

const root = mkdtempSync(join(tmpdir(), "vibehack-provision-browser-"));
const artifacts = resolve("artifacts");
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors: string[] = [];
let workspace: Workspace | undefined;
let phase: Workspace["spritePhase"] = null;
let status: Workspace["spriteStatus"] = "local";
let posts = 0;
let polls = 0;
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/state", async (route) => {
  const response = await route.fetch();
  const state = (await response.json()) as PortalState;
  state.capabilities.sprites = true;
  for (const item of state.myWorkspaces) {
    item.spriteStatus = status;
    item.spritePhase = phase;
    item.spriteName = status === "local" ? null : "vibehack-provision-fixture";
    workspace = item;
  }
  await route.fulfill({ response, json: state });
});
await page.route("**/api/workspaces/*/sprite", async (route) => {
  if (route.request().method() === "POST") {
    posts += 1;
    if (posts === 1)
      return route.fulfill({
        status: 409,
        json: { error: "The provider is unavailable. Retry preparation." },
      });
    status = "provisioning";
    phase = "creating";
    return route.fulfill({ status: 202, json: { preparing: true } });
  }
  polls += 1;
  await route.fulfill({
    json: {
      ...workspace,
      spriteStatus: status,
      spritePhase: phase,
      spriteUpdatedAt: new Date().toISOString(),
    },
  });
});
try {
  await page.goto(address);
  await page.getByLabel("Email address").fill("provisioning@example.test");
  await page.getByRole("button", { name: "Enter prototype" }).click();
  await page.getByRole("button", { name: "Create your first event" }).click();
  await page.getByLabel("Event name").fill("Provisioning fixture");
  await page.getByLabel("Date", { exact: true }).fill("2026-10-03");
  await page.getByLabel("Location").fill("Oak Park");
  await page.getByRole("button", { name: "Create event", exact: true }).click();
  await page.getByRole("button", { name: "Open registration" }).click();
  await page.getByRole("button", { name: "Explore projects", exact: true }).click();
  await page.getByRole("button", { name: "Create a team", exact: true }).click();
  await page.getByLabel("Team name").fill("Preparation team");
  await page.getByRole("button", { name: "Create and join team" }).click();
  await page.getByRole("button", { name: "Open my workspace" }).click();
  await page.getByRole("alert").filter({ hasText: "provider is unavailable" }).waitFor();
  const before = polls;
  await page.waitForTimeout(2300);
  assert(polls > before, "Status polling must continue after an initial start failure");
  assert.equal(posts, 1, "A failed start must not retry endlessly");
  assert(
    await page.getByRole("alert").filter({ hasText: "provider is unavailable" }).isVisible(),
    "Status polling must retain the start error",
  );
  await page.screenshot({
    path: join(artifacts, "provisioning-start-error.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Retry preparation" }).click();
  await page.getByRole("status").filter({ hasText: "Creating your personal Sprite" }).waitFor();
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Creating your personal Sprite" }).waitFor();
  assert.equal(posts, 2, "Reload during preparation must attach to the existing job");
  phase = "checkout";
  await page.getByRole("status").filter({ hasText: "Copying and checking out" }).waitFor();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator('html[data-theme="dark"]').waitFor();
  await page.waitForFunction(() => {
    const button = document.querySelector(".workspace-header button");
    return button && getComputedStyle(button).backgroundColor === "rgb(28, 32, 36)";
  });
  await page.screenshot({
    path: join(artifacts, "provisioning-progress-dark.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(artifacts, "provisioning-progress-mobile.png"),
    animations: "disabled",
  });
  phase = "ready";
  status = "ready";
  await page.getByRole("button", { name: "Files", exact: true }).waitFor();
  assert.equal(posts, 2);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: startup error persists, explicit retry, real phases, reload attaches without duplicate creation, and ready opens files; no Sprite/model calls.",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
