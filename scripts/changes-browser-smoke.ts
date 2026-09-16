import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { testIdentity } from "../tests/auth-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "civic-spark-changes-browser-"));
const artifacts = resolve("artifacts");
mkdirSync(artifacts, { recursive: true });
const port = await new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    if (!a || typeof a === "string") throw new Error("Port");
    server.close(() => resolve(a.port));
  });
});
const address = `http://127.0.0.1:${port}`;
const { app, service, authentication } = await createApp(root, false, address, undefined, "email");
await app.listen({ host: "127.0.0.1", port });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
try {
  const identity = await testIdentity(authentication, "Changes Tester");
  assert(identity.actor);
  const event = unwrap(
    service.createEvent(identity.actor, {
      name: "Changes browser",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    service.createTeam(identity.actor, {
      eventId: event.id,
      name: "Changes team",
      projectId: "data-starter",
    }),
  );
  const id = team.workspace.id;
  const dir = service.workspacePath(id);
  writeFileSync(
    join(dir, "README.md"),
    Array.from({ length: 240 }, (_, i) => `Changed project line ${i}`).join("\n"),
  );
  writeFileSync(join(dir, "z-last.txt"), "LAST FILE IS ACCESSIBLE\n");
  await page.context().addCookies([identity.browserCookie]);
  await page.addInitScript(
    (id) => localStorage.setItem(`civic-spark:workspace:${id}:tab`, "changes"),
    id,
  );
  await page.goto(`${address}/#workspace=${id}`);
  const region = page.getByRole("region", { name: "Changes view", exact: true });
  await page.getByRole("button", { name: "Share", exact: true }).waitFor();
  await page.locator(".file-diff").first().waitFor();
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    const dimensions = await region.evaluate((node) => ({
      height: node.clientHeight,
      scroll: node.scrollHeight,
      bottom: node.getBoundingClientRect().bottom,
      overflow: getComputedStyle(node).overflowY,
    }));
    assert(dimensions.height > 0 && dimensions.height < 800);
    assert(dimensions.scroll > dimensions.height * 2);
    assert(dimensions.bottom <= 800);
    assert.equal(dimensions.overflow, "auto");
    await region.evaluate((node) => {
      node.scrollTop = 0;
    });
    await region.hover();
    await page.mouse.wheel(0, 600);
    await page.waitForFunction(
      () => (document.querySelector(".workspace-changes-view")?.scrollTop ?? 0) > 100,
    );
    await region.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => {
      const e = document.querySelector(".workspace-changes-view");
      if (!e) return false;
      return e.scrollTop + e.clientHeight >= e.scrollHeight - 2;
    });
    await page
      .getByText("LAST FILE IS ACCESSIBLE", { exact: false })
      .last()
      .waitFor({ state: "visible" });
    const colors = await page
      .locator(".live-diff")
      .first()
      .evaluate((node) => ({
        background: getComputedStyle(node).backgroundColor,
        text: getComputedStyle(node).color,
        added: getComputedStyle(node.querySelector(".diff-add") ?? node).backgroundColor,
      }));
    if (theme === "dark") {
      assert.notEqual(colors.background, "rgb(255, 255, 255)");
      assert.equal(colors.background, "rgb(23, 27, 31)");
      assert.equal(colors.added, "rgb(38, 61, 49)");
    } else assert.equal(colors.added, "rgb(234, 242, 227)");
    const shareBounds = await page
      .getByRole("button", { name: "Share", exact: true })
      .boundingBox();
    assert(
      shareBounds && shareBounds.y > 0 && shareBounds.y < 250,
      "Commit controls stay visible while reviewing long diffs",
    );
    await page.screenshot({
      path: join(artifacts, `changes-${theme}-scrolled.png`),
      animations: "disabled",
    });
    await region.evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({
      path: join(artifacts, `changes-${theme}.png`),
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Commit message", { exact: true }).fill("Improve the project data");
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(artifacts, "changes-mobile.png"), animations: "disabled" });
  let shares = 0;
  await page.route("**/api/workspaces/*/share", async (route) => {
    shares += 1;
    if (shares === 1)
      return route.fulfill({
        status: 409,
        json: { error: "Sharing could not complete. Your local commit is preserved; retry Share." },
      });
    await route.continue();
  });
  await page.getByLabel("Commit message", { exact: true }).press("Enter");
  await page.locator(".workspace-toast").getByRole("alert").waitFor();
  assert.equal(
    await page.getByLabel("Commit message", { exact: true }).inputValue(),
    "Improve the project data",
  );
  assert.equal(
    await page.locator(".changes-panel [role=alert]").count(),
    0,
    "Ordinary failures belong in the toast",
  );
  await page.screenshot({
    path: join(artifacts, "changes-error-toast.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.getByLabel("Commit message", { exact: true }).press("Enter");
  await page
    .locator(".workspace-toast")
    .getByRole("status")
    .filter({ hasText: "Shared with your team" })
    .waitFor();
  assert.equal(service.portal(identity.actor, false).contributions.length, 1);
  assert.equal(
    git(dir, ["log", "-1", "--format=%s"]).toString().trim(),
    "Improve the project data",
  );
  assert.equal(await page.getByLabel("Commit message", { exact: true }).inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Share", exact: true }).isDisabled(), true);
  await page.screenshot({
    path: join(artifacts, "changes-shared-toast.png"),
    animations: "disabled",
  });
  await page.mouse.move(0, 0);
  await page.locator(".workspace-toast").waitFor({ state: "hidden", timeout: 10000 });
  assert.equal(shares, 2);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: long Changes wheel/keyboard scrolling, final file access, light/dark diff surfaces, compact commit controls, mobile layout, keyboard Share, dismissible/expiring toasts and real Git commit message.",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
