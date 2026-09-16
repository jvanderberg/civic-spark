import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";

// Explicit integration test: creates and retains one paid-account Sprite, but calls no models.
if (!process.argv.includes("--live")) {
  throw new Error("Use npm run test:sprite -- --live to create one real, retained test Sprite.");
}
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const name = `vibehack-smoke-${Date.now().toString(36)}`;
const root = resolve(".data/sprite-smoke", name);
const local = join(root, "local");
mkdirSync(local, { recursive: true });
git(local, ["init", "--initial-branch=main"]);
writeFileSync(
  join(local, "README.md"),
  "# VibeHack transport rehearsal\n\nCreated on the organizer’s Mac.\n",
);
git(local, ["add", "."]);
git(local, ["commit", "-m", "Seed repository on Mac"]);
const initialCommit = git(local, ["rev-parse", "HEAD"]).toString().trim();
const outbound = join(root, "outbound.bundle");
git(local, ["bundle", "create", outbound, "--all"]);
const client = new SpriteClient();
console.log(`Creating dedicated test Sprite ${name}`);
unwrap(await client.create(name));
// Record the resource immediately, including if a later step fails.
writeFileSync(
  join(root, "resource.json"),
  JSON.stringify({ name, createdAt: new Date().toISOString() }, null, 2),
);
const home = unwrap(await client.exec(name, ["pwd"]))
  .toString()
  .trim();
console.log(`Remote working directory: ${home}`);
unwrap(await client.uploadBundle(name, outbound));
const remoteInitial = unwrap(
  await client.exec(name, ["git", "-C", "/home/sprite/project", "rev-parse", "HEAD"]),
)
  .toString()
  .trim();
assert.equal(remoteInitial, initialCommit);
console.log(`Mac → Sprite verified at ${initialCommit}`);
unwrap(
  await client.exec(name, [
    "bash",
    "-lc",
    "set -e; cd /home/sprite/project; printf 'This commit was made inside a Sprite.\n' > sprite-result.txt; git add sprite-result.txt; git commit -m 'Return work from Sprite'; git bundle create /tmp/vibehack-return.bundle --all",
  ]),
);
const remoteCommit = unwrap(
  await client.exec(name, ["git", "-C", "/home/sprite/project", "rev-parse", "HEAD"]),
)
  .toString()
  .trim();
const inbound = join(root, "inbound.bundle");
writeFileSync(inbound, unwrap(await client.exec(name, ["cat", "/tmp/vibehack-return.bundle"])));
git(local, ["bundle", "verify", inbound]);
git(local, ["fetch", inbound, "main:refs/remotes/sprite/main"]);
git(local, ["merge", "--ff-only", "refs/remotes/sprite/main"]);
assert.equal(git(local, ["rev-parse", "HEAD"]).toString().trim(), remoteCommit);
assert.equal(
  readFileSync(join(local, "sprite-result.txt"), "utf8"),
  "This commit was made inside a Sprite.\n",
);
const report = {
  name,
  initialCommit,
  remoteCommit,
  verifiedAt: new Date().toISOString(),
  transport: "Git bundles uploaded and downloaded through authenticated Sprite CLI",
  modelCalls: 0,
  retained: true,
};
writeFileSync(join(root, "result.json"), JSON.stringify(report, null, 2));
console.log(
  `Sprite → Mac verified at ${remoteCommit}\nPASS. Report: ${join(root, "result.json")}\nSprite retained: ${name}`,
);
