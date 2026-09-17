import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import { ok, type Result } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { openAdminSection, openPortalMenu } from "./browser-portal-menu.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
async function inBounds(locator: Locator, page: Page) {
  const box = await locator.boundingBox();
  const size = page.viewportSize();
  assert(box && size, "Control is initially visible");
  assert(
    box.x >= 0 && box.x + box.width <= size.width + 1,
    "Control fits horizontally before click",
  );
  assert(
    box.y >= 0 && box.y + box.height <= size.height + 1,
    "Control fits vertically before click",
  );
  assert(box.height >= 44, "Touch target is at least 44px high");
}
export async function verifySpriteRows() {
  const root = mkdtempSync(join(tmpdir(), "cs-sprite-rows-browser-"));
  const artifacts = resolve("artifacts/sprite-rows");
  mkdirSync(artifacts, { recursive: true });
  const port = await new Promise<number>((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      server.close(() => resolvePort(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const priorOrg = process.env.CIVIC_SPARK_SPRITE_ORG;
  process.env.CIVIC_SPARK_SPRITE_ORG = "fixture-org";
  const states = new Map<string, string>();
  const stopped: string[] = [];
  const destroyed: string[] = [];
  const { app, service } = await createApp(root, true, origin, undefined, "prototype", undefined, {
    async inspect(name) {
      return {
        status: states.get(name) ?? "running",
        createdAt: new Date(Date.now() - 25 * 3600000).toISOString(),
        observedAt: new Date().toISOString(),
        updatedAt: null,
        error: null,
      };
    },
    async stop(name) {
      stopped.push(name);
      states.set(name, "warm");
    },
    async destroy(name) {
      destroyed.push(name);
      states.set(name, "deleted");
    },
  });
  const actor = {
    id: "rows@example.test",
    email: "rows@example.test",
    name: "Alex Organizer",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(actor, {
      name: "Dozens of workspace Sprites",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 100,
      budget: 0,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(actor, event.id, "registration"));
  const team = unwrap(
    service.createTeam(actor, {
      eventId: event.id,
      name: "Community mapping team",
      projectId: "data-starter",
    }),
  );
  const workspaces = [team.workspace];
  for (let index = 1; index < 32; index++) {
    const user = {
      id: `rows-${index}@example.test`,
      email: `rows-${index}@example.test`,
      name: `Participant ${String(index).padStart(2, "0")}`,
      emailVerified: true as const,
    };
    workspaces.push(unwrap(service.joinTeam(user, team.team.id)));
  }
  for (const [index, workspace] of workspaces.entries()) {
    const name = `civic-spark-${workspace.id}`;
    unwrap(service.setSprite(workspace.id, name, "ready", null));
    states.set(name, ["running", "warm", "cold"][index % 3] as string);
  }
  const originalExec = SpriteClient.prototype.exec;
  let wakes = 0;
  SpriteClient.prototype.exec = async (_name, args) => {
    assert.deepEqual(args, ["true"]);
    wakes++;
    return ok(Buffer.alloc(0));
  };
  await app.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  try {
    await page.goto(origin);
    await page.getByLabel("Email address").fill(actor.email);
    await page.getByLabel("Name (optional, for your first visit)").fill(actor.name);
    await page.getByRole("button", { name: "Enter prototype" }).click();
    await page.getByRole("heading", { name: event.name, exact: true }).waitFor();
    let index = 0;
    for (const theme of ["light", "dark"] as const)
      for (const [width, height] of [
        [360, 780],
        [390, 844],
        [1440, 900],
        [900, 390],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme: theme });
        await openAdminSection(page, "Sprites");
        const table = page.getByRole("table", { name: "Event Sprites" });
        await table.waitFor();
        const rows = table.locator("tbody tr");
        assert.equal(await rows.count(), 32 - index);
        await page.getByRole("button", { name: "Refresh status", exact: true }).click();
        assert.equal(wakes, index, "Admin inventory/navigation never wakes a workspace");
        assert.equal(await page.locator(".sprite-card").count(), 0);
        assert.equal(
          (await table.locator(".sprite-cost").first().innerText()).replace(/\s/g, ""),
          width <= 760 ? "Est.$2.78" : "$2.78",
        );
        assert(!/bounds|assume|CPU|allocation-age|continuously/.test(await table.innerText()));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const first = rows.first();
        const firstBox = await first.boundingBox();
        assert(firstBox);
        assert(
          firstBox.height <= (width <= 760 ? 112 : 85),
          `Compact row height: ${firstBox.height}`,
        );
        // No locator.click auto-scroll: inspect viewport bounds before interacting.
        // Short pages scroll the content pane deliberately to expose the first row.
        if (height < 500) await first.scrollIntoViewIfNeeded();
        const pause = first.getByRole("button", { name: "Pause", exact: true });
        const remove = first.getByRole("button", { name: "Delete", exact: true });
        await inBounds(pause, page);
        await inBounds(remove, page);
        await page.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-list.png`) });
        const otherRuntimes = workspaces.slice(1).map((workspace) => service.runtime(workspace.id));
        await pause.tap();
        let dialog = page.getByRole("dialog", { name: "Pause Sprite", exact: true });
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(stopped.length, index);
        await pause.press("Enter");
        await dialog.getByRole("button", { name: "Pause Sprite", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        assert.equal(stopped.length, index + 1);
        assert.equal(stopped.at(-1), `civic-spark-${team.workspace.id}`);
        assert.deepEqual(
          workspaces.slice(1).map((workspace) => service.runtime(workspace.id)),
          otherRuntimes,
        );
        const wake = await page.request.post(`${origin}/api/workspaces/${team.workspace.id}/wake`, {
          headers: { origin },
        });
        assert.equal(wake.status(), 200);
        assert.equal(wakes, index + 1);
        // Delete a different row each round, keeping the first row for repeated pause checks.
        const target = rows.nth(1);
        await target.scrollIntoViewIfNeeded();
        const deleteButton = target.getByRole("button", { name: "Delete", exact: true });
        await inBounds(deleteButton, page);
        await deleteButton.tap();
        dialog = page.getByRole("dialog", { name: "Delete Sprite", exact: true });
        await dialog.waitFor();
        assert.match(
          await dialog.innerText(),
          /unshared private files, saved keys and conversation history/,
        );
        assert.match(await dialog.innerText(), /Shared team Git remains/);
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(destroyed.length, index);
        await deleteButton.press("Enter");
        const confirm = dialog.getByRole("button", { name: "Delete Sprite", exact: true });
        if (height < 500) await confirm.scrollIntoViewIfNeeded();
        await inBounds(confirm, page);
        await page.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-delete.png`) });
        await confirm.click();
        await dialog.waitFor({ state: "detached" });
        await page.waitForFunction(
          (count) =>
            document.querySelectorAll('table[aria-label="Event Sprites"] tbody tr').length ===
            count,
          31 - index,
        );
        assert.equal(destroyed.length, index + 1);
        assert.equal(destroyed.at(-1), `civic-spark-${workspaces[index + 1]?.id}`);
        assert.equal(
          service.provisioningRecords().find((w) => w.id === workspaces[index + 1]?.id)?.spriteName,
          null,
        );
        index++;
        await openPortalMenu(page);
      }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: 32 compact Sprite rows, initial control bounds, one cost amount, per-row pause/delete/cancel, keyboard/touch, isolated resources, 360/390/desktop/short in both themes; clean console.",
    );
  } catch (error) {
    await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
    console.error({ errors });
    throw error;
  } finally {
    await browser.close();
    await app.close();
    SpriteClient.prototype.exec = originalExec;
    if (priorOrg === undefined) delete process.env.CIVIC_SPARK_SPRITE_ORG;
    else process.env.CIVIC_SPARK_SPRITE_ORG = priorOrg;
    rmSync(root, { recursive: true, force: true });
  }
}
