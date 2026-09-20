import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { git, listFiles, safePath } from "../packages/git/src/repository.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { commitChanges } from "../packages/workspace/src/share.ts";
import { projectPath } from "../packages/workspace/src/types.ts";

const cases = [
  [".gitignore", true],
  ["src/.gitignore", true],
  ["src/app.ts", true],
  [".gitignore/secret.txt", false],
  [".gitignore/.gitignore", false],
  [".GITIGNORE", false],
  [".gitignore.local", false],
  [".gitignore ", false],
  [".env", false],
  [".env.example", false],
  [".npmrc", false],
  [".git/config", false],
  [".civic-spark-agent/.gitignore", false],
  [".claude/.gitignore", false],
  ["credentials/.gitignore", false],
  ["secrets/.gitignore", false],
  ["node_modules/.gitignore", false],
  ["src/.private/.gitignore", false],
  ["src/private.key", false],
  ["a.pem/.gitignore", false],
  ["../.gitignore", false],
  ["/.gitignore", false],
  ["src//.gitignore", false],
  ["src\\.gitignore", false],
  ["src/./.gitignore", false],
  ["CON/.gitignore", false],
  ["a\0b/.gitignore", false],
] as const;

it("keeps TypeScript and both Sprite filters in parity with only an exact .gitignore leaf exception", () => {
  const expected = cases.map(([, allowed]) => allowed);
  expect(cases.map(([path]) => projectPath(path))).toEqual(expected);
  for (const name of ["workspace.py", "files.py"]) {
    const source = readFileSync(
      new URL(`../packages/sprites/src/${name}`, import.meta.url),
      "utf8",
    );
    // Extract only the pure predicate and its denylist; never run the adapter entrypoint.
    const result = spawnSync(
      "python3",
      [
        "-c",
        `import ast,json,re,sys
source,paths=json.load(sys.stdin)
tree=ast.parse(source)
nodes=[n for n in tree.body if (isinstance(n,ast.FunctionDef) and n.name=='allowed') or (isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='EXCLUDED' for t in n.targets))]
exec(compile(ast.Module(body=nodes,type_ignores=[]),'<path-policy>','exec'))
print(json.dumps([allowed(p) for p in paths]))`,
      ],
      {
        input: JSON.stringify([source, cases.map(([path]) => path)]),
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout), name).toEqual(expected);
  }
});

