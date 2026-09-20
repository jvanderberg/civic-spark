import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import { backupDirectoryFor, readPendingRestore } from "../packages/backup/src/live.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { openAdminSection } from "./browser-portal-menu.ts";

function unwrap<T>(result: Result<T>) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function inViewport(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
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
  assert(box.height >= 30, `Touch target too short: ${await locator.innerText()}`);
}
const viewports = [
  [360, 780],
  [390, 844],
  [1440, 900],
  [360, 430],
] as const;

export async function verifyAdminBackups() {
  // Backups live beside the data root, so the parent must be private.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "civic-spark-backups-browser-")));
  chmodSync(base, 0o700);
  const root = join(base, "data");
  const artifacts = resolve("artifacts/admin-backups");
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
    id: "backup-admin@example.test",
    email: "backup-admin@example.test",
    name: "Backup organizer",
    emailVerified: true as const,
  };
  const member = {
    id: "backup-member@example.test",
    email: "backup-member@example.test",
    name: "Backup participant",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(admin, {
      name: "Backup event",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 40,
      budget: 0,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(admin, event.id, "registration"));
  const project = unwrap(
    service.createProject(admin, event.id, {
      name: "Backed up project",
      brief: "A project brief that is long enough to satisfy validation rules.",
    }),
  );
  unwrap(
    service.createTeam(member, {
      eventId: event.id,
      name: "Backed up team",
      projectId: project.id,
    }),
  );
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 360, height: 780 },
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  async function capture(name: string) {
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${name}: document overflow`,
    );
    await page.screenshot({ path: join(artifacts, `${name}.png`), animations: "disabled" });
  }
  const section = page.locator(".backups");
  try {
    await page.goto(origin);
    await page.getByLabel("Email address").fill(admin.email);
    await page.getByRole("button", { name: "Enter prototype" }).click();
    await page.getByRole("heading", { name: "Backup event", exact: true }).waitFor();
    await openAdminSection(page, "Backups");
    await section.getByRole("heading", { name: "Backups", exact: true }).waitFor();
    await page.getByText("No backups yet").waitFor();
    await capture("360-empty-light");
    // Members never reach the section: the API refuses and the nav is admin-only.
    const memberContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(origin);
    await memberPage.getByLabel("Email address").fill(member.email);
    await memberPage.getByRole("button", { name: "Enter prototype" }).click();
    await memberPage.getByRole("heading", { name: "Backup event", exact: true }).waitFor();
    assert.equal(await memberPage.getByRole("button", { name: "Admin", exact: true }).count(), 0);
    const refused = await memberContext.request.get(`${origin}/api/events/${event.id}/backups`);
    assert.equal(refused.status(), 403);
    await memberContext.close();

    await inViewport(page, section.getByRole("button", { name: "Create backup", exact: true }));
    await section.getByRole("button", { name: "Create backup", exact: true }).tap();
    await section.getByRole("status").filter({ hasText: "Backup created" }).waitFor();
    const row = section.locator(".backup-list tbody tr");
    await row.waitFor();
    assert.equal(await row.count(), 1);
    assert.match(await row.innerText(), /1 events · 1 teams · 2 accounts/);
    const archives = readdirSync(backupDirectoryFor(root)).filter((n) => n.startsWith("backup-"));
    assert.equal(archives.length, 1, "One sealed archive on disk");
    const download = await context.request.get(
      `${origin}${await row.getByRole("link", { name: "Download" }).getAttribute("href")}`,
    );
    assert.equal(download.status(), 200);
    assert.equal(download.headers()["content-type"], "application/zip");
    assert.match(download.headers()["content-disposition"] ?? "", /civic-spark-backup-.*\.zip/);
    assert((await download.body()).length > 1024, "Download streams the archive");

    for (const theme of ["light", "dark"] as const)
      for (const [width, height] of viewports) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        await inViewport(page, section.getByRole("button", { name: "Create backup", exact: true }));
        await inViewport(page, section.getByRole("button", { name: "Upload backup", exact: true }));
        for (const name of ["Download", "Restore", "Delete"])
          await inViewport(
            page,
            row.getByRole(name === "Download" ? "link" : "button", { name, exact: true }),
          );
        await capture(`${width}-${height}-list-${theme}`);
        await row.getByRole("button", { name: "Restore", exact: true }).tap();
        const dialog = page.getByRole("dialog", { name: "Restore backup", exact: true });
        await dialog.waitFor();
        await inViewport(
          page,
          dialog.getByRole("button", { name: "Restore and restart", exact: true }),
        );
        await inViewport(page, dialog.getByRole("button", { name: "Cancel", exact: true }));
        await inViewport(page, dialog.getByRole("button", { name: "Close dialog" }));
        await capture(`${width}-${height}-restore-dialog-${theme}`);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
      }
    await page.setViewportSize({ width: 360, height: 780 });
    await page.emulateMedia({ colorScheme: "light" });

    // Without a process restart hook the restore is staged and reported as manual.
    await row.getByRole("button", { name: "Restore", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "Restore backup", exact: true });
    await dialog.getByRole("button", { name: "Restore and restart", exact: true }).tap();
    await section.getByRole("status").filter({ hasText: "The restore is staged" }).waitFor();
    await capture("360-restore-staged");
    const pending = readPendingRestore(root);
    assert(pending && existsSync(pending.staged), "Staged root exists beside the live data");
    assert(
      existsSync(join(root, "prototype", "state.sqlite")),
      "Live data untouched until restart",
    );
    await page.reload();
    await page.getByRole("heading", { name: "Backup event", exact: true }).waitFor();
    await openAdminSection(page, "Backups");
    await section.getByText("waiting for the server to restart").waitFor();
    assert(await section.getByRole("button", { name: "Create backup", exact: true }).isDisabled());
    await capture("360-restore-pending");
    await section.getByRole("button", { name: "Discard staged restore", exact: true }).tap();
    await section.getByRole("status").filter({ hasText: "Staged restore discarded" }).waitFor();
    assert.equal(readPendingRestore(root), null);
    assert(!existsSync(pending.staged), "Staged root removed");

    await row.getByRole("button", { name: "Delete", exact: true }).tap();
    await section.getByRole("status").filter({ hasText: "Backup deleted" }).waitFor();
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0] ?? "", /Delete the backup/);
    await page.getByText("No backups yet").waitFor();
    assert.equal(
      readdirSync(backupDirectoryFor(root)).filter((n) => n.startsWith("backup-")).length,
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: admin Backups section at 360/390/desktop/short in light and dark: create, list, download, restore dialog, staged restore notice/discard and delete by touch with clean console. Chromium emulation only; the real restart swap is covered by tests/backup-live.test.ts.",
    );
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
    console.error({ errors, body: await page.locator("body").innerText() });
    throw error;
  } finally {
    await browser.close();
    await app.close();
    rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await verifyAdminBackups();
