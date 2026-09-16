import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../git/src/repository.ts";
import { WorkspaceFiles } from "./files.ts";
import { projectPath, TREE_LIMIT } from "./types.ts";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
/** Commit the reviewed project files locally. Publication transports this exact commit. */
export function commitChanges(root: string, title: string, revision: string) {
  const files = new WorkspaceFiles(root);
  const snapshot = files.snapshot();
  if (snapshot.revision !== revision)
    throw new Error(
      "Files changed since the preview. Refresh Changes and review them before sharing.",
    );
  if (Object.values(snapshot.current).reduce((n, f) => n + f.size, 0) > TREE_LIMIT)
    throw new Error("Sharing supports up to 50 MB of project files.");
  const dir = git(root, ["rev-parse", "--absolute-git-dir"]).toString().trim();
  const index = join(dir, "index");
  const original = existsSync(index) ? readFileSync(index) : Buffer.alloc(0);
  const ref = git(root, ["rev-parse", "--symbolic-full-name", "HEAD"]).toString().trim();
  const temp = mkdtempSync(join(tmpdir(), "civic-spark-commit-"));
  const lock = `${index}.lock`;
  let fd: number | undefined;
  let ownsLock = false;
  try {
    fd = openSync(lock, "wx", 0o600);
    ownsLock = true;
    if (hash(existsSync(index) ? readFileSync(index) : Buffer.alloc(0)) !== hash(original))
      throw new Error("Git staging changed. Review Changes before sharing.");
    const commitEnv = { GIT_INDEX_FILE: join(temp, "commit-index") };
    const nextEnv = { GIT_INDEX_FILE: join(temp, "next-index") };
    git(root, ["read-tree", snapshot.head], commitEnv);
    if (original.length) writeFileSync(nextEnv.GIT_INDEX_FILE, original);
    else git(root, ["read-tree", "--empty"], nextEnv);
    const apply = (environment: NodeJS.ProcessEnv) => {
      for (const path of git(root, ["ls-files", "-z"], environment).toString().split("\0")) {
        if (
          projectPath(path) &&
          !snapshot.current[path] &&
          !snapshot.skipped.some((p) => path === p || path.startsWith(`${p}/`))
        )
          git(root, ["update-index", "--force-remove", "--", path], environment);
      }
      for (const [path, item] of Object.entries(snapshot.current)) {
        const oid = git(root, ["hash-object", "-w", "--no-filters", "--", path]).toString().trim();
        if (oid !== item.revision)
          throw new Error("Files changed since the preview. Refresh Changes before sharing.");
        git(root, ["update-index", "--add", "--cacheinfo", item.mode, oid, path], environment);
      }
    };
    apply(commitEnv);
    apply(nextEnv);
    if (
      files.snapshot().revision !== revision ||
      git(root, ["rev-parse", "--symbolic-full-name", "HEAD"]).toString().trim() !== ref
    )
      throw new Error("Files or Git branch changed. Refresh Changes before sharing.");
    const tree = git(root, ["write-tree"], commitEnv).toString().trim();
    const oldTree = git(root, ["rev-parse", `${snapshot.head}^{tree}`])
      .toString()
      .trim();
    // A failed push is retried using the existing local commit, without an empty duplicate.
    const commit =
      tree === oldTree
        ? snapshot.head
        : git(root, ["commit-tree", tree, "-p", snapshot.head, "-m", title], commitEnv)
            .toString()
            .trim();
    writeFileSync(fd, readFileSync(nextEnv.GIT_INDEX_FILE));
    fsyncSync(fd);
    if (commit !== snapshot.head) git(root, ["update-ref", ref, commit, snapshot.head]);
    closeSync(fd);
    fd = undefined;
    renameSync(lock, index);
    ownsLock = false;
    const transferRef = `refs/civic-spark/share/${revision}`;
    git(root, ["update-ref", transferRef, commit]);
    return { commit, ref: transferRef, revision };
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (ownsLock && existsSync(lock)) rmSync(lock);
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Repair only a previously created commit whose parent is still the current clean index/HEAD. */
export function adoptExistingCommit(root: string, commit: string, expectedHead: string) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(expectedHead))
    throw new Error("Invalid commit");
  const dir = git(root, ["rev-parse", "--absolute-git-dir"]).toString().trim();
  const index = join(dir, "index"),
    lock = `${index}.lock`;
  let fd: number | undefined;
  let owned = false;
  const temp = mkdtempSync(join(tmpdir(), "civic-spark-adopt-"));
  try {
    fd = openSync(lock, "wx", 0o600);
    owned = true;
    const head = git(root, ["rev-parse", "HEAD"]).toString().trim();
    if (head === commit) return { commit, alreadyCompleted: true };
    if (
      head !== expectedHead ||
      git(root, ["show", "-s", "--format=%P", commit]).toString().trim() !== expectedHead ||
      git(root, ["diff", "--cached", "--name-only", "--no-ext-diff", "--no-textconv", expectedHead])
        .length
    )
      throw new Error("Git changed since the repair preview; nothing was overwritten.");
    const branch = git(root, ["rev-parse", "--symbolic-full-name", "HEAD"]).toString().trim();
    const env = { GIT_INDEX_FILE: join(temp, "index") };
    git(root, ["read-tree", commit], env);
    writeFileSync(fd, readFileSync(env.GIT_INDEX_FILE));
    fsyncSync(fd);
    git(root, ["update-ref", branch, commit, expectedHead]);
    closeSync(fd);
    fd = undefined;
    renameSync(lock, index);
    owned = false;
    return { commit, alreadyCompleted: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (owned && existsSync(lock)) rmSync(lock);
    rmSync(temp, { recursive: true, force: true });
  }
}
