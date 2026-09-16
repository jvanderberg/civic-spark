import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import {
  claudePrompt,
  openCodeParts,
  requireImageCapability,
} from "../packages/agents/src/multimodal.ts";
import { agentInputSchema, agentModels } from "../packages/agents/src/protocol.ts";

// Actual pinned harnesses, isolated fake credentials and loopback inference only.
// Prepare once: npm ci --prefix packages/agents/runtime
const root = await mkdtemp(join(tmpdir(), "cs-image-wire-"));
const project = join(root, "project");
await mkdir(project);
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const requests: { model: string; messages: { role: string; content: unknown }[] }[] = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!req.url?.includes("messages") && !req.url?.includes("chat/completions")) {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  const request = JSON.parse(body);
  requests.push(request);
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (req.url.includes("chat/completions")) {
    for (const delta of [{ role: "assistant", content: "" }, { content: "OK" }])
      res.write(
        `data: ${JSON.stringify({ id: "chatcmpl_local", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl_local", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    );
  } else {
    for (const event of [
      {
        type: "message_start",
        message: {
          id: "msg_local",
          type: "message",
          role: "assistant",
          model: request.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ])
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const baseURL = `http://127.0.0.1:${address.port}`;
const env = {
  PATH: process.env.PATH,
  HOME: root,
  TMPDIR: tmpdir(),
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  ANTHROPIC_API_KEY: "local-fake-key",
  ANTHROPIC_BASE_URL: baseURL,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
let openProcess: ReturnType<typeof spawn> | undefined;
try {
  for (const provider of ["claude", "opencode"] as const) {
    let client: ReturnType<typeof createOpencodeClient> | undefined;
    let session: string | undefined;
    if (provider === "opencode") {
      openProcess = spawn(
        resolve("packages/agents/runtime/node_modules/.bin/opencode"),
        ["serve", "--hostname=127.0.0.1", "--port=0"],
        {
          cwd: project,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: tmpdir(),
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_DATA_HOME: join(root, "data"),
            XDG_CACHE_HOME: join(root, "cache"),
            XDG_STATE_HOME: join(root, "state"),
            OPENCODE_DISABLE_AUTOUPDATE: "1",
            OPENCODE_DISABLE_MODELS_FETCH: "1",
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              enabled_providers: ["openrouter"],
              provider: {
                openrouter: { options: { apiKey: "local-fake-key", baseURL: `${baseURL}/v1` } },
              },
              permission: "deny",
              share: "disabled",
            }),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const child = openProcess;
      const url = await new Promise<string>((done, fail) => {
        const timer = setTimeout(() => fail(Error("OpenCode startup timed out")), 30000);
        let output = "";
        child.stdout?.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/opencode server listening on (http:\/\/[^\s]+)/);
          if (match?.[1]) {
            clearTimeout(timer);
            done(match[1]);
          }
        });
        child.once("error", fail);
        child.once("exit", (code) => {
          clearTimeout(timer);
          fail(Error(`OpenCode exited ${code}`));
        });
        child.stderr?.resume();
      });
      client = createOpencodeClient({ baseUrl: url, directory: project, throwOnError: true });
      const providers = await client.provider.list();
      const model = providers.data?.all.find((provider) => provider.id === "openrouter")?.models[
        "z-ai/glm-5.3-flash"
      ];
      assert(model, "Pinned OpenCode registry lacks exact configured GLM model");
      requireImageCapability(model.capabilities.input.image);
      session = (await client.session.create({ title: "Local image wire test" })).data?.id;
      assert(session);
      console.log(
        "Pinned OpenCode 1.18.31 registry: openrouter/z-ai/glm-5.3-flash input.image=true",
      );
    }
    for (const text of ["", "Inspect this screenshot", "Continue from the prior image"]) {
      const previous = session;
      const parsed = agentInputSchema.parse({
        type: "prompt",
        provider,
        text,
        images: text.startsWith("Continue")
          ? []
          : [{ id: crypto.randomUUID(), name: "Screenshot.png", mime: "image/png", data: png }],
      });
      assert(parsed.type === "prompt");
      const before = requests.length;
      if (provider === "claude") {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 30000);
        try {
          for await (const event of query({
            prompt: claudePrompt(parsed),
            options: {
              cwd: project,
              resume: session,
              env,
              model: agentModels.claude.model,
              tools: [],
              settingSources: [],
              maxTurns: 1,
              abortController: abort,
            },
          })) {
            if ("session_id" in event) session = event.session_id;
            if (event.type === "result") assert(!event.is_error, "Claude fake API turn failed");
          }
        } finally {
          clearTimeout(timer);
        }
      } else {
        assert(client && session);

        const response = await client.session.prompt({
          sessionID: session,
          model: { providerID: "openrouter", modelID: "z-ai/glm-5.3-flash" },
          parts: openCodeParts(parsed),
        });
        assert(!response.data?.info.error, "OpenCode local API turn failed");
      }
      assert(session);
      if (previous) assert.equal(session, previous, "Provider context changed");
      assert(requests.length > before, "No inference request captured");
      const request = requests.at(-1);
      assert(request);
      assert.equal(request.model, provider === "claude" ? "claude-opus-5" : "z-ai/glm-5.3-flash");
      const content = JSON.stringify(request.messages);
      assert(content.includes(png), "Actual provider request lost image bytes on send/resume");
      assert(content.includes(provider === "claude" ? '"type":"image"' : '"type":"image_url"'));
      if (text) assert(content.includes(text), "Mixed/followup text missing");
    }
    console.log(
      `PASS ${provider}: actual outgoing API contains image-only, mixed and resumed image context; fixed model/session retained.`,
    );
  }
} finally {
  if (openProcess && openProcess.exitCode === null) {
    openProcess.kill();
    await new Promise<void>((done) => openProcess?.once("close", () => done()));
  }
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
}
