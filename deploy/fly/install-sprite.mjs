import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("./sprite-release.json", import.meta.url)));
const entry = manifest.platforms[`linux-${process.arch === "arm64" ? "aarch64" : "x86_64"}`];
if (!["arm64", "x64"].includes(process.arch) || !entry || !process.argv[2])
  throw new Error("Unsupported Sprite target");
const response = await fetch(entry.providers[0].url);
if (!response.ok) throw new Error("Sprite download failed");
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== entry.digest)
  throw new Error("Sprite checksum mismatch");
writeFileSync(process.argv[2], bytes, { mode: 0o755 });
