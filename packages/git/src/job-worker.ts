import { readFileSync } from "node:fs";
import { commitChanges } from "../../workspace/src/share.ts";
import { projectPath } from "../../workspace/src/types.ts";
import { gitJobSchema } from "./jobs.ts";
import { git } from "./repository.ts";

// Trusted Git/file operations only. Never imports EventService or opens SQLite.
try {
  const input = gitJobSchema.parse(JSON.parse(readFileSync(0, "utf8")));
  if (input.operation === "commit") {
    let retained: string | undefined;
    try {
      retained = git(input.root, [
        "rev-parse",
        "--verify",
        `refs/civic-spark/share/${input.revision}`,
      ])
        .toString()
        .trim();
    } catch {
      /* No earlier commit for this explicit request. */
    }
    if (retained) {
      if (
        git(input.root, ["rev-parse", "HEAD"]).toString().trim() !== retained ||
        git(input.root, ["status", "--porcelain"]).length
      )
        throw new Error("Files or Git changed since this Share. Refresh Changes before sharing.");
      process.stdout.write(JSON.stringify({ ok: true, value: { commit: retained } }));
    } else {
      const value = commitChanges(input.root, input.title, input.revision);
      process.stdout.write(JSON.stringify({ ok: true, value: { commit: value.commit } }));
    }
  } else {
    const { repo, source, commit } = input;
    const main = git(repo, ["rev-parse", "main"]).toString().trim();
    git(source, ["fetch", repo, "main"]);
    const base = git(source, ["merge-base", main, commit]).toString().trim();
    if (base !== main)
      throw new Error(
        "Your local commit is saved, but the team repository has newer changes. Update your workspace from the team repository, resolve any conflicts, then Share again.",
      );

    const privateEntries = new Map<string, string>();
    for (const entry of git(source, ["ls-tree", "-rz", main]).toString().split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab >= 0 && !projectPath(entry.slice(tab + 1)))
        privateEntries.set(entry.slice(tab + 1), entry.slice(0, tab));
    }
    const incoming = git(source, ["rev-list", "--max-count=501", commit, "--not", main])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    if (incoming.length > 500)
      throw new Error("Contribution history exceeds 500 commits. Your files are preserved.");
    for (const revision of incoming) {
      for (const entry of git(source, ["ls-tree", "-rz", revision]).toString().split("\0")) {
        const tab = entry.indexOf("\t");
        if (tab < 0) continue;
        const path = entry.slice(tab + 1);
        if (
          (!projectPath(path) && privateEntries.get(path) !== entry.slice(0, tab)) ||
          entry.startsWith("120000") ||
          entry.startsWith("160000")
        )
          throw new Error(
            "The contribution history includes excluded files or links. Your private workspace is preserved.",
          );
      }
    }

    for (const path of git(source, ["diff", "--name-only", "-z", base, commit])
      .toString()
      .split("\0")
      .filter(Boolean)) {
      if (!projectPath(path))
        throw new Error(
          "The committed history includes excluded files. Remove them from the contribution before sharing.",
        );
    }
    let diff = git(source, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--stat",
      `${main}...${commit}`,
    ]).toString();
    if (commit === main) throw new Error("There are no new changes to share.");
    if (!diff) diff = "Commit history updated; no file content changes.";

    git(source, ["push", repo, `${commit}:${input.ref}`]);
    process.stdout.write(JSON.stringify({ ok: true, value: { main, diff } }));
  }
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "Git preparation failed",
    }),
  );
}
