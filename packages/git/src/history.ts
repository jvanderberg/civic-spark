import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DIFF_FILE_LIMIT, projectPath } from "../../workspace/src/types.ts";
import { git } from "./repository.ts";

export const commitIdSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const historyQuerySchema = z.object({
  head: commitIdSchema.optional(),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
export const restoreInputSchema = z.object({
  commit: commitIdSchema,
  expectedHead: commitIdSchema,
  confirmed: z.literal(true),
});
export const restoreFileInputSchema = restoreInputSchema.extend({
  path: z.string().refine(projectPath, "This file is excluded from repository recovery"),
});
export type RepositoryCommit = {
  id: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
};
export type RepositoryHistory = {
  head: string;
  commits: RepositoryCommit[];
  nextOffset: number | null;
};
export type RepositoryFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "unchanged";
};
export type RepositoryVersion = { commit: RepositoryCommit; files: RepositoryFile[] };
export type RepositoryFileView = { content: string; diff: string; notice: string | null };

export function repositoryHead(repo: string) {
  return git(repo, ["rev-parse", "refs/heads/main"]).toString().trim();
}
function sharedCommit(repo: string, id: string) {
  commitIdSchema.parse(id);
  git(repo, ["merge-base", "--is-ancestor", id, "refs/heads/main"]);
  return id;
}
function commitInfo(repo: string, id: string): RepositoryCommit {
  const [hash = "", parents = "", author = "", date = "", subject = ""] = git(repo, [
    "show",
    "-s",
    "--format=%H%x00%P%x00%an%x00%aI%x00%s",
    id,
  ])
    .toString()
    .trimEnd()
    .split("\0");
  return { id: hash, parents: parents ? parents.split(" ") : [], author, date, subject };
}
export function repositoryHistory(
  repo: string,
  input: z.input<typeof historyQuerySchema>,
): RepositoryHistory {
  const query = historyQuerySchema.parse(input);
  const head = query.head ? sharedCommit(repo, query.head) : repositoryHead(repo);
  const ids = git(repo, [
    "rev-list",
    "--topo-order",
    `--skip=${query.offset}`,
    "--max-count=31",
    head,
  ])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  return {
    head,
    commits: ids.slice(0, 30).map((id) => commitInfo(repo, id)),
    nextOffset: ids.length > 30 ? query.offset + 30 : null,
  };
}
function tree(repo: string, commit: string) {
  return git(repo, ["ls-tree", "-r", "-z", commit])
    .toString()
    .split("\0")
    .filter(Boolean)
    .flatMap((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, id] = line.slice(0, tab).split(" ");
      const path = line.slice(tab + 1);
      return type === "blob" && (mode === "100644" || mode === "100755") && id && projectPath(path)
        ? [{ path, id, mode }]
        : [];
    });
}
export function repositoryVersion(repo: string, id: string): RepositoryVersion {
  sharedCommit(repo, id);
  const commit = commitInfo(repo, id);
  const current = new Map(tree(repo, id).map((f) => [f.path, f]));
  const before = new Map(
    (commit.parents[0] ? tree(repo, commit.parents[0]) : []).map((f) => [f.path, f]),
  );
  const files: RepositoryFile[] = [...new Set([...current.keys(), ...before.keys()])]
    .sort()
    .map((path) => ({
      path,
      status: !current.has(path)
        ? "deleted"
        : !before.has(path)
          ? "added"
          : current.get(path)?.id !== before.get(path)?.id ||
              current.get(path)?.mode !== before.get(path)?.mode
            ? "modified"
            : "unchanged",
    }));
  return { commit, files };
}
export function repositoryFile(repo: string, id: string, path: string): RepositoryFileView {
  sharedCommit(repo, id);
  if (!projectPath(path)) throw new Error("This file is excluded from repository browsing.");
  const parent = commitInfo(repo, id).parents[0];
  const current = tree(repo, id).find((f) => f.path === path);
  const before = parent ? tree(repo, parent).find((f) => f.path === path) : undefined;
  if (!current && !before) throw new Error("File not found in this commit.");
  for (const entry of [current, before]) {
    if (entry && Number(git(repo, ["cat-file", "-s", entry.id]).toString()) > DIFF_FILE_LIMIT)
      return { content: "", diff: "", notice: "This file exceeds the 1 MiB preview limit." };
  }
  const bytes = current ? git(repo, ["cat-file", "blob", current.id]) : Buffer.from("");
  if (bytes.includes(0) || (before && git(repo, ["cat-file", "blob", before.id]).includes(0)))
    return { content: "", diff: "", notice: "Binary file; text preview is unavailable." };
  const args = ["--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=3"];
  const diff = parent
    ? git(repo, ["diff", ...args, parent, id, "--", `:(literal)${path}`])
    : git(repo, ["show", "--format=", ...args, id, "--", `:(literal)${path}`]);
  return {
    content: bytes.toString("utf8"),
    diff: diff.toString("utf8"),
    notice: current ? null : "This file was deleted in this commit.",
  };
}
export function restoreRepository(
  repo: string,
  input: z.input<typeof restoreInputSchema>,
  author: { name: string; email: string },
) {
  const parsed = restoreInputSchema.parse(input);
  sharedCommit(repo, parsed.commit);
  const head = repositoryHead(repo);
  if (head !== parsed.expectedHead)
    throw new Error("The team repository changed. Refresh and review it before restoring.");
  const targetTree = git(repo, ["rev-parse", `${parsed.commit}^{tree}`])
    .toString()
    .trim();
  if (
    targetTree ===
    git(repo, ["rev-parse", `${head}^{tree}`])
      .toString()
      .trim()
  )
    throw new Error("The team already has these files. No restore is needed.");
  const commit = git(
    repo,
    [
      "commit-tree",
      targetTree,
      "-p",
      head,
      "-m",
      `Restore project to ${parsed.commit.slice(0, 12)}`,
    ],
    {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
    },
  )
    .toString()
    .trim();
  git(repo, ["update-ref", "refs/heads/main", commit, head]);
  return { commit, previousHead: head, restoredFrom: parsed.commit };
}

