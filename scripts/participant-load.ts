import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { z } from "zod";
import { blobSchema } from "../packages/workspace/src/types.ts";
import { writeEditor } from "./browser-editor.ts";
import { openPortalMenu } from "./browser-portal-menu.ts";
import {
  completedReply,
  completionText,
  FatalScenarioError,
  type ObservedAgentEvent,
  observeAgentEvent,
  redact,
  retry,
  type Scenario,
  scenarioSchema,
  sleep,
  turnEvents,
  verifyReactZip,
} from "./participant-scenario.ts";

const portalSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
  teams: z.array(
    z.object({
      id: z.string(),
      eventId: z.string(),
      name: z.string(),
      projectId: z.string(),
      joined: z.boolean(),
      memberCount: z.number(),
    }),
  ),
  myWorkspaces: z.array(
    z.object({
      id: z.string(),
      teamId: z.string(),
      spriteName: z.string().nullable().optional(),
      runtime: z
        .object({ held: z.boolean().optional(), reason: z.string().nullable().optional() })
        .optional(),
    }),
  ),
});
const historySchema = z.object({
  head: z.string(),
  commits: z.array(z.object({ id: z.string(), subject: z.string() })),
});
const eventSchema = z.object({
  type: z.string(),
  id: z.string(),
  text: z.string(),
  outcome: z.string().optional(),
  replayed: z.boolean().optional(),
});

