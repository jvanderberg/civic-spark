// Installed command wrappers invoke this only inside their participant Sprite.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { cliConfiguration } from "./cli-config.ts";

const provider = process.argv[2];
if (provider !== "claude" && provider !== "opencode") process.exit(2);
const configuration = cliConfiguration(
  "/home/sprite",
  provider,
  process.argv.slice(3),
  process.env,
);
const executable =
  provider === "claude"
    ? "/home/sprite/.vibehack-agent/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
    : "/home/sprite/.vibehack-agent/node_modules/opencode-ai/bin/opencode.exe";
const child = spawn(executable, configuration.args, { env: configuration.env, stdio: "inherit" });
child.on("error", () => {
  process.stderr.write("The agent runtime is incomplete. Reconnect in VibeHack to repair it.\n");
  process.exitCode = 1;
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
  });
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1));
});
