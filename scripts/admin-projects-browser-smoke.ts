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

function unwrap<T>(result: Result<T>) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
// Deliberately inspect bounds before any Playwright scroll or click can hide clipping.
async function visibleBounds(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const size = page.viewportSize();
  assert(
    box &&
      size &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= size.width + 1 &&
      box.y + box.height <= size.height + 1,
    `Clipped: ${await locator.innerText()}`,
  );
}
export async function verifyAdminProjects() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-admin-browser-"));
  const artifacts = resolve("artifacts/admin-projects");
  mkdirSync(artifacts, { recursive: true });
  const { app, service } = await createApp(
    root,
    false,
    "http://127.0.0.1:4311",
    undefined,
    "prototype",
  );
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const admin = {
    id: "catalog@example.test",
    email: "catalog@example.test",
    name: "Catalog organizer",
    emailVerified: true as const,
  };
  const member = {
    id: "participant@example.test",
    email: "participant@example.test",
    name: "Catalog participant",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(admin, {
      name: "Catalog event",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 40,
      budget: 0,
      templateId: "diod",
    }),
  );
  unwrap(service.transition(admin, event.id, "registration"));
  const id = unwrap(
    service.createProject(admin, event.id, {
      name: "Editable project",
      brief:
        "  # Full source\n\n[Data](https://example.test/data?a=1&b=%20)  \n\n" +
        "Source paragraph.\n".repeat(500),
    }),
  ).id;
  const existing = unwrap(
    service.createTeam(member, { eventId: event.id, name: "Existing team", projectId: id }),
  );
  const before = unwrap(service.readFile(member, existing.workspace.id, "PROJECT.md"));
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 360, height: 780 },
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  async function state() {
    return (await (await context.request.get(`${origin}/api/state`)).json()) as PortalState;
  }
  async function login(email: string) {
    await page.goto(origin);
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Enter prototype" }).click();
    await page.getByRole("heading", { name: "Catalog event", exact: true }).waitFor();
  }
  async function edit(name: string) {
    await openAdminSection(page, "Projects");
    await page
      .locator(".project-card")
      .filter({ has: page.getByRole("heading", { name, exact: true }) })
      .getByRole("button", { name: "Edit project", exact: true })
      .click();
  }
  try {
    await login(admin.email);
    let name = "Editable project";
    for (const theme of ["light", "dark"] as const)
      for (const [width, height] of [
        [360, 780],
        [390, 844],
        [1440, 900],
        [360, 430],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.reload();
        await page.getByRole("button", { name: "Event admin", exact: true }).waitFor();
        await visibleBounds(page, page.getByRole("button", { name: "Event admin", exact: true }));
        await page.getByRole("button", { name: "Event admin", exact: true }).click();
        await openPortalMenu(page);
        const nav = page.getByRole("navigation", {
          name: "Admin navigation",
          exact: true,
          includeHidden: true,
        });
        for (const label of ["Sprites", "Projects", "Teams", "People & roles"])
          await visibleBounds(page, nav.getByRole("button", { name: label, exact: true }));
        await page.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-menu.png`) });
        const menu = page.getByRole("button", { name: "Portal navigation", exact: true });
        if (await menu.isVisible()) {
          await page.keyboard.press("Escape");
          assert.equal(await menu.getAttribute("aria-expanded"), "false");
          assert(await menu.evaluate((el) => el === document.activeElement));
        }
        for (const section of ["Sprites", "Teams", "People & roles", "Projects"] as const) {
          await openAdminSection(page, section);
          assert.equal(
            await nav
              .getByRole("button", { name: section, exact: true, includeHidden: true })
              .getAttribute("aria-current"),
            "page",
          );
          assert.equal(
            await page.getByRole("heading", { name: "People & event roles", exact: true }).count(),
            section === "People & roles" ? 1 : 0,
          );
        }
        await edit(name);
        const dialog = page.getByRole("dialog", { name: "Edit project", exact: true });
        const project = (await state()).events[0]?.projects.find((p) => p.id === id);
        assert(project);
        assert.equal(
          await dialog.getByLabel("Project brief (Markdown)").inputValue(),
          project.description,
        );
        await visibleBounds(
          page,
          dialog.getByRole("button", { name: "Save project", exact: true }),
        );
        assert.equal(
          await dialog
            .getByLabel("Project name", { exact: true })
            .evaluate((el) => getComputedStyle(el).fontSize),
          "16px",
        );
        name = `Edited ${theme} ${width} ${height}`;
        const brief = `${project.description}\n[More data](https://example.test/next?a=1&b=%20)  \n`;
        await dialog.getByLabel("Project name", { exact: true }).fill(name);
        await dialog.getByLabel("Project brief (Markdown)").fill(brief);
        await visibleBounds(page, dialog.getByLabel("Project brief (Markdown)"));
        await page.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-edit.png`) });
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await openAdminSection(page, "Teams");
        await openPortalMenu(page);
        await page.getByRole("button", { name: "Explore projects", exact: true }).click();
        await openAdminSection(page, "Projects");
        await page.getByRole("button", { name: "Resume project draft", exact: true }).click();
        assert.equal(await dialog.getByLabel("Project brief (Markdown)").inputValue(), brief);
        // Responsive changes preserve the same draft and revision.
        await page.setViewportSize({ width: width === 360 ? 390 : 360, height: 430 });
        assert.equal(await dialog.getByLabel("Project name", { exact: true }).inputValue(), name);
        await page.setViewportSize({ width, height });
        await dialog.getByRole("button", { name: "Save project", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await page.reload();
        await openAdminSection(page, "Projects");
        assert.equal(
          (await state()).events[0]?.projects.find((p) => p.id === id)?.description,
          brief,
        );
        await page.getByRole("heading", { name, exact: true }).waitFor();
        await page.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-saved.png`) });
        await openPortalMenu(page);
        await page.getByRole("button", { name: "Explore projects", exact: true }).click();
        const card = page
          .locator(".project-card")
          .filter({ has: page.getByRole("heading", { name, exact: true }) });
        await card.getByRole("button", { name: "Start a team", exact: true }).click();
        assert.equal(await page.getByLabel("Project", { exact: true }).inputValue(), id);
        await page.getByRole("button", { name: "Close dialog", exact: true }).click();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    // A second editor writes while this dialog still holds an earlier revision.
    await edit(name);
    const current = (await state()).events[0]?.projects.find((p) => p.id === id);
    assert(current);
    await page.getByLabel("Project name", { exact: true }).fill("Unsaved conflicting draft");
    unwrap(
      service.updateProject(admin, event.id, id, {
        name: "Second editor saved",
        brief: current.description,
        expectedRevision: current.revision ?? 0,
      }),
    );
    const response = page.waitForResponse((r) => r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    assert.equal((await response).status(), 409);
    await page.getByRole("alert").filter({ hasText: "This project changed" }).waitFor();
    assert.equal(
      await page.getByLabel("Project name", { exact: true }).inputValue(),
      "Unsaved conflicting draft",
    );
    await page.getByRole("button", { name: "Load latest version", exact: true }).waitFor();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Load latest version", exact: true }).click();
    assert.equal(
      await page.getByLabel("Project name", { exact: true }).inputValue(),
      "Second editor saved",
    );
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    assert.equal(
      unwrap(service.readFile(member, existing.workspace.id, "PROJECT.md")).content,
      before.content,
    );
    await openAdminSection(page, "Teams");
    const download = await context.request.get(`${origin}/api/teams/${existing.team.id}/export`);
    assert.equal(download.status(), 200);
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", { name: "Remove Catalog participant from Existing team", exact: true })
      .click();
    await page.getByText("No members yet", { exact: true }).waitFor();
    await context.clearCookies();
    await login(member.email);
    await openPortalMenu(page);
    assert.equal(
      await page
        .getByRole("navigation", { name: "Admin navigation", exact: true, includeHidden: true })
        .count(),
      0,
    );
    assert.equal(await page.getByRole("button", { name: "Event admin", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Edit project", exact: true }).count(), 0);
    assert.deepEqual(
      errors.filter((e) => !e.includes("409 (Conflict)")),
      [],
    );
    console.log(
      "PASS: admin subsection navigation, exact project edit/save/reload, long Markdown, stale conflicts, retained drafts, membership removal, shared ZIP, participant isolation; 360/390/desktop/short in both themes, initial bounds and screenshots, no unexpected console errors.",
    );
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure.png") });
    console.error(await page.locator("body").innerText());
    throw error;
  } finally {
    await browser.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await verifyAdminProjects();
