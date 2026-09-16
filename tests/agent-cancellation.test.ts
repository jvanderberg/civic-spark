import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { saveCredential } from "../packages/agents/src/credentials.ts";
import type { AgentEvent } from "../packages/agents/src/protocol.ts";

it.each(["claude", "opencode"] as const)(
  "Stop during delayed Tasks PUT prevents %s inference and releases the hold; next explicit turn works",
  async (provider) => {
    const home = mkdtempSync(join(tmpdir(), "cs-cancel-"));
    const runtime = join(home, ".civic-spark-agent");
    mkdirSync(runtime);
    mkdirSync(join(home, "project"));
    saveCredential(home, provider, "fake-key");
    const socketPath = join(home, "tasks.sock");
    let pending: ServerResponse | undefined;
    let puts = 0;
    let deletes = 0;
    const server = createServer((req, res) => {
      req.resume();
      if (req.method === "PUT") {
        puts++;
        if (puts === 1) pending = res;
        else res.end("{}");
      } else {
        deletes++;
        res.writeHead(204).end();
      }
    });
    await new Promise<void>((done) => server.listen(socketPath, done));
    const invoked = join(home, "invocations");
    const mocks = join(home, "mock.mjs");
    writeFileSync(
      mocks,
      `
    import {appendFileSync} from 'node:fs';
    const invoked = () => appendFileSync(${JSON.stringify(invoked)}, 'model\n');
    export async function verifyProviderKey() { return {}; }
    export async function* query() { invoked(); }
    export async function getSessionMessages() { return []; }
    export async function createOpencodeServer() { return {url:'http://127.0.0.1:1',close(){}}; }
    export function createOpencodeClient() { return {
      event:{subscribe:async()=>({stream:(async function*(){})()})},
      session:{create:async()=>({data:{id:'preserved-session'}}),abort:async()=>{},prompt:async()=>{invoked();return {};}}
    }; }
  `.replace("'model\n'", "'model\\n'"),
    );
    writeFileSync(
      join(runtime, "context.ts"),
      "export const claudeSystemPrompt = () => ''; export const workspaceContext = () => '';\n",
    );
    writeFileSync(
      join(runtime, "activity.ts"),
      readFileSync(resolve("packages/agents/src/activity.ts"), "utf8").replace(
        '"/.sprite/api.sock"',
        JSON.stringify(socketPath),
      ),
    );
    const entry = join(runtime, "runner.ts");
    writeFileSync(
      entry,
      readFileSync(resolve("packages/agents/src/runner.ts"), "utf8")
        .replaceAll("/home/sprite", home)
        .replaceAll('"@anthropic-ai/claude-agent-sdk"', JSON.stringify(pathToFileURL(mocks).href))
        .replaceAll('"@opencode-ai/sdk/v2"', JSON.stringify(pathToFileURL(mocks).href))
        .replaceAll('"./provider.ts"', JSON.stringify(pathToFileURL(mocks).href))
        .replace(/"\.\/(credentials|journal|protocol)\.ts"/g, (_, name: string) =>
          JSON.stringify(pathToFileURL(resolve(`packages/agents/src/${name}.ts`)).href),
        ),
    );
    const child = spawn(process.execPath, ["--experimental-strip-types", entry], { stdio: "pipe" });
    const events: AgentEvent[] = [];
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => events.push(JSON.parse(line) as AgentEvent));
    let diagnostics = "";
    child.stderr.on("data", (data) => {
      diagnostics += data.toString();
    });
    const send = (value: object) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const wait = (check: () => boolean) =>
      vi.waitFor(() => expect(check(), diagnostics).toBe(true), { timeout: 4000, interval: 10 });
    try {
      await wait(() => events.some((e) => e.type === "ready"));
      send({ type: "prompt", provider, text: "First explicit turn" });
      await wait(() => Boolean(pending));
      send({ type: "stop" });
      // FIFO barrier: a subsequent prompt is rejected while the cancelled turn is still draining.
      send({ type: "prompt", provider, text: "Barrier while active" });
      await wait(() =>
        events.some((e) => e.type === "error" && e.text.includes("already running")),
      );
      pending?.end("{}");
      await wait(() => events.some((e) => e.type === "done"));
      expect(deletes).toBe(1);
      expect(() => readFileSync(invoked)).toThrow();
      send({ type: "prompt", provider, text: "Next explicit turn" });
      await wait(() => events.filter((e) => e.type === "done").length === 2);
      expect(readFileSync(invoked, "utf8")).toBe("model\n");
      expect(puts).toBe(2);
      expect(deletes).toBe(2);
    } finally {
      pending?.end("{}");
      child.kill();
      await new Promise<void>((done) => child.once("close", () => done()));
      reader.close();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(home, { recursive: true, force: true });
    }
  },
);
