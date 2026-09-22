import assert from "node:assert/strict";
import { join } from "node:path";
import type { ConsoleMessage, Page } from "playwright";
import {
  type AgentEvent,
  type AgentInput,
  agentInputSchema,
} from "../packages/agents/src/protocol.ts";

export async function checkAgentImages(
  page: Page,
  requests: AgentInput[],
  emit: (event: AgentEvent) => void,
  artifacts: string,
) {
  const consoleErrors: string[] = [];
  const recordConsole = (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  };
  page.on("console", recordConsole);
  const composer = page.getByLabel("Message to agent");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 240;
    canvas.height = 120;
    const context = canvas.getContext("2d");
    if (!context) throw Error();
    context.fillStyle = "#4298bc";
    context.fillRect(0, 0, 240, 120);
    context.fillStyle = "white";
    context.font = "24px sans-serif";
    context.fillText("Screenshot", 20, 65);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });
  const count = () => requests.filter((request) => request.type === "prompt").length;
  const wait = async (check: () => boolean) => {
    const until = Date.now() + 5000;
    while (!check()) {
      assert(Date.now() < until, "Image request timed out");
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  const attach = async (name = "Screenshot.png", data = png, mimeType = "image/png") => {
    await page
      .getByLabel("Choose images")
      .setInputFiles({ name, mimeType, buffer: Buffer.from(data, "base64") });
  };
  const complete = async () => {
    const request = requests.filter((request) => request.type === "prompt").at(-1);
    assert(request?.type === "prompt" && request.id && request.images?.length);
    assert(agentInputSchema.safeParse(request).success);
    // The composer empties the moment the message is handed over: the thumbnail
    // goes with the text, before the agent acknowledges the turn.
    await page.getByRole("button", { name: "Remove Screenshot.png" }).waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("region", { name: "Attached images" }).count(), 0);
    assert.equal(await composer.inputValue(), "");
    emit({ type: "user", id: request.id, text: request.text, images: request.images });
    emit({ type: "done", id: crypto.randomUUID(), text: "Ready" });
    // The sent images stay in the conversation.
    await page.locator(".chat-user .chat-images img").last().waitFor();
    return request;
  };
  emit({
    type: "state",
    id: "image-ready",
    text: "Ready",
    runtimeReady: true,
    working: false,
    configuredProviders: ["opencode", "claude"],
  });
  await composer.fill("");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [width, height] of [
      [360, 780],
      [390, 844],
      [1440, 1000],
      [390, 300],
    ]) {
      assert(width && height);
      await page.setViewportSize({ width, height });
      await page.getByLabel("Agent model").selectOption(theme === "dark" ? "claude" : "opencode");
      const before = count();
      await attach();
      const remove = page.getByRole("button", { name: "Remove Screenshot.png" });
      await remove.waitFor();
      assert.equal(count(), before, "Selecting an image sent automatically");
      const image = page.getByRole("region", { name: "Attached images" }).locator("img");
      assert(await image.evaluate((image) => (image as HTMLImageElement).naturalWidth > 0));
      await composer.fill(width === 360 ? "" : "Use this screenshot");
      if (width === 390 && height > 300) {
        await page.getByRole("button", { name: "Files", exact: true }).click();
        await page.getByRole("button", { name: "Agent", exact: true }).click();
        await remove.waitFor();
        assert.equal(await composer.inputValue(), "Use this screenshot");
      }
      await remove.scrollIntoViewIfNeeded();
      const box = await remove.boundingBox();
      assert(box && box.width >= 44 && box.height >= 44);
      if (width === 390 && height === 300) {
        await page.getByRole("button", { name: "Workspace controls", exact: true }).click();
        await page.getByRole("button", { name: "Workspace controls", exact: true }).click();
        assert.equal(await composer.inputValue(), "Use this screenshot");
        await remove.waitFor();
      }
      await composer.focus();
      if (height === 300) {
        const inputBox = await composer.boundingBox();
        const sendBox = await page.getByRole("button", { name: "Send to agent" }).boundingBox();
        assert(
          inputBox && sendBox && inputBox.y >= 0 && inputBox.y + inputBox.height <= sendBox.y,
          "Focused image prompt must stay above Send",
        );
      }
      await page.screenshot({
        path: join(artifacts, `agent-images-${width}-${height}-${theme}.png`),
      });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const send = page.getByRole("button", { name: "Send to agent" });
      await send.scrollIntoViewIfNeeded();
      const sendBox = await send.boundingBox();
      assert(sendBox && sendBox.y >= 0 && sendBox.y + sendBox.height <= height);
      await send.click();
      await wait(() => count() === before + 1);
      const request = await complete();
      assert.equal(request.images?.[0]?.data, png);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  // Clipboard event emulation tests the actual focused composer handler. Native
  // clipboard/phone picker behavior still requires physical-device rehearsal.
  await composer.fill("Text draft");
  await composer.focus();
  const beforePaste = count();
  await composer.evaluate((element, data) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(
      new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], "Screenshot.png", {
        type: "image/png",
      }),
    );
    const event = new ClipboardEvent("paste", {
      clipboardData: clipboard,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    if (!event.defaultPrevented) throw Error("Image-only paste should be handled");
  }, png);
  await page.getByRole("button", { name: "Remove Screenshot.png" }).waitFor();
  assert.equal(await composer.inputValue(), "Text draft");
  assert.equal(count(), beforePaste);
  await page.getByRole("button", { name: "Remove Screenshot.png" }).click();
  assert.equal(await composer.inputValue(), "Text draft");
  await composer.evaluate((element, data) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "Pasted text");
    clipboard.items.add(
      new File([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], "Screenshot.png", {
        type: "image/png",
      }),
    );
    const event = new ClipboardEvent("paste", {
      clipboardData: clipboard,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    if (event.defaultPrevented) throw Error("Mixed clipboard must preserve native text insertion");
  }, png);
  await page.getByRole("button", { name: "Remove Screenshot.png" }).waitFor();
  await page.getByRole("button", { name: "Send to agent" }).click();
  await wait(() => count() === beforePaste + 1);
  const rejected = requests.filter((request) => request.type === "prompt").at(-1);
  assert(rejected?.id);
  emit({ type: "user", id: rejected.id, text: rejected.text, images: rejected.images });
  emit({
    type: "error",
    id: "image-rejection",
    requestId: rejected.id,
    text: "The selected model or provider could not accept these images. Remove the images to send text, or choose another configured model.",
  });
  emit({ type: "done", id: "image-rejection-done", text: "Ready" });
  await page.getByRole("alert").filter({ hasText: "could not accept these images" }).waitFor();
  // A rejected send returns the attachments so they are not lost.
  await page.getByRole("button", { name: "Remove Screenshot.png" }).waitFor();
  assert.equal(await composer.inputValue(), "");
  await composer.fill("Text draft");
  await page.getByRole("button", { name: "Remove Screenshot.png" }).click();
  for (const [name, mime] of [
    ["bad.svg", "image/svg+xml"],
    ["bad.png", "image/png"],
  ]) {
    assert(name && mime);
    await attach(name, Buffer.from("invalid").toString("base64"), mime);
    await page
      .locator(".agent-panel")
      .getByRole("alert")
      .filter({ hasText: mime === "image/svg+xml" ? "Attach a PNG" : "valid PNG" })
      .waitFor();
    assert.equal(await page.getByRole("region", { name: "Attached images" }).count(), 0);
    assert.equal(await composer.inputValue(), "Text draft");
  }
  await page.getByLabel("Choose images").setInputFiles(
    Array.from({ length: 5 }, (_, i) => ({
      name: `${i}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    })),
  );
  await page.getByRole("alert").filter({ hasText: "up to 4" }).waitFor();
  assert.equal(count(), beforePaste + 1);
  await composer.fill("");
  await page.getByRole("button", { name: "Dismiss agent error" }).click();
  page.off("console", recordConsole);
  assert.deepEqual(consoleErrors, []);
  console.log(
    "PASS: image composer360/390/desktop/300px in both themes, image-only/mixed send, paste handler, picker/removal, tab retention, format/count errors and failed-provider draft retention; no automatic sends.",
  );
}
