import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { loadCredentials, saveCredential } from "../packages/agents/src/credentials.ts";
import type { AgentEvent } from "../packages/agents/src/protocol.ts";

it("keeps a saved OpenRouter key through startup failure and retries the native credential without browser key submission", async () => {
  const home = mkdtempSync(join(tmpdir(), "civic-spark-saved-key-"));
  const runtime = join(home, ".civic-spark-agent");
  mkdirSync(runtime);
  mkdirSync(join(home, "project"));
  saveCredential(home, "opencode", "fake-router-startup");
  const mocks = join(home, "mock.mjs");
  writeFileSync(
    mocks,
    `
    let checks = 0;
    export async function verifyProviderKey() {
      if (++checks === 1) throw new Error("fetch failed");
      return {};
    }
    export function query() { throw new Error("No model requests permitted"); }
    export async function getSessionMessages() { return []; }
    export async function createOpencodeServer() { return {url:"http://127.0.0.1:1",close(){}}; }
    export function createOpencodeClient() { return {event:{subscribe:async()=>({stream:(async function*(){})()})}}; }
  `,
  );
  const source = readFileSync(resolve("packages/agents/src/runner.ts"), "utf8")
    .replaceAll("/home/sprite", home)
    .replaceAll('"@anthropic-ai/claude-agent-sdk"', JSON.stringify(pathToFileURL(mocks).href))
    .replaceAll('"@opencode-ai/sdk/v2"', JSON.stringify(pathToFileURL(mocks).href))
    .replaceAll('"./provider.ts"', JSON.stringify(pathToFileURL(mocks).href))
    .replace(
      /"\.\/(credentials|journal|protocol|multimodal|activity|opencode-turn)\.ts"/g,
      (_, name: string) =>
        JSON.stringify(pathToFileURL(resolve(`packages/agents/src/${name}.ts`)).href),
    );
  const entry = join(runtime, "runner.ts");
  writeFileSync(entry, source);
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], { stdio: "pipe" });
  const events: AgentEvent[] = [];
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => events.push(JSON.parse(line) as AgentEvent));
  child.stderr.resume();
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error("Fixture runner did not reach expected state");
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  try {
    await waitFor(() => events.some((event) => event.type === "state" && event.runtimeReady));
    expect(events.at(-1)).toMatchObject({
      savedProviders: ["opencode"],
      configuredProviders: [],
      failedProviders: ["opencode"],
    });
    expect(loadCredentials(home).opencode).toBe("fake-router-startup");
    // A native terminal can update the same private credential between attempts.
    saveCredential(home, "opencode", "fake-router-native-replacement");
    child.stdin.write(`${JSON.stringify({ type: "reconnect", provider: "opencode" })}\n`);
    await waitFor(() => events.some((event) => event.type === "configured"));
    await waitFor(() => events.at(-1)?.configuredProviders?.includes("opencode") === true);
    expect(events.at(-1)).toMatchObject({
      savedProviders: ["opencode"],
      configuredProviders: ["opencode"],
      failedProviders: [],
    });
    expect(loadCredentials(home).opencode).toBe("fake-router-native-replacement");
    expect(JSON.stringify(events)).not.toContain("fake-router");
    expect(events.filter((event) => event.type === "user")).toHaveLength(0);
  } finally {
    child.kill();
    await new Promise<void>((done) => child.once("close", () => done()));
    reader.close();
    rmSync(home, { recursive: true, force: true });
  }
});
