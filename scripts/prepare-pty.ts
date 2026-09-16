import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// node-pty 1.1.0's macOS prebuilt helper ships without its executable bit.
// Repair only that installed package helper; never touch participant files.
if (process.platform === "darwin") {
  const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  const helper = join(root, "prebuilds", `darwin-${process.arch}`, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o111);
}
