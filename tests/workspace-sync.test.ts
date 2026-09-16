import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { git } from "../packages/git/src/repository.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { planSync } from "../packages/workspace/src/sync.ts";
import { FILE_LIMIT, type Manifest, projectPath } from "../packages/workspace/src/types.ts";

const manifest = (revision: string | null): Manifest => ({
  files: revision ? { "data.csv": { revision, size: 1 } } : {},
  skipped: [],
});
it.each([
  [null, "a", null, "upload"],
  [null, null, "a", "download"],
  [null, "a", "b", "conflict"],
  ["a", "b", "a", "upload"],
  ["a", "a", "b", "download"],
  ["a", "b", "c", "conflict"],
  ["a", null, "a", "upload"],
  ["a", "a", null, "download"],
  ["a", null, "b", "conflict"],
  ["a", "b", null, "conflict"],
])("reconciles baseline %s local %s remote %s as %s", (base, local, remote, direction) => {
  expect(
    planSync(base ? { "data.csv": base } : {}, manifest(local), manifest(remote)),
  ).toMatchObject([{ path: "data.csv", direction, local, remote }]);
});
it("recognizes converged copies and never treats excluded paths as deletions", () => {
  expect(planSync({ "data.csv": "old" }, manifest("new"), manifest("new"))).toEqual([]);
  expect(
    planSync({ "data.csv": "a" }, { files: {}, skipped: ["data.csv"] }, manifest("b")),
  ).toEqual([]);
});
it("creates, updates and deletes with revision checks; diffs include untracked and committed changes", () => {
  const root = mkdtempSync(join(tmpdir(), "vibehack-files-"));
  try {
    git(root, ["init", "--initial-branch=main"]);
    writeFileSync(join(root, "README.md"), "Before\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "Start"]);
    git(root, ["update-ref", "refs/vibehack/base", "HEAD"]);
    const fs = new WorkspaceFiles(root);
    const old = fs.read("README.md");
    fs.mutate({
      path: old.path,
      revision: old.revision,
      data: Buffer.from("After\n").toString("base64"),
    });
    expect(() => fs.mutate({ path: old.path, revision: old.revision, data: null })).toThrow(
      "changed",
    );
    fs.mutate({
      path: "src/chart.ts",
      revision: null,
      data: Buffer.from("export const chart = 1;\n").toString("base64"),
    });
    expect(fs.changes().files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "README.md",
          status: "modified",
          diff: expect.stringContaining("+After"),
        }),
        expect.objectContaining({ path: "src/chart.ts", status: "added" }),
      ]),
    );
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "Agent commit"]);
    expect(fs.changes().files).toHaveLength(2);
    fs.mutate({ path: "README.md", revision: fs.read("README.md").revision, data: null });
    expect(fs.changes().files.find((f) => f.path === "README.md")?.status).toBe("deleted");
    const binary = Buffer.from([0, 255, 42]);
    fs.mutate({ path: "image.bin", revision: null, data: binary.toString("base64") });
    expect(Buffer.from(fs.read("image.bin").data, "base64")).toEqual(binary);
    expect(fs.changes().files.find((f) => f.path === "image.bin")?.binary).toBe(true);
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "secret.txt"), "hidden");
    writeFileSync(join(root, ".env"), "hidden");
    symlinkSync("/tmp", join(root, "external"));
    expect(fs.manifest().skipped).toEqual(
      expect.arrayContaining(["node_modules", ".env", "external"]),
    );
    expect(() => fs.mutate({ path: "external/leak", data: "", revision: null })).toThrow();
    expect(() => fs.mutate({ path: "../leak", data: "", revision: null })).toThrow();
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("hidden");
    writeFileSync(join(root, "large.csv"), Buffer.alloc(FILE_LIMIT + 1));
    expect(() => fs.manifest()).toThrow("25 MiB");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.each([
  ".git/config",
  "src/../secret",
  "node_modules/a",
  "src\\a",
  "/root",
  "CON.txt",
  "file.",
  "foo/private.pem",
  "secrets/api-key",
  "a\0b",
])("excludes unsafe or nonportable path %s", (path) => expect(projectPath(path)).toBe(false));
