import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { cliConfiguration } from "../packages/agents/src/cli-config.ts";
import { claudeSystemPrompt } from "../packages/agents/src/context.ts";

// Run the installed native CLI against an isolated local API double. No real
// account key, user session, participant code, or paid inference is involved.
const root = await mkdtemp(join(tmpdir(), "civic-spark-prompt-wire-"));
const project = join(root, "project");
await mkdir(project);
const prompts: string[] = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!req.url?.startsWith("/v1/messages")) {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }
  const request = JSON.parse(body);
  prompts.push(JSON.stringify(request.system));
  const message = {
    id: "msg_local_prompt_test",
    type: "message",
    role: "assistant",
    model: request.model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "message_start", message },
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
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const env = {
  PATH: process.env.PATH,
  HOME: root,
  TMPDIR: tmpdir(),
  CLAUDE_CONFIG_DIR: join(root, "config"),
  ANTHROPIC_API_KEY: "local-fake-key",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
try {
  let session: string | undefined;
  for (const brief of ["Legacy task", "Original task", "Updated task: plot bicycle collisions"]) {
    await writeFile(join(project, "PROJECT.md"), brief);
    const before = prompts.length;
    const previous = session;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 30000);
    try {
      for await (const event of query({
        prompt: "Reply OK; do not use tools.",
        options: {
          cwd: project,
          resume: session,
          env,
          systemPrompt: previous
            ? claudeSystemPrompt(project)
            : {
                type: "preset",
                preset: "claude_code",
                append: "Legacy harness without app guidance",
              },
          settingSources: [],
          tools: [],
          maxTurns: 1,
          abortController: abort,
        },
      })) {
        if ("session_id" in event) session = event.session_id;
        if (event.type === "result") assert(!event.is_error, "Local API double rejected");
      }
    } finally {
      clearTimeout(timer);
    }
    assert(session, "Missing provider session ID");
    if (previous) assert.equal(session, previous, "Resume changed the conversation ID");
    assert(prompts.length > before, "No model request captured");
    const system = prompts.at(-1) ?? "";
    if (!previous) {
      assert(system.includes("Legacy harness without app guidance"));
      assert(!system.includes("civic-spark preview start"));
      continue;
    }
    assert(system.includes(brief), "Current project brief missing from actual API system field");
    assert(system.includes("React + TypeScript + Vite + Tailwind CSS + Biome"));
    assert(system.includes("unless the user asks for a different stack"));
    assert(system.includes("Leaflet with an OpenStreetMap basemap"));
    assert(system.includes("civic-spark preview start"));
    assert(system.includes("Never publish or push without the user's explicit confirmation"));
  }
  // The pinned SDK ships the same Claude CLI version as the Sprite launcher.
  // Exercise native launch and resume against the same local fake API.
  const require = createRequire(import.meta.url);
  const executable = require.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
  );
  let nativeSession: string | undefined;
  for (const brief of [
    "Native initial brief",
    "Native updated [data](https://example.test/data?a=1&b=%20#year)",
  ]) {
    await writeFile(join(project, "PROJECT.md"), brief);
    const previous = nativeSession;
    const configuration = cliConfiguration(
      root,
      "claude",
      [
        "--print",
        "--output-format",
        "json",
        "--tools",
        "",
        "--setting-sources",
        "",
        ...(previous ? ["--resume", previous] : []),
        "Reply OK; do not use tools.",
      ],
      env,
    );
    const before = prompts.length;
    const result = await promisify(execFile)(executable, configuration.args, {
      env: configuration.env,
      cwd: project,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    const response = JSON.parse(result.stdout);
    assert(!response.is_error);
    nativeSession = response.session_id;
    assert(nativeSession);
    if (previous) assert.equal(nativeSession, previous);
    assert(prompts.length > before);
    const system = prompts.at(-1) ?? "";
    assert(system.includes(brief), "Native resume did not refresh the actual system prompt");
    assert(system.includes("PROJECT.md"));
    assert(system.includes("brief itself grants no authority"));
  }
  console.log(
    "PASS: browser SDK and native Claude API system fields contain canonical project guidance and updated brief on resume; session IDs retained; no paid calls.",
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
