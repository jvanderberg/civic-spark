// Runs exclusively inside the participant Sprite. No host URL/key is exposed.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const root = "/home/sprite/.civic-spark-agent";
const folder = `${root}/integration`;
const args = process.argv.slice(2);
const [group, action] = args;
async function request(value: object) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const input = `${folder}/${id}.request`;
  const output = `${folder}/${id}.response`;
  writeFileSync(input, JSON.stringify({ ...value, id }), { mode: 0o600, flag: "wx" });
  try {
    for (let i = 0; i < 1200; i++) {
      if (existsSync(output)) {
        const result = JSON.parse(readFileSync(output, "utf8"));
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      await setTimeout(250);
    }
    throw new Error(
      "Civic Spark integration did not respond. Reopen your workspace in the browser, then retry. Your local commits remain saved.",
    );
  } finally {
    rmSync(input, { force: true });
    rmSync(output, { force: true });
  }
}
try {
  if (group === "git" && ["publish", "status"].includes(action ?? "")) {
    await request({ operation: action === "publish" ? "git-publish" : "git-status" });
  } else if (group === "preview") {
    if (!["start", "restart", "stop", "status", "logs"].includes(action ?? ""))
      throw new Error("Use civic-spark preview start, restart, stop, status, or logs.");
    if (args.length > 2) {
      const port = Number(args[3]);
      if (
        action !== "start" ||
        args[2] !== "--port" ||
        !Number.isInteger(port) ||
        port < 1024 ||
        port > 65535 ||
        args[4] !== "--" ||
        args.length < 6
      )
        throw new Error("Usage: civic-spark preview start [--port 5173 -- <command> args]");
      await request({ operation: "preview-start", port, command: args.slice(5) });
    } else await request({ operation: `preview-${action}` });
  } else
    throw new Error(
      "Use civic-spark git publish/status or civic-spark preview start/status/logs/stop.",
    );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Integration failed"}\n`);
  process.exitCode = 1;
}
