import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliConfiguration } from "../packages/agents/src/cli-config.ts";
import { loadCredentials, saveCredential } from "../packages/agents/src/credentials.ts";
import { agentFailure, agentModels } from "../packages/agents/src/protocol.ts";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "vibehack-credential-test-"));
  homes.push(home);
  return home;
}
function json(home: string, path: string, value?: object) {
  const file = join(home, path);
  if (value) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value), { mode: 0o644 });
  }
  return JSON.parse(readFileSync(file, "utf8"));
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
describe("native CLI credential sharing", () => {
  it("preserves unrelated settings, restricts files, and keeps all credentials outside the project", () => {
    const home = fixture();
    mkdirSync(join(home, "project"));
    json(home, ".local/share/opencode/auth.json", { other: { type: "api", key: "other-fixture" } });
    json(home, ".config/opencode/opencode.json", { theme: "dark", permission: "ask" });
    json(home, ".claude/settings.json", {
      env: { KEEP_ME: "yes" },
      permissions: { additionalDirectories: ["/tmp"] },
      theme: "dark",
    });
    saveCredential(home, "opencode", "router-fixture");
    saveCredential(home, "claude", "anthropic-fixture");
    expect(loadCredentials(home)).toEqual({
      opencode: "router-fixture",
      claude: "anthropic-fixture",
    });
    expect(json(home, ".local/share/opencode/auth.json").other.key).toBe("other-fixture");
    expect(json(home, ".config/opencode/opencode.json")).toMatchObject({
      theme: "dark",
      permission: "allow",
      model: agentModels.opencode.model,
    });
    expect(json(home, ".claude/settings.json")).toMatchObject({
      theme: "dark",
      env: { KEEP_ME: "yes", ANTHROPIC_API_KEY: "anthropic-fixture" },
      permissions: { defaultMode: "bypassPermissions", additionalDirectories: ["/tmp"] },
      model: agentModels.claude.model,
    });
    for (const file of [
      ".local/share/opencode/auth.json",
      ".config/opencode/opencode.json",
      ".claude/settings.json",
    ])
      expect(statSync(join(home, file)).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, "project"))).toEqual([]);
  });
  it("does not overwrite working keys when existing configuration is malformed and sanitizes errors", () => {
    const home = fixture();
    saveCredential(home, "opencode", "original-fixture");
    writeFileSync(join(home, ".config/opencode/opencode.json"), "PRIVATE-BROKEN-JSON");
    try {
      saveCredential(home, "opencode", "replacement-fixture");
      throw new Error("Expected failure");
    } catch (error) {
      expect(agentFailure(error)).toContain("Could not save the agent settings");
      expect(String(error)).not.toContain("PRIVATE");
    }
    expect(loadCredentials(home).opencode).toBe("original-fixture");
    expect(readdirSync(join(home, ".config/opencode"))).toEqual(["opencode.json"]);
  });
  it("loads providers independently and refuses invalid JSON shapes or blank keys", () => {
    const home = fixture();
    saveCredential(home, "claude", "anthropic-fixture");
    json(home, ".local/share/opencode/auth.json", []);
    expect(loadCredentials(home)).toEqual({ claude: "anthropic-fixture" });
    expect(() => saveCredential(home, "opencode", "new-fixture")).toThrow();
    expect(() => saveCredential(home, "claude", "  ")).toThrow();
    expect(loadCredentials(home).claude).toBe("anthropic-fixture");
  });
  it("launches terminal agents with saved keys, fixed models and bypass permissions without argv secrets", () => {
    const home = fixture();
    saveCredential(home, "opencode", "router-fixture");
    saveCredential(home, "claude", "anthropic-fixture");
    const opencode = cliConfiguration(home, "opencode", ["serve", "--port", "12345"], {
      OPENROUTER_API_KEY: "stale",
      PATH: "/bin",
    });
    expect(opencode.args).toEqual(["serve", "--port", "12345"]);
    expect(opencode.env.OPENROUTER_API_KEY).toBe("router-fixture");
    expect(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT ?? "")).toMatchObject({
      model: agentModels.opencode.model,
      permission: "allow",
    });
    const claude = cliConfiguration(home, "claude", ["--continue"], { ANTHROPIC_API_KEY: "stale" });
    expect(claude.env.ANTHROPIC_API_KEY).toBe("anthropic-fixture");
    expect(claude.args).toEqual([
      "--model",
      agentModels.claude.model,
      "--dangerously-skip-permissions",
      "--append-system-prompt-file",
      join(home, ".vibehack-agent/workspace-context.md"),
      "--system-prompt-snapshot",
      "off",
      "--continue",
    ]);
    expect(JSON.stringify([opencode.args, claude.args])).not.toContain("fixture");
  });
});
