import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { testIdentity } from "../tests/auth-fixture.ts";
import { openPortalMenu } from "./browser-portal-menu.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
export async function verifySiteEventPortal() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-site-browser-"));
  const artifacts = resolve("artifacts/site-event");
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
  let current = await createApp(root, false, origin);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 360, height: 780 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.setDefaultTimeout(10000);
  try {
    const admin = await testIdentity(current.authentication, "Site organizer");
    const participant = await testIdentity(current.authentication, "Site participant");
    assert(admin.actor);
    const actor = admin.actor;
    const events = ["Unrelated smoke event", "Harbor Data Day"].map((name) => {
      const event = unwrap(
        current.service.createEvent(actor, {
          name,
          date: "2026-10-03",
          timezone: "America/Chicago",
          location: "Library",
          capacity: 40,
          budget: 20,
          templateId: "blank",
        }),
      );
      unwrap(current.service.transition(actor, event.id, "registration"));
      const { workspace } = unwrap(
        current.service.createTeam(actor, {
          eventId: event.id,
          name: `${name} team`,
          projectId: "data-starter",
        }),
      );
      return { event, workspace };
    });
    const other = events[0];
    const pinned = events[1];
    assert(other && pinned);
    await current.app.close();
    current = await createApp(root, false, origin, undefined, "email", pinned.event.id);
    await current.app.listen({ host: "127.0.0.1", port });
    for (const theme of ["light", "dark"] as const) {
      for (const [width, height] of [
        [360, 780],
        [390, 844],
        [1440, 900],
        [360, 430],
        [900, 390],
      ]) {
        assert(width && height);
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        await context.clearCookies();
        await page.goto(origin);
        await page.getByRole("heading", { name: pinned.event.name, exact: true }).waitFor();
        assert.equal(await page.title(), pinned.event.name);
        await page.getByLabel("Email address").fill("participant@example.test");
        await page.getByLabel("Email address").focus();
        await page
          .getByRole("button", { name: "Email me a sign-in link" })
          .scrollIntoViewIfNeeded();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: join(artifacts, `sign-in-${width}-${height}-${theme}.png`) });
        await context.addCookies([participant.browserCookie]);
        await page.goto(origin);
        await page.getByRole("heading", { name: "Projects to explore", exact: true }).waitFor();
        assert.equal(await page.getByRole("combobox", { name: "Select event" }).count(), 0);
        assert.equal(
          await page.getByRole("button", { name: /Create (an|your first) event/ }).count(),
          0,
        );
        assert.equal(await page.getByText(other.event.name, { exact: true }).count(), 0);
        assert.equal(await page.locator(".brand").innerText(), pinned.event.name);
        assert.equal(await page.getByRole("button", { name: "Admin overview" }).count(), 0);
        assert.equal(
          await page.getByRole("button", { name: "Event admin", exact: true }).count(),
          0,
        );
        await page.getByRole("button", { name: "Start a team", exact: true }).first().tap();
        await page.getByLabel("Team name").fill("Draft team");
        const create = page.getByRole("button", { name: "Create and join team" });
        await create.scrollIntoViewIfNeeded();
        const box = await create.boundingBox();
        assert(box && box.y >= 0 && box.y + box.height <= height + 1);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole("button", { name: "Close dialog" }).tap();
        await page.locator(".brand").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(artifacts, `projects-${width}-${height}-${theme}.png`),
        });
        await context.clearCookies();
        await context.addCookies([admin.browserCookie]);
        await page.goto(`${origin}/#workspace=${other.workspace.id}`);
        await page.reload();
        await page.getByRole("heading", { name: "Projects to explore", exact: true }).waitFor();
        assert.equal(await page.locator(".workspace-screen").count(), 0);
        await page.waitForURL(`${origin}/`);
        assert.equal(new URL(page.url()).hash, "");
        // Assert initial bounds BEFORE Playwright can scroll a clipped control into view.
        const adminEntry = page.getByRole("button", { name: "Event admin", exact: true });
        const entryBox = await adminEntry.boundingBox();
        assert(
          entryBox &&
            entryBox.x >= 0 &&
            entryBox.y >= 0 &&
            entryBox.x + entryBox.width <= width &&
            entryBox.y + entryBox.height <= height &&
            entryBox.height >= 44,
        );
        await adminEntry.tap();
        await page.getByRole("heading", { name: "People & event roles", exact: true }).waitFor();
        await openPortalMenu(page);
        await page.getByRole("button", { name: "Explore projects", exact: true }).tap();
        await page.getByRole("heading", { name: "Projects to explore", exact: true }).waitFor();
        await openPortalMenu(page);
        const portalToggle = page.getByRole("button", { name: "Portal navigation", exact: true });
        const adminNav = page.getByRole("button", { name: "Admin overview", exact: true });
        const navBox = await adminNav.boundingBox();
        assert(
          navBox &&
            navBox.x >= 0 &&
            navBox.x + navBox.width <= width &&
            navBox.y >= 0 &&
            navBox.y + navBox.height <= height,
        );
        if (await portalToggle.isVisible()) {
          assert(navBox.height >= 44);
          const panel = await page.locator(".sidebar .mobile-menu-content").boundingBox();
          assert(
            panel && navBox.y >= panel.y && navBox.y + navBox.height <= panel.y + panel.height,
          );
          await page.screenshot({
            path: join(artifacts, `portal-menu-${width}-${height}-${theme}.png`),
          });
          await page.keyboard.press("Escape");
          assert.equal(await portalToggle.getAttribute("aria-expanded"), "false");
          assert(await portalToggle.evaluate((el) => document.activeElement === el));
          await portalToggle.press("Enter");
        }
        await adminNav.tap();
        await page.getByRole("heading", { name: "People & event roles", exact: true }).waitFor();
        await page.screenshot({
          path: join(artifacts, `admin-entry-${width}-${height}-${theme}.png`),
        });
        await page.getByRole("button", { name: "Create project", exact: true }).tap();
        await page.getByLabel("Project name", { exact: true }).fill("New project draft");
        await page
          .getByLabel("Project brief (Markdown)")
          .fill("# Local project\n\nExplore the community data.");
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Create project", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(artifacts, `admin-${width}-${height}-${theme}.png`) });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole("button", { name: "Close dialog" }).tap();
      }
    }
    // Valid pinned workspace links still reattach and survive refresh.
    await page.goto(`${origin}/#workspace=${pinned.workspace.id}`);
    await page.reload();
    await page.locator(".workspace-screen").waitFor();
    await page.reload();
    await page.locator(".workspace-screen").waitFor();
    assert.equal(
      new URLSearchParams(new URL(page.url()).hash.slice(1)).get("workspace"),
      pinned.workspace.id,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: configured event with multiple underlying events; anonymous branding/title, participant project/team controls, admin project dialog, no switcher/create-event UI, stale workspace exclusion and valid workspace refresh, 360/390/desktop/short in both themes; clean console.",
    );
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
    console.error({ errors });
    throw error;
  } finally {
    await browser.close();
    await current.app.close();
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifySiteEventPortal();
