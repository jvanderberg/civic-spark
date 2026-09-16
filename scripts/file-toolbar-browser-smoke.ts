import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { testIdentity } from "../tests/auth-fixture.ts";
import { editorInput, readEditor, waitEditorText, writeEditor } from "./browser-editor.ts";

const root = mkdtempSync(join(tmpdir(), "vibehack-toolbar-browser-"));
const artifacts = resolve("artifacts");
mkdirSync(artifacts, { recursive: true });
const port = await new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    if (!a || typeof a === "string") throw new Error("No port");
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
  const user = await testIdentity(authentication, "Toolbar owner"),
    outsider = await testIdentity(authentication, "Toolbar outsider");
  assert(user.actor);
  const event = unwrap(
    service.createEvent(user.actor, {
      name: "Toolbar rehearsal",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    service.createTeam(user.actor, {
      eventId: event.id,
      name: "File toolbar",
      projectId: "data-starter",
    }),
  );
  const id = team.workspace.id;
  const endpoint = `${address}/api/workspaces/${id}`;
  await page.context().addCookies([user.browserCookie]);
  await page.goto(`${address}/#workspace=${id}`);
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await waitEditorText(page, "#");
  await (await editorInput(page)).press("ArrowLeft");
  const toolbar = page.getByRole("toolbar", { name: "File actions" });
  const labels = ["New file", "Upload file", "Download file", "Reload", "Save", "Delete file"];
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      let y: number | undefined;
      for (const name of labels) {
        const button = toolbar.getByRole("button", { name, exact: true });
        const box = await button.boundingBox();
        assert(box);
        assert(box.x >= 0 && box.x + box.width <= 190);
        assert.equal(box.height, 28);
        assert.equal((await button.innerText()).trim(), "");
        assert(await button.getAttribute("title"));
        if (y !== undefined) assert.equal(box.y, y);
        y = box.y;
      }
      assert.equal(
        await page
          .locator(".editor-toolbar")
          .getByRole("button", { name: "Save", exact: true })
          .count(),
        0,
      );
      await page.screenshot({ path: join(artifacts, `file-toolbar-${theme}-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  // Keyboard activation opens the real file chooser and retains create-only upload semantics.
  const chooser = page.waitForEvent("filechooser");
  await toolbar.getByRole("button", { name: "Upload file", exact: true }).focus();
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({
    name: "upload-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Uploaded fixture\n"),
  });
  await page.getByRole("treeitem", { name: "upload-note.txt", exact: true }).waitFor();
  page.once("dialog", (dialog) => void dialog.accept("new-note.txt"));
  await toolbar.getByRole("button", { name: "New file", exact: true }).click();
  await page.locator(".editor-toolbar").getByText("new-note.txt", { exact: true }).waitFor();
  await writeEditor(page, "Saved note\n");
  assert.equal(
    await toolbar.getByRole("button", { name: "Delete file", exact: true }).isDisabled(),
    true,
  );
  await toolbar.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector<HTMLButtonElement>('.file-action[aria-label="Save"]')?.disabled,
  );
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>('.file-action[aria-label="New file"]')?.disabled,
  );
  await writeEditor(page, "Saved with shortcut\n");
  assert.equal(await readEditor(page), "Saved with shortcut\n");
  await (await editorInput(page)).press("ControlOrMeta+S");
  await page.waitForFunction(
    () => document.querySelector<HTMLButtonElement>('.file-action[aria-label="Save"]')?.disabled,
  );
  const downloaded = page.waitForEvent("download");
  await toolbar.getByRole("button", { name: "Download file", exact: true }).click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), "new-note.txt");
  const path = await download.path();
  assert(path);
  assert.equal(readFileSync(path, "utf8"), "Saved with shortcut\n");
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>('.file-action[aria-label="New file"]')?.disabled,
  );
  await writeEditor(page, "Unsaved draft\n");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await toolbar.getByRole("button", { name: "Reload", exact: true }).click();
  assert.equal(await readEditor(page), "Unsaved draft\n");
  page.once("dialog", (dialog) => void dialog.accept());
  await toolbar.getByRole("button", { name: "Reload", exact: true }).click();
  await waitEditorText(page, "Saved with shortcut");
  page.once("dialog", (dialog) => {
    assert.equal(dialog.message(), "Delete new-note.txt?");
    void dialog.dismiss();
  });
  await toolbar.getByRole("button", { name: "Delete file", exact: true }).click();
  assert((await (await page.request.get(`${endpoint}/files`)).json()).includes("new-note.txt"));
  page.once("dialog", (dialog) => void dialog.accept());
  await toolbar.getByRole("button", { name: "Delete file", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Deleted new-note.txt." }).waitFor();
  assert.equal(await page.getByRole("treeitem", { name: "new-note.txt", exact: true }).count(), 0);
  await page.getByText("No file selected", { exact: true }).waitFor();
  assert.equal(
    await toolbar.getByRole("button", { name: "Delete file", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("treeitem", { name: "upload-note.txt", exact: true }).click();
  await waitEditorText(page, "Uploaded fixture");
  const blob = await (await page.request.get(`${endpoint}/blob?path=upload-note.txt`)).json();
  const denied = await page.request.put(`${endpoint}/blob`, {
    headers: { cookie: outsider.cookie, origin: address },
    data: { path: "upload-note.txt", data: null, revision: blob.revision },
  });
  assert.equal(denied.status(), 404);
  // A concurrent edit made while the confirmation is open must make deletion fail by revision.
  page.once("dialog", async (dialog) => {
    const changed = await page.request.put(`${endpoint}/blob`, {
      data: {
        path: "upload-note.txt",
        data: Buffer.from("Newer external version\n").toString("base64"),
        revision: blob.revision,
      },
    });
    assert.equal(changed.status(), 200);
    await dialog.accept();
  });
  await toolbar.getByRole("button", { name: "Delete file", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "changed since" }).waitFor();
  const preserved = await (await page.request.get(`${endpoint}/blob?path=upload-note.txt`)).json();
  assert.equal(Buffer.from(preserved.data, "base64").toString(), "Newer external version\n");
  assert.equal(
    await page.getByRole("treeitem", { name: "upload-note.txt", exact: true }).count(),
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: compact six-icon light/dark/mobile toolbar; keyboard upload, create, download, Save shortcut, reload safeguards, confirmed/cancelled/stale/unauthorized deletion.",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
