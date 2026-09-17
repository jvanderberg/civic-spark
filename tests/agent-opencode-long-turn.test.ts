import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { AgentEvent } from "../packages/agents/src/protocol.ts";

// This opt-in test runs the pinned OpenCode binary and SDK against a loopback
// OpenRouter-compatible stream. It intentionally exceeds the 300-second
// undici headers timeout that exposed the original synchronous prompt bug.
it.runIf(Boolean(process.env.CIVIC_SPARK_LONG_TURN))(
  "keeps one real pinned OpenCode turn Working past five minutes and finishes normally",
  async () => {
    expect(process.version).toBe("v24.18.0");
    expect(
      execFileSync(resolve("packages/agents/runtime/node_modules/.bin/opencode"), ["--version"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("1.18.31");
    const home = mkdtempSync(join(tmpdir(), "civic-spark-opencode-long-turn-"));
    const project = join(home, "project");
    const runtime = join(home, ".civic-spark-agent");
    mkdirSync(project);
    mkdirSync(runtime);
    writeFileSync(
      join(runtime, "context.ts"),
      "export const claudeSystemPrompt = () => ''; export const workspaceContext = () => '';\n",
    );
    const mocks = join(home, "mocks.mjs");
    writeFileSync(
      mocks,
      "export async function verifyProviderKey() { return {}; }\nexport async function* query() { throw new Error('Claude is not used in this test'); }\nexport async function getSessionMessages() { return []; }\n",
    );
    let inferenceRequests = 0;
    let inferenceStartedAt = 0;
    let providerText = "";
    const trace: { event: string; at: number }[] = [];
    let holds = 0;
    let releases = 0;
    const tasks = createServer((request, response) => {
      request.resume();
      trace.push({ event: `tasks-${request.method}`, at: Date.now() });
      if (request.method === "PUT") holds++;
      if (request.method === "DELETE") releases++;
      response.writeHead(204).end();
    });
    const socketPath = join(home, "tasks.sock");
    await new Promise<void>((done) => tasks.listen(socketPath, done));
    writeFileSync(
      join(runtime, "activity.ts"),
      readFileSync(resolve("packages/agents/src/activity.ts"), "utf8").replace(
        '"/.sprite/api.sock"',
        JSON.stringify(socketPath),
      ),
    );
    const api = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* Consume the request before opening the streamed response. */
      }
      if (!request.url?.includes("chat/completions")) {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      inferenceRequests++;
      inferenceStartedAt = Date.now();
      trace.push({ event: "inference-start", at: inferenceStartedAt });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      const chunk = (delta: Record<string, string>, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "z-ai/glm-5.3-flash", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      providerText = "Loopback long-turn proof. ";
      response.write(chunk({ role: "assistant", content: providerText }));
      const heartbeat = setInterval(() => {
        providerText += ".";
        response.write(chunk({ content: "." }));
      }, 1000);
      const finish = setTimeout(() => {
        clearInterval(heartbeat);
        trace.push({ event: "inference-finish", at: Date.now() });
        response.end(`${chunk({}, "stop")}data: [DONE]\n\n`);
      }, 305000);
      response.on("close", () => {
        clearInterval(heartbeat);
        clearTimeout(finish);
      });
    });
    await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    const source = readFileSync(resolve("packages/agents/src/runner.ts"), "utf8")
      .replaceAll("/home/sprite", home)
      .replaceAll('"@anthropic-ai/claude-agent-sdk"', JSON.stringify(pathToFileURL(mocks).href))
      .replaceAll(
        '"@opencode-ai/sdk/v2"',
        JSON.stringify(
          pathToFileURL(
            resolve("packages/agents/runtime/node_modules/@opencode-ai/sdk/dist/v2/index.js"),
          ).href,
        ),
      )
      .replace(
        'config: { permission: "allow" },',
        'config: { permission: "allow", enabled_providers: ["openrouter"], share: "disabled", provider: { openrouter: { options: { apiKey: "local-loopback-key", baseURL: process.env.CIVIC_SPARK_TEST_BASE_URL } } } },',
      )
      .replaceAll('"./provider.ts"', JSON.stringify(pathToFileURL(mocks).href))
      .replace(
        /"\.\/(credentials|journal|protocol|multimodal|opencode-turn)\.ts"/g,
        (_, name: string) =>
          JSON.stringify(pathToFileURL(resolve(`packages/agents/src/${name}.ts`)).href),
      );
    const entry = join(runtime, "runner.ts");
    writeFileSync(entry, source);
    const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
      cwd: project,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_STATE_HOME: join(home, "state"),
        TMPDIR: tmpdir(),
        PATH: `${resolve("packages/agents/runtime/node_modules/.bin")}:${process.env.PATH ?? ""}`,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          enabled_providers: ["openrouter"],
          provider: {
            openrouter: {
              options: {
                apiKey: "local-loopback-key",
                baseURL: `http://127.0.0.1:${address.port}/v1`,
              },
            },
          },
          permission: "deny",
          share: "disabled",
        }),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        CIVIC_SPARK_TEST_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      stdio: "pipe",
    });
    const events: AgentEvent[] = [];
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      try {
        events.push(JSON.parse(line) as AgentEvent);
      } catch {
        /* Diagnostics are not part of the runner protocol. */
      }
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk.toString();
    });
    const waitFor = async (predicate: () => boolean, timeout: number) => {
      const deadline = Date.now() + timeout;
      while (!predicate()) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(
            `Long-turn fixture did not reach the expected state: ${diagnostics} ${JSON.stringify(events.slice(-8))}`,
          );
        await new Promise((done) => setTimeout(done, 100));
      }
    };
    try {
      await waitFor(() => events.some((event) => event.type === "ready"), 30000);
      child.stdin.write(
        `${JSON.stringify({ type: "configure", provider: "opencode", key: "local-loopback-key" })}\n`,
      );
      await waitFor(() => events.some((event) => event.type === "configured"), 30000);
      const requestID = randomUUID();
      child.stdin.write(
        `${JSON.stringify({ type: "prompt", provider: "opencode", id: requestID, text: "Reply slowly for the local long-turn proof." })}\n`,
      );
      await waitFor(
        () => events.some((event) => event.type === "status" && event.text === "Working"),
        30000,
      );
      await waitFor(() => inferenceRequests === 1, 30000);
      await new Promise((done) => setTimeout(done, 301000));
      expect(Date.now() - inferenceStartedAt).toBeGreaterThan(300000);
      expect(holds).toBeGreaterThanOrEqual(6);
      expect(releases).toBe(0);
      expect(
        events.find((event) => event.type === "status" && event.text === "Working"),
      ).toBeDefined();
      expect(events.some((event) => event.type === "done")).toBe(false);
      await waitFor(
        () => events.some((event) => event.type === "done" && event.requestId === requestID),
        30000,
      );
      const done = events.find((event) => event.type === "done" && event.requestId === requestID);
      expect(done?.outcome).toBe("success");
      expect(inferenceRequests).toBe(1);
      expect(releases).toBe(1);
      console.log(
        JSON.stringify({
          node: process.version,
          opencode: "1.18.31",
          elapsedMs: Date.now() - inferenceStartedAt,
          inferenceRequests,
          holds,
          releases,
          outcome: done?.outcome,
        }),
      );
      expect(
        events.filter((event) => event.type === "user" && event.id === requestID),
      ).toHaveLength(1);
      const deliveredText = events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      expect(deliveredText).toBe(providerText);
      mkdirSync(resolve("artifacts"), { recursive: true });
      writeFileSync(
        resolve("artifacts/followup-long-turn-result.json"),
        JSON.stringify(
          {
            node: process.version,
            opencode: "1.18.31",
            inferenceRequests,
            holds,
            releases,
            elapsedMs: Date.now() - inferenceStartedAt,
            outcome: done?.outcome,
            providerText,
            deliveredText,
            trace,
          },
          null,
          2,
        ),
      );
      expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    } finally {
      child.kill();
      await new Promise<void>((done) => child.once("close", () => done()));
      reader.close();
      api.closeAllConnections();
      await new Promise<void>((done) => api.close(() => done()));
      await new Promise<void>((done) => tasks.close(() => done()));
      rmSync(home, { recursive: true, force: true });
    }
  },
  390000,
);
