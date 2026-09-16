import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import dockerignore from "@balena/dockerignore";

const root = fileURLToPath(new URL("../", import.meta.url));
// Docker directory negation includes descendants too (unlike the old glob approximation).
export function includedInContext(path: string, rules: string[]) {
  return !dockerignore().add(rules).ignores(path);
}
export function stageContext(destination: string) {
  const rules = readFileSync(join(root, ".dockerignore"), "utf8")
    .split("\n")
    .map((line) => line.trim());
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const included = paths.filter((path) => includedInContext(path, rules));
  for (const path of [
    "packages/agents/src/credentials.ts",
    "packages/sprites/src/credentials.ts",
    "templates/events/blank.json",
    "apps/web/index.html",
    "packages/agents/runtime/package-lock.json",
  ]) {
    if (!included.includes(path)) throw new Error(`Required build input excluded: ${path}`);
  }
  for (const path of [
    ".env",
    ".env.production",
    "apps/web/.env.local",
    "packages/agents/.data/token",
    ".data/fly/secrets.json",
    "deploy/fly/local-token.json",
    "packages/agents/private.key",
    "apps/server/artifacts/secret.json",
  ]) {
    if (includedInContext(path, rules))
      throw new Error("Sensitive test fixture would enter build context");
  }
  const scripts = included.filter((path) => path.startsWith("scripts/"));
  if (
    scripts.length !== 2 ||
    !scripts.includes("scripts/prepare-pty.ts") ||
    !scripts.includes("scripts/backup.ts")
  )
    throw new Error("Deployment must include only the install and recovery scripts");
  for (const path of included) {
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    copyFileSync(join(root, path), join(destination, path));
  }
  return included.length;
}
function main() {
  const directory = mkdtempSync(join(tmpdir(), "civic-spark-build-context-"));
  try {
    const count = stageContext(directory);
    if (!existsSync(join(root, "node_modules"))) throw new Error("Run npm ci first");
    // Local-only dependencies are attached AFTER staging; they never enter Docker context.
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
    execFileSync("npm", ["run", "build"], { cwd: directory, stdio: "inherit" });
    console.log(
      `Clean context passed TypeScript/Vite build (${count} packaged files). Linux image execution is a separate check.`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
