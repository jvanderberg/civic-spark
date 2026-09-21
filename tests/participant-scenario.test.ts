import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  completedReply,
  completionText,
  FatalScenarioError,
  observeAgentEvent,
  redact,
  retry,
  scenarioSchema,
  turnEvents,
  verifyReactZip,
} from "../scripts/participant-scenario.ts";

const input = {
  version: 1,
  id: "test-person",
  baseUrl: "https://example.test",
  authMode: "demo",
  eventName: "Test",
  projectName: "Project",
  participant: { name: "Test Person", email: "test@example.test" },
  teamName: "Dedicated test",
};
describe("scripted participant configuration", () => {
  it("defaults to five-minute waits and bounds retries and paid completion questions", () => {
    const config = scenarioSchema.parse(input);
    expect(config.timing.completionWaitMs).toBe(300000);
    expect(config.timing.completionChecks).toBe(6);
    expect(scenarioSchema.safeParse({ ...input, timing: { retries: 99 } }).success).toBe(false);
    expect(scenarioSchema.safeParse({ ...input, key: "secret" }).success).toBe(false);
    expect(
      scenarioSchema.safeParse({ ...input, baseUrl: "https://key@example.test" }).success,
    ).toBe(false);
    expect(
      scenarioSchema.safeParse({ ...input, baseUrl: "http://public.example.test" }).success,
    ).toBe(false);
  });
  it("redacts provider keys and the exact supplied secret", () => {
    expect(redact("error sk-or-v1-abc123 and fixture-private", "fixture-private")).toBe(
      "error [REDACTED] and [REDACTED]",
    );
  });
  it("retries bounded transient failures, but never retries fatal conflicts", async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          if (++calls < 3) throw new Error("busy");
          return "ok";
        },
        2,
        1,
      ),
    ).resolves.toBe("ok");
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new FatalScenarioError("conflict");
        },
        3,
        1,
      ),
    ).rejects.toThrow("conflict");
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error("busy");
        },
        2,
        1,
      ),
    ).rejects.toThrow("busy");
    expect(calls).toBe(3);
  });
});
describe("agent completion evidence", () => {
  const question = `Are you done? Say ${completionText}`;
  const user = { type: "user", id: "user", text: question };
  const reply = { type: "text", id: "reply", text: completionText };
  const done = { type: "done", id: "done", text: "Done", outcome: "success" };
  it("requires a fresh assistant response and successful end of turn", () => {
    expect(completedReply([user, reply, done], question)).toBe(true);
    expect(
      completedReply(
        [user, { ...reply, text: "WE'RE " }, { ...reply, text: "ALL GOOD" }, done],
        question,
      ),
    ).toBe(true);
    expect(
      completedReply(
        [user, { ...reply, text: "WE'RE " }, { ...reply, id: "other", text: "ALL GOOD" }, done],
        question,
      ),
    ).toBe(false);
    expect(completedReply([user, done], question)).toBe(false);
    expect(
      completedReply([user, { ...user, text: "Another request" }, reply, done], question),
    ).toBe(false);
    expect(completedReply([reply, user, done], question)).toBe(false);
    expect(completedReply([user, { ...reply, type: "tool" }, done], question)).toBe(false);
    expect(completedReply([user, { ...reply, replayed: true }, done], question)).toBe(false);
    expect(completedReply([user, reply], question)).toBe(false);
    expect(completedReply([user, reply, { ...done, outcome: "failed" }], question)).toBe(false);
    expect(
      completedReply([user, { ...reply, text: `Not yet ${completionText}` }, done], question),
    ).toBe(false);
    expect(completedReply([user, { ...reply, text: "we're all good" }, done], question)).toBe(
      false,
    );
  });
});
describe("observed agent event buffer", () => {
  const question = `Are you done? Say ${completionText}`;
  it("coalesces streamed text deltas per message and keeps replayed events separate", () => {
    const events: Parameters<typeof observeAgentEvent>[0] = [];
    observeAgentEvent(events, { type: "user", id: "u1", text: question });
    observeAgentEvent(events, { type: "text", id: "m1", text: "WE'RE " });
    observeAgentEvent(events, { type: "text", id: "m1", text: "ALL GOOD" });
    observeAgentEvent(events, { type: "text", id: "m2", text: "other" });
    observeAgentEvent(events, { type: "text", id: "m2", text: "later", replayed: true });
    expect(events.map((event) => [event.id, event.text])).toEqual([
      ["u1", question],
      ["m1", "WE'RE ALL GOOD"],
      ["m2", "other"],
      ["m2", "later"],
    ]);
  });
  it("finds the current turn after the buffer trims older turns, and never trims the turn itself", () => {
    const events: Parameters<typeof observeAgentEvent>[0] = [];
    for (let i = 0; i < 30; i++)
      observeAgentEvent(events, { type: "text", id: `old${i}`, text: "x" }, 12);
    observeAgentEvent(events, { type: "user", id: "u1", text: question }, 12);
    for (let i = 0; i < 20; i++)
      observeAgentEvent(events, { type: "text", id: `m${i}`, text: "x" }, 12);
    observeAgentEvent(events, { type: "text", id: "final", text: completionText }, 12);
    observeAgentEvent(events, { type: "done", id: "d1", text: "Ready", outcome: "success" }, 12);
    expect(events[0]).toMatchObject({ type: "user", id: "u1" });
    expect(events).toHaveLength(23);
    expect(turnEvents(events, question)?.done).toMatchObject({ id: "d1", outcome: "success" });
    expect(completedReply(events, question)).toBe(true);
    expect(turnEvents(events, "never asked")).toBeUndefined();
    const pending = events.slice(0, -1);
    expect(turnEvents(pending, question)).toMatchObject({ done: undefined });
    expect(turnEvents(pending, question)?.turn).toHaveLength(21);
  });
  it("ignores a replayed end of turn and requires the fresh echo of the question", () => {
    const events: Parameters<typeof observeAgentEvent>[0] = [];
    observeAgentEvent(events, { type: "user", id: "u0", text: question, replayed: true });
    observeAgentEvent(events, {
      type: "done",
      id: "d0",
      text: "Ready",
      outcome: "success",
      replayed: true,
    });
    expect(turnEvents(events, question)).toBeUndefined();
    observeAgentEvent(events, { type: "user", id: "u1", text: question });
    observeAgentEvent(events, {
      type: "done",
      id: "d1",
      text: "Ready",
      outcome: "success",
      replayed: true,
    });
    expect(turnEvents(events, question)?.done).toBeUndefined();
  });
});
describe("React ZIP inspection", () => {
  it("inspects real archives without executing source; rejects manifest-only, missing React, and changed hello", () => {
    const root = mkdtempSync(join(tmpdir(), "civic-spark-zip-check-"));
    const zip = join(root, "out.zip");
    const archive = () => {
      rmSync(zip, { force: true });
      execFileSync("zip", ["-q", zip, "hello.txt", "package.json", "index.html", "main.tsx"], {
        cwd: root,
      });
    };
    const manifest = (deps: Record<string, string>) =>
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ dependencies: deps, scripts: { build: "vite build" } }),
      );
    try {
      writeFileSync(join(root, "hello.txt"), "42");
      writeFileSync(join(root, "index.html"), '<div id="root"></div>');
      writeFileSync(
        join(root, "main.tsx"),
        'import React from "react"; export default () => <h1>Hello</h1>;',
      );
      manifest({ react: "19", "react-dom": "19" });
      archive();
      expect(verifyReactZip(zip).manifest).toBe("package.json");
      expect(verifyReactZip(zip).data).toEqual({ files: 0, sources: false });
      mkdirSync(join(root, "public", "data"), { recursive: true });
      writeFileSync(join(root, "public", "data", "stops.json"), "[]");
      writeFileSync(join(root, "public", "data", "SOURCES.md"), "# Sources\n");
      execFileSync("zip", ["-q", "-r", zip, "public"], { cwd: root });
      expect(verifyReactZip(zip).data).toEqual({ files: 1, sources: true });
      archive();
      writeFileSync(join(root, "main.tsx"), "// React is planned");
      archive();
      expect(() => verifyReactZip(zip)).toThrow("ZIP lacks a React app");
      manifest({});
      archive();
      expect(() => verifyReactZip(zip)).toThrow("ZIP lacks a React app");
      writeFileSync(join(root, "hello.txt"), "43");
      archive();
      expect(() => verifyReactZip(zip)).toThrow("exactly 42");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
