import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EventService } from "../packages/domain/src/service.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { adoptExistingCommit, commitChanges } from "../packages/workspace/src/share.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
function setup() {
  const root = mkdtempSync(join(tmpdir(), "vibehack-share-test-"));
  const service = new EventService(root);
  cleanups.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  const alice = {
    id: "alice",
    name: "Alice",
    email: "alice@example.test",
    emailVerified: true as const,
  };
  const bob = { id: "bob", name: "Bob", email: "bob@example.test", emailVerified: true as const };
  const event = unwrap(
    service.createEvent(alice, {
      name: "Test event",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 10,
      budget: 10,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    service.createTeam(alice, { eventId: event.id, name: "Data crew", projectId: "data-starter" }),
  );
  const id = team.workspace.id;
  const dir = service.workspacePath(id);
  const files = new WorkspaceFiles(dir);
  return { root, service, alice, bob, event, team, id, dir, files };
}
it("large data files do not break Changes; Share commits locally and pushes that exact commit", () => {
  const { service, alice, id, dir, files, root, team } = setup();
  const content = "a,b\n".repeat(270000);
  writeFileSync(join(dir, "large.csv"), content);
  writeFileSync(join(dir, "note.txt"), "hello\n");
  git(dir, ["add", "note.txt"]);
  const head = git(dir, ["rev-parse", "HEAD"]).toString();
  const preview = files.changes();
  expect(preview.files.find((f) => f.path === "large.csv")?.diff).toContain("can still be shared");
  expect(files.manifest().files["large.csv"]?.size).toBe(Buffer.byteLength(content));
  const contribution = unwrap(
    service.shareLocal(alice, id, "Data update", preview.revision as string),
  );
  expect(
    git(join(root, "repos", `${team.team.id}.git`), [
      "show",
      `${contribution.commit}:large.csv`,
    ]).toString(),
  ).toBe(content);
  expect(git(dir, ["rev-parse", "HEAD"]).toString()).not.toBe(head);
  expect(git(dir, ["rev-parse", "HEAD"]).toString().trim()).toBe(contribution.commit);
  expect(git(dir, ["status", "--porcelain"]).toString()).toBe("");
  expect(
    git(join(root, "repos", `${team.team.id}.git`), ["rev-parse", "main"])
      .toString()
      .trim(),
  ).toBe(contribution.commit);
  expect(git(dir, ["log", "-1", "--format=%s"]).toString().trim()).toBe("Data update");
  expect(unwrap(service.shareLocal(alice, id, "Retry", preview.revision as string)).id).toBe(
    contribution.id,
  );
  expect(service.portal(alice, false).contributions).toHaveLength(1);
});
it("rejects stale previews and unauthorized or removed participants", () => {
  const { service, alice, bob, id, dir, files, team } = setup();
  writeFileSync(join(dir, "note.txt"), "first");
  const revision = files.changes().revision as string;
  writeFileSync(join(dir, "note.txt"), "second");
  expect(service.shareLocal(alice, id, "stale", revision)).toMatchObject({
    ok: false,
    error: expect.stringContaining("changed since"),
  });
  expect(service.shareLocal(bob, id, "private", revision)).toMatchObject({
    ok: false,
    status: 404,
  });
  unwrap(service.removeMember(alice, team.team.id, alice.id));
  expect(service.shareLocal(alice, id, "removed", revision)).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("second");
});
it("repeated Share commits are linear and private native history blocks publication without rewriting it", () => {
  const { service, alice, id, dir, files, root, team } = setup();
  writeFileSync(join(dir, "README.md"), "First update\n");
  const first = unwrap(service.shareLocal(alice, id, "First", files.changes().revision as string));
  writeFileSync(join(dir, "README.md"), "Second update\n");
  const second = unwrap(
    service.shareLocal(alice, id, "Second", files.changes().revision as string),
  );
  expect(
    git(dir, ["rev-parse", `${second.commit}^`])
      .toString()
      .trim(),
  ).toBe(first.commit);
  const repo = join(root, "repos", `${team.team.id}.git`);
  expect(git(repo, ["rev-parse", "main"]).toString().trim()).toBe(second.commit);
  writeFileSync(join(dir, "private.key"), "PRIVATE TEST FIXTURE");
  git(dir, ["add", "private.key"]);
  git(dir, ["commit", "-m", "Private native commit"]);
  unlinkSync(join(dir, "private.key"));
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "-m", "Remove private file"]);
  writeFileSync(join(dir, "README.md"), "Third update\n");
  expect(service.shareLocal(alice, id, "Third", files.changes().revision as string)).toMatchObject({
    ok: false,
    error: expect.stringContaining("history includes excluded"),
  });
  expect(git(dir, ["log", "-1", "--format=%s"]).toString().trim()).toBe("Third");
  expect(git(repo, ["rev-parse", "main"]).toString().trim()).toBe(second.commit);
  expect(git(dir, ["status", "--porcelain"]).toString()).toBe("");
});
it("rejects imported hidden-file history even when the tip deleted it", () => {
  const { service, alice, id, dir } = setup();
  writeFileSync(join(dir, "secret.key"), "PRIVATE TEST FIXTURE");
  git(dir, ["add", "secret.key"]);
  git(dir, ["commit", "-m", "Secret"]);
  unlinkSync(join(dir, "secret.key"));
  writeFileSync(join(dir, "README.md"), "Public\n");
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "-m", "Deleted"]);
  const commit = git(dir, ["rev-parse", "HEAD"]).toString().trim();
  expect(service.publishSnapshot(alice, id, "Unsafe", "a".repeat(64), dir, commit)).toMatchObject({
    ok: false,
    error: expect.stringContaining("history includes excluded"),
  });
  expect(service.portal(alice, false).contributions).toHaveLength(0);
});
it("the trusted Sprite adapter previews and bundles large files with snapshot guards", () => {
  const { dir, root } = setup();
  const script = readFileSync(
    new URL("../packages/sprites/src/workspace.py", import.meta.url),
    "utf8",
  )
    .replace(
      "ROOT = pathlib.Path('/home/sprite/project')",
      `ROOT = pathlib.Path(${JSON.stringify(dir)})`,
    )
    .replace("'/home/sprite/.vibehack-file-lock'", JSON.stringify(join(root, "lock")));
  const run = (payload: object) =>
    JSON.parse(
      spawnSync("python3", ["-c", script], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }).stdout,
    );
  writeFileSync(join(dir, "large.csv"), "a,b\n".repeat(270000));
  const preview = run({ operation: "changes" });
  expect(preview.ok).toBe(true);
  expect(preview.value.files[0].diff).toContain("Large file");
  const shared = run({ operation: "share", title: "Large file", revision: preview.value.revision });
  expect(shared.ok).toBe(true);
  const bundle = join(root, "result.bundle");
  writeFileSync(bundle, Buffer.from(shared.value.bundle, "base64"));
  expect(() => git(dir, ["bundle", "verify", bundle])).not.toThrow();
  writeFileSync(join(dir, "large.csv"), "changed");
  expect(
    run({ operation: "share", title: "Stale", revision: preview.value.revision }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("changed since") });
});
it("a diverged team rejects push but retains the local commit; retry after update pushes the existing commit", () => {
  const { service, alice, bob, id, dir, files, root, team, event } = setup();
  unwrap(service.transition(alice, event.id, "registration"));
  const other = unwrap(service.joinTeam(bob, team.team.id));
  const otherDir = service.workspacePath(other.id),
    otherFiles = new WorkspaceFiles(otherDir);
  writeFileSync(join(dir, "alice.txt"), "Alice\n");
  const first = unwrap(
    service.shareLocal(alice, id, "Alice adds file", files.changes().revision as string),
  );
  writeFileSync(join(otherDir, "bob.txt"), "Bob\n");
  expect(
    service.shareLocal(bob, other.id, "Bob adds file", otherFiles.changes().revision as string),
  ).toMatchObject({
    ok: false,
    status: 409,
    error: expect.stringContaining("local commit is saved"),
  });
  const saved = git(otherDir, ["rev-parse", "HEAD"]).toString().trim();
  expect(git(otherDir, ["status", "--porcelain"]).toString()).toBe("");
  expect(
    service.shareLocal(bob, other.id, "Retry", otherFiles.changes().revision as string),
  ).toMatchObject({ ok: false, status: 409 });
  expect(git(otherDir, ["rev-parse", "HEAD"]).toString().trim()).toBe(saved);
  const repo = join(root, "repos", `${team.team.id}.git`);
  expect(git(repo, ["rev-parse", "main"]).toString().trim()).toBe(first.commit);
  unwrap(service.sync(bob, other.id));
  const merged = git(otherDir, ["rev-parse", "HEAD"]).toString().trim();
  const shared = unwrap(
    service.shareLocal(
      bob,
      other.id,
      "Retry after update",
      otherFiles.changes().revision as string,
    ),
  );
  expect(shared.commit).toBe(merged);
  expect(git(repo, ["rev-parse", "main"]).toString().trim()).toBe(merged);
  expect(git(repo, ["show", "main:alice.txt"]).toString()).toBe("Alice\n");
  expect(git(repo, ["show", "main:bob.txt"]).toString()).toBe("Bob\n");
});

