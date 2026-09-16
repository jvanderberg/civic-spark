import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import type { FileBlob } from "../packages/workspace/src/types.ts";
import { editorInput, readEditor, waitEditorText, writeEditor } from "./browser-editor.ts";

const root = mkdtempSync(join(tmpdir(), "vibehack-workspace-browser-"));
const artifacts = resolve("artifacts");
mkdirSync(artifacts, { recursive: true });
const port = await new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    server.close(() => resolve(address.port));
  });
});
const address = `http://127.0.0.1:${port}`;
const { app } = await createApp(root, false, address, undefined, "prototype");
await app.listen({ host: "127.0.0.1", port });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
await page.emulateMedia({ colorScheme: "dark" });
const errors: string[] = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.error("Browser error:", e.message);
});
// Replace only the OS picker. File reads/writes use Chromium's real FileSystem handles in a disposable origin-private directory.
await page.addInitScript(`Object.defineProperty(window, "showDirectoryPicker", {
  configurable: true,
  value: async () => (await navigator.storage.getDirectory()).getDirectoryHandle("sync-test", { create: true })
});`);
async function localWrite(path: string, content: string | null) {
  await page.evaluate(
    async ({ path, content }) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("sync-test");
      if (content === null) {
        await root.removeEntry(path);
        return;
      }
      const writer = await (await root.getFileHandle(path, { create: true })).createWritable();
      await writer.write(content);
      await writer.close();
    },
    { path, content },
  );
}
async function localRead(path: string) {
  return page.evaluate(
    async (path) =>
      (
        await (
          await (
            await (await navigator.storage.getDirectory()).getDirectoryHandle("sync-test")
          ).getFileHandle(path)
        ).getFile()
      ).text(),
    path,
  );
}
try {
  await page.goto(address);
  await page.locator('html[data-theme="dark"]').waitFor();
  await page.screenshot({
    path: join(artifacts, "portal-sign-in-dark.png"),
    animations: "disabled",
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByLabel("Email address").fill("Organizer@Example.test");
  await page.getByLabel("Name (optional, for your first visit)").fill("Prototype Organizer");
  await page.screenshot({ path: join(artifacts, "prototype-sign-in.png"), fullPage: true });
  await page.getByRole("button", { name: "Enter prototype" }).click();
  await page.getByRole("button", { name: "Create your first event" }).click();
  await page.getByLabel("Event name").fill("Workspace prototype");
  await page.getByLabel("Date", { exact: true }).fill("2026-10-03");
  await page.getByLabel("Location").fill("Local rehearsal");
  await page.getByRole("button", { name: "Create event", exact: true }).click();
  await page.getByRole("button", { name: "Open registration" }).click();
  await page.getByRole("button", { name: "Explore projects", exact: true }).click();
  await page.getByRole("button", { name: "Create a team", exact: true }).click();
  await page.getByLabel("Team name").fill("Local explorers");
  await page.getByRole("button", { name: "Create and join team" }).click();
  await page.getByRole("button", { name: "Open my workspace" }).click();
  const frame = await page.locator(".workspace-screen").boundingBox();
  assert.deepEqual(frame, { x: 0, y: 0, width: 1440, height: 1100 });
  assert.equal(await page.locator("dialog").count(), 0);
  const toolbar = await page.locator(".workspace-header").boundingBox();
  assert(toolbar && toolbar.x === 0 && toolbar.y === 0 && toolbar.height <= 50);
  await page.screenshot({ path: join(artifacts, "workspace-files.png"), fullPage: true });
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  const state = (await (await page.request.get(`${address}/api/state`)).json()) as PortalState;
  const id = state.myWorkspaces[0]?.id;
  assert(id);
  const endpoint = `${address}/api/workspaces/${id}`;
  const explorer = page.getByRole("complementary", { name: "File explorer" });
  const separator = page.getByRole("separator", { name: "Resize file explorer" });
  const folder = page.getByRole("treeitem", { name: "data", exact: true });
  assert.equal(await folder.getAttribute("aria-expanded"), "false");
  assert.equal(
    await page.getByRole("treeitem", { name: "data/sample.csv", exact: true }).count(),
    0,
  );
  await folder.focus();
  await folder.press("ArrowRight");
  const sample = page.getByRole("treeitem", { name: "data/sample.csv", exact: true });
  await sample.waitFor();
  await folder.press("ArrowRight");
  assert.equal(await sample.evaluate((node) => node === document.activeElement), true);
  await sample.press("ArrowLeft");
  assert.equal(await folder.evaluate((node) => node === document.activeElement), true);
  await folder.press("ArrowLeft");
  assert.equal(await folder.getAttribute("aria-expanded"), "false");
  await folder.press("Enter");
  await sample.press("Enter");
  await page.getByRole("table").waitFor();
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await separator.focus();
  const originalWidth = Number(await separator.getAttribute("aria-valuenow"));
  await separator.press("ArrowRight");
  assert.equal(Number(await separator.getAttribute("aria-valuenow")), originalWidth + 16);
  const handle = await separator.boundingBox();
  assert(handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 84, handle.y + 80, { steps: 8 });
  await page.mouse.up();
  const resizedWidth = Number(await separator.getAttribute("aria-valuenow"));
  assert.equal(resizedWidth, originalWidth + 100);
  await page.getByRole("button", { name: "Collapse file explorer" }).click();
  assert.equal(await separator.count(), 0);
  assert.equal((await explorer.boundingBox())?.width, 32);
  await page.reload();
  await page.getByRole("button", { name: "Show file explorer" }).waitFor();
  assert.equal((await explorer.boundingBox())?.width, 32);
  await page.getByRole("button", { name: "Show file explorer" }).click();
  assert.equal(Number(await separator.getAttribute("aria-valuenow")), resizedWidth);
  // Nested paths are shown as expandable directories, not flattened names.
  const nested = await page.request.put(`${endpoint}/blob`, {
    data: {
      path: "src/components/Chart.tsx",
      revision: null,
      data: Buffer.from(
        "export function Chart() { return <div>Data visualization</div>; }\n",
      ).toString("base64"),
    },
  });
  assert.equal(nested.status(), 200);
  await page.getByRole("treeitem", { name: "src", exact: true }).click();
  await page.getByRole("treeitem", { name: "src/components", exact: true }).click();
  await page.getByRole("treeitem", { name: "src/components/Chart.tsx", exact: true }).click();
  await waitEditorText(page, "export function Chart");
  assert.equal(
    await page
      .getByRole("treeitem", { name: "src/components/Chart.tsx", exact: true })
      .getAttribute("aria-level"),
    "3",
  );
  await page.screenshot({ path: join(artifacts, "workspace-explorer.png"), fullPage: true });
  await page.waitForFunction(() => {
    const colors = new Set(
      Array.from(document.querySelectorAll(".monaco-editor .view-line span")).map(
        (node) => getComputedStyle(node).color,
      ),
    );
    return colors.size > 1;
  });
  const updatedCode =
    "const count: number = 12;\nexport function Chart() { return <div>{count}</div>; }\n";
  await writeEditor(page, updatedCode);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator('html[data-theme="dark"] .monaco-editor.vs-dark').waitFor();
  assert.equal(await readEditor(page), updatedCode);
  await (await editorInput(page)).press("ArrowRight");
  await page.screenshot({
    path: join(artifacts, "workspace-editor-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await (await editorInput(page)).press("ControlOrMeta+S");
  await page.getByRole("status").filter({ hasText: "Saved to your workspace" }).waitFor();
  assert.equal(
    Buffer.from(
      (await (await page.request.get(`${endpoint}/blob?path=src/components/Chart.tsx`)).json())
        .data,
      "base64",
    ).toString(),
    updatedCode,
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator('html[data-theme="light"] .monaco-editor.vs').waitFor();
  assert.equal(await readEditor(page), updatedCode);
  await (await editorInput(page)).press("ArrowRight");
  await page.screenshot({
    path: join(artifacts, "workspace-editor-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  async function remoteRead(path: string): Promise<FileBlob> {
    const response = await page.request.get(`${endpoint}/blob?path=${encodeURIComponent(path)}`);
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  }
  async function remoteWrite(path: string, text: string) {
    const old = await remoteRead(path);
    const response = await page.request.put(`${endpoint}/blob`, {
      data: { path, revision: old.revision, data: Buffer.from(text).toString("base64") },
    });
    assert.equal(response.status(), 200);
  }
  for (let i = 0; i < 16; i++) {
    const response = await page.request.put(`${endpoint}/blob`, {
      data: {
        path: `preview/file-${i}.txt`,
        revision: null,
        data: Buffer.from("preview row\n").toString("base64"),
      },
    });
    assert.equal(response.status(), 200);
  }
  await page.getByRole("button", { name: "Local folder", exact: true }).click();
  await page.getByRole("button", { name: "Connect local folder" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Review sync$/ })
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Sync now", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /Apply sync/ }).count(), 0);
  await page.setViewportSize({ width: 1280, height: 480 });
  const syncRegion = page.getByRole("region", { name: "Local folder sync", exact: true });
  const dimensions = await syncRegion.evaluate((node) => ({
    bottom: node.getBoundingClientRect().bottom,
    height: node.clientHeight,
    scroll: node.scrollHeight,
  }));
  assert(dimensions.bottom <= 480 && dimensions.scroll > dimensions.height);
  await syncRegion.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const node = document.querySelector(".workspace-local-view");
    return node && node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
  });
  await page.screenshot({ path: join(artifacts, "local-sync-scroll.png") });
  await syncRegion.evaluate((node) => {
    node.scrollTop = 0;
  });
  const applyBox = await page.getByRole("button", { name: "Sync now", exact: true }).boundingBox();
  assert(applyBox && applyBox.y + applyBox.height <= 480);
  await page.screenshot({ path: join(artifacts, "local-sync-preview.png") });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Synced$/ })
    .waitFor();
  assert((await localRead("README.md")).startsWith("#"));
  // All yearly CSVs arriving together must download with one Sync now action.
  const csvs = Array.from({ length: 12 }, (_, i) => ({
    path: `data/crashes_${2014 + i}.csv`,
    text: `year,value\n${2014 + i},42\n${i === 3 ? "record,1234\n".repeat(110000) : ""}`,
  }));
  for (const { path, text } of csvs) {
    const response = await page.request.put(`${endpoint}/blob`, {
      data: { path, revision: null, data: Buffer.from(text).toString("base64") },
    });
    assert.equal(response.status(), 200);
  }
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Synced$/ })
    .waitFor();
  for (const { path, text } of csvs) {
    const actual = await page.evaluate(async (path) => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("sync-test");
      return (
        await (
          await (await root.getDirectoryHandle("data")).getFileHandle(path.slice("data/".length))
        ).getFile()
      ).text();
    }, path);
    assert.equal(actual, text);
  }
  assert.equal(await page.getByRole("button", { name: /Apply sync/ }).count(), 0);
  await localWrite("local.csv", "name,value\nOak Park,42\n");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Synced$/ })
    .waitFor();
  assert.equal(
    Buffer.from((await remoteRead("local.csv")).data, "base64").toString(),
    "name,value\nOak Park,42\n",
  );
  await remoteWrite("local.csv", "name,value\nOak Park,43\n");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Synced$/ })
    .waitFor();
  assert((await localRead("local.csv")).includes("43"));
  await localWrite("local.csv", "local conflicting edit\n");
  await remoteWrite("local.csv", "remote conflicting edit\n");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page.getByLabel("Resolve local.csv").waitFor();
  await page.screenshot({ path: join(artifacts, "local-sync-conflict.png"), fullPage: true });
  await page.getByLabel("Resolve local.csv").selectOption("upload");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Synced$/ })
    .waitFor();
  assert.equal(
    Buffer.from((await remoteRead("local.csv")).data, "base64").toString(),
    "local conflicting edit\n",
  );
  async function waitRemote(text: string) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await page.request.get(`${endpoint}/blob?path=automatic.csv`);
      if (result.ok() && (await result.json()).data === Buffer.from(text).toString("base64"))
        return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Automatic local-to-workspace sync did not finish");
  }
  await localWrite("automatic.csv", "automatic upload\n");
  await waitRemote("automatic upload\n");
  await localWrite("automatic.csv", "automatic second save\n");
  await waitRemote("automatic second save\n");
  await remoteWrite("automatic.csv", "automatic download\n");
  const deadline = Date.now() + 20000;
  while ((await localRead("automatic.csv")) !== "automatic download\n") {
    if (Date.now() > deadline) throw new Error("Automatic workspace-to-local sync did not finish");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await localWrite("local.csv", null);
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page.getByText("Delete from workspace", { exact: true }).waitFor();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  assert((await (await page.request.get(`${endpoint}/manifest`)).json()).files["local.csv"]);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Synced$/ })
    .waitFor();
  assert(!(await (await page.request.get(`${endpoint}/manifest`)).json()).files["local.csv"]);
  await page.getByRole("button", { name: "Disconnect folder", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await waitEditorText(page, "# Our community project");
  await writeEditor(page, "My unsaved browser work\n");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("treeitem", { name: "PROJECT.md", exact: true }).click();
  assert.equal(await readEditor(page), "My unsaved browser work\n");
  await page.getByRole("button", { name: "Collapse file explorer" }).click();
  await page.getByRole("button", { name: "Show file explorer" }).click();
  assert.equal(await readEditor(page), "My unsaved browser work\n");
  await remoteWrite("README.md", "Changed by another editor\n");
  await page.getByRole("status").filter({ hasText: "This file changed outside" }).waitFor();
  assert.equal(await readEditor(page), "My unsaved browser work\n");
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.locator(".file-diff code").filter({ hasText: "README.md" }).waitFor();
  await page.screenshot({ path: join(artifacts, "workspace-changes.png"), fullPage: true });
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.getByText("Send a message to start the conversation.", { exact: true }).waitFor();
  assert.deepEqual(await page.getByLabel("Agent model").locator("option").allTextContents(), [
    "GLM",
    "Opus 5",
  ]);
  await page.screenshot({ path: join(artifacts, "workspace-agent.png"), fullPage: true });
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("heading", { name: "Your Sprite terminal" }).waitFor();
  await page.screenshot({ path: join(artifacts, "workspace-terminal.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Show file explorer" }).waitFor();
  assert.equal((await explorer.boundingBox())?.width, 44);
  await page.getByRole("button", { name: "Show file explorer" }).click();
  await page.screenshot({ path: join(artifacts, "workspace-explorer-mobile.png"), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "Local folder", exact: true }).click();
  await page.screenshot({ path: join(artifacts, "workspace-mobile.png"), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[aria-label="Resize file explorer"]')
        ?.getAttribute("aria-valuenow") === String(expected),
    resizedWidth,
  );
  assert.equal(await readEditor(page), "My unsaved browser work\n");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Back to teams" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Email address").fill("organizer@example.test");
  await page.getByRole("button", { name: "Enter prototype" }).click();
  await page.getByRole("button", { name: "My teams", exact: false }).click();
  await page.getByRole("heading", { name: "Local explorers", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: prototype email identity, returning teams, native Chromium file handles, two-way sync, conflicts, deletion preview, unsaved-editor preservation, changes, agent/terminal views, mobile. OS picker substituted; Windows native picker not tested.",
  );
} catch (e) {
  await page.screenshot({ path: join(artifacts, "workspace-browser-failure.png"), fullPage: true });
  console.error(await page.locator("body").innerText());
  throw e;
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