it("roundtrips ignore files through local and Python editor/sync/Changes and preserves native HEAD on remote Share", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-ignore-"));
  const directory = join(root, "project");
  mkdirSync(join(directory, "src"), { recursive: true });
  const run = (name: string, payload: object) => {
    const source = readFileSync(new URL(`../packages/sprites/src/${name}`, import.meta.url), "utf8")
      .replace(
        /ROOT = pathlib.Path\(['"]\/home\/sprite\/project['"]\)/,
        `ROOT = pathlib.Path(${JSON.stringify(directory)})`,
      )
      .replaceAll("/home/sprite/.civic-spark-file-lock", join(root, "lock"));
    const result = spawnSync("python3", ["-c", source], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    git(directory, ["init", "--initial-branch=main"]);
    writeFileSync(join(directory, ".gitignore"), ".env\n");
    writeFileSync(join(directory, "README.md"), "Project\n");
    git(directory, ["add", "."]);
    git(directory, ["commit", "-m", "Seed"]);
    git(directory, ["update-ref", "refs/civic-spark/base", "HEAD"]);
    const files = new WorkspaceFiles(directory);
    files.mutate({
      path: "src/.gitignore",
      data: Buffer.from("scratch/\n").toString("base64"),
      revision: null,
    });
    for (const path of [".gitignore", "src/.gitignore"]) {
      expect(listFiles(directory)).toContain(path);
      expect(safePath(directory, path)).toBe(join(directory, path));
      expect(run("files.py", { operation: "list" }).value).toContain(path);
      const before = run("files.py", { operation: "read", path });
      expect(before.ok).toBe(true);
      expect(
        run("files.py", {
          operation: "save",
          path,
          content: `${before.value.content}temporary/\n`,
          revision: before.value.revision,
        }).ok,
      ).toBe(true);
      expect(
        run("files.py", {
          operation: "save",
          path,
          content: "stale",
          revision: before.value.revision,
        }).ok,
      ).toBe(false);
      const blob = run("workspace.py", { operation: "read", path });
      expect(blob.value.data).toBe(files.read(path).data);
      expect(
        run("workspace.py", {
          operation: "mutate",
          path,
          data: Buffer.from("scratch/\n").toString("base64"),
          revision: blob.value.revision,
        }).ok,
      ).toBe(true);
    }
    expect(run("workspace.py", { operation: "manifest" }).value.files).toEqual(
      files.manifest().files,
    );
    expect(
      run("workspace.py", { operation: "changes" }).value.files.map(
        (f: { path: string }) => f.path,
      ),
    ).toEqual(files.changes().files.map((f) => f.path));
    git(directory, ["add", ".gitignore", "src/.gitignore"]);
    git(directory, ["commit", "-m", "Native config"]);
    const head = git(directory, ["rev-parse", "HEAD"]).toString().trim();
    const changes = run("workspace.py", { operation: "changes" });
    const shared = run("workspace.py", {
      operation: "share",
      title: "Share existing config",
      revision: changes.value.revision,
    });
    expect(shared.ok).toBe(true);
    expect(shared.value.commit).toBe(head);
    expect(git(directory, ["rev-parse", "HEAD"]).toString().trim()).toBe(head);
    const bundle = join(root, "share.bundle");
    writeFileSync(bundle, Buffer.from(shared.value.bundle, "base64"));
    expect(() => git(directory, ["bundle", "verify", bundle])).not.toThrow();
    for (const path of [".env", "credentials/.gitignore", ".civic-spark-agent/.gitignore"]) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), "PRIVATE TEST FIXTURE");
      expect(safePath(directory, path)).toBeNull();
      expect(run("files.py", { operation: "read", path }).ok).toBe(false);
      expect(run("workspace.py", { operation: "read", path }).ok).toBe(false);
      expect(listFiles(directory)).not.toContain(path);
      expect(run("files.py", { operation: "list" }).value).not.toContain(path);
    }
    rmSync(join(directory, "src/.gitignore"));
    symlinkSync(join(directory, ".env"), join(directory, "src/.gitignore"));
    expect(safePath(directory, "src/.gitignore")).toBeNull();
    expect(files.manifest().skipped).toContain("src/.gitignore");
    expect(run("workspace.py", { operation: "manifest" }).value.skipped).toContain(
      "src/.gitignore",
    );
    expect(run("files.py", { operation: "read", path: "src/.gitignore" }).ok).toBe(false);
    expect(run("files.py", { operation: "list" }).value).not.toContain("src/.gitignore");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps ignored build output out of Changes, the preview fingerprint and Share on both adapters", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-ignored-output-"));
  const directory = join(root, "project");
  mkdirSync(join(directory, "src"), { recursive: true });
  const python = (payload: object) => {
    const source = readFileSync(
      new URL("../packages/sprites/src/workspace.py", import.meta.url),
      "utf8",
    )
      .replace(
        /ROOT = pathlib.Path\(['"]\/home\/sprite\/project['"]\)/,
        `ROOT = pathlib.Path(${JSON.stringify(directory)})`,
      )
      .replaceAll("/home/sprite/.civic-spark-file-lock", join(root, "lock"));
    const result = spawnSync("python3", ["-c", source], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const tree = (commit: string) =>
    git(directory, ["ls-tree", "-r", "--name-only", commit]).toString().trim().split("\n").sort();
  try {
    git(directory, ["init", "--initial-branch=main"]);
    writeFileSync(join(directory, ".gitignore"), "*.tsbuildinfo\ncache/\n");
    writeFileSync(join(directory, "README.md"), "Project\n");
    writeFileSync(join(directory, "generated.txt"), "tracked before the rule\n");
    git(directory, ["add", "."]);
    git(directory, ["commit", "-m", "Seed"]);
    git(directory, ["update-ref", "refs/civic-spark/base", "HEAD"]);
    const files = new WorkspaceFiles(directory);
    expect(files.changes().files).toEqual([]);
    const clean = files.changes().revision;
    // A build writes ignored output: no change, and the fingerprint stays put.
    writeFileSync(join(directory, "tsconfig.tsbuildinfo"), "{}");
    mkdirSync(join(directory, "cache"));
    writeFileSync(join(directory, "cache", "data.json"), "[]");
    expect(files.changes().files).toEqual([]);
    expect(files.changes().revision).toBe(clean);
    expect(python({ operation: "changes" }).value.files).toEqual([]);
    // Real edits still show, including a tracked file that a new rule now matches.
    writeFileSync(join(directory, "src", "app.ts"), "export const app = 1;\n");
    appendFileSync(join(directory, ".gitignore"), "generated.txt\n");
    writeFileSync(join(directory, "generated.txt"), "edited while ignored\n");
    const shown = [".gitignore", "generated.txt", "src/app.ts"];
    expect(files.changes().files.map((f) => `${f.path}:${f.status}`)).toEqual([
      ".gitignore:modified",
      "generated.txt:modified",
      "src/app.ts:added",
    ]);
    const remote = python({ operation: "changes" }).value;
    expect(remote.files.map((f: { path: string }) => f.path)).toEqual(shown);
    // Share on the Sprite adapter commits only the shown files.
    const shared = python({ operation: "share", title: "Real edits", revision: remote.revision });
    expect(shared.ok, shared.error).toBe(true);
    expect(tree(shared.value.commit)).toEqual(
      [".gitignore", "README.md", "generated.txt", "src/app.ts"].sort(),
    );
    expect(git(directory, ["status", "--porcelain"]).toString()).toBe("");
    // The host adapter does the same for the next edit.
    git(directory, ["update-ref", "refs/civic-spark/base", "HEAD"]);
    writeFileSync(join(directory, "src", "more.ts"), "export const more = 2;\n");
    writeFileSync(join(directory, "cache", "again.json"), "{}");
    const local = files.changes();
    expect(local.files.map((f) => f.path)).toEqual(["src/more.ts"]);
    const commit = commitChanges(directory, "More edits", local.revision ?? "").commit ?? "";
    expect(tree(commit)).toEqual(
      [".gitignore", "README.md", "generated.txt", "src/app.ts", "src/more.ts"].sort(),
    );
    expect(existsSync(join(directory, "tsconfig.tsbuildinfo"))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
