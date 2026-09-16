import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright";

// A mock websocket records bytes; none of this text is executed as a command.
export async function verifyTerminalInput(page: Page, inputs: string[], artifacts: string) {
  const textarea = page.locator(".sprite-terminal textarea");
  const keyboard = page.getByRole("button", { name: "Type in terminal", exact: true });
  const host = page.locator(".sprite-terminal");
  const isFocused = () => textarea.evaluate((input) => input === document.activeElement);
  for (const scheme of ["light", "dark"] as const) {
    for (const viewport of [
      { width: 360, height: 780 },
      { width: 390, height: 844 },
      { width: 360, height: 430 },
    ]) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForFunction(() => {
        const host = document.querySelector(".sprite-terminal");
        const frame = document.querySelector(".workspace-screen");
        return (
          host &&
          frame &&
          frame.getBoundingClientRect().height === (visualViewport?.height ?? innerHeight) &&
          host.getBoundingClientRect().height > 30 &&
          host.getBoundingClientRect().bottom <= innerHeight
        );
      });
      await textarea.evaluate((input) => input.blur());
      // Check focus during the trusted touch event itself, before any synthesized
      // mouse event or deferred task. Desktop tap-to-mouse emulation alone hid this gap.
      await page.evaluate(() => {
        Reflect.set(window, "terminalTouchFocused", false);
        window.addEventListener(
          "touchend",
          (event) => {
            Reflect.set(
              window,
              "terminalTouchFocused",
              event.isTrusted && document.activeElement?.matches(".xterm-helper-textarea"),
            );
          },
          { once: true },
        );
      });
      const bounds = await host.boundingBox();
      assert(bounds && bounds.height > 30);
      await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      assert.equal(await page.evaluate(() => Reflect.get(window, "terminalTouchFocused")), true);
      assert(await isFocused());
      await keyboard.tap();
      assert(await isFocused(), "Keyboard action synchronously focuses the native xterm textarea");
      assert(await textarea.isEditable());
      assert.equal(await textarea.getAttribute("inputmode"), "text");
      assert.equal(await textarea.getAttribute("autocapitalize"), "off");
      assert.equal(await textarea.getAttribute("spellcheck"), "false");
      assert.equal(await textarea.evaluate((input) => getComputedStyle(input).fontSize), "16px");
      const button = await keyboard.boundingBox();
      assert(button && button.height >= 44 && button.y >= 0);
      assert(button.y + button.height <= viewport.height);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: join(artifacts, `terminal-input-${viewport.width}-${viewport.height}-${scheme}.png`),
      });
    }
  }

  const start = inputs.length;
  await keyboard.tap();
  await page.keyboard.type("abc");
  await page.keyboard.insertText("é🙂"); // Native input event, without keydown/keypress.
  await page.waitForTimeout(50);
  await textarea.evaluate((input) => {
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("Missing terminal textarea");
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value += "日本";
    input.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "日本" }));
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertCompositionText",
        data: "日本",
        isComposing: true,
      }),
    );
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
  });
  await page.waitForTimeout(50);
  assert.equal(inputs.slice(start).join(""), "abcé🙂日本", "IME emits exactly one committed value");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(50);
  assert.equal(inputs.slice(start).join(""), "abcé🙂日本\x7f\r");

  // Mobile keyboards can send edit intentions without desktop key events.
  for (const inputType of ["deleteContentBackward", "insertLineBreak"]) {
    await textarea.evaluate((input, type) => {
      if (!(input instanceof HTMLTextAreaElement)) throw new Error("Missing terminal textarea");
      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: type,
      });
      if (input.dispatchEvent(event)) {
        input.value =
          type === "deleteContentBackward" ? input.value.slice(0, -1) : `${input.value}\n`;
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: type }));
      }
    }, inputType);
  }
  await page.waitForTimeout(50);
  assert.equal(inputs.slice(start).join(""), "abcé🙂日本\x7f\r\x7f\r");
  const beforeMobileKey = inputs.length;
  await textarea.evaluate((input) => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, keyCode: 229 }));
    input.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertParagraph",
      }),
    );
  });
  await page.waitForTimeout(50);
  await textarea.dispatchEvent("keyup", { keyCode: 229 });
  assert.equal(
    inputs.slice(beforeMobileKey).join(""),
    "\r",
    "Unidentified mobile key does not duplicate Return",
  );
  const beforeComposingEdit = inputs.length;
  await textarea.dispatchEvent("beforeinput", {
    inputType: "deleteContentBackward",
    isComposing: true,
    cancelable: true,
  });
  await page.waitForTimeout(50);
  assert.equal(inputs.length, beforeComposingEdit, "Composing edits stay under xterm IME handling");

  // A scroll/pinch/cancel/long press must not be converted into a request to type.
  await textarea.evaluate((input) => input.blur());
  await host.evaluate((element) => {
    const first = { clientX: 20, clientY: 20 };
    const moved = { clientX: 20, clientY: 80 };
    for (const [type, touches] of [
      ["touchstart", [first]],
      ["touchmove", [moved]],
      ["touchend", []],
      ["touchstart", [first]],
      ["touchcancel", []],
      ["touchend", []],
      ["touchstart", [first, moved]],
      ["touchend", []],
    ] as const) {
      const event = new Event(type, {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperties(event, {
        touches: { value: touches },
        targetTouches: { value: [] },
        changedTouches: { value: [] },
      });
      element.dispatchEvent(event);
      if (event.defaultPrevented) throw new Error("Terminal focus must not cancel touch scrolling");
    }
  });
  assert.equal(await isFocused(), false);
  await host.evaluate((element) => {
    const event = new Event("touchstart", { bubbles: true });
    Object.defineProperties(event, {
      touches: { value: [{ clientX: 20, clientY: 20 }] },
      targetTouches: { value: [] },
      changedTouches: { value: [] },
    });
    element.dispatchEvent(event);
  });
  await page.waitForTimeout(450);
  await host.evaluate((element) => {
    const event = new Event("touchend", { bubbles: true });
    Object.defineProperties(event, {
      touches: { value: [] },
      targetTouches: { value: [] },
      changedTouches: { value: [] },
    });
    element.dispatchEvent(event);
  });
  assert.equal(await isFocused(), false, "Long press does not request keyboard focus");
  await keyboard.tap();
  assert(await isFocused());
}
