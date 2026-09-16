import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { claudeSystemPrompt } from "../packages/agents/src/context.ts";

it("sends fresh guidance and disables prompt snapshots across the real SDK resume boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibehack-prompt-"));
  const project = join(root, "project");
  mkdirSync(project);
  const session = "ae5f4a33-3d36-4fa6-b7f7-d82fc8f4d707";
  try {
    for (const resume of [undefined, session]) {
      const brief = resume ? "Updated bicycle visualization" : "Initial bicycle visualization";
      writeFileSync(join(project, "PROJECT.md"), brief);
      let initialized: Record<string, unknown> | undefined;
      let args: string[] = [];
      // Replace only the CLI process. The installed SDK serializes its real
      // initialization protocol; no provider, credentials or inference is used.
      const result = query({
        prompt: "Describe the configured environment",
        options: {
          cwd: project,
          resume,
          systemPrompt: claudeSystemPrompt(project),
          settingSources: [],
          env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: root },
          spawnClaudeCodeProcess(options) {
            args = options.args;
            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const emitter = new EventEmitter();
            const process = Object.assign(emitter, {
              stdin,
              stdout,
              killed: false,
              exitCode: null as number | null,
              kill() {
                this.killed = true;
                this.exitCode = 0;
                stdout.end();
                emitter.emit("exit", 0, null);
                return true;
              },
            });
            const send = (message: object) => stdout.write(`${JSON.stringify(message)}\n`);
            createInterface({ input: stdin }).on("line", (line) => {
              const message = JSON.parse(line);
              if (message.type === "control_request") {
                if (message.request.subtype === "initialize") initialized = message.request;
                send({
                  type: "control_response",
                  response: {
                    subtype: "success",
                    request_id: message.request_id,
                    response: { commands: [], models: [] },
                  },
                });
              } else if (message.type === "user") {
                send({ type: "result", subtype: "success", session_id: session, result: "OK" });
              }
            });
            stdin.on("finish", () => process.kill());
            return process;
          },
        },
      });
      for await (const _ of result) {
        // Drain the SDK transport normally, including its shutdown path.
      }
      expect(initialized?.systemPromptSnapshot).toBe(false);
      expect(initialized?.appendSystemPrompt).toContain(brief);
      expect(initialized?.appendSystemPrompt).toContain(
        "React + TypeScript + Vite + Tailwind CSS + Biome",
      );
      expect(initialized?.appendSystemPrompt).toContain("vibehack preview start");
      if (resume) expect(args).toContain(`--resume=${session}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