export function restoreRepositoryFile(
  repo: string,
  input: z.input<typeof restoreFileInputSchema>,
  author: { name: string; email: string },
) {
  const parsed = restoreFileInputSchema.parse(input);
  sharedCommit(repo, parsed.commit);
  const head = repositoryHead(repo);
  if (head !== parsed.expectedHead)
    throw new Error(
      "The team repository changed. Refresh and review it before restoring this file.",
    );
  const source = tree(repo, parsed.commit).find((file) => file.path === parsed.path);
  if (!source) throw new Error("Choose a commit where this file exists as a regular project file.");
  const directory = mkdtempSync(join(tmpdir(), "civic-spark-file-restore-"));
  try {
    // A private temporary index changes one tree entry without checking out or
    // executing project content, touching a participant index, or reading blobs.
    const environment = { GIT_INDEX_FILE: join(directory, "index") };
    git(repo, ["read-tree", head], environment);
    git(
      repo,
      ["update-index", "--add", "--cacheinfo", `${source.mode},${source.id},${source.path}`],
      environment,
    );
    const targetTree = git(repo, ["write-tree"], environment).toString().trim();
    const changed = git(repo, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      head,
      targetTree,
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
    if (!changed.length)
      throw new Error("The team already has this version of the file. No restore is needed.");
    if (changed.length !== 1 || changed[0] !== parsed.path)
      throw new Error(
        "Restoring this file would replace other paths. Resolve the directory conflict separately.",
      );
    const commit = git(
      repo,
      [
        "commit-tree",
        targetTree,
        "-p",
        head,
        "-m",
        `Restore ${source.path} from ${parsed.commit.slice(0, 12)}`,
      ],
      {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
      },
    )
      .toString()
      .trim();
    git(repo, ["update-ref", "refs/heads/main", commit, head]);
    return { commit, previousHead: head, restoredFrom: parsed.commit, path: source.path };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
