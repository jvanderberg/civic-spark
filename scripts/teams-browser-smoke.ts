import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { openAdminSection, openPortalMenu } from "./browser-portal-menu.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
async function bounds(page: Page, target: Locator) {
  const box = await target.boundingBox();
  const size = page.viewportSize();
  assert(
    box &&
      size &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= size.width + 1 &&
      box.y + box.height <= size.height + 1,
  );
  assert(box.height >= 44);
}
export async function verifyTeamsPortal() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-teams-browser-"));
  const artifacts = resolve("artifacts/teams");
  mkdirSync(artifacts, { recursive: true });
  // Cloud execution is disabled; all repositories are disposable local fixtures.
  const { app, service } = await createApp(
    root,
    false,
    "http://127.0.0.1:4311",
    undefined,
    "prototype",
  );
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const admin = {
    id: "teams-admin@example.test",
    email: "teams-admin@example.test",
    name: "Team organizer",
    emailVerified: true as const,
  };
  const participant = {
    id: "teams-member@example.test",
    email: "teams-member@example.test",
    name: "Team participant",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(admin, {
      name: "Community teams",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 80,
      budget: 0,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(admin, event.id, "registration"));
  const project = unwrap(
    service.createProject(admin, event.id, {
      name: "Neighborhood connections and accessible community spaces",
      brief: "Explore local connections with community data and compare access.",
    }),
  );
  const seeded = Array.from({ length: 16 }, (_, i) =>
    unwrap(
      service.createTeam(admin, {
        eventId: event.id,
        name: i === 0 ? "Neighborhood access and community connections" : `Community team ${i + 1}`,
        projectId: project.id,
      }),
    ),
  );
  const other = unwrap(
    service.createEvent(admin, {
      name: "Other event",
      date: "2026-10-04",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 80,
      budget: 0,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(admin, other.id, "registration"));
  unwrap(
    service.createTeam(admin, {
      eventId: other.id,
      name: "Other event team",
      projectId: "data-starter",
    }),
  );
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 360, height: 780 },
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  const runtimeRequests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("request", (request) => {
    if (/\/api\/workspaces\//.test(request.url())) runtimeRequests.push(request.url());
  });
  async function navigate(name: string) {
    await openPortalMenu(page);
    await page
      .locator(".main-nav:not(.admin-nav) > button")
      .filter({ hasText: name === "Teams" ? /^\s*Teams\s*$/ : name })
      .click();
  }
  async function login(email: string) {
    // End the previous account’s polling before replacing its test cookies.
    await page.goto("about:blank");
    await context.clearCookies();
    await page.goto(origin);
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Enter prototype" }).click();
    await page.getByRole("heading", { name: "Projects to explore", exact: true }).waitFor();
    await openPortalMenu(page);
    await page.getByLabel("Select event").selectOption(event.id);
    const menu = page.getByRole("button", { name: "Portal navigation", exact: true });
    if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) === "true")
      await page.keyboard.press("Escape");
  }
  try {
    await login(participant.email);
    for (const theme of ["light", "dark"] as const)
      for (const [width, height] of [
        [360, 780],
        [390, 844],
        [1440, 900],
        [360, 430],
        [900, 390],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        await page.reload();
        await page.getByRole("heading", { name: "Projects to explore", exact: true }).waitFor();
        assert.equal(await page.locator(".team-card, .team-list").count(), 0);
        assert.equal(await page.getByRole("button", { name: "Join team", exact: true }).count(), 0);
        await openPortalMenu(page);
        const nav = page.locator(".main-nav:not(.admin-nav) > button");
        assert.deepEqual(
          (await nav.allTextContents()).map((t) => t.trim()),
          ["Explore projects", "Teams", "My teams 0", "Event schedule"],
        );
        // Initial geometry is captured before click/scrollIntoView can mask clipping.
        for (const button of await nav.all()) await bounds(page, button);
        await page.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-menu.png`) });
        await nav.filter({ hasText: /^\s*Teams\s*$/ }).press("Enter");
        const list = page.getByRole("region", { name: "Event teams", exact: true });
        await list.waitFor();
        assert.equal(await page.locator(".team-list-row").count(), 16);
        assert.equal(await page.getByText("Other event team", { exact: true }).count(), 0);
        assert.equal(
          await page.getByRole("button", { name: "Repository", exact: true }).count(),
          0,
        );
        const first = page.locator(".team-list-row").first();
        assert.match(
          await first.innerText(),
          /Neighborhood connections and accessible community spaces/,
        );
        assert.match(await first.innerText(), /1 member/);
        assert.match(await first.innerText(), /Team organizer/);
        assert.equal(await first.getByRole("link", { name: "Team ZIP" }).count(), 0);
        await first
          .getByRole("button", { name: "Join team", exact: true })
          .scrollIntoViewIfNeeded();
        await bounds(page, first.getByRole("button", { name: "Join team", exact: true }));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-list.png`) });
        await list.focus();
        await page.keyboard.press("End");
        await page.waitForFunction(() => {
          const panel = document.querySelector(".team-list");
          return panel && panel.scrollTop >= panel.scrollHeight - panel.clientHeight - 1;
        });
        await page.screenshot({
          path: join(artifacts, `${theme}-${width}-${height}-scrolled.png`),
        });
        await navigate("My teams");
        await page.getByRole("heading", { name: "You haven’t joined a team yet" }).waitFor();
        assert.equal(await page.locator(".team-card").count(), 0);
      }
    assert.deepEqual(runtimeRequests, [], "Listing and navigation never open a workspace/runtime");
    await page.setViewportSize({ width: 390, height: 844 });
    await navigate("Teams");
    await page
      .locator(".team-list-row")
      .first()
      .getByRole("button", { name: "Join team", exact: true })
      .tap();
    await page.getByRole("heading", { name: "Your teams, your workspaces", exact: true }).waitFor();
    await page.getByRole("button", { name: "Open my workspace", exact: true }).waitFor();
    assert.equal(await page.locator(".team-card").count(), 1);
    assert.deepEqual(runtimeRequests, [], "Joining reserves the workspace without waking it");
    const state = (await (await context.request.get(`${origin}/api/state`)).json()) as PortalState;
    const own = state.myWorkspaces.find((w) => w.teamId === seeded[0]?.team.id);
    assert(own && own.id !== seeded[0]?.workspace.id);
    assert.equal(
      (
        await context.request.get(`${origin}/api/workspaces/${seeded[0]?.workspace.id}/files`)
      ).status(),
      404,
    );
    assert.equal(
      (await context.request.get(`${origin}/api/teams/${own.teamId}/export`)).status(),
      200,
    );
    await navigate("Teams");
    const joined = page.locator(".team-list-row").first();
    assert.match(await joined.innerText(), /2 members · Your team/);
    await joined.getByRole("button", { name: "Open my workspace", exact: true }).tap();
    await page.locator(".workspace-screen").waitFor();
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("workspace"), own.id);
    await page.reload();
    await page.locator(".workspace-screen").waitFor();
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("workspace"), own.id);
    await login(admin.email);
    await navigate("Teams");
    assert.equal(await page.locator(".team-list-row").count(), 16);
    await openAdminSection(page, "Teams");
    assert.equal(await page.getByRole("button", { name: "Repository", exact: true }).count(), 16);
    await navigate("Teams");
    assert.equal(await page.getByRole("button", { name: "Repository", exact: true }).count(), 0);
    await openPortalMenu(page);
    await page.getByLabel("Select event").selectOption(other.id);
    await navigate("Teams");
    assert.equal(await page.locator(".team-list-row").count(), 1);
    await page.getByRole("heading", { name: "Other event team", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      "PASS: distinct compact Teams, Projects-only discovery, initial main menu order/bounds, event scoping, My teams/Admin scopes, join/own-workspace/reload/ZIP isolation, no runtime calls while listing/joining; internal keyboard scroll, touch, 360/390/desktop/short/landscape both themes, clean console.",
    );
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure.png") });
    console.error({ errors, body: await page.locator("body").innerText() });
    throw error;
  } finally {
    await browser.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifyTeamsPortal();
