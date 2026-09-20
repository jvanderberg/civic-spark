import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import { eventSettings } from "../apps/web/src/AdminEventDetails.tsx";
import type { Event, Result } from "../packages/domain/src/types.ts";
import { testIdentity } from "../tests/auth-fixture.ts";
import { openAdminSection, openPortalMenu } from "./browser-portal-menu.ts";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function bounds(page: Page, control: Locator) {
  const box = await control.boundingBox();
  const size = page.viewportSize();
  assert(
    box &&
      size &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= size.width + 1 &&
      box.y + box.height <= size.height + 1,
    `Clipped ${await control.innerText()}`,
  );
}
export async function verifyAdminEventDetails() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-settings-browser-"));
  const artifacts = resolve("artifacts/admin-event");
  mkdirSync(artifacts, { recursive: true });
  let current = await createApp(root, false);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 360, height: 780 },
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  const expectedErrors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const unexpectedRequests: string[] = [];
  page.on("request", (r) => {
    if (/example\.test/.test(r.url())) unexpectedRequests.push(r.url());
  });
  try {
    const admin = await testIdentity(current.authentication, "Settings organizer");
    assert(admin.actor);
    const actor = admin.actor;
    const event = value(
      current.service.createEvent(actor, {
        name: "Editable event",
        date: "2026-10-03",
        timezone: "America/Chicago",
        location: "Library",
        capacity: 40,
        budget: 20,
        templateId: "blank",
      }),
    );
    value(current.service.transition(actor, event.id, "registration"));
    await current.app.close();
    current = await createApp(root, false, undefined, undefined, "email", event.id);
    const origin = await current.app.listen({ host: "127.0.0.1", port: 0 });
    await context.addCookies([admin.browserCookie]);
    const latest = () => {
      const e = current.service.portal(actor, false).events[0];
      assert(e);
      return e;
    };
    let sequence = 0;
    for (const theme of ["light", "dark"] as const) {
      for (const [width, height] of [
        [360, 780],
        [390, 844],
        [1440, 900],
        [360, 430],
        [390, 300],
        [900, 390],
      ] as const) {
        sequence++;
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(origin);
        await page.getByRole("heading", { name: latest().name, exact: true }).waitFor();
        await openAdminSection(page, "Event details");
        await page.getByRole("button", { name: "Edit event details", exact: true }).tap();
        const dialog = page.getByRole("dialog", { name: "Edit event details" });
        const name = `Workshop ${sequence}`;
        await dialog.getByLabel("Event name", { exact: true }).fill(name);
        await dialog.getByLabel("Date", { exact: true }).fill("2027-02-06");
        await dialog.getByLabel("Timezone", { exact: true }).fill("Pacific/Auckland");
        await dialog.getByLabel("Start time (optional)").fill("09:00");
        await dialog.getByLabel("End time (optional)").fill("17:00");
        await dialog.getByLabel("Venue", { exact: true }).fill("Community hall");
        await dialog.getByLabel("Address", { exact: true }).fill("123 Main Street");
        await dialog
          .getByLabel("Participant description")
          .fill("Build a useful neighborhood demo.\n<img src=https://example.test/no-fetch>");
        await dialog.getByLabel("Participant capacity").fill("45");
        await dialog.getByLabel("Planned model budget ($)").fill("25.50");
        await dialog
          .getByLabel("New project guidance")
          .fill(`Guidance ${sequence}: problem, audience, outcome, data and success.`);
        // Close retains the draft through real section/menu navigation and responsive changes.
        await bounds(page, dialog.getByRole("button", { name: "Save event details", exact: true }));
        await dialog.getByRole("button", { name: "Close", exact: true }).tap();
        await openAdminSection(page, "Projects");
        await page.setViewportSize({ width: width === 360 ? 390 : 360, height: 430 });
        await openAdminSection(page, "Event details");
        await page.getByRole("button", { name: "Resume event draft" }).tap();
        assert.equal(await dialog.getByLabel("Event name", { exact: true }).inputValue(), name);
        assert.equal(
          await dialog.getByLabel("New project guidance").inputValue(),
          `Guidance ${sequence}: problem, audience, outcome, data and success.`,
        );
        await page.setViewportSize({ width, height });
        // Add and reorder same-time entries by buttons (keyboard as well as touch).
        if (sequence === 1) {
          for (const title of ["First welcome", "Second welcome", "Remove me"]) {
            await dialog.getByRole("button", { name: "Add schedule entry" }).tap();
            const row = dialog.locator("fieldset").last();
            await row.getByLabel("Title", { exact: true }).fill(title);
            await row.getByLabel("Time or label").fill("09:00");
            await row.getByLabel("Details", { exact: true }).fill(`${title} details`);
          }
          await dialog.getByRole("button", { name: "Move entry 2 up", exact: true }).focus();
          await page.keyboard.press("Enter");
          assert.equal(
            await dialog
              .locator("fieldset")
              .first()
              .getByLabel("Title", { exact: true })
              .inputValue(),
            "Second welcome",
          );
          page.once("dialog", (d) => d.dismiss());
          await dialog.getByRole("button", { name: "Remove entry 3", exact: true }).tap();
          assert.equal(await dialog.locator("fieldset").count(), 3);
          page.once("dialog", (d) => d.accept());
          await dialog.getByRole("button", { name: "Remove entry 3", exact: true }).tap();
          assert.equal(await dialog.locator("fieldset").count(), 2);
        }
        const last = dialog.locator("fieldset").last();
        await last.getByLabel("Details", { exact: true }).fill(`Updated details ${sequence}`);
        await last.getByLabel("Details", { exact: true }).focus();
        await bounds(page, last.getByLabel("Details", { exact: true }));
        await bounds(page, dialog.getByRole("button", { name: "Save event details", exact: true }));
        assert(
          await dialog
            .locator(".project-editor-fields")
            .evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollTop > 0),
        );
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({
          path: join(artifacts, `schedule-${width}-${height}-${theme}.png`),
        });
        const saved = page.waitForResponse(
          (r) => r.url().endsWith(`/api/events/${event.id}`) && r.request().method() === "PATCH",
        );
        let releaseSave: (() => void) | undefined;
        if (sequence === 1) {
          const gate = new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
          await page.route(`**/api/events/${event.id}`, async (route) => {
            await gate;
            await route.continue();
          });
        }
        await dialog.getByRole("button", { name: "Save event details", exact: true }).tap();
        if (sequence === 1) {
          await dialog.getByRole("button", { name: "Saving…", exact: true }).waitFor();
          assert(await dialog.getByRole("button", { name: "Saving…", exact: true }).isDisabled());
          assert(await dialog.getByLabel("Event name", { exact: true }).isDisabled());
          assert(await dialog.getByRole("button", { name: "Close", exact: true }).isDisabled());
          releaseSave?.();
        }
        assert.equal((await saved).status(), 200);
        if (sequence === 1) await page.unroute(`**/api/events/${event.id}`);
        await page.getByText("Event details saved.", { exact: true }).waitFor();
        assert.equal(latest().name, name);
        assert.equal(latest().budget, 25.5);
        assert.equal(latest().status, "registration");
        await page.getByRole("heading", { name, exact: true }).waitFor();
        assert.equal(await page.title(), name);
        assert.equal(await page.locator(".brand").innerText(), name);
        await page.reload();
        await page.getByRole("heading", { name, exact: true }).waitFor();
        await page.getByText("Community hall · 123 Main Street", { exact: true }).waitFor();
        await openPortalMenu(page);
        await page.getByRole("button", { name: "Event schedule", exact: true }).tap();
        assert.equal(await page.locator(".timeline-item").count(), 2);
        assert.equal(await page.locator(".timeline-item h3").first().innerText(), "Second welcome");
        await page.getByText(`Updated details ${sequence}`, { exact: true }).waitFor();
        await page.screenshot({ path: join(artifacts, `saved-${width}-${height}-${theme}.png`) });
      }
    }
    await openAdminSection(page, "Event details");
    await page.getByRole("button", { name: "Edit event details", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit event details" });
    await dialog.getByLabel("Event name", { exact: true }).fill("Retained conflict draft");
    const remote = value(
      current.service.updateEvent(actor, event.id, {
        ...eventSettings(latest()),
        name: "Another admin saved",
        projectBriefGuidance: "Remote guidance",
      }),
    );
    const conflict = page.waitForResponse(
      (r) => r.url().endsWith(`/api/events/${event.id}`) && r.status() === 409,
    );
    await dialog.getByRole("button", { name: "Save event details", exact: true }).click();
    await conflict;
    expectedErrors.push("409");
    await dialog.getByRole("alert").waitFor();
    assert.equal(
      await dialog.getByLabel("Event name", { exact: true }).inputValue(),
      "Retained conflict draft",
    );
    await bounds(page, dialog.getByRole("alert"));
    page.once("dialog", (d) => d.dismiss());
    await dialog.getByRole("button", { name: "Load latest version" }).click();
    assert.equal(
      await dialog.getByLabel("Event name", { exact: true }).inputValue(),
      "Retained conflict draft",
    );
    page.once("dialog", (d) => d.accept());
    await dialog.getByRole("button", { name: "Load latest version" }).click();
    assert.equal(await dialog.getByLabel("Event name", { exact: true }).inputValue(), remote.name);
    assert.equal(await dialog.getByLabel("New project guidance").inputValue(), "Remote guidance");
    await dialog.getByLabel("Timezone", { exact: true }).fill("Not/AZone");
    const invalid = page.waitForResponse(
      (r) => r.url().endsWith(`/api/events/${event.id}`) && r.status() === 400,
    );
    await dialog.getByRole("button", { name: "Save event details", exact: true }).click();
    await invalid;
    expectedErrors.push("400");
    await dialog.getByRole("alert").waitFor();
    await bounds(page, dialog.getByRole("alert"));
    await page.screenshot({ path: join(artifacts, "validation-error-dark.png") });
    await dialog.getByLabel("Timezone", { exact: true }).fill("Pacific/Auckland");
    await dialog.getByLabel("Event name", { exact: true }).fill("Final saved event");
    await dialog.getByRole("button", { name: "Save event details", exact: true }).click();
    await page.getByText("Event details saved.", { exact: true }).waitFor();
    value(
      current.service.updateEvent(actor, event.id, {
        ...eventSettings(latest()),
        schedule: [
          ...eventSettings(latest()).schedule,
          {
            id: "freeform",
            time: "After-lunch-planning-and-sharing-with-the-whole-room",
            title: "LongTitle".repeat(20),
            description: "LongDetail".repeat(500),
          },
        ],
      }),
    );
    await page.setViewportSize({ width: 360, height: 780 });
    await page.reload();
    await page.getByRole("heading", { name: "Final saved event", exact: true }).waitFor();
    await openPortalMenu(page);
    await page.getByRole("button", { name: "Event schedule", exact: true }).tap();
    const label = page.locator(".timeline-item").last();
    assert.equal(
      await label.locator("time").innerText(),
      "After-lunch-planning-and-sharing-with-the-whole-room",
    );
    await label.scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await label.locator("p").evaluate((el) => el.scrollHeight > el.clientHeight));
    await page.screenshot({ path: join(artifacts, "freeform-long-schedule-dark.png") });
    await page.goto("about:blank");
    await context.clearCookies();
    await page.goto(origin);
    await page.getByRole("heading", { name: "Final saved event", exact: true }).waitFor();
    assert.equal(await page.title(), "Final saved event");
    assert.equal(await page.getByText("Remote guidance", { exact: true }).count(), 0);
    const persisted = latest();
    await current.app.close();
    current = await createApp(root, false, undefined, undefined, "email", event.id);
    assert.deepEqual(current.service.portal(actor, false).events[0], persisted);
    assert.deepEqual(unexpectedRequests, []);
    assert.equal(errors.length, expectedErrors.length, JSON.stringify(errors));
    for (const code of expectedErrors)
      assert(
        errors.some((e) => e.includes(code)),
        JSON.stringify(errors),
      );
    console.log(
      "PASS: event settings 360/390/desktop/short/landscape light+dark; metadata, guidance, add/edit/remove/reorder schedule, duplicate times, internal scroll, touch/keyboard, menu/resize drafts, save/reload/title, conflict/validation/confirmation, restart, no unexpected console errors. Native devices unverified.",
    );
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure.png") });
    console.error({ errors, body: await page.locator("body").innerText() });
    throw error;
  } finally {
    await browser.close();
    await current.app.close();
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await verifyAdminEventDetails();