it("new edits after the local commit stay dirty and excluded staging is preserved", () => {
  const { service, alice, id, dir, files, root, team } = setup();
  writeFileSync(join(dir, "private.key"), "EXCLUDED STAGED FIXTURE");
  git(dir, ["add", "private.key"]);
  writeFileSync(join(dir, "note.txt"), "Reviewed contents\n");
  const preview = files.changes();
  const saved = commitChanges(dir, "Reviewed message", preview.revision as string);
  expect(git(dir, ["diff", "--cached", "--name-only"]).toString().trim()).toBe("private.key");
  writeFileSync(join(dir, "note.txt"), "Newer unsaved-to-Git contents\n");
  const pushed = unwrap(
    service.publishSnapshot(
      alice,
      id,
      "Reviewed message",
      preview.revision as string,
      dir,
      saved.commit,
    ),
  );
  expect(pushed.commit).toBe(git(dir, ["rev-parse", "HEAD"]).toString().trim());
  expect(git(dir, ["status", "--porcelain"]).toString()).toContain(" M note.txt");
  expect(
    git(join(root, "repos", `${team.team.id}.git`), ["show", "main:note.txt"]).toString(),
  ).toBe("Reviewed contents\n");
});
it("adopts only the existing reviewed child commit, keeping newer working edits and rejecting stale staging", () => {
  const { dir } = setup();
  const head = git(dir, ["rev-parse", "HEAD"]).toString().trim();
  writeFileSync(join(dir, "note.txt"), "Previously shared\n");
  git(dir, ["add", "note.txt"]);
  const tree = git(dir, ["write-tree"]).toString().trim();
  const commit = git(dir, ["commit-tree", tree, "-p", head, "-m", "Previously shared"])
    .toString()
    .trim();
  expect(() => adoptExistingCommit(dir, commit, head)).toThrow("Git changed");
  git(dir, ["reset", "--mixed", head]);
  writeFileSync(join(dir, "note.txt"), "A newer edit\n");
  expect(adoptExistingCommit(dir, commit, head).commit).toBe(commit);
  expect(git(dir, ["rev-parse", "HEAD"]).toString().trim()).toBe(commit);
  expect(git(dir, ["status", "--porcelain"]).toString()).toContain(" M note.txt");
  expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("A newer edit\n");
  expect(adoptExistingCommit(dir, commit, head).alreadyCompleted).toBe(true);
});
it("Sprite legacy repair adopts the already-created commit without touching later files", () => {
  const { dir, root } = setup();
  const head = git(dir, ["rev-parse", "HEAD"]).toString().trim();
  writeFileSync(join(dir, "legacy.txt"), "Previously shared\n");
  git(dir, ["add", "legacy.txt"]);
  const tree = git(dir, ["write-tree"]).toString().trim();
  const commit = git(dir, ["commit-tree", tree, "-p", head, "-m", "Previously shared"])
    .toString()
    .trim();
  git(dir, ["reset", "--mixed", head]);
  writeFileSync(join(dir, "legacy.txt"), "Later edit\n");
  const script = readFileSync(
    new URL("../packages/sprites/src/workspace.py", import.meta.url),
    "utf8",
  )
    .replace(
      "ROOT = pathlib.Path('/home/sprite/project')",
      `ROOT = pathlib.Path(${JSON.stringify(dir)})`,
    )
    .replace("'/home/sprite/.vibehack-file-lock'", JSON.stringify(join(root, "lock")));
  const result = JSON.parse(
    spawnSync("python3", ["-c", script], {
      input: JSON.stringify({ operation: "adopt-share", commit, head }),
      encoding: "utf8",
    }).stdout,
  );
  expect(result).toMatchObject({ ok: true, value: { commit } });
  expect(git(dir, ["rev-parse", "HEAD"]).toString().trim()).toBe(commit);
  expect(git(dir, ["status", "--porcelain"]).toString()).toContain(" M legacy.txt");
  expect(readFileSync(join(dir, "legacy.txt"), "utf8")).toBe("Later edit\n");
});
