import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import { ok, type Result } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { waitEditorText } from "./browser-editor.ts";
import { openAdminSection, openPortalMenu } from "./browser-portal-menu.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
export async function verifyLifecyclePortal() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-lifecycle-browser-"));
  const artifacts = resolve("artifacts/lifecycle");
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
  const statuses = new Map<string, string>();
  let wakes = 0;
  let stops = 0;
  const { app, service } = await createApp(
    root,
    true,
    origin,
    undefined,
    "prototype",
    undefined,
    undefined,
    {
      async inspect(name) {
        return {
          status: statuses.get(name) ?? "running",
          observedAt: new Date().toISOString(),
          createdAt: "2026-09-16T00:00:00Z",
          updatedAt: null,
          error: null,
        };
      },
      async stop(name) {
        stops++;
        statuses.set(name, "warm");
      },
    },
  );
  const admin = {
    id: "admin@example.test",
    email: "admin@example.test",
    name: "Lifecycle organizer",
    emailVerified: true as const,
  };
  const member = {
    id: "member@example.test",
    email: "member@example.test",
    name: "Workspace owner",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(admin, {
      name: "Community Build Day",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(admin, event.id, "registration"));
  const team = unwrap(
    service.createTeam(member, {
      eventId: event.id,
      name: "Shared source team",
      projectId: "data-starter",
    }),
  );
  const workspace = team.workspace;
  const paths = unwrap(service.files(member, workspace.id));
  const files = new Map(
    paths.map((path) => [path, unwrap(service.readFile(member, workspace.id, path))]),
  );
  const changes = service.workspaceFiles(member, workspace.id, "changes");
  const reference = unwrap(service.teamReference(member, workspace.id));
  const teamStatus = service.localTeamStatus(member, workspace.id, reference.remote);
  service.setSprite(workspace.id, `civic-spark-${workspace.id}`, "ready", null);
  const original = {
    exec: SpriteClient.prototype.exec,
    files: SpriteClient.prototype.files,
    readFile: SpriteClient.prototype.readFile,
    changes: SpriteClient.prototype.changes,
    teamStatus: SpriteClient.prototype.teamStatus,
    preview: SpriteClient.prototype.preview,
  };
  SpriteClient.prototype.exec = async (name) => {
    wakes++;
    statuses.set(name, "running");
    return ok(Buffer.alloc(0));
  };
  SpriteClient.prototype.files = async () => ok(paths);
  SpriteClient.prototype.readFile = async (_name, path) =>
    ok(files.get(path) ?? { path, content: "", revision: "fixture" });
  SpriteClient.prototype.changes = async () =>
    changes as Awaited<ReturnType<typeof original.changes>>;
  SpriteClient.prototype.teamStatus = async () => teamStatus;
  SpriteClient.prototype.preview = async () =>
    ok({ port: 5173, command: ["npm", "run", "dev"], ready: false, running: false });
  await app.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch();
  const adminContext = await browser.newContext({
    hasTouch: true,
    viewport: { width: 360, height: 780 },
    acceptDownloads: true,
  });
  const ownerContext = await browser.newContext({
    hasTouch: true,
    viewport: { width: 360, height: 780 },
    acceptDownloads: true,
  });
  const page = await adminContext.newPage();
  const owner = await ownerContext.newPage();
  const errors: string[] = [];
  for (const target of [page, owner]) {
    target.setDefaultTimeout(10000);
    target.on("pageerror", (error) => errors.push(error.message));
    target.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
  }
  try {
    for (const [target, identity] of [
      [page, admin],
      [owner, member],
    ] as const) {
      await target.goto(origin);
      await target.getByLabel("Email address").fill(identity.email);
      await target.getByLabel("Name (optional, for your first visit)").fill(identity.name);
      await target.getByRole("button", { name: "Enter prototype" }).click();
      await target.getByRole("heading", { name: event.name, exact: true }).waitFor();
    }
    for (const theme of ["light", "dark"] as const)
      for (const [width, height] of [
        [360, 780],
        [390, 844],
        [1440, 900],
        [360, 430],
      ] as const) {
        for (const target of [page, owner]) {
          await target.setViewportSize({ width, height });
          await target.emulateMedia({ colorScheme: theme });
        }
        await openPortalMenu(page);
        const menu = page.getByRole("button", { name: "Portal navigation" });
        if (width < 650) {
          assert.equal(await menu.getAttribute("aria-expanded"), "true");
          await page.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-menu.png`) });
          await page.keyboard.press("Escape");
          assert.equal(await menu.getAttribute("aria-expanded"), "false");
          assert(await menu.evaluate((el) => el === document.activeElement));
          await menu.press("Enter");
        }
        await page.getByRole("button", { name: "Admin overview", exact: true }).click();
        await openAdminSection(page, "Sprites");
        const inventory = page.getByRole("region", { name: "Workspace Sprites" });
        await inventory.getByText("Workspace owner", { exact: true }).waitFor();
        assert.equal(wakes, stops / 2); // Inventory and main navigation never wake runtimes.
        await inventory.getByRole("button", { name: "Pause all Sprites", exact: true }).click();
        let dialog = page.getByRole("dialog", { name: "Pause all Sprites", exact: true });
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await inventory.getByRole("button", { name: "Pause all Sprites", exact: true }).click();
        await dialog.getByRole("button", { name: "Pause all Sprites", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        assert.equal(service.execution(event.id).paused, false);
        await inventory.getByRole("button", { name: "Pause hackathon", exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Pause hackathon", exact: true });
        await dialog
          .getByRole("button", { name: "Pause hackathon", exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-confirm.png`) });
        await dialog.getByRole("button", { name: "Pause hackathon", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        assert.equal(service.execution(event.id).paused, true);
        await inventory.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(artifacts, `${theme}-${width}-${height}-inventory.png`),
          fullPage: true,
        });
        await owner.reload();
        await owner.getByRole("heading", { name: event.name, exact: true }).waitFor();
        await openPortalMenu(owner);
        assert.equal(
          await owner.getByRole("button", { name: "Admin overview", exact: true }).count(),
          0,
        );
        await owner.getByRole("button", { name: /My teams/ }).click();
        await owner.getByRole("button", { name: "Open my workspace" }).click();
        const paused = owner.getByRole("dialog", { name: "Hackathon paused", exact: true });
        await paused.waitFor();
        await owner.screenshot({
          path: join(artifacts, `${theme}-${width}-${height}-download.png`),
        });
        const downloaded = owner.waitForEvent("download");
        await paused.getByRole("link", { name: "Download shared source" }).click();
        assert.equal((await downloaded).suggestedFilename(), "team-project.zip");
        assert.equal(wakes, stops / 2 - 1);
        await openAdminSection(page, "Teams");
        const adminDownload = page.waitForEvent("download");
        await page.getByRole("link", { name: "Shared team ZIP", exact: true }).click();
        assert.equal((await adminDownload).suggestedFilename(), "team-project.zip");
        assert.equal(wakes, stops / 2 - 1, "Admin shared downloads must not wake a Sprite");
        await openAdminSection(page, "Sprites");
        await inventory.getByRole("button", { name: "Unpause hackathon", exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Unpause hackathon", exact: true });
        await dialog.getByRole("button", { name: "Unpause hackathon", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        const before = wakes;
        await owner.reload();
        await owner.locator(".monaco-editor").waitFor();
        const initialFile = files.get(paths[0] ?? "");
        assert(initialFile, "The isolated shared fixture has a readable file");
        await waitEditorText(owner, initialFile.content.slice(0, 80));
        await owner.locator(".monaco-editor textarea.inputarea").press("ArrowLeft");
        assert.equal(wakes, before + 1);
        assert.equal(
          service.provisioningRecords().find((w) => w.id === workspace.id)?.spriteName,
          `civic-spark-${workspace.id}`,
        );
        await owner.screenshot({
          path: join(artifacts, `${theme}-${width}-${height}-resumed.png`),
        });
        await owner.goto(origin);
        for (const target of [page, owner])
          assert(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: portal Menu, role-scoped Sprite inventory, pause-all/event confirmations, paused shared download, unpause and same-Sprite reload; 360/390/desktop/short, both themes, keyboard/touch, clean console. Isolated mocked provider only.",
    );
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure-admin.png"), fullPage: true });
    await owner.screenshot({ path: join(artifacts, "failure-owner.png"), fullPage: true });
    console.error({ errors });
    throw error;
  } finally {
    await browser.close();
    await app.close();
    Object.assign(SpriteClient.prototype, original);
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifyLifecyclePortal();
