import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { git } from "../../git/src/repository.ts";

/** Preserve an exact, local recovery copy including a conflicted index; never published. */
export function backupWorkingTree(root: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid recovery identifier");
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]).toString().trim();
  const target = join(gitDir, "civic-spark-recovery", id);
  mkdirSync(join(target, "files"), { recursive: true });
  const paths = [
    ...new Set(
      git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .toString()
        .split("\0")
        .filter(Boolean),
    ),
  ];
  if (paths.length > 5000)
    throw new Error("The recovery copy exceeds 5,000 files. Your workspace was not replaced.");
  const revisions: Record<string, string | null> = {};
  let bytes = 0;
  const fingerprint = (path: string) => {
    const full = join(root, path);
    if (!existsSync(full)) {
      try {
        if (lstatSync(full).isSymbolicLink()) return `link:${readlinkSync(full)}`;
      } catch {
        /* Deleted file. */
      }
      return null;
    }
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return `link:${readlinkSync(full)}`;
    if (!stat.isFile())
      throw new Error("A workspace path changed type. Your workspace was not replaced.");
    return createHash("sha256").update(readFileSync(full)).digest("hex");
  };
  for (const path of paths) {
    if (path.startsWith("/") || path.split("/").some((p) => !p || p === ".." || p === ".git"))
      throw new Error("Invalid recovery path");
    let parent = root;
    for (const part of path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
        throw new Error(
          "A symbolic-link directory prevents safe recovery. Your workspace was not replaced.",
        );
    }
    const stamp = fingerprint(path);
    revisions[path] = stamp;
    if (stamp === null) continue;
    const source = join(root, path);
    bytes += lstatSync(source).size;
    if (bytes > 50 * 1024 * 1024)
      throw new Error("The recovery copy exceeds 50 MB. Your workspace was not replaced.");
    const destination = join(target, "files", path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { dereference: false, verbatimSymlinks: true });
    if (stamp !== fingerprint(path))
      throw new Error(
        "Files changed while creating the recovery copy. Your workspace was not replaced.",
      );
  }
  for (const file of ["index", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE"]) {
    const source = join(gitDir, file);
    if (existsSync(source)) cpSync(source, join(target, file));
  }
  writeFileSync(
    join(target, "manifest.json"),
    JSON.stringify(
      { head: git(root, ["rev-parse", "HEAD"]).toString().trim(), revisions },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return {
    path: target,
    verify() {
      const current = [
        ...new Set(
          git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
            .toString()
            .split("\0")
            .filter(Boolean),
        ),
      ];
      if (
        current.length !== paths.length ||
        current.some((p) => !(p in revisions) || fingerprint(p) !== revisions[p])
      )
        throw new Error("Files changed after the recovery copy. Your workspace was not replaced.");
    },
  };
}
