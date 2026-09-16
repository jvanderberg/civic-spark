import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createApp } from "../apps/server/src/app.ts";
import type { LoginEmail } from "../apps/server/src/email.ts";
import type { PortalState } from "../packages/domain/src/access-types.ts";
import { testIdentity } from "../tests/auth-fixture.ts";
import { readEditor, waitEditorText, writeEditor } from "./browser-editor.ts";

const root = mkdtempSync(join(tmpdir(), "vibehack-browser-"));
const artifacts = resolve("artifacts");
mkdirSync(artifacts, { recursive: true });
const port = await new Promise<number>((resolve, reject) => {
  const listener = createServer();
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address();
    if (!address || typeof address === "string") return reject(new Error("No port"));
    listener.close(() => resolve(address.port));
  });
});
const address = `http://127.0.0.1:${port}`;
const outbox: LoginEmail[] = [];
const { app, authentication } = await createApp(root, false, address, {
  configured: true,
  async send(message) {
    outbox.push(message);
  },
});
await app.listen({ host: "127.0.0.1", port });
const browser = await chromium.launch();
const organizer = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const participant = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const adminPage = await organizer.newPage();
const page = await participant.newPage();
const errors: string[] = [];
for (const p of [adminPage, page]) {
  p.setDefaultTimeout(10000);
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
}
try {
  await page.goto(address);
  await page.getByRole("button", { name: "Email me a sign-in link" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Add person|Add participant/ }).count(), 0);
  assert.equal((await participant.request.get(`${address}/api/state`)).status(), 401);
  await page.screenshot({ path: join(artifacts, "sign-in.png"), fullPage: true });
  for (const [target, name, email] of [
    [adminPage, "Morgan Organizer", "morgan@example.test"],
    [page, "Alex Participant", "alex@example.test"],
  ] as const) {
    await target.goto(address);
    await target.getByLabel("Email address").fill(email);
    await target.getByLabel("Name (optional, for your first visit)").fill(name);
    await target.getByRole("button", { name: "Email me a sign-in link" }).click();
    await target.getByRole("heading", { name: "Check your email" }).waitFor();
    if (target === page)
      await target.screenshot({ path: join(artifacts, "email-sent.png"), fullPage: true });
    const message = outbox.find((entry) => entry.email === email);
    assert(message, "The test mailbox should receive the link");
    await target.goto(message.url);
    await target.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  }
  await adminPage.getByRole("button", { name: "Create your first event" }).click();
  await adminPage.getByLabel("Starting point").selectOption("diod");
  await adminPage.getByLabel("Event name").fill("Day in Our Data");
  await adminPage.getByLabel("Date", { exact: true }).fill("2026-10-03");
  await adminPage.getByLabel("Location").fill("Oak Park Library");
  await adminPage.getByRole("button", { name: "Create event", exact: true }).click();
  await adminPage.getByRole("button", { name: "Open registration" }).click();
  await adminPage.getByRole("button", { name: "Explore projects", exact: true }).click();
  await adminPage.getByRole("button", { name: "Create a team", exact: true }).click();
  await adminPage.getByLabel("Team name").fill("Data neighbors");
  await adminPage.getByRole("button", { name: "Create and join team" }).click();
  await adminPage.getByRole("heading", { name: "Data neighbors", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Teams you can join" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Admin overview", exact: true }).count(), 0);
  await page.screenshot({ path: join(artifacts, "participant-discovery.png"), fullPage: true });
  await page.getByRole("button", { name: "Join team", exact: true }).click();
  await page.getByRole("button", { name: "Open my workspace", exact: true }).waitFor();
  await page.getByRole("button", { name: "Create a team", exact: true }).click();
  await page.getByLabel("Team name").fill("Library connections");
  await page.getByLabel("Project", { exact: true }).selectOption("custom");
  await page.getByLabel("Project title").fill("A library within reach");
  await page
    .getByLabel("Project brief")
    .fill(
      "Map library access by public transit and explore which neighborhoods need better connections.",
    );
  await page.getByRole("button", { name: "Create and join team" }).click();
  await page.getByRole("heading", { name: "Library connections", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Open my workspace", exact: true }).count(),
    2,
  );
  await page.screenshot({ path: join(artifacts, "my-teams.png"), fullPage: true });
  const state = (await (
    await participant.request.get(`${address}/api/state`)
  ).json()) as PortalState;
  assert.equal(state.myWorkspaces.length, 2);
  const first = state.myWorkspaces[0];
  assert(first);
  assert.equal(
    (await organizer.request.get(`${address}/api/workspaces/${first.id}/files`)).status(),
    404,
  );
  await page.getByRole("button", { name: "Open my workspace", exact: true }).first().click();
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await waitEditorText(page, "#");
  await writeEditor(page, `${await readEditor(page)}\nA contribution from my private workspace.\n`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.getByLabel("Commit message").fill("Share our first finding");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Shared with your team" }).waitFor();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("treeitem", { name: "data", exact: true }).click();
  await page.getByRole("treeitem", { name: "data/sample.csv", exact: true }).click();
  await page.getByRole("table").waitFor();
  assert.equal(await page.locator("tbody tr").count(), 6);
  await page.screenshot({ path: join(artifacts, "personal-workspace.png") });
  await page.getByRole("button", { name: "Back to teams" }).click();
  await page.getByRole("button", { name: "View changes", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByText("Committed and pushed to the shared team repository.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Team ZIP", exact: true }).first().click();
  const zip = join(artifacts, "team-project.zip");
  await (await downloadPromise).saveAs(zip);
  assert.equal(readFileSync(zip).subarray(0, 2).toString(), "PK");
  await adminPage.reload();
  await adminPage.getByRole("button", { name: "Admin overview", exact: true }).click();
  await adminPage.getByRole("button", { name: "Make admin", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Admin overview", exact: true }).waitFor();
  const coordinator = await testIdentity(authentication, "Jamie Coordinator");
  await app.inject({
    url: "/api/state",
    headers: { host: `127.0.0.1:${port}`, cookie: coordinator.cookie },
  });
  await adminPage.getByRole("button", { name: "Add admin", exact: true }).click();
  await adminPage.getByLabel("Admin email").fill(coordinator.user.email);
  await adminPage.getByRole("button", { name: "Give admin access", exact: true }).click();
  await adminPage.getByText("Jamie Coordinator", { exact: true }).waitFor();
  await adminPage.screenshot({ path: join(artifacts, "admin-overview.png"), fullPage: true });
  adminPage.once("dialog", (dialog) => void dialog.accept());
  await adminPage
    .getByRole("button", { name: "Remove Alex Participant from Data neighbors", exact: true })
    .click();
  await page.reload();
  await page.getByRole("button", { name: "My teams", exact: false }).click();
  await page.getByRole("heading", { name: "Library connections", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Open my workspace", exact: true }).count(),
    1,
  );
  assert.equal(
    (await participant.request.get(`${address}/api/workspaces/${first.id}/files`)).status(),
    404,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, "participant-mobile.png"), fullPage: true });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    "Mobile overflow",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Email me a sign-in link" }).waitFor();
  assert.equal((await participant.request.get(`${address}/api/state`)).status(), 401);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: separate authenticated admin/participant browsers; event ownership, discovery, custom project, two teams, private files, sharing/ZIP, admin promotion, removal/revocation, mobile, logout, clean console. Email-link signup uses the real auth endpoints and a test-only mailbox; external email delivery requires provider credentials.",
  );
} catch (error) {
  console.error({
    error,
    consoleErrors: errors,
    participant: await page.locator("body").innerText(),
    admin: await adminPage.locator("body").innerText(),
  });
  await page.screenshot({ path: join(artifacts, "browser-failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
