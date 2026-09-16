import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
import { git } from "../../git/src/repository.ts";
import {
  type Changes,
  DIFF_FILE_LIMIT,
  FILE_LIMIT,
  type FileBlob,
  type FileMutation,
  type Manifest,
  projectPath,
  TREE_LIMIT,
} from "./types.ts";

const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
export class WorkspaceFiles {
  constructor(private root: string) {}
  private path(name: string) {
    if (!projectPath(name)) throw new Error("Path is excluded from workspace access");
    const target = resolve(this.root, name);
    if (!target.startsWith(`${resolve(this.root)}${sep}`)) throw new Error("Invalid path");
    let current = this.root;
    for (const part of name.split("/")) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error("Symbolic links are excluded");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return target;
  }
  manifest(): Manifest {
    const files: Manifest["files"] = Object.create(null);
    const skipped: string[] = [];
    let bytes = 0;
    const cases = new Set<string>();
    const walk = (dir: string, prefix = "") => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (!projectPath(name) || entry.isSymbolicLink()) {
          skipped.push(name);
          continue;
        }
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), `${name}/`);
          continue;
        }
        if (!entry.isFile()) {
          skipped.push(name);
          continue;
        }
        const file = this.read(name);
        const size = Buffer.from(file.data, "base64").length;
        bytes += size;
        if (bytes > TREE_LIMIT || Object.keys(files).length >= 5000)
          throw new Error("Sync limit: 50 MiB and 5,000 files");
        if (cases.has(name.toLowerCase()))
          throw new Error("Filenames differ only by case; rename before syncing across computers");
        cases.add(name.toLowerCase());
        files[name] = { revision: file.revision, size };
      }
    };
    walk(this.root);
    return { files, skipped };
  }
  read(name: string): FileBlob {
    const path = this.path(name);
    if (!lstatSync(path).isFile() || lstatSync(path).size > FILE_LIMIT)
      throw new Error("Sync supports files up to 25 MiB; larger files pause the scan");
    const data = readFileSync(path);
    return { path: name, data: data.toString("base64"), revision: hash(data) };
  }
  mutate(input: FileMutation) {
    const path = this.path(input.path);
    const current = existsSync(path) ? this.read(input.path).revision : null;
    if (current !== input.revision)
      throw new Error(
        "File changed since the sync preview. Refresh to reconcile; neither version was overwritten.",
      );
    if (input.data === null) {
      if (current !== null) unlinkSync(path);
      return { revision: null };
    }
    const data = Buffer.from(input.data, "base64");
    if (data.length > FILE_LIMIT || data.toString("base64") !== input.data)
      throw new Error("Invalid file data or file exceeds 25 MiB");
    mkdirSync(dirname(path), { recursive: true });
    this.path(input.path);
    const temp = join(dirname(path), `.vibehack-${crypto.randomUUID()}`);
    try {
      writeFileSync(temp, data, { flag: "wx" });
      renameSync(temp, path);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
    return { revision: hash(data) };
  }
  snapshot() {
    let base: string;
    try {
      base = git(this.root, ["rev-parse", "refs/vibehack/base"]).toString().trim();
    } catch {
      try {
        base = git(this.root, ["rev-parse", "origin/main"]).toString().trim();
      } catch {
        base = git(this.root, ["rev-parse", "HEAD"]).toString().trim();
      }
    }
    const head = git(this.root, ["rev-parse", "HEAD"]).toString().trim();
    const before = new Map<string, string>();
    for (const entry of git(this.root, ["ls-tree", "-rz", base]).toString().split("\0")) {
      const tab = entry.indexOf("\t");
      const name = entry.slice(tab + 1);
      if (tab < 0 || !entry.startsWith("100") || !projectPath(name)) continue;
      before.set(name, entry.slice(0, tab).split(" ")[2] as string);
    }
    const current: Record<string, { revision: string; size: number; mode: string }> = {};
    const skipped: string[] = [];
    const walk = (dir: string, prefix = "") => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (!projectPath(name) || entry.isSymbolicLink()) {
          skipped.push(name);
          continue;
        }
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), `${name}/`);
          continue;
        }
        if (!entry.isFile()) {
          skipped.push(name);
          continue;
        }
        const path = this.path(name);
        const stat = lstatSync(path);
        // Git hashes large files directly; Changes does not reuse folder-sync size limits.
        current[name] = {
          revision: git(this.root, ["hash-object", "--no-filters", "--", name]).toString().trim(),
          size: stat.size,
          mode: stat.mode & 0o111 ? "100755" : "100644",
        };
        if (Object.keys(current).length > 5000)
          throw new Error("Changes supports up to 5,000 project files");
      }
    };
    walk(this.root);
    const revision = hash(Buffer.from(JSON.stringify([base, head, current, skipped])));
    return { base, head, before, current, skipped, revision };
  }
  changes(): Changes {
    const { base, before, current, skipped, revision } = this.snapshot();
    const files: Changes["files"] = [];
    let total = 0;
    for (const path of [...new Set([...before.keys(), ...Object.keys(current)])].sort()) {
      if (skipped.some((p) => path === p || path.startsWith(`${p}/`))) continue;
      const oid = before.get(path);
      const item = current[path];
      if (oid === item?.revision) continue;
      const oldSize = oid ? Number(git(this.root, ["cat-file", "-s", oid]).toString()) : 0;
      const large = oldSize > DIFF_FILE_LIMIT || (item?.size ?? 0) > DIFF_FILE_LIMIT;
      const old = oid && !large ? git(this.root, ["cat-file", "blob", oid]) : undefined;
      const next = item && !large ? readFileSync(this.path(path)) : undefined;
      const binary = Boolean(old?.includes(0) || next?.includes(0));
      let diff = large
        ? "Large file changed; preview limited to files up to 1 MB. This file can still be shared."
        : binary
          ? "Binary file changed"
          : createTwoFilesPatch(
              `a/${path}`,
              `b/${path}`,
              old?.toString("utf8") ?? "",
              next?.toString("utf8") ?? "",
            );
      if (total >= 2000000) diff = "Diff preview limit reached. This file can still be shared.";
      else if (diff.length > 200000)
        diff = `${diff.slice(0, 200000)}\n[Preview truncated; the full file will be shared.]`;
      total += diff.length;
      files.push({ path, status: !oid ? "added" : !item ? "deleted" : "modified", diff, binary });
    }
    return { base, revision, files };
  }
}