export async function runParticipant(scenario: Scenario, key: string, output: string, page: Page) {
  const s = scenario;
  const origin = new URL(s.baseUrl).origin;
  const logPath = join(output, "steps.jsonl");
  const traceId = randomUUID();
  await page.context().setExtraHTTPHeaders({ "x-civic-spark-test-trace": traceId });
  const network: {
    at: string;
    step: string;
    method: string;
    path: string;
    status: number;
    requestId?: string;
  }[] = [];
  const observeResponse = (
    url: string,
    method: string,
    status: number,
    headers: Record<string, string>,
  ) => {
    const parsed = new URL(url);
    if (parsed.origin !== origin || !parsed.pathname.startsWith("/api/")) return;
    // Drop query strings (which can contain file paths), request/response bodies and headers.
    const record = {
      at: new Date().toISOString(),
      traceId,
      step,
      method,
      path: parsed.pathname,
      status,
      requestId: headers["x-civic-spark-request-id"],
    };
    appendFileSync(join(output, "requests.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (status >= 400) network.push(record);
  };
  page.on("response", (response) =>
    observeResponse(
      response.url(),
      response.request().method(),
      response.status(),
      response.headers(),
    ),
  );
  const logEntries: string[] = [];
  const errors: string[] = [];
  const events: ObservedAgentEvent[] = [];
  let terminal = "";
  let step = "start";
  let workspaceId = "";
  let teamId = "";
  const commits: Record<string, string> = {};
  const started = Date.now();
  let checks = 0;
  const log = (message: string) => {
    const entry = {
      at: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      step,
      message: redact(message, key),
    };
    logEntries.push(JSON.stringify(entry));
    writeFileSync(logPath, `${logEntries.join("\n")}\n`, { mode: 0o600 });
    console.log(`[${s.id}] ${step}: ${entry.message}`);
  };
  const again = <T>(operation: () => Promise<T>) =>
    retry(operation, s.timing.retries, s.timing.retryMs, (attempt) =>
      log(`Retry ${attempt}/${s.timing.retries}`),
    );
  const until = async (
    predicate: () => boolean | Promise<boolean>,
    timeout: number,
    label: string,
  ) => {
    const deadline = Date.now() + timeout;
    let heartbeat = Date.now();
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
      if (Date.now() - heartbeat >= 30000) {
        log(`Waiting for ${label}`);
        heartbeat = Date.now();
      }
      await sleep(s.timing.pollMs);
    }
  };
  const get = async <T>(path: string, schema: z.ZodType<T>) =>
    again(async () => {
      const response = await page.request.get(`${origin}/api${path}`, {
        timeout: s.timing.actionMs,
      });
      observeResponse(response.url(), "GET", response.status(), response.headers());
      if ([401, 403, 404].includes(response.status()))
        throw new FatalScenarioError(`GET ${path.split("?")[0]} returned ${response.status()}`);
      if (!response.ok()) throw new Error(`GET returned ${response.status()}`);
      return schema.parse(await response.json());
    });
  const portal = () => get("/state", portalSchema);
  // Agent waits fail fast when the workspace can no longer answer: a held or
  // paused Sprite, or an agent connection the app reports as ended. Waiting out
  // the full turn timeout would only hide the real cause.
  let lastRuntimeCheck = 0;
  const agentBlocked = async () => {
    const dialog = page.getByRole("dialog").filter({ hasText: "Sprite paused" });
    if (await dialog.isVisible().catch(() => false)) return "Sprite paused dialog is shown";
    const chatError = page
      .locator(".chat-feedback, .error, [role=alert]")
      .filter({ hasText: /no longer has workspace access|Could not reconnect to the agent/ });
    if (await chatError.isVisible().catch(() => false))
      return `agent connection ended: ${(await chatError.first().innerText()).trim()}`;
    if (workspaceId && Date.now() - lastRuntimeCheck >= 5000) {
      lastRuntimeCheck = Date.now();
      const runtime = (await portal()).myWorkspaces.find((w) => w.id === workspaceId)?.runtime;
      if (runtime?.held) return `workspace held (${runtime.reason ?? "unknown reason"})`;
    }
    return undefined;
  };
  const agentWait = (predicate: () => boolean | Promise<boolean>, timeout: number, label: string) =>
    until(
      async () => {
        if (await predicate()) return true;
        const blocked = await agentBlocked();
        if (blocked) throw new FatalScenarioError(`Stopped waiting for ${label}: ${blocked}`);
        return false;
      },
      timeout,
      label,
    );
  const history = () => get(`/teams/${teamId}/repository`, historySchema);
  const screenshot = (name: string) =>
    page.screenshot({
      path: join(output, `${name}.png`),
      animations: "disabled",
      mask: [page.locator('input[type="password"]')],
    });
  const phase = async (name: string, work: () => Promise<void>) => {
    step = name;
    log("Started");
    await sleep(s.timing.thinkMs);
    await work();
    log("Passed");
    await screenshot(name);
  };
  page.setDefaultTimeout(s.timing.actionMs);
  page.on("pageerror", (error) => errors.push(redact(error.message, key)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(redact(message.text(), key));
  });
  // Observe incoming browser traffic only. Never record outbound credential frames,
  // request bodies, cookies, storage state, HAR, traces or provider tool details.
  await page.exposeFunction("civicSparkScenarioObserve", (url: string, raw: unknown) => {
    if (url.endsWith("/terminal")) {
      const value = z.object({ type: z.literal("output"), data: z.string() }).safeParse(raw);
      if (value.success) terminal = (terminal + value.data.data).slice(-200000);
    } else if (url.endsWith("/agent")) {
      const value = eventSchema.safeParse(raw);
      if (value.success) {
        // Persist every observed event (key redacted) so a missed completion can
        // be diagnosed from evidence instead of inference.
        appendFileSync(
          join(output, "agent-events.jsonl"),
          `${JSON.stringify({ at: new Date().toISOString(), step, ...value.data, text: redact(value.data.text, key) })}\n`,
          { mode: 0o600 },
        );
        observeAgentEvent(events, value.data);
      }
    }
  });
  // Passive incoming listener also works with Playwright's in-browser transport
  // doubles. The original socket and all app handlers remain in use.
  await page.addInitScript(() => {
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(Target, args) {
        const socket = new Target(String(args[0]), args[1] as string | string[] | undefined);
        socket.addEventListener("message", (event) => {
          try {
            const data = JSON.parse(String(event.data));
            const selected =
              data.type === "output"
                ? { type: data.type, data: data.data }
                : ["user", "text", "done", "error"].includes(data.type)
                  ? {
                      type: data.type,
                      id: data.id,
                      text: data.text,
                      outcome: data.outcome,
                      replayed: data.replayed,
                    }
                  : null;
            if (selected)
              void Reflect.get(window, "civicSparkScenarioObserve")(socket.url, selected);
          } catch {
            /* Ignore non-JSON frames. */
          }
        });
        return socket;
      },
    });
  });
  const share = async (title: "hello" | "MVP") => {
    await page.getByRole("button", { name: /^Changes/ }).click();
    const baseline = (await history()).head;
    await again(async () => {
      const current = await history();
      if (current.head !== baseline) {
        if (current.commits[0]?.subject !== title)
          throw new FatalScenarioError(
            "Unexpected shared commit; inspect team history before continuing",
          );
        commits[title] = current.head;
        return;
      }
      await page.getByLabel("Commit message", { exact: true }).fill(title);
      await page.getByRole("button", { name: "Share", exact: true }).click();
      await until(
        async () => {
          const current = await history();
          if (current.head === baseline) {
            const alert = page.locator(".workspace-toast [role=alert]");
            if (await alert.isVisible()) {
              const message = await alert.innerText();
              if (/changed since the preview|Refresh Changes/i.test(message)) {
                // A background refresh replaced the preview fingerprint; refresh
                // Changes as a person would and Share again.
                await page.getByRole("button", { name: "Dismiss notification" }).click();
                await page.getByRole("button", { name: "Refresh changes", exact: true }).click();
                await sleep(s.timing.thinkMs);
                throw new Error("Preview refreshed after a stale Share; retrying");
              }
              if (/conflict|diverg|review.*again|stale/i.test(message))
                throw new FatalScenarioError("Share needs a new review or conflict resolution");
              await page.getByRole("button", { name: "Dismiss notification" }).click();
              throw new Error("Share reported an error; checking shared history before retry");
            }
            return false;
          }
          if (current.commits[0]?.subject !== title)
            throw new FatalScenarioError("Shared HEAD has an unexpected commit message");
          commits[title] = current.head;
          return true;
        },
        s.timing.provisioningMs,
        `shared ${title} commit`,
      );
    });
    log(`Verified shared main commit ${commits[title]}`);
  };
  const sendPrompt = async (text: string) => {
    const input = page.getByRole("textbox", { name: "Message to agent" });
    await input.fill(text);
    // The app cannot submit while working. Do not interrupt an active turn at
    // the five-minute mark; keep this question drafted until Send becomes ready.
    await agentWait(
      async () => {
        const send = page.getByRole("button", { name: "Send to agent", exact: true });
        return (await send.isVisible()) && (await send.isEnabled());
      },
      s.timing.agentTurnMs,
      "agent ready to accept a message",
    );
    await page.getByRole("button", { name: "Send to agent", exact: true }).click();
    // A lost acknowledgement is ambiguous: never blindly repeat paid prompts.
    await until(
      () => events.some((event) => event.type === "user" && event.text === text && !event.replayed),
      s.timing.actionMs,
      "prompt acknowledgement (no automatic resubmit)",
    );
  };
  try {
    await phase("01-sign-in", async () => {
      await again(() => page.goto(origin).then(() => undefined));
      await page.getByLabel("Email address").fill(s.participant.email);
      await page.getByLabel("Name (optional, for your first visit)").fill(s.participant.name);
      await page
        .getByRole("button", {
          name: s.authMode === "demo" ? "Enter demo" : "Enter prototype",
          exact: true,
        })
        .click();
      await page.getByLabel("Email address").waitFor({ state: "hidden" });
      const state = await portal();
      const matches = state.events.filter((event) => event.name === s.eventName);
      assert.equal(matches.length, 1, "Expected exactly one matching event");
      // Fresh identities prevent overwriting work or rerunning paid MVP requests.
      if (state.myWorkspaces.length)
        throw new FatalScenarioError(
          "This identity already has workspaces. Use a fresh JSON identity for a new run.",
        );
    });
    await phase("02-project-workspace", async () => {
      await openPortalMenu(page);
      const picker = page.getByRole("combobox", { name: "Select event", exact: true });
      if (await picker.isVisible()) await picker.selectOption({ label: s.eventName });
      await page.getByRole("button", { name: "Explore projects", exact: true }).click();
      const state = await portal();
      const event = state.events.find((event) => event.name === s.eventName);
      assert(event);
      const project = event.projects.filter((project) => project.name === s.projectName);
      assert.equal(project.length, 1, "Expected one exact project match");
      assert(
        !state.teams.some((team) => team.eventId === event.id && team.name === s.teamName),
        "Test team name is already in use",
      );
      const card = page
        .locator(".project-card")
        .filter({ has: page.getByRole("heading", { name: s.projectName, exact: true }) });
      await card.getByRole("button", { name: "Start a team", exact: true }).click();
      await page.getByLabel("Team name", { exact: true }).fill(s.teamName);
      await page.getByRole("button", { name: "Create and join team", exact: true }).click();
      await until(
        async () => {
          const state = await portal();
          const team = state.teams.find(
            (team) => team.eventId === event.id && team.name === s.teamName && team.joined,
          );
          if (!team) return false;
          assert.equal(team.projectId, project[0]?.id);
          assert.equal(team.memberCount, 1, "Use a dedicated test team");
          const workspace = state.myWorkspaces.find((workspace) => workspace.teamId === team.id);
          if (!workspace) return false;
          teamId = team.id;
          workspaceId = workspace.id;
          return true;
        },
        s.timing.actionMs,
        "new team membership",
      );
      const teamCard = page
        .locator(".team-card")
        .filter({ has: page.getByRole("heading", { name: s.teamName, exact: true }) });
      await teamCard.getByRole("button", { name: "Open my workspace", exact: true }).click();
      let preparationRetries = 0;
      await until(
        async () => {
          if (
            await page
              .getByRole("button", { name: "New file", exact: true })
              .isEnabled()
              .catch(() => false)
          )
            return true;
          const retryButton = page.getByRole("button", { name: "Retry preparation", exact: true });
          if ((await retryButton.isVisible()) && (await retryButton.isEnabled())) {
            if (preparationRetries >= s.timing.retries)
              throw new Error("Workspace preparation retries exhausted");
            await sleep(s.timing.retryMs * 2 ** preparationRetries++);
            await retryButton.click();
            log(`Preparation retry ${preparationRetries}`);
          }
          return false;
        },
        s.timing.provisioningMs,
        "workspace preparation",
      );
      const workspace = (await portal()).myWorkspaces.find(
        (workspace) => workspace.id === workspaceId,
      );
      log(`Dedicated workspace ${workspaceId}; Sprite ${workspace?.spriteName ?? "local fixture"}`);
    });
    await phase("03-hello-file", async () => {
      page.once("dialog", (dialog) => {
        void dialog.accept("hello.txt");
      });
      await page.getByRole("button", { name: "New file", exact: true }).click();
      await page.locator(".editor-toolbar").getByText("hello.txt", { exact: true }).waitFor();
      await writeEditor(page, "42");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await until(
        async () => {
          const blob = await get(`/workspaces/${workspaceId}/blob?path=hello.txt`, blobSchema);
          return Buffer.from(blob.data, "base64").toString() === "42";
        },
        s.timing.actionMs,
        "saved hello.txt contents",
      );
      await share("hello");
      const shared = await get(
        `/teams/${teamId}/repository/commits/${commits.hello}/file?path=hello.txt`,
        z.object({ content: z.string() }),
      );
      assert.equal(shared.content, "42");
    });
    await phase("04-terminal", async () => {
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await page
        .locator(".terminal-panel")
        .getByText("Connected", { exact: true })
        .waitFor({ timeout: s.timing.provisioningMs });
      await sleep(s.timing.thinkMs);
      await again(async () => {
        terminal = "";
        await page.getByRole("button", { name: "Type in terminal", exact: true }).click();
        await page.keyboard.type("ls");
        await page.keyboard.press("Enter");
        await until(
          () => /\bhello\.txt\b/.test(terminal) && /\bPROJECT\.md\b/.test(terminal),
          s.timing.actionMs,
          "ls output containing hello.txt and PROJECT.md",
        );
      });
      log("ls returned the repository listing");
    });
    await phase("05-agent-mvp", async () => {
      await page.getByRole("button", { name: "Agent", exact: true }).click();
      await page.getByRole("combobox", { name: "Agent model" }).selectOption("opencode");
      await page.getByLabel("Agent API key", { exact: true }).fill(key);
      await page
        .locator(".chat-connection")
        .getByRole("button", { name: "Connect", exact: true })
        .click();
      await sendPrompt(s.prompt);
      log("GLM acknowledged the MVP request");
    });
    await phase("06-completion-loop", async () => {
      let complete = false;
      for (checks = 0; checks < s.timing.completionChecks; ) {
        checks++;
        const untilTime = Date.now() + s.timing.completionWaitMs;
        log(
          `Completion check ${checks}/${s.timing.completionChecks}: wait ${s.timing.completionWaitMs / 1000}s`,
        );
        while (Date.now() < untilTime) {
          await sleep(Math.min(30000, untilTime - Date.now()));
          log(
            `Completion wait: ${Math.max(0, Math.ceil((untilTime - Date.now()) / 1000))}s remaining`,
          );
        }
        const question = `Completion check ${checks}: Have you finished the project MVP? If it is done, reply with ${completionText} in caps on its own line. Only say this when the MVP is complete. Otherwise continue implementing it and report what remains. Use exactly MVP for any local commit message. Do not publish; I will Share the changes.`;
        await sendPrompt(question);
        await agentWait(
          () => Boolean(turnEvents(events, question)?.done),
          s.timing.agentTurnMs,
          "completion-check response",
        );
        const done = turnEvents(events, question)?.done;
        if (done?.outcome !== "success")
          throw new FatalScenarioError(
            "Agent completion check failed or stopped; inspect the workspace before retrying",
          );
        complete = completedReply(events, question);
        if (complete) {
          await until(
            async () =>
              (await page.locator(".chat-assistant .chat-markdown").allTextContents()).some(
                (text) => text.includes(completionText),
              ),
            s.timing.actionMs,
            "completion reply rendered in chat",
          );
          log(`Verified fresh successful assistant response: ${completionText}`);
          break;
        }
        log("Agent has not confirmed completion; continue the bounded loop");
      }
      if (!complete) throw new Error("Agent completion checks exhausted; MVP was not published");
    });
    await phase("07-share-mvp", () => share("MVP"));
    let zip: ReturnType<typeof verifyReactZip> | undefined;
    await phase("08-download-zip", async () => {
      const menu = page.getByRole("button", { name: "Workspace controls", exact: true });
      if (await menu.isVisible()) await menu.click();
      await page.getByRole("button", { name: /Back to teams/ }).click();
      await openPortalMenu(page);
      await page.getByRole("button", { name: /^My teams/ }).click();
      const card = page
        .locator(".team-card")
        .filter({ has: page.getByRole("heading", { name: s.teamName, exact: true }) });
      const filename = join(output, "project.zip");
      await again(async () => {
        const waiting = page.waitForEvent("download", { timeout: s.timing.provisioningMs });
        await card.getByRole("link", { name: "Team ZIP", exact: true }).click();
        const download = await waiting;
        if (await download.failure()) throw new Error("ZIP download failed");
        await download.saveAs(filename);
      });
      zip = verifyReactZip(filename);
      const final = await history();
      assert.equal(
        final.head,
        commits.MVP,
        "Exported team must still be at the verified MVP commit",
      );
      log(
        `ZIP verified: ${zip.entries} entries, React manifest ${zip.manifest}, source ${zip.source}`,
      );
    });
    const result = {
      passed: true,
      scenario: s.id,
      workspaceId,
      teamId,
      commits,
      checks,
      zip,
      elapsedMs: Date.now() - started,
      browserErrors: errors,
      traceId,
      httpErrors: network,
    };
    writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), key);
    log(`FAILED: ${message}`);
    await screenshot("failure").catch(() => {});
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify(
        {
          passed: false,
          scenario: s.id,
          step,
          message,
          workspaceId,
          teamId,
          commits,
          checks,
          elapsedMs: Date.now() - started,
          browserErrors: errors,
          traceId,
          httpErrors: network,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    throw new Error(message);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const filename = args.find((arg) => !arg.startsWith("--"));
  if (
    !filename ||
    args.some((arg) => arg.startsWith("--") && !["--live", "--validate"].includes(arg))
  )
    throw new Error("Usage: npm run test:participant -- scenario.json --validate|--live");
  const parsed = scenarioSchema.safeParse(JSON.parse(readFileSync(resolve(filename), "utf8")));
  if (!parsed.success)
    throw new Error(
      `Invalid scenario fields: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  const scenario = parsed.data;
  if (args.includes("--validate")) {
    console.log(
      `Valid scenario: ${scenario.id}; ${scenario.projectName}; completion wait ${scenario.timing.completionWaitMs}ms`,
    );
    return;
  }
  if (!args.includes("--live"))
    throw new Error(
      "Use --live for the explicit Sprite/model/publication rehearsal, or --validate for a free config check",
    );
  if (scenario.timing.completionWaitMs < 300000)
    throw new Error("Live completion checks must wait at least five minutes");
  const key = process.env[scenario.credentialEnv]?.trim();
  if (!key) throw new Error(`Set ${scenario.credentialEnv} in the process environment`);
  const output = resolve(
    "artifacts",
    "participant-load",
    `${scenario.id}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
  );
  mkdirSync(output, { recursive: true, mode: 0o700 });
  console.log(`Evidence: ${output}`);
  const browser = await chromium.launch({ headless: !scenario.browser.headed });
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: scenario.browser.width, height: scenario.browser.height },
      colorScheme: scenario.browser.theme,
      hasTouch: scenario.browser.width <= 390,
    });
    await runParticipant(scenario, key, output, await context.newPage());
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
