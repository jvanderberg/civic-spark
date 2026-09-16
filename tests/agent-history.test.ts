import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentReplay, historyByteLimit, historyLimit } from "../packages/agents/src/history.ts";
import { AgentJournal } from "../packages/agents/src/journal.ts";
import type { AgentEvent } from "../packages/agents/src/protocol.ts";

const roots: string[] = [];
function path() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-history-"));
  roots.push(root);
  return join(root, "conversation.json");
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("agent reconnect state and durable conversation", () => {
  it("retains saved-key presence independently of failed startup and reconnects", () => {
    const replay = new AgentReplay();
    replay.accept({
      type: "state",
      id: "starting",
      text: "Connecting",
      runtimeReady: false,
      configuredProviders: [],
      savedProviders: ["opencode", "claude"],
      failedProviders: [],
    });
    expect(replay.snapshot()).toMatchObject({
      savedProviders: ["opencode", "claude"],
      configuredProviders: [],
    });
    replay.accept({
      type: "error",
      id: "provider-error",
      text: "Saved key failed to connect",
      provider: "opencode",
      credentialFailure: true,
    });
    const restored = new AgentReplay();
    restored.accept(replay.snapshot());
    expect(restored.snapshot()).toMatchObject({
      savedProviders: ["opencode", "claude"],
      failedProviders: ["opencode"],
    });
    restored.accept({ type: "configured", id: "opencode", text: "GLM ready" });
    expect(restored.snapshot()).toMatchObject({
      savedProviders: ["opencode", "claude"],
      configuredProviders: ["opencode"],
      failedProviders: [],
    });
    restored.accept({
      type: "error",
      id: "network-error",
      text: "Temporary network failure",
      provider: "opencode",
      credentialFailure: false,
    });
    expect(restored.snapshot().failedProviders).toEqual([]);
    restored.accept({
      type: "error",
      id: "old-auth-error",
      text: "Old rejected key",
      provider: "opencode",
      credentialFailure: true,
      replayed: true,
    });
    expect(restored.snapshot().failedProviders).toEqual([]);
  });
  it("preserves current readiness and work independently of capped transcript history", () => {
    const replay = new AgentReplay();
    replay.accept({ type: "ready", id: "ready", text: "Ready" });
    replay.accept({ type: "configured", id: "opencode", text: "GLM ready" });
    replay.accept({ type: "status", id: "busy", text: "Working" });
    for (let i = 0; i < 600; i++)
      replay.accept({ type: "tool", id: `${i}`, text: "Read", details: `file-${i}` });
    expect(replay.events).toHaveLength(historyLimit);
    expect(replay.events.some((e) => e.id === "busy")).toBe(false);
    expect(replay.snapshot()).toMatchObject({
      type: "state",
      runtimeReady: true,
      working: true,
      configuredProviders: ["opencode"],
    });
    replay.accept({
      type: "state",
      id: "runtime-state",
      text: "Ready",
      runtimeReady: true,
      working: false,
      configuredProviders: [],
    });
    expect(replay.snapshot()).toMatchObject({ working: false, configuredProviders: [] });
  });
  it("preserves the runtime turn clock across reconnect and clears it on settlement", () => {
    const replay = new AgentReplay();
    const workingStartedAt = "2026-09-16T12:00:00.000Z";
    replay.accept({ type: "status", id: "start", text: "Working", workingStartedAt });
    expect(replay.snapshot()).toMatchObject({ working: true, workingStartedAt });
    replay.accept({
      type: "status",
      id: "old",
      text: "Working",
      workingStartedAt: "2020-01-01T00:00:00.000Z",
      replayed: true,
    });
    expect(replay.snapshot().workingStartedAt).toBe(workingStartedAt);
    const reconnect = new AgentReplay();
    reconnect.accept(replay.snapshot());
    expect(reconnect.snapshot().workingStartedAt).toBe(workingStartedAt);
    reconnect.accept({ type: "error", id: "failed", text: "Provider failed" });
    expect(reconnect.snapshot()).toMatchObject({ working: false, workingStartedAt: undefined });
    replay.accept({ type: "done", id: "done", text: "Ready" });
    expect(replay.snapshot().workingStartedAt).toBeUndefined();
    replay.accept({ type: "status", id: "legacy", text: "Working" });
    expect(replay.snapshot().workingStartedAt).toBeUndefined();
    const journal = new AgentJournal(path());
    journal.record({ type: "status", id: "start", text: "Working", workingStartedAt });
    journal.flush();
    expect(journal.events[0]?.workingStartedAt).toBe(workingStartedAt);
  });
  it("separates historical errors from the current failure during both replay paths", () => {
    const replay = new AgentReplay();
    replay.accept({
      type: "error",
      id: "old-failure",
      text: "Old provider failure",
      replayed: true,
    });
    replay.accept({ type: "status", id: "old-working", text: "Working", replayed: true });
    expect(replay.events.map((event) => event.id)).toEqual(["old-failure", "old-working"]);
    expect(replay.snapshot()).toMatchObject({
      currentError: null,
      working: false,
      runtimeReady: false,
    });
    replay.accept({ type: "error", id: "current-failure", text: "Saved API key was rejected" });
    replay.accept({ type: "ready", id: "ready", text: "Runtime ready" });
    replay.accept({
      type: "state",
      id: "state",
      text: "Ready",
      runtimeReady: true,
      working: false,
      configuredProviders: [],
    });
    expect(replay.snapshot()).toMatchObject({
      currentError: "Saved API key was rejected",
      runtimeReady: true,
    });
    replay.accept({ type: "configured", id: "opencode", text: "GLM ready" });
    replay.accept({
      type: "error",
      id: "old-failure",
      text: "Old provider failure",
      replayed: true,
    });
    expect(replay.snapshot()).toMatchObject({
      currentError: null,
      configuredProviders: ["opencode"],
    });
    replay.accept({ type: "error", id: "turn-failure", text: "Current turn failed" });
    replay.accept({ type: "done", id: "done", text: "Ready" });
    expect(replay.snapshot().currentError).toBe("Current turn failed");
    replay.accept({ type: "user", id: "retry", text: "Try again" });
    expect(replay.snapshot().currentError).toBeNull();
  });
  it("aggregates streamed text and latest tool state within the byte cap", () => {
    const replay = new AgentReplay();
    replay.accept({ type: "text", id: "reply", text: "Hello " });
    replay.accept({ type: "text", id: "reply", text: "again" });
    replay.accept({ type: "tool", id: "edit", text: "Edit", details: "running" });
    replay.accept({ type: "tool", id: "edit", text: "Edit", details: "completed" });
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0]?.text).toBe("Hello again");
    expect(replay.events[1]?.details).toBe("completed");
    for (let i = 0; i < 20; i++)
      replay.accept({ type: "text", id: `large-${i}`, text: "x".repeat(200000) });
    expect(Buffer.byteLength(JSON.stringify(replay.events))).toBeLessThanOrEqual(historyByteLimit);
  });
  it("restores transcript after restart, flags interrupted work, and clears that flag after completion", () => {
    const file = path();
    const journal = new AgentJournal(file);
    journal.record({ type: "user", id: "question", text: "Make a chart" });
    journal.record({ type: "status", id: "working", text: "Working" });
    journal.record({ type: "text", id: "answer", text: "Starting" });
    journal.flush();
    const restored = new AgentJournal(file);
    expect(restored.interrupted).toBe(true);
    expect(restored.events.map((e) => e.text)).toContain("Starting");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    restored.record({ type: "done", id: "interrupted", text: "Ready" });
    expect(new AgentJournal(file).interrupted).toBe(false);
  });
  it("never records configure payloads and redacts known secrets from transcript content", () => {
    const file = path();
    const secret = "private-test-api-key";
    const journal = new AgentJournal(file, [secret]);
    journal.record({
      type: "configure",
      provider: "opencode",
      key: secret,
    } as unknown as AgentEvent);
    journal.record({ type: "configured", id: "opencode", text: "GLM ready" });
    journal.record({
      type: "user",
      id: "text",
      text: `A pasted key ${secret}`,
      key: secret,
    } as AgentEvent);
    journal.flush();
    const content = readFileSync(file, "utf8");
    expect(content).not.toContain(secret);
    expect(content).not.toContain('"key"');
    expect(content).not.toContain('"configure"');
    expect(content).toContain("[redacted]");
    expect(new AgentJournal(file).events).toHaveLength(1);
  });
  it("tolerates damaged journal files and reports write failure without killing a live turn", () => {
    const file = path();
    writeFileSync(file, "{broken");
    expect(new AgentJournal(file).events).toEqual([]);
    const journal = new AgentJournal(join(file, "impossible.json"));
    expect(() => journal.record({ type: "user", id: "new", text: "Continue" })).not.toThrow();
    expect(journal.failed).toBe(true);
  });
  it("loads runtime support modules with Node's native TypeScript stripping", () => {
    const module = fileURLToPath(new URL("../packages/agents/src/journal.ts", import.meta.url));
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(module)})`,
        ],
        { stdio: "pipe" },
      ),
    ).not.toThrow();
  });
});
