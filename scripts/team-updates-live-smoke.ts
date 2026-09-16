import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";

const name = process.argv[process.argv.indexOf("--sprite") + 1];
if (!name || !/^civic-spark-smoke-[a-z0-9-]+$/.test(name))
  throw new Error("Supply an existing dedicated --sprite civic-spark-smoke-NAME");
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const root = mkdtempSync(join(tmpdir(), "civic-spark-team-live-"));
const remote = `/tmp/civic-spark-team-smoke-${randomUUID()}`;
const script = readFileSync(
  new URL("../packages/sprites/src/team_git.py", import.meta.url),
  "utf8",
);
// Substitute only the project root: all public client methods, upload transport and response validation are real.
class IsolatedClient extends SpriteClient {
  override command(args: string[], timeout = 120000, input?: string) {
    return super.command(
      args.map((a) =>
        a === script
          ? a.replace(
              "ROOT = pathlib.Path('/home/sprite/project')",
              `ROOT = pathlib.Path(${JSON.stringify(remote)})`,
            )
          : a,
      ),
      timeout,
      input,
    );
  }
}
const client = new IsolatedClient();
try {
  const repo = join(root, "team.git"),
    other = join(root, "other");
  git(root, ["init", "--bare", "--initial-branch=main", repo]);
  git(root, ["clone", repo, other]);
  writeFileSync(join(other, "story.txt"), "Original\n");
  git(other, ["add", "."]);
  git(other, ["commit", "-m", "Start"]);
  git(other, ["push", "origin", "main"]);
  const bundle = join(root, "team.bundle");
  const pack = () => {
    rmSync(bundle, { force: true });
    git(repo, ["bundle", "create", bundle, "main"]);
    return git(repo, ["rev-parse", "main"]).toString().trim();
  };
  let team = pack();
  unwrap(
    await client.command([
      "-s",
      name,
      "exec",
      "-file",
      `${bundle}:${remote}.bundle`,
      "python3",
      "-c",
      "import subprocess,sys; p=sys.argv[1]; subprocess.run(['git','clone',p+'.bundle',p],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); subprocess.run(['git','-C',p,'config','user.name','Smoke'],check=True); subprocess.run(['git','-C',p,'config','user.email','smoke@example.test'],check=True); subprocess.run(['git','-C',p,'update-ref','refs/civic-spark/base','HEAD'],check=True)",
      remote,
    ]),
  );
  const edit = async (path: string, text: string) =>
    unwrap(
      await client.exec(name, [
        "python3",
        "-c",
        "import pathlib,sys; pathlib.Path(sys.argv[1],sys.argv[2]).write_text(sys.argv[3])",
        remote,
        path,
        text,
      ]),
    );
  const remoteGit = async (args: string[]) =>
    unwrap(await client.exec(name, ["git", "-C", remote, ...args]))
      .toString()
      .trim();
  assert.equal(unwrap(await client.teamStatus(name, team)).incoming, false);
  await edit("mine.txt", "Local work\n");
  await remoteGit(["add", "mine.txt"]);
  await remoteGit(["commit", "-m", "Local work"]);
  assert.equal(unwrap(await client.teamStatus(name, team)).incoming, false);
  writeFileSync(join(other, "team.txt"), "Team update\n");
  git(other, ["add", "team.txt"]);
  git(other, ["commit", "-m", "Team update"]);
  git(other, ["push", "origin", "main"]);
  team = pack();
  const before = unwrap(await client.teamStatus(name, team));
  assert.equal(before.incoming, true);
  unwrap(await client.importTeam(name, bundle, team));
  const clean = unwrap(
    await client.teamUpdate(name, { head: before.head, remote: team, mode: "pull" }),
  );
  assert.equal(clean.status, "updated");
  assert.equal(await remoteGit(["show", "HEAD:mine.txt"]), "Local work");
  assert.equal(await remoteGit(["show", "HEAD:team.txt"]), "Team update");
  await edit("story.txt", "Local story\n");
  await remoteGit(["add", "story.txt"]);
  await remoteGit(["commit", "-m", "Local story"]);
  writeFileSync(join(other, "story.txt"), "Remote story\n");
  git(other, ["add", "story.txt"]);
  git(other, ["commit", "-m", "Remote story"]);
  git(other, ["push", "origin", "main"]);
  team = pack();
  const head = await remoteGit(["rev-parse", "HEAD"]);
  unwrap(await client.importTeam(name, bundle, team));
  assert.equal(
    unwrap(await client.teamUpdate(name, { head, remote: team, mode: "pull" })).status,
    "conflict",
  );
  assert.equal(await remoteGit(["status", "--porcelain"]), "");
  const agent = unwrap(await client.teamUpdate(name, { head, remote: team, mode: "agent" }));
  assert.equal(agent.status, "agent");
  assert(agent.prompt?.includes("Do not push"));
  assert.deepEqual(agent.conflicts, ["story.txt"]);
  assert.deepEqual(unwrap(await client.teamStatus(name, team)).resolution, { head, remote: team });
  assert.equal((await client.verifyTeamUpdate(name, head, team)).ok, false);
  // No inference: exercise the server verification with an explicit deterministic merge resolution.
  await edit("story.txt", "Local and remote story\n");
  await remoteGit(["add", "story.txt"]);
  await remoteGit(["commit", "-m", "Resolve team update"]);
  assert.equal(unwrap(await client.verifyTeamUpdate(name, head, team)).status, "updated");
  assert.equal(unwrap(await client.teamStatus(name, team)).outgoing, true);
  await edit("notes.txt", "Keep my draft in recovery\n");
  const replaceHead = await remoteGit(["rev-parse", "HEAD"]);
  const replaced = unwrap(
    await client.teamUpdate(name, { head: replaceHead, remote: team, mode: "replace" }),
  );
  assert.equal(replaced.status, "updated");
  assert.equal(await remoteGit(["status", "--porcelain"]), "");
  assert.equal(await remoteGit(["rev-parse", `${replaced.backup}/head`]), replaceHead);
  const recoveryId = replaced.backup?.split("/").at(-1);
  assert(recoveryId);
  assert.equal(
    unwrap(
      await client.exec(name, [
        "cat",
        `${remote}/.git/civic-spark-recovery/${recoveryId}/files/notes.txt`,
      ]),
    ).toString(),
    "Keep my draft in recovery\n",
  );
  assert.equal(git(repo, ["rev-parse", "main"]).toString().trim(), team);
  console.log(
    "PASS: real Sprite bundle import, clean diverged merge, conflict preview, explicit agent preparation/verification, recoverable team replacement. No models or participant project mutations.",
  );
} finally {
  await client.exec(name, [
    "python3",
    "-c",
    "import pathlib,shutil,sys; shutil.rmtree(sys.argv[1],ignore_errors=True); pathlib.Path(sys.argv[1]+'.bundle').unlink(missing_ok=True)",
    remote,
  ]);
  rmSync(root, { recursive: true, force: true });
}
