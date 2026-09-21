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
  let incoming = false;
  let outgoing = false;
  let conflicted = false;
  let calls = 0;
  const head = "a".repeat(40);
  const remote = "b".repeat(40);
  await page.route("**/team-status*", (route) =>
    route.fulfill({
      json: {
        head,
        remote,
        incoming,
        outgoing,
        dirty: false,
        merging: false,
        conflicts: [],
      },
    }),
  );
  await page.route("**/team-update", async (route) => {
    calls++;
    const input = route.request().postDataJSON();
    assert.equal(input.head, head);
    assert.equal(input.remote, remote);
    if (input.mode === "replace") {
      incoming = false;
      await route.fulfill({
        json: {
          status: "updated",
          head: remote,
          remote,
          conflicts: [],
          backup: "refs/civic-spark/recovery/test",
        },
      });
    } else if (conflicted && input.mode === "agent") {
      await route.fulfill({
        json: {
          status: "agent",
          head,
          remote,
          conflicts: ["README.md"],
          prompt: `Resolve the Git merge that I requested in this workspace. The original local commit is ${head}; the incoming team commit is ${remote}.`,
        },
      });
    } else if (conflicted) {
      await route.fulfill({ json: { status: "conflict", head, remote, conflicts: ["README.md"] } });
    } else {
      incoming = false;
      await route.fulfill({ json: { status: "updated", head: remote, remote, conflicts: [] } });
    }
  });
  await page.context().addCookies([identity.browserCookie]);
  await page.goto(`${address}/#workspace=${id}`);
  const top = page.locator(".team-updates > button");
  await top.click();
  await page.getByText("Your workspace includes the latest team commits.").waitFor();
  assert.equal(calls, 0);
  await page.getByRole("button", { name: "Later", exact: true }).click();
  incoming = true;
  await top.click();
  await page.getByRole("button", { name: "Get updates", exact: true }).click();
  await page.getByText("Team updates loaded into your workspace.").waitFor();
  assert.equal(calls, 1);
  await page.getByRole("button", { name: "Later", exact: true }).click();
  incoming = true;
  conflicted = true;
  await top.click();
  await page.getByRole("button", { name: "Get updates", exact: true }).click();
  await page.getByText("Some changes overlap").waitFor();
  assert.equal(calls, 2);
  // Later only closes the choice; it must not change the Git state.
  await page.getByRole("button", { name: "Later", exact: true }).click();
  assert.equal(calls, 2);
  await top.click();
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    await page.waitForFunction((theme) => {
      const button = document.querySelector(".team-updates-menu .button.primary");
      return (
        button &&
        getComputedStyle(button).backgroundColor ===
          (theme === "dark" ? "rgb(166, 203, 183)" : "rgb(37, 78, 62)")
      );
    }, theme);
    await page.screenshot({ path: join(artifacts, `team-updates-${theme}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Workspace controls", exact: true }).click();
  const box = await page.getByRole("region", { name: "Team updates", exact: true }).boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= 390);
  await page.screenshot({ path: join(artifacts, "team-updates-mobile.png") });
  page.once("dialog", (d) => void d.dismiss());
  await page.getByRole("button", { name: "Use team version", exact: true }).click();
  assert.equal(calls, 2);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Use team version", exact: true }).click();
  await page.getByText("Team version loaded.", { exact: false }).waitFor();
  assert.equal(calls, 3);
  await page.getByRole("button", { name: "Later", exact: true }).click();
  // Resolve in terminal: starts the agent-mode merge and shows the prompt inline
  // for a terminal agent instead of handing it to the Agent tab.
  incoming = true;
  await top.click();
  await page.getByRole("button", { name: "Get updates", exact: true }).click();
  await page.getByText("Some changes overlap").waitFor();
  assert.equal(calls, 4);
  await page.getByRole("button", { name: "Resolve in terminal", exact: true }).click();
  await page.getByLabel("Resolution prompt", { exact: true }).waitFor();
  assert.equal(calls, 5);
  assert(
    (await page.getByLabel("Resolution prompt", { exact: true }).inputValue()).includes(
      "Resolve the Git merge",
    ),
  );
  assert.equal(
    await page.locator(".agent-panel").evaluate((node) => (node as HTMLElement).hidden),
    true,
    "No Agent tab hand-off",
  );
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await page.getByRole("button", { name: "Later", exact: true }).click();
  // Use my version: the typed-confirmation escape hatch publishes this workspace
  // over the team head through Share, never through team-update. The overlap
  // state is still open from the terminal hand-off above.
  await top.click();
  await page.getByText("Some changes overlap").waitFor();
  assert.equal(calls, 5);
  const dir = service.workspacePath(id);
  writeFileSync(join(dir, "mine.txt"), "My version\n");
  const replace = page.getByRole("button", { name: "Replace team version", exact: true });
  await page.getByRole("button", { name: "Use my version", exact: true }).click();
  assert.equal(await replace.isDisabled(), true, "Requires the typed confirmation");
  await page
    .getByRole("region", { name: "Team updates", exact: true })
    .getByLabel("Type YES to confirm", { exact: true })
    .fill("YES");
  assert.equal(await replace.isEnabled(), true);
  const replaceBox = await replace.boundingBox();
  assert(replaceBox && replaceBox.x >= 0 && replaceBox.x + replaceBox.width <= 390);
  await page.screenshot({ path: join(artifacts, "team-updates-use-mine.png") });
  await replace.click();
  await page.getByText("team repository now matches", { exact: false }).waitFor();
  assert.equal(calls, 5, "Use my version never calls team-update");
  const repo = join(root, "repos", `${team.team.id}.git`);
  assert.equal(
    git(repo, ["rev-parse", "main"]).toString().trim(),
    git(dir, ["rev-parse", "HEAD"]).toString().trim(),
  );
  assert.equal(git(dir, ["log", "-1", "--format=%s"]).toString().trim(), "Keep my version");
  // The team head is now this workspace's commit, so nothing is incoming.
  incoming = false;
  await page.getByRole("button", { name: "Later", exact: true }).click();
  outgoing = true;
  await top.click();
  await page.getByText("Your workspace includes the latest team commits.").waitFor();
  await page.getByRole("button", { name: "Later", exact: true }).click();
  await page.getByRole("button", { name: "Workspace controls", exact: true }).click();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByText("Local commits are ready to push.").waitFor();
  await page.getByLabel("Commit message", { exact: true }).fill("Share merged team work");
  assert.equal(await page.getByRole("button", { name: "Share", exact: true }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: team update indicator, clean pull, conflict choices, Later does not mutate, replacement confirmation, typed-YES Use my version through Share, light/dark/mobile menu.",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
