import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import { defaultProjectBriefGuidance, type Result } from "../packages/domain/src/types.ts";
import { openPortalMenu } from "./browser-portal-menu.ts";

// Server-side changes made outside this tab arrive on the 15 s portal poll;
// a visibility event asks the app to refresh immediately, as returning to the
// tab would.
const refreshPortal = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function bounds(page: Page, target: Locator) {
  const box = await target.boundingBox();
  const viewport = page.viewportSize();
  assert(
    box &&
      viewport &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1,
    "Control must fit viewport",
  );
}
export async function verifyParticipantProjects() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-participant-project-browser-"));
  const artifacts = resolve("artifacts/participant-projects");
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
    id: "project-admin@example.test",
    name: "Project admin",
    email: "project-admin@example.test",
    emailVerified: true as const,
  };
  const event = value(
    service.createEvent(admin, {
      name: "Participant projects",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 1,
      budget: 0,
      templateId: "blank",
    }),
  );
  value(service.transition(admin, event.id, "registration"));
  const seed = value(
    service.createProject(admin, event.id, {
      name: "Existing idea",
      brief: "An existing project for the team selector.",
    }),
  ).id;
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 360, height: 780 },
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  const remoteRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(origin) && /^https?:/.test(request.url()))
      remoteRequests.push(request.url());
  });
  const state = async () =>
    (await (await context.request.get(`${origin}/api/state`)).json()) as PortalState;
  let projectPosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/events/${event.id}/projects`))
      projectPosts++;
  });
  try {
    await page.goto(origin);
    await page.getByLabel("Email address").fill("project-participant@example.test");
    await page.getByRole("button", { name: "Enter prototype", exact: true }).click();
    await page.getByRole("heading", { name: event.name, exact: true }).waitFor();
    assert.equal((await state()).events[0]?.role, "visitor");
    assert.equal(await page.getByRole("button", { name: "Event admin", exact: true }).count(), 0);
    const brief =
      "  ## Useful outcome\n\nHelp **neighbors** find data.\n\n[Source](https://example.test/data?a=1&b=%20#rows)  \n\n- Done when a small demo works.\n";
    let lastProject = "";
    for (const theme of ["light", "dark"] as const) {
      for (const [width, height] of [
        [360, 780],
        [390, 844],
        [1440, 900],
        [360, 430],
        [900, 390],
      ] as const) {
        const label = `${theme}-${width}-${height}`;
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        const create = page.getByRole("button", { name: "Create project", exact: true });
        await create.tap();
        let dialog = page.getByRole("dialog", { name: "Create project", exact: true });
        await dialog.getByLabel("Project title").fill(`Catalog ${label}`);
        assert.equal(
          await dialog.locator(".project-creation-guidance").innerText(),
          defaultProjectBriefGuidance,
        );
        assert.equal(
          await dialog
            .locator(".project-creation-guidance a, .project-creation-guidance img")
            .count(),
          0,
        );
        await dialog.getByLabel("Project brief (Markdown)").fill(brief);
        await page.setViewportSize({ width: width === 390 ? 360 : 390, height: 430 });
        assert.equal(await dialog.getByLabel("Project brief (Markdown)").inputValue(), brief);
        await page.setViewportSize({ width, height });
        await bounds(page, dialog.getByRole("button", { name: "Create project", exact: true }));
        await page.screenshot({ path: join(artifacts, `${label}-project.png`) });
        await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
        await dialog.waitFor({ state: "detached" });
        await page.waitForFunction(
          () => document.activeElement?.textContent?.trim() === "Create project",
        );
        assert(
          await create.evaluate((element) => element === document.activeElement),
          "Restore focus to Projects action",
        );
        await openPortalMenu(page);
        await page.getByRole("button", { name: "Event schedule", exact: true }).click();
        await openPortalMenu(page);
        await page.getByRole("button", { name: "Explore projects", exact: true }).click();
        await create.click();
        dialog = page.getByRole("dialog", { name: "Create project", exact: true });
        assert.equal(await dialog.getByLabel("Project title").inputValue(), `Catalog ${label}`);
        assert.equal(await dialog.getByLabel("Project brief (Markdown)").inputValue(), brief);
        const beforePosts = projectPosts;
        if (label === "light-360-780") {
          await dialog.getByLabel("Project brief (Markdown)").fill(" ".repeat(40));
          assert.equal(
            await dialog.getByLabel("Project brief (Markdown)").inputValue(),
            " ".repeat(40),
          );
          await page.keyboard.press("Tab");
          assert.equal(
            await dialog.getByLabel("Project brief (Markdown)").inputValue(),
            " ".repeat(40),
          );
          await dialog.getByRole("button", { name: "Create project", exact: true }).click();
          await dialog.getByRole("alert").filter({ hasText: "at least 20 characters" }).waitFor();
          assert.equal(projectPosts, beforePosts);
          await dialog.getByLabel("Project brief (Markdown)").fill(brief);
          let release: () => void = () => {};
          let received: () => void = () => {};
          const pending = new Promise<void>((resolve) => {
            release = resolve;
          });
          const started = new Promise<void>((resolve) => {
            received = resolve;
          });
          await page.route(
            `**/events/${event.id}/projects`,
            async (route) => {
              const response = await route.fetch({
                headers: { ...route.request().headers(), "if-none-match": "" },
              });
              received();
              await pending;
              await route.fulfill({ response });
            },
            { times: 1 },
          );
          await dialog.locator("form").evaluate((form) => {
            (form as HTMLFormElement).requestSubmit();
            (form as HTMLFormElement).requestSubmit();
          });
          await started;
          assert(await dialog.getByRole("button", { name: "Saving…", exact: true }).isDisabled());
          // Polling can learn the created project before its POST response reaches the form.
          await page.waitForFunction(
            (name) =>
              [...document.querySelectorAll(".project-card h2")].some(
                (heading) => heading.textContent === name,
              ),
            `Catalog ${label}`,
            { timeout: 25000 }, // Background portal polling runs every 15 s.
          );
          release();
        } else {
          await dialog.getByRole("button", { name: "Create project", exact: true }).focus();
          await page.keyboard.press("Enter");
        }
        await dialog.waitFor({ state: "detached" });
        assert.equal(projectPosts, beforePosts + 1);
        await page.getByRole("heading", { name: `Catalog ${label}`, exact: true }).waitFor();
        assert.equal(
          await page.getByRole("heading", { name: `Catalog ${label}`, exact: true }).count(),
          1,
        );
        let snapshot = await state();
        const catalogProject = snapshot.events[0]?.projects.find(
          (project) => project.name === `Catalog ${label}`,
        );
        assert(catalogProject && snapshot.events[0]);
        assert.equal(
          value(service.project(admin, snapshot.events[0].id, catalogProject.id)).description,
          brief,
        );
        assert.equal(snapshot.teams.length, 0);
        assert.equal(snapshot.myWorkspaces.length, 0);
        assert.equal(snapshot.events[0]?.role, "visitor");
        await page.getByRole("button", { name: "Create a team", exact: true }).tap();
        const team = page.getByRole("dialog", { name: "Start a team", exact: true });
        await team.getByLabel("Team name").fill(`Team draft ${label}`);
        await team.getByLabel("Project", { exact: true }).selectOption(seed);
        await team.getByLabel("Project", { exact: true }).selectOption("new");
        dialog = page.getByRole("dialog", { name: "Create project", exact: true });
        assert.equal(await page.locator("dialog[open]").count(), 1);
        await dialog.getByLabel("Project title").fill("Existing idea");
        await dialog.getByLabel("Project brief (Markdown)").fill(brief);
        await page.keyboard.press("Escape");
        assert.equal(await team.getByLabel("Team name").inputValue(), `Team draft ${label}`);
        assert.equal(await team.getByLabel("Project", { exact: true }).inputValue(), seed);
        await page.waitForFunction(() => document.activeElement?.tagName === "SELECT");
        await team.getByLabel("Project", { exact: true }).selectOption("new");
        await dialog.getByRole("button", { name: "Create project", exact: true }).click();
        await dialog.getByRole("alert").filter({ hasText: "already exists" }).waitFor();
        assert.equal(await dialog.getByLabel("Project brief (Markdown)").inputValue(), brief);
        await bounds(page, dialog.getByRole("button", { name: "Cancel", exact: true }));
        await page.screenshot({ path: join(artifacts, `${label}-error.png`) });
        lastProject = `Nested ${label}`;
        await dialog.getByLabel("Project title").fill(lastProject);
        await dialog.getByRole("button", { name: "Create project", exact: true }).tap();
        await team.waitFor();
        assert.equal(await page.locator("dialog[open]").count(), 1);
        assert.equal(await team.getByLabel("Team name").inputValue(), `Team draft ${label}`);
        assert.equal(await team.locator("option:checked").innerText(), lastProject);
        await page.waitForFunction(() => document.activeElement?.tagName === "SELECT");
        snapshot = await state();
        assert.equal(snapshot.teams.length, 0, "Project creation must not submit team");
        assert.equal(snapshot.myWorkspaces.length, 0);
        await bounds(page, team.getByRole("button", { name: "Create and join team" }));
        await page.screenshot({ path: join(artifacts, `${label}-returned-team.png`) });
        await team.getByRole("button", { name: "Cancel", exact: true }).click();
      }
    }
    await page.getByRole("button", { name: "Create a team", exact: true }).click();
    const team = page.getByRole("dialog", { name: "Start a team", exact: true });
    await team.getByLabel("Project", { exact: true }).selectOption({ label: lastProject });
    await team.getByRole("button", { name: "Create and join team" }).click();
    await team.waitFor({ state: "detached" });
    const joined = await state();
    assert.equal(joined.myWorkspaces.length, 1);
    const file = await context.request.get(
      `${origin}/api/workspaces/${joined.myWorkspaces[0]?.id}/file?path=PROJECT.md`,
    );
    assert.equal((await file.json()).content, `# ${lastProject}\n\n${brief}\n`);
    await openPortalMenu(page);
    await page.getByRole("button", { name: "Explore projects", exact: true }).click();
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    const projectDialog = page.getByRole("dialog", { name: "Create project", exact: true });
    await projectDialog.getByLabel("Project title").fill("Guided project at capacity");
    await projectDialog.getByLabel("Project brief (Markdown)").fill(brief);
    const adminContext = await browser.newContext();
    try {
      assert(
        (
          await adminContext.request.post(`${origin}/api/prototype/sign-in`, {
            data: { email: admin.email },
          })
        ).ok(),
      );
      const current = (await state()).events.find((item) => item.id === event.id);
      assert(current);
      const guidance =
        'New organizer guidance: describe a useful demo.\n<img src="https://example.test/help.png" onerror="alert(1)"> <script>alert(1)</script>\nhttps://example.test/help';
      const response = await adminContext.request.patch(`${origin}/api/events/${event.id}`, {
        data: {
          name: current.name,
          date: current.date,
          timezone: current.timezone,
          location: current.location,
          capacity: current.capacity,
          budget: current.budget,
          description: current.description,
          address: current.address,
          startTime: current.startTime,
          endTime: current.endTime,
          schedule: current.schedule,
          expectedRevision: current.revision,
          projectBriefGuidance: guidance,
        },
      });
      assert.equal(response.status(), 200);
      // Admin guidance saved elsewhere reaches this tab on its 15 s portal poll.
      await projectDialog
        .locator(".project-creation-guidance")
        .filter({ hasText: "New organizer guidance" })
        .waitFor({ timeout: 25000 });
      assert.equal(await projectDialog.locator(".project-creation-guidance").innerText(), guidance);
      assert.equal(
        await projectDialog
          .locator(
            ".project-creation-guidance img, .project-creation-guidance script, .project-creation-guidance a",
          )
          .count(),
        0,
      );
      assert.equal(await projectDialog.getByLabel("Project brief (Markdown)").inputValue(), brief);
      await page.screenshot({ path: join(artifacts, "latest-admin-guidance.png") });
      await projectDialog.getByRole("button", { name: "Create project", exact: true }).click();
      await projectDialog.waitFor({ state: "detached" });
      assert.equal((await state()).teams.length, 1);
      await page.getByRole("button", { name: "Create a team", exact: true }).click();
      await team.getByLabel("Team name").fill("Retained at capacity");
      await team.getByLabel("Project", { exact: true }).selectOption("new");
      assert.equal(await projectDialog.locator(".project-creation-guidance").innerText(), guidance);
      await projectDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await team.getByLabel("Team name").inputValue(), "Retained at capacity");
      await team.getByRole("button", { name: "Cancel", exact: true }).click();
    } finally {
      await adminContext.close();
    }
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await projectDialog.getByLabel("Project title").fill("Retained after close");
    await projectDialog.getByLabel("Project brief (Markdown)").fill(brief);
    value(service.transition(admin, event.id, "live"));
    value(service.transition(admin, event.id, "closed"));
    await projectDialog.getByRole("button", { name: "Create project", exact: true }).click();
    await projectDialog.getByRole("alert").filter({ hasText: "read-only" }).waitFor();
    await page.screenshot({ path: join(artifacts, "event-closed-draft.png") });
    assert.equal(await projectDialog.getByLabel("Project brief (Markdown)").inputValue(), brief);
    await refreshPortal(page);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll<HTMLButtonElement>("dialog button")].some(
          (button) => button.textContent?.trim() === "Create project" && button.disabled,
        ),
      undefined,
      { timeout: 25000 },
    );
    await projectDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const other = value(
      service.createEvent(admin, {
        name: "Separate event",
        date: "2026-10-04",
        timezone: "America/Chicago",
        location: "Library",
        capacity: 4,
        budget: 0,
        templateId: "blank",
      }),
    );
    value(service.transition(admin, other.id, "registration"));
    await refreshPortal(page);
    await page.waitForFunction(
      (id) => [...document.querySelectorAll("option")].some((option) => option.value === id),
      other.id,
      { timeout: 25000 },
    );
    await openPortalMenu(page);
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByLabel("Select event").selectOption(other.id);
    assert.equal(await page.getByLabel("Select event").inputValue(), event.id);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByLabel("Select event").selectOption(other.id);
    await page.getByRole("heading", { name: "Separate event", exact: true }).waitFor();
    // Close Menu without remounting portal contents on compact screens.
    await page.getByRole("button", { name: "Explore projects", exact: true }).click();
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    assert.equal(await projectDialog.getByLabel("Project title").inputValue(), "");
    assert.equal(await projectDialog.getByLabel("Project brief (Markdown)").inputValue(), "");
    await projectDialog.getByLabel("Project title").fill("Lost event access draft");
    await projectDialog.getByLabel("Project brief (Markdown)").fill(brief);
    value(service.transition(admin, other.id, "live"));
    value(service.transition(admin, other.id, "closed"));
    await refreshPortal(page);
    await projectDialog.waitFor({ state: "detached", timeout: 25000 });
    assert.equal(
      (await state()).events.some((item) => item.id === other.id),
      false,
    );
    // Restore visibility explicitly as an admin. An old creation request must not reopen.
    value(service.addAdmin(admin, other.id, "project-participant@example.test"));
    await refreshPortal(page);
    await page.waitForFunction(
      (id) => [...document.querySelectorAll("option")].some((option) => option.value === id),
      other.id,
      { timeout: 25000 },
    );
    await openPortalMenu(page);
    await page.getByLabel("Select event").selectOption(other.id);
    await page.getByRole("heading", { name: "Separate event", exact: true }).waitFor();
    assert.equal(await page.locator("dialog[open]").count(), 0);
    // A successful response from an unmounted event must reconcile data without
    // closing the new event's dialog, replacing its draft, or changing its tab.
    for (const kind of ["project", "team"] as const) {
      const makeEvent = (name: string) => {
        const created = value(
          service.createEvent(admin, {
            name,
            date: "2026-10-05",
            timezone: "America/Chicago",
            location: "Library",
            capacity: 4,
            budget: 0,
            templateId: "blank",
          }),
        );
        value(service.transition(admin, created.id, "registration"));
        return created;
      };
      const oldEvent = makeEvent(`Delayed ${kind} event`);
      const newEvent = makeEvent(`Current ${kind} event`);
      await refreshPortal(page);
      await page.waitForFunction(
        (id) => [...document.querySelectorAll("option")].some((option) => option.value === id),
        newEvent.id,
        { timeout: 25000 },
      );
      await openPortalMenu(page);
      await page.getByLabel("Select event").selectOption(oldEvent.id);
      await page.getByRole("button", { name: "Explore projects", exact: true }).click();
      let release: () => void = () => {};
      let received: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        received = resolve;
      });
      const path = kind === "project" ? `/events/${oldEvent.id}/projects` : "/teams";
      await page.route(
        `**/api${path}`,
        async (route) => {
          const response = await route.fetch({
            headers: { ...route.request().headers(), "if-none-match": "" },
          });
          assert.equal(response.status(), 200);
          received();
          await pending;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      if (kind === "project") {
        await page.getByRole("button", { name: "Create project", exact: true }).click();
        await projectDialog.getByLabel("Project title").fill("Delayed successful project");
        await projectDialog.getByLabel("Project brief (Markdown)").fill(brief);
        await projectDialog.getByRole("button", { name: "Create project", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Create a team", exact: true }).click();
        await team.getByLabel("Team name").fill("Delayed successful team");
        await team.getByRole("button", { name: "Create and join team", exact: true }).click();
      }
      await started;
      if (kind === "team")
        value(service.removeEventMember(admin, oldEvent.id, "project-participant@example.test"));
      value(service.transition(admin, oldEvent.id, "live"));
      value(service.transition(admin, oldEvent.id, "closed"));
      await refreshPortal(page);
      await page.locator("dialog[open]").waitFor({ state: "detached", timeout: 25000 });
      await openPortalMenu(page);
      await page.getByLabel("Select event").selectOption(newEvent.id);
      await page.getByRole("button", { name: "Explore projects", exact: true }).click();
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await projectDialog.getByLabel("Project title").fill(`Current ${kind} draft`);
      await projectDialog.getByLabel("Project brief (Markdown)").fill(brief);
      const delivered = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().endsWith(`/api${path}`),
      );
      release();
      await delivered;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(
        await projectDialog.getByLabel("Project title").inputValue(),
        `Current ${kind} draft`,
      );
      assert.equal(await projectDialog.getByLabel("Project brief (Markdown)").inputValue(), brief);
      assert.equal(
        (await page.locator(".main-nav > button.active").first().textContent())?.trim(),
        "Explore projects",
      );
      assert.equal(await page.getByLabel("Select event").inputValue(), newEvent.id);
      const reconciled = service.portal(admin, false);
      if (kind === "project")
        assert.equal(
          reconciled.events
            .find((item) => item.id === oldEvent.id)
            ?.projects.filter((project) => project.name === "Delayed successful project").length,
          1,
        );
      else
        assert.equal(
          reconciled.teams.filter(
            (item) => item.eventId === oldEvent.id && item.name === "Delayed successful team",
          ).length,
          1,
        );
      await page.screenshot({ path: join(artifacts, `delayed-${kind}-new-event-draft.png`) });
      await projectDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      // Discard the new event draft explicitly when moving to the next scenario.
      page.once("dialog", (dialog) => dialog.accept());
    }
    assert.deepEqual(remoteRequests, []);
    assert.deepEqual(
      errors.filter((message) => !message.includes("409 (Conflict)")),
      [],
    );
    console.log(
      "PASS: participant Projects creation and nested team cancel/error/success, exact Markdown and canonical PROJECT.md, live admin guidance as plain text, duplicate-submit latch, poll-before-response deduplication, stale project/team success guards across events, closed-event draft retention, retained drafts, no implicit team/workspace/role, focus/keyboard/touch; 360/390/desktop/short/landscape both themes, screenshots and clean unexpected console.",
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
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifyParticipantProjects();
