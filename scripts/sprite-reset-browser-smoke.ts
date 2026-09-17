import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import { ok, type Result } from "../packages/domain/src/types.ts";
import { git, listFiles, readText, revision } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { waitEditorText } from "./browser-editor.ts";
import { openAdminSection, openPortalMenu } from "./browser-portal-menu.ts";
import { verifyRuntimeIdentity } from "./runtime-identity-browser-smoke.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw Error(result.error);
  return result.value;
};
export async function verifySpriteReset() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-delete-reset-"));
  const artifacts = resolve("artifacts/sprite-delete-reset/browser");
  mkdirSync(artifacts, { recursive: true });
  const port = await new Promise<number>((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address !== "string");
      server.close(() => done(address.port));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const env = { org: process.env.CIVIC_SPARK_SPRITE_ORG, token: process.env.SPRITE_TOKEN };
  process.env.CIVIC_SPARK_SPRITE_ORG = "fixture-org";
  process.env.SPRITE_TOKEN = "fixture-org/id/token/value";
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const address = new URL(String(url));
    if (address.hostname === "api.sprites.dev") {
      assert.equal(options?.method, "GET");
      return address.search
        ? Response.json({ name: "fixture-org", sprites: [] })
        : new Response(null, { status: 404 });
    }
    assert(["127.0.0.1", "localhost"].includes(address.hostname), "No external fixture network");
    return fetchOriginal(url, options);
  };
  const destroyed: string[] = [];
  const created: string[] = [];
  const roots = new Map<string, string>();
  const original = {
    create: SpriteClient.prototype.create,
    uploadBundle: SpriteClient.prototype.uploadBundle,
    files: SpriteClient.prototype.files,
    readFile: SpriteClient.prototype.readFile,
    exec: SpriteClient.prototype.exec,
    changes: SpriteClient.prototype.changes,
    teamStatus: SpriteClient.prototype.teamStatus,
    preview: SpriteClient.prototype.preview,
  };
  SpriteClient.prototype.create = async (name) => {
    created.push(name);
    return ok(name);
  };
  SpriteClient.prototype.uploadBundle = async (name, bundle, guard) => {
    await guard?.();
    const checkout = join(root, name);
    git(root, ["clone", bundle, checkout]);
    assert(
      !existsSync(join(checkout, "PRIVATE.txt")),
      "Private local edits never seed a replacement",
    );
    assert.equal(readFileSync(join(checkout, "README.md"), "utf8"), "Shared reset fixture\n");
    roots.set(name, checkout);
    return ok(Buffer.alloc(0));
  };
  const checkout = (name: string) => {
    const path = roots.get(name);
    assert(path, "Current fixture resource");
    return path;
  };
  SpriteClient.prototype.files = async (name) => ok(listFiles(checkout(name)));
  SpriteClient.prototype.readFile = async (name, path) =>
    ok({
      path,
      content: readText(join(checkout(name), path)),
      revision: revision(readText(join(checkout(name), path))),
    });
  SpriteClient.prototype.exec = async (_name, args) => {
    assert.deepEqual(args, ["true"]);
    return ok(Buffer.alloc(0));
  };
  SpriteClient.prototype.changes = async (name) => ok(new WorkspaceFiles(checkout(name)).changes());
  SpriteClient.prototype.preview = async () =>
    ok({ port: 5173, command: ["npm", "run", "dev"], ready: false, running: false });
  const { app, service } = await createApp(root, true, origin, undefined, "prototype", undefined, {
    async inspect() {
      return {
        status: "running",
        createdAt: null,
        updatedAt: null,
        observedAt: new Date().toISOString(),
        error: null,
      };
    },
    async stop() {},
    async destroy(name) {
      destroyed.push(name);
      roots.delete(name);
    },
  });
  const actor = {
    id: "reset@example.test",
    email: "reset@example.test",
    name: "Reset owner",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(actor, {
      name: "Sprite reset rehearsal",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(actor, event.id, "registration"));
  const team = unwrap(
    service.createTeam(actor, {
      eventId: event.id,
      name: "Shared reset team",
      projectId: "data-starter",
    }),
  );
  const workspace = team.workspace;
  // A real shared commit, plus private local work that must not be copied.
  const local = service.workspacePath(workspace.id);
  writeFileSync(join(local, "README.md"), "Shared reset fixture\n");
  git(local, ["add", "README.md"]);
  git(local, ["commit", "-m", "Shared reset fixture"]);
  git(local, ["push", "origin", "HEAD:main"]);
  const sharedHead = git(service.sharedWorkspaceRepository(workspace.id), [
    "rev-parse",
    "main",
  ]).toString();
  writeFileSync(join(local, "PRIVATE.txt"), "private work must be lost\n");
  git(local, ["add", "PRIVATE.txt"]);
  git(local, ["commit", "-m", "Private fixture commit"]);
  const reference = unwrap(service.teamReference(actor, workspace.id));
  const teamStatus = service.localTeamStatus(actor, workspace.id, reference.remote);
  SpriteClient.prototype.teamStatus = async () => teamStatus;
  const oldName = `civic-spark-${workspace.id}`;
  roots.set(oldName, local);
  unwrap(service.setSprite(workspace.id, oldName, "ready", null));
  await app.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch();
  const admin = await browser.newPage({ hasTouch: true });
  const owner = await browser.newPage({ hasTouch: true });
  const errors: string[] = [];
  for (const page of [admin, owner]) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
  }
  try {
    for (const page of [admin, owner]) {
      await page.goto(origin);
      await page.getByLabel("Email address").fill(actor.email);
      await page.getByLabel("Name (optional, for your first visit)").fill(actor.name);
      await page.getByRole("button", { name: "Enter prototype" }).click();
      await page.getByRole("heading", { name: event.name, exact: true }).waitFor();
    }
    for (const theme of ["light", "dark"] as const)
      for (const [width, height] of [
        [360, 780],
        [390, 844],
        [1440, 900],
        [360, 430],
      ] as const) {
        for (const page of [admin, owner]) {
          await page.setViewportSize({ width, height });
          await page.emulateMedia({ colorScheme: theme });
        }
        const before = created.length;
        const previous = service
          .provisioningRecords()
          .find((w) => w.id === workspace.id)?.spriteName;
        await openAdminSection(admin, "Sprites");
        await admin.getByRole("button", { name: "Refresh status", exact: true }).click();
        await admin.getByRole("button", { name: "Delete", exact: true }).click();
        const dialog = admin.getByRole("dialog", { name: "Delete Sprite", exact: true });
        await dialog
          .getByRole("button", { name: "Delete Sprite", exact: true })
          .scrollIntoViewIfNeeded();
        await admin.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-delete.png`) });
        await dialog.getByRole("button", { name: "Delete Sprite", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        assert.equal(destroyed.at(-1), previous);
        assert.equal(
          service.provisioningRecords().find((w) => w.id === workspace.id)?.spriteName,
          null,
        );
        await owner.reload();
        if (before === 0) {
          await owner.getByRole("heading", { name: event.name, exact: true }).waitFor();
          await openPortalMenu(owner);
          await owner.getByRole("button", { name: /My teams/ }).click();
          await owner.getByRole("button", { name: "Open my workspace" }).click();
        }
        await owner.getByRole("dialog", { name: "Connect a new Sprite" }).waitFor();
        await owner.reload();
        const connect = owner.getByRole("button", { name: "Connect new Sprite", exact: true });
        await connect.waitFor();
        assert.equal(created.length, before, "Reload and polling cannot recreate");
        await connect.scrollIntoViewIfNeeded();
        const box = await connect.boundingBox();
        assert(box && box.height >= 44 && box.y >= 0 && box.y + box.height <= height);
        await owner.screenshot({
          path: join(artifacts, `${theme}-${width}-${height}-connect.png`),
        });
        await connect.tap();
        await waitEditorText(owner, ".env");
        const showFiles = owner.getByRole("button", { name: "Show file explorer", exact: true });
        if (await showFiles.isVisible()) await showFiles.click();
        await owner.getByRole("treeitem", { name: "README.md", exact: true }).click();
        await waitEditorText(owner, "Shared reset fixture");
        await owner.screenshot({ path: join(artifacts, `${theme}-${width}-${height}-files.png`) });
        assert.equal(created.length, before + 1);
        assert.notEqual(created.at(-1), previous);
        assert.equal(
          git(service.sharedWorkspaceRepository(workspace.id), ["rev-parse", "main"]).toString(),
          sharedHead,
        );
        assert(!(await owner.getByText("PRIVATE.txt", { exact: true }).count()));
      }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: UI Delete → explicit owner connect → real shared Git bundle/files; fresh identity, no private seed, reload/polling preservation, 360/390/desktop/short in both themes; clean consoles.",
    );
  } catch (error) {
    await owner.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
    console.error({ errors, body: await owner.locator("body").innerText() });
    throw error;
  } finally {
    await browser.close();
    await app.close();
    Object.assign(SpriteClient.prototype, original);
    globalThis.fetch = fetchOriginal;
    if (env.org === undefined) delete process.env.CIVIC_SPARK_SPRITE_ORG;
    else process.env.CIVIC_SPARK_SPRITE_ORG = env.org;
    if (env.token === undefined) delete process.env.SPRITE_TOKEN;
    else process.env.SPRITE_TOKEN = env.token;
    rmSync(root, { recursive: true, force: true });
  }
  await verifyRuntimeIdentity();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifySpriteReset();
