import assert from "node:assert/strict";
import type { Page } from "playwright";

export async function editorInput(page: Page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const input = page.locator(".monaco-editor textarea.inputarea");
  await input.waitFor();
  return input;
}
export async function readEditor(page: Page) {
  const input = await editorInput(page);
  await input.focus();
  await input.press("ControlOrMeta+A");
  await input.press("ControlOrMeta+C");
  return page.evaluate(() => navigator.clipboard.readText());
}
export async function writeEditor(page: Page, text: string) {
  const input = await editorInput(page);
  await input.focus();
  await input.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}
export async function waitEditorText(page: Page, prefix: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await readEditor(page)).startsWith(prefix)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Editor did not show expected content: ${prefix.slice(0, 40)}`);
}
