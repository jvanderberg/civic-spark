import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { git } from "../packages/git/src/repository.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import {
  applyTeamUpdate,
  importTeamBundle,
  teamStatus,
  verifyTeamUpdate,
} from "../packages/workspace/src/team-git.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-team-test-"));
  cleanup.push(root);
  const repo = join(root, "team.git"),
    local = join(root, "local"),
    other = join(root, "other");
  git(root, ["init", "--bare", "--initial-branch=main", repo]);
  git(root, ["clone", repo, other]);
  writeFileSync(join(other, "story.txt"), "Original\n");
  writeFileSync(join(other, ".gitignore"), ".env\n");
  git(other, ["add", "."]);
  git(other, ["commit", "-m", "Start"]);
  git(other, ["push", "origin", "main"]);
  git(root, ["clone", repo, local]);
  git(local, ["update-ref", "refs/civic-spark/base", "HEAD"]);
  const head = () => git(local, ["rev-parse", "HEAD"]).toString().trim();
  const remote = () => git(repo, ["rev-parse", "main"]).toString().trim();
  const update = (path = "team.txt", content = "Team update\n") => {
    writeFileSync(join(other, path), content);
    git(other, ["add", "--all"]);
    git(other, ["commit", "-m", "Team update"]);
    git(other, ["push", "origin", "main"]);
    return remote();
  };
  const fetch = () => {
    const bundle = join(root, "team.bundle");
    if (existsSync(bundle)) rmSync(bundle);
    git(repo, ["bundle", "create", bundle, "main"]);
    importTeamBundle(local, bundle, remote());
    return bundle;
  };
  return { root, repo, local, other, head, remote, update, fetch };
}
it("polling sees incoming team commits, ignores local-ahead commits, and clean pulls preserve both histories", () => {
  const f = setup();
  expect(teamStatus(f.local, f.remote()).incoming).toBe(false);
  writeFileSync(join(f.local, "mine.txt"), "Mine\n");
  git(f.local, ["add", "mine.txt"]);
  git(f.local, ["commit", "-m", "Local work"]);
  const original = f.head();
  expect(teamStatus(f.local, f.remote())).toMatchObject({ incoming: false, outgoing: true });
  f.update();
  expect(teamStatus(f.local, f.remote()).incoming).toBe(true);
  f.fetch();
  const result = applyTeamUpdate(f.local, { head: original, remote: f.remote(), mode: "pull" });
  expect(result.status).toBe("updated");
  expect(git(f.local, ["merge-base", "--is-ancestor", original, "HEAD"]).length).toBe(0);
  expect(git(f.local, ["merge-base", "--is-ancestor", f.remote(), "HEAD"]).length).toBe(0);
  expect(readFileSync(join(f.local, "mine.txt"), "utf8")).toBe("Mine\n");
  expect(readFileSync(join(f.local, "team.txt"), "utf8")).toBe("Team update\n");
  expect(git(f.local, ["rev-parse", "refs/civic-spark/base"]).toString().trim()).toBe(f.remote());
  expect(new WorkspaceFiles(f.local).changes().files.some((file) => file.path === "mine.txt")).toBe(
    true,
  );
});
it("conflict previews do not touch files; explicit agent merge survives reconnect and only verifies after both histories are retained", () => {
  const f = setup();
  writeFileSync(join(f.local, "story.txt"), "Local version\n");
  git(f.local, ["add", "story.txt"]);
  git(f.local, ["commit", "-m", "Local story"]);
  f.update("story.txt", "Team version\n");
  f.fetch();
  const input = { head: f.head(), remote: f.remote(), mode: "pull" as const };
  const before = readFileSync(join(f.local, ".git/index"));
  expect(applyTeamUpdate(f.local, input).status).toBe("conflict");
  expect(readFileSync(join(f.local, "story.txt"), "utf8")).toBe("Local version\n");
  expect(readFileSync(join(f.local, ".git/index"))).toEqual(before);
  expect(existsSync(join(f.local, ".git/MERGE_HEAD"))).toBe(false);
  const agent = applyTeamUpdate(f.local, { ...input, mode: "agent" });
  expect(agent.status).toBe("agent");
  expect(agent.prompt).toContain("Do not push");
  expect(agent.conflicts).toEqual(["story.txt"]);
  expect(teamStatus(f.local, f.remote()).resolution).toEqual({
    head: input.head,
    remote: input.remote,
  });
  expect(applyTeamUpdate(f.local, { ...input, mode: "agent" }).status).toBe("agent");
  expect(() => verifyTeamUpdate(f.local, input.head, input.remote)).toThrow("not finished");
  writeFileSync(join(f.local, "story.txt"), "Local and team versions combined\n");
  git(f.local, ["add", "story.txt"]);
  git(f.local, ["commit", "-m", "Resolve team update"]);
  expect(verifyTeamUpdate(f.local, input.head, input.remote).status).toBe("updated");
  expect(f.remote()).toBe(input.remote);
  expect(teamStatus(f.local, f.remote()).resolution).toBeUndefined();
  expect(
    new WorkspaceFiles(f.local).changes().files.some((file) => file.path === "story.txt"),
  ).toBe(true);
});
it("Use team version preserves conflicted files, untracked files, index, and local history in recovery before replacing", () => {
  const f = setup();
  writeFileSync(join(f.local, "story.txt"), "Local\n");
  git(f.local, ["add", "story.txt"]);
  git(f.local, ["commit", "-m", "Local"]);
  f.update("story.txt", "Remote\n");
  f.fetch();
  const input = { head: f.head(), remote: f.remote(), mode: "agent" as const };
  applyTeamUpdate(f.local, input);
  writeFileSync(join(f.local, "notes.txt"), "Untracked recovery\n");
  writeFileSync(join(f.local, ".env"), "IGNORED TEST FIXTURE");
  const conflicted = readFileSync(join(f.local, "story.txt"), "utf8"),
    index = readFileSync(join(f.local, ".git/index"));
  const result = applyTeamUpdate(f.local, { ...input, mode: "replace" });
  expect(result.status).toBe("updated");
  const recovery = join(
    f.local,
    ".git/civic-spark-recovery",
    result.backup?.split("/").at(-1) ?? "missing",
  );
  expect(readFileSync(join(recovery, "files/story.txt"), "utf8")).toBe(conflicted);
  expect(readFileSync(join(recovery, "files/notes.txt"), "utf8")).toBe("Untracked recovery\n");
  expect(readFileSync(join(recovery, "index"))).toEqual(index);
  expect(existsSync(join(recovery, "MERGE_HEAD"))).toBe(true);
  expect(
    git(f.local, ["rev-parse", `${result.backup}/head`])
      .toString()
      .trim(),
  ).toBe(input.head);
  expect(readFileSync(join(f.local, "story.txt"), "utf8")).toBe("Remote\n");
  expect(existsSync(join(f.local, "notes.txt"))).toBe(false);
  expect(readFileSync(join(f.local, ".env"), "utf8")).toBe("IGNORED TEST FIXTURE");
  expect(git(f.local, ["status", "--porcelain"]).length).toBe(0);
});
it("stale heads and dirty work reject ordinary pulls without overwriting files", () => {
  const f = setup();
  const head = f.head();
  f.update();
  f.fetch();
  writeFileSync(join(f.local, "draft.txt"), "Saved draft\n");
  expect(() => applyTeamUpdate(f.local, { head, remote: f.remote(), mode: "pull" })).toThrow(
    "uncommitted",
  );
  git(f.local, ["add", "draft.txt"]);
  git(f.local, ["commit", "-m", "New local commit"]);
  expect(() => applyTeamUpdate(f.local, { head, remote: f.remote(), mode: "pull" })).toThrow(
    "changed since",
  );
  expect(readFileSync(join(f.local, "draft.txt"), "utf8")).toBe("Saved draft\n");
});
it("Sprite Python adapter matches clean/conflict/agent/replace behavior with no model calls", () => {
  const f = setup();
  const script = readFileSync(
    new URL("../packages/sprites/src/team_git.py", import.meta.url),
    "utf8",
  ).replace(
    "ROOT = pathlib.Path('/home/sprite/project')",
    `ROOT = pathlib.Path(${JSON.stringify(f.local)})`,
  );
  const run = (payload: object) => {
    const result = spawnSync("python3", ["-c", script], {
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
    return JSON.parse(result.stdout);
  };
  writeFileSync(join(f.local, "story.txt"), "Local\n");
  git(f.local, ["add", "story.txt"]);
  git(f.local, ["commit", "-m", "Local"]);
  f.update("story.txt", "Remote\n");
  f.fetch();
  const input = { head: f.head(), remote: f.remote() };
  expect(run({ operation: "status", remote: f.remote() }).value.incoming).toBe(true);
  expect(run({ operation: "apply", mode: "pull", ...input }).value.status).toBe("conflict");
  expect(run({ operation: "apply", mode: "agent", ...input }).value.status).toBe("agent");
  expect(run({ operation: "status", remote: f.remote() }).value.resolution).toEqual(input);
  expect(run({ operation: "verify", ...input }).ok).toBe(false);
  const replaced = run({ operation: "apply", mode: "replace", ...input });
  expect(replaced.ok).toBe(true);
  expect(replaced.value.status).toBe("updated");
  expect(f.head()).toBe(f.remote());
  const copy = join(
    f.local,
    ".git/civic-spark-recovery",
    replaced.value.backup.split("/").at(-1),
    "files/story.txt",
  );
  expect(readFileSync(copy, "utf8")).toContain("<<<<<<<");
});

it("finalizes a finished agent merge from status alone and never moves the baseline backwards", () => {
  const f = setup();
  writeFileSync(join(f.local, "story.txt"), "Local version\n");
  git(f.local, ["add", "story.txt"]);
  git(f.local, ["commit", "-m", "Local story"]);
  f.update("story.txt", "Team version\n");
  f.fetch();
  const input = { head: f.head(), remote: f.remote(), mode: "agent" as const };
  expect(applyTeamUpdate(f.local, input).status).toBe("agent");
  const receipt = join(f.local, ".git/civic-spark-agent-merge.json");
  expect(teamStatus(f.local, f.remote()).resolution).toBeDefined();
  writeFileSync(join(f.local, "story.txt"), "Local and team versions combined\n");
  git(f.local, ["add", "story.txt"]);
  git(f.local, ["commit", "-m", "Resolve team update"]);
  // Nobody pressed Check agent result: polling sees the completed merge.
  const status = teamStatus(f.local, f.remote());
  expect(status.resolution).toBeUndefined();
  expect(status.outgoing).toBe(true);
  expect(existsSync(receipt)).toBe(false);
  expect(git(f.local, ["rev-parse", "refs/civic-spark/base"]).toString().trim()).toBe(input.remote);
  expect(() => verifyTeamUpdate(f.local, input.head, input.remote)).toThrow("No agent merge");
  // Shared first, then checked: the baseline already points past the team commit and stays there.
  git(f.local, ["update-ref", "refs/civic-spark/base", "HEAD"]);
  writeFileSync(receipt, JSON.stringify({ head: input.head, remote: input.remote }));
  expect(teamStatus(f.local, f.remote()).resolution).toBeUndefined();
  expect(git(f.local, ["rev-parse", "refs/civic-spark/base"]).toString().trim()).toBe(f.head());
  expect(existsSync(receipt)).toBe(false);
});

it("Sprite Python adapter finalizes a finished agent merge from status alone", () => {
  const f = setup();
  const script = readFileSync(
    new URL("../packages/sprites/src/team_git.py", import.meta.url),
    "utf8",
  ).replace(
    "ROOT = pathlib.Path('/home/sprite/project')",
    `ROOT = pathlib.Path(${JSON.stringify(f.local)})`,
  );
  const run = (payload: object) => {
    const result = spawnSync("python3", ["-c", script], {
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
    return JSON.parse(result.stdout);
  };
  writeFileSync(join(f.local, "story.txt"), "Local\n");
  git(f.local, ["add", "story.txt"]);
  git(f.local, ["commit", "-m", "Local"]);
  f.update("story.txt", "Remote\n");
  f.fetch();
  const input = { head: f.head(), remote: f.remote() };
  expect(run({ operation: "apply", mode: "agent", ...input }).value.status).toBe("agent");
  expect(run({ operation: "status", remote: f.remote() }).value.resolution).toEqual(input);
  writeFileSync(join(f.local, "story.txt"), "Local and remote combined\n");
  git(f.local, ["add", "story.txt"]);
  git(f.local, ["commit", "-m", "Resolve team update"]);
  const status = run({ operation: "status", remote: f.remote() }).value;
  expect(status.resolution).toBeUndefined();
  expect(status.outgoing).toBe(true);
  expect(existsSync(join(f.local, ".git/civic-spark-agent-merge.json"))).toBe(false);
  expect(git(f.local, ["rev-parse", "refs/civic-spark/base"]).toString().trim()).toBe(input.remote);
  expect(run({ operation: "verify", ...input }).ok).toBe(false);
  // A baseline that already points past the team commit is left alone.
  git(f.local, ["update-ref", "refs/civic-spark/base", "HEAD"]);
  writeFileSync(
    join(f.local, ".git/civic-spark-agent-merge.json"),
    JSON.stringify({ head: input.head, remote: input.remote }),
  );
  expect(run({ operation: "status", remote: f.remote() }).value.resolution).toBeUndefined();
  expect(git(f.local, ["rev-parse", "refs/civic-spark/base"]).toString().trim()).toBe(f.head());
});
