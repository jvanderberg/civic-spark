import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceContext } from "./context.ts";
import { claudeEnvironment, loadCredentials } from "./credentials.ts";
import { agentModels } from "./protocol.ts";

// Used by both terminal launchers. Keys stay in the child environment, never argv.
export function cliConfiguration(
  home: string,
  provider: keyof typeof agentModels,
  args: string[],
  inherited: NodeJS.ProcessEnv,
) {
  const env = { ...inherited };
  // Native Claude's version probe must not initialize a prompt-file session.
  // Setup verifies the executable; only actual coding launches need context.
  if (args.includes("--version")) return { env, args };
  const runtime = join(home, ".vibehack-agent");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const contextFile = join(runtime, "workspace-context.md");
  writeFileSync(contextFile, workspaceContext(join(home, "project")), { mode: 0o600 });
  const key = loadCredentials(home)[provider];
  if (provider === "opencode") {
    if (key) env.OPENROUTER_API_KEY = key;
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: agentModels.opencode.model,
      permission: "allow",
      instructions: [contextFile],
    });
    return { env, args };
  }
  if (key) env.ANTHROPIC_API_KEY = key;
  return {
    env: claudeEnvironment(home, env, key),
    args: [
      "--model",
      agentModels.claude.model,
      "--dangerously-skip-permissions",
      "--append-system-prompt-file",
      contextFile,
      // Match browser Claude: a resume must not restore an obsolete brief/policy.
      "--system-prompt-snapshot",
      "off",
      ...args,
    ],
  };
}
