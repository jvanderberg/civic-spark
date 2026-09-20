import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { git } from "../../git/src/repository.ts";
import { backupWorkingTree } from "./recovery.ts";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const teamStatusSchema = z.object({
  head: sha,
  remote: sha,
  incoming: z.boolean(),
  outgoing: z.boolean(),
  dirty: z.boolean(),
  merging: z.boolean(),
  conflicts: z.array(z.string()),
  agentWorking: z.boolean().optional(),
  resolution: z.object({ head: sha, remote: sha }).optional(),
});
export type TeamStatus = z.infer<typeof teamStatusSchema>;
export const teamUpdateSchema = z.object({
  head: sha,
  remote: sha,
  mode: z.enum(["pull", "agent", "replace"]),
});
export type TeamUpdate = z.infer<typeof teamUpdateSchema>;
export const teamUpdateResultSchema = z.object({
  status: z.enum(["updated", "conflict", "agent"]),
  head: sha,
  remote: sha,
  conflicts: z.array(z.string()),
  backup: z.string().optional(),
  prompt: z.string().optional(),
});
export type TeamUpdateResult = z.infer<typeof teamUpdateResultSchema>;
function ancestor(root: string, older: string, newer: string) {
  try {
    git(root, ["merge-base", "--is-ancestor", older, newer]);
    return true;
  } catch {
    return false;
  }
}
function directory(root: string) {
  return git(root, ["rev-parse", "--absolute-git-dir"]).toString().trim();
}
function conflicts(root: string) {
  return git(root, ["diff", "--name-only", "--diff-filter=U", "-z"])
    .toString()
    .split("\0")
    .filter(Boolean);
}
/** Move the Changes baseline to the merged team commit without ever moving it backwards. */
function advanceBase(root: string, remote: string) {
  let base: string | undefined;
  try {
    base = git(root, ["rev-parse", "--verify", "refs/civic-spark/base"]).toString().trim();
  } catch {
    /* No baseline yet. */
  }
  if (!base || ancestor(root, base, remote))
    git(root, ["update-ref", "refs/civic-spark/base", remote]);
}
export function teamStatus(root: string, remote: string): TeamStatus {
  sha.parse(remote);
  const head = git(root, ["rev-parse", "HEAD"]).toString().trim();
  const receipt = join(directory(root), "civic-spark-agent-merge.json");
  let resolution = existsSync(receipt)
    ? (JSON.parse(readFileSync(receipt, "utf8")) as { head: string; remote: string })
    : undefined;
  const merging = existsSync(join(directory(root), "MERGE_HEAD"));
  const unresolved = conflicts(root);
  if (
    resolution &&
    !merging &&
    !unresolved.length &&
    ancestor(root, resolution.head, head) &&
    ancestor(root, resolution.remote, head)
  ) {
    // The agent merge is complete and both histories are retained. The person
    // may already have moved on (for example by sharing the merge), so finish
    // the resolution here instead of waiting for an explicit check.
    advanceBase(root, resolution.remote);
    unlinkSync(receipt);
    resolution = undefined;
  }
  return {
    head,
    remote,
    resolution: resolution ? { head: resolution.head, remote: resolution.remote } : undefined,
    incoming: !ancestor(root, remote, head),
    outgoing: head !== remote && ancestor(root, remote, head),
    dirty: Boolean(git(root, ["status", "--porcelain", "-z"]).length),
    merging,
    conflicts: unresolved,
  };
}
export function resolutionPrompt(head: string, remote: string) {
  return `Resolve the Git merge that I requested in this workspace. The original local commit is ${head}; the incoming team commit is ${remote}. Git has started the merge. Inspect the conflicted files and reconcile both sides' intent, preserving unrelated work. Resolve all conflicts and create a normal merge commit retaining both histories. Do not force-push, publish, reset --hard, or discard one side wholesale. Do not ask me to edit merge markers. Run appropriate existing checks inside this workspace. Verify there are no unmerged index entries, MERGE_HEAD is gone, and both specified commits are ancestors of HEAD. If resolution is unsafe or ambiguous, leave the work recoverable and explain the issue. Do not push; I will use Share separately.`;
}
export function importTeamBundle(root: string, bundle: string, remote: string) {
  sha.parse(remote);
  git(root, ["bundle", "verify", bundle]);
  git(root, ["fetch", bundle, "refs/heads/main:refs/civic-spark/team-incoming"]);
  if (git(root, ["rev-parse", "refs/civic-spark/team-incoming"]).toString().trim() !== remote)
    throw new Error("The team version changed during transfer. Check for updates again.");
}
export function applyTeamUpdate(root: string, input: TeamUpdate): TeamUpdateResult {
  teamUpdateSchema.parse(input);
  const state = teamStatus(root, input.remote);
  if (state.head !== input.head)
    throw new Error("Your workspace changed since the update preview. Check for updates again.");
  if (git(root, ["rev-parse", "refs/civic-spark/team-incoming"]).toString().trim() !== input.remote)
    throw new Error("The incoming team version changed. Check for updates again.");
  const continuing =
    state.merging &&
    input.mode === "agent" &&
    readFileSync(join(directory(root), "MERGE_HEAD"), "utf8").trim() === input.remote;
  if (state.merging && !continuing && input.mode !== "replace")
    throw new Error("A merge is already in progress. Finish the current agent resolution first.");
  if (!state.incoming && input.mode !== "replace")
    return { status: "updated", head: state.head, remote: input.remote, conflicts: [] };
  if (state.dirty && input.mode !== "replace" && !continuing)
    throw new Error(
      "Your workspace has uncommitted edits. Save them with Share before getting team updates; any failed push still preserves the local commit.",
    );
  if (input.mode === "pull") {
    // Probe using Git's in-memory merge: conflicts never alter files or the index.
    try {
      git(root, ["merge-tree", "--write-tree", input.head, input.remote]);
    } catch {
      return { status: "conflict", head: state.head, remote: input.remote, conflicts: [] };
    }
  }
  let backup: string | undefined;
  if (input.mode !== "pull") {
    backup = `refs/civic-spark/recovery/${randomUUID()}`;
    git(root, ["update-ref", `${backup}/head`, input.head]);
  }
  if (input.mode === "replace") {
    const id = backup?.split("/").at(-1);
    if (!id) throw new Error("Recovery reference unavailable");
    const recovery = backupWorkingTree(root, id);
    recovery.verify();
    if (teamStatus(root, input.remote).head !== input.head)
      throw new Error("Your Git branch changed during recovery. Your workspace was not replaced.");
    git(root, ["reset", "--hard", input.remote]);
    git(root, ["clean", "-fd"]);
    const receipt = join(directory(root), "civic-spark-agent-merge.json");
    if (existsSync(receipt)) unlinkSync(receipt);
  } else {
    if (teamStatus(root, input.remote).head !== input.head)
      throw new Error("Your Git branch changed during the update. Retry after reviewing it.");
    try {
      if (!continuing)
        git(root, ["merge", input.mode === "agent" ? "--no-commit" : "--no-edit", input.remote]);
    } catch {
      if (!existsSync(join(directory(root), "MERGE_HEAD")))
        throw new Error("Team updates could not be applied. Your local work is preserved.");
    }
    if (existsSync(join(directory(root), "MERGE_HEAD"))) {
      const unresolved = conflicts(root);
      if (input.mode === "pull") {
        // A native writer raced the clean preflight. Keep the merge recoverable.
        return {
          status: "conflict",
          head: input.head,
          remote: input.remote,
          conflicts: unresolved,
        };
      }
      writeFileSync(
        join(directory(root), "civic-spark-agent-merge.json"),
        JSON.stringify({ head: input.head, remote: input.remote, backup }),
        { mode: 0o600 },
      );
      return {
        status: "agent",
        head: input.head,
        remote: input.remote,
        conflicts: unresolved,
        backup,
        prompt: resolutionPrompt(input.head, input.remote),
      };
    }
  }
  git(root, ["update-ref", "refs/civic-spark/base", input.remote]);
  return {
    status: "updated",
    head: git(root, ["rev-parse", "HEAD"]).toString().trim(),
    remote: input.remote,
    conflicts: [],
    backup,
  };
}
export function verifyTeamUpdate(root: string, head: string, remote: string): TeamUpdateResult {
  sha.parse(head);
  sha.parse(remote);
  const path = join(directory(root), "civic-spark-agent-merge.json");
  if (!existsSync(path)) throw new Error("No agent merge is awaiting verification.");
  const receipt = JSON.parse(readFileSync(path, "utf8")) as {
    head: string;
    remote: string;
    backup?: string;
  };
  if (receipt.head !== head || receipt.remote !== remote)
    throw new Error("The pending merge changed. Reopen team updates.");
  // Status finalizes a completed merge itself; a receipt that survives it is unfinished.
  const state = teamStatus(root, remote);
  if (existsSync(path))
    throw new Error(
      "The agent has not finished a merge preserving both versions yet. Continue the resolution in Agent.",
    );
  return { status: "updated", head: state.head, remote, conflicts: [], backup: receipt.backup };
}
