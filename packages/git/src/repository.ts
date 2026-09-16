import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { FILE_LIMIT, projectPath } from "../../workspace/src/types.ts";

export function git(cwd: string, args: string[], environment: NodeJS.ProcessEnv = {}): Buffer {
  const result = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args],
    {
      cwd,
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Civic Spark",
        GIT_AUTHOR_EMAIL: "workspace@civic-spark.local",
        GIT_COMMITTER_NAME: "Civic Spark",
        GIT_COMMITTER_EMAIL: "workspace@civic-spark.local",
        ...environment,
      },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Git operation failed. Your existing project has been preserved.");
  return result.stdout;
}
export function initializeTeam(root: string, teamId: string, templatePath: string, brief?: string) {
  const repo = join(root, "repos", `${teamId}.git`);
  const integration = join(root, "integration", teamId);
  mkdirSync(dirname(repo), { recursive: true });
  mkdirSync(integration, { recursive: true });
  git(root, ["init", "--bare", "--initial-branch=main", repo]);
  git(root, ["clone", repo, integration]);
  cpSync(templatePath, integration, { recursive: true });
  writeFileSync(join(integration, ".gitignore"), ".env\n.env.*\nnode_modules/\n.DS_Store\n*.log\n");
  if (brief) writeFileSync(join(integration, "PROJECT.md"), brief);
  git(integration, ["add", "."]);
  git(integration, ["commit", "-m", "Start the team project"]);
  git(integration, ["push", "origin", "main"]);
}
export function revision(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
export function safePath(root: string, name: string): string | null {
  if (isAbsolute(name) || !projectPath(name)) return null;
  const target = resolve(root, name);
  if (!target.startsWith(`${resolve(root)}${sep}`)) return null;
  let cursor = resolve(root);
  for (const segment of name.split("/")) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) return null;
  }
  if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).size > FILE_LIMIT)
    return null;
  if (!realpathSync(target).startsWith(`${realpathSync(root)}${sep}`)) return null;
  return target;
}
export function listFiles(root: string): string[] {
  const files: string[] = [];
  function visit(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (!projectPath(relative(root, path).split(sep).join("/")) || entry.isSymbolicLink())
        continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  }
  visit(root);
  return files.sort();
}
export function readText(path: string): string {
  const bytes = readFileSync(path);
  if (bytes.includes(0)) throw new Error("This file is binary. Use a download to inspect it.");
  return bytes.toString("utf8");
}
