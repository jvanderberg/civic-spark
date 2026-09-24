import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { LoginEmail } from "../apps/server/src/email.ts";

// Demo site with a listed owner: the owner signs in with an emailed code,
// participants still skip verification and cannot create events.
export async function verifyDemoOwnerSignIn() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-demo-owner-browser-"));
  const artifacts = resolve("artifacts/demo-owner");
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
  const outbox: LoginEmail[] = [];
  const previousOwners = process.env.CIVIC_SPARK_OWNERS;
  process.env.CIVIC_SPARK_OWNERS = "owner@example.test";
  const { app } = await createApp(
    root,
    false,
    origin,
    {
      configured: true,
      async send(message) {
        outbox.push(message);
      },
    },
    "demo",
  );
  await app.listen({ host: "127.0.0.1", port });
  const browser = await chromium.launch();
  const errors: string[] = [];
  const open = async () => {
    const context = await browser.newContext({
      viewport: { width: 360, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(origin);
    return page;
  };
  const reachable = async (page: Page, name: string) => {
    const target = page.getByRole("button", { name, exact: true });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const size = page.viewportSize();
    assert(box && size && box.y >= 0 && box.y + box.height <= size.height && box.height >= 44);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  };
  let page: Page | undefined;
  try {
    // A participant who arrives before the event exists waits for the organizer.
    page = await open();
    await page.getByLabel("Email address").fill("participant@example.test");
    await page.getByRole("button", { name: "Enter demo" }).tap();
    await page.getByText("The event is not open yet.").waitFor();
    assert.equal(await page.getByRole("button", { name: /Create (an|your) event/ }).count(), 0);
    for (const colorScheme of ["light", "dark"] as const) {
      for (const [width, height] of [
        [360, 780],
        [390, 844],
        [1440, 900],
        [900, 390],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ colorScheme });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({
          path: join(artifacts, `participant-${width}-${height}-${colorScheme}.png`),
        });
      }
    }
    const participant = page;

    page = await open();
    await page.getByLabel("Email address").fill("Owner@example.test");
    await page.getByRole("button", { name: "Enter demo" }).tap();
    await page.getByRole("heading", { name: "Check your email" }).waitFor();
    assert.equal(
      (await page.context().cookies()).some((cookie) => cookie.name.includes("session_token")),
      false,
      "Typing an owner email must not sign in",
    );
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await reachable(page, "Sign in");
      await page.screenshot({ path: join(artifacts, `owner-code-360-${colorScheme}.png`) });
    }
    const message = outbox.findLast((entry) => entry.email === "owner@example.test");
    assert(message, "The owner should receive a code");
    await page.getByLabel("Sign-in code").fill(message.code);
    await page.getByRole("button", { name: "Sign in", exact: true }).tap();
    // The owner's first event becomes the site's one event.
    await page.getByRole("button", { name: "Create your event" }).tap();
    await page.getByLabel("Event name").fill("Harbor Data Day");
    await page.getByLabel("Date", { exact: true }).fill("2026-10-03");
    await page.getByLabel("Location").fill("Community library");
    await page.getByRole("button", { name: "Create event", exact: true }).tap();
    await page.getByRole("button", { name: "Open registration" }).tap();
    await page.locator(".brand.site-brand", { hasText: "Harbor Data Day" }).waitFor();
    assert.equal(await page.getByRole("button", { name: /Create (an|your) event/ }).count(), 0);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: join(artifacts, `owner-event-360-${colorScheme}.png`) });
    }
    await participant.reload();
    await participant.locator(".brand.site-brand", { hasText: "Harbor Data Day" }).waitFor();
    assert.equal(await participant.title(), "Harbor Data Day");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: demo participant signs in directly and waits without Create event; owner gets an emailed code (no session from typing the email), creates the site's one event and the site takes its name for everyone; 360/390/desktop/short in both themes; clean console.",
    );
  } catch (error) {
    await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
    console.error({ errors });
    throw error;
  } finally {
    await browser.close();
    await app.close();
    if (previousOwners === undefined) delete process.env.CIVIC_SPARK_OWNERS;
    else process.env.CIVIC_SPARK_OWNERS = previousOwners;
    rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await verifyDemoOwnerSignIn();
