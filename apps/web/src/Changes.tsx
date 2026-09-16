import "./changes.css";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import type { Changes as WorkspaceChanges } from "../../../packages/workspace/src/types.ts";
import { api } from "./api.ts";
import { useToast } from "./Toast.tsx";

function diffLines(diff: string) {
  const lines = diff.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  return firstHunk > 0 ? lines.slice(firstHunk) : lines;
}

export function Changes({
  value,
  outgoing = false,
  refresh,
  dirty,
  workspace,
  readOnly,
  onShared,
  error,
}: {
  value: WorkspaceChanges | null;
  outgoing?: boolean;
  refresh: () => void;
  dirty: boolean;
  workspace: string;
  readOnly: boolean;
  onShared: () => Promise<void>;
  error: string;
}) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState("");
  const { notify, toast } = useToast();
  const messageId = useId();
  const helpId = useId();
  const count = value?.files.length ?? 0;
  const canShare = Boolean(
    !busy &&
      !dirty &&
      !readOnly &&
      (count || outgoing) &&
      value?.revision &&
      (shared !== value.revision || outgoing) &&
      !error &&
      title.trim(),
  );
  async function share() {
    if (!canShare || !value?.revision) return;
    setBusy(true);
    try {
      const result = await api<{ notice?: string }>(`/workspaces/${workspace}/share`, "POST", {
        title: title.trim(),
        revision: value.revision,
      });
      setShared(value.revision);
      setTitle("");
      notify(result.notice ?? "Shared with your team.");
      try {
        await onShared();
        refresh();
      } catch {
        notify("Shared with your team. Refresh Changes to update this view.", "error");
      }
    } catch (cause) {
      notify(
        cause instanceof Error ? cause.message : "Could not share. Your files are preserved.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-panel changes-panel" aria-label="Workspace changes">
      <div className="changes-controls">
        <div className="changes-toolbar">
          <span>
            {count} {count === 1 ? "file" : "files"} changed{outgoing ? " · Commits to push" : ""}
          </span>
          <button
            type="button"
            className="button small changes-refresh"
            onClick={refresh}
            disabled={busy}
            aria-label="Refresh changes"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Refresh
          </button>
        </div>
        <form
          className="changes-commit"
          onSubmit={(event) => {
            event.preventDefault();
            void share();
          }}
        >
          <label htmlFor={messageId}>Commit message</label>
          <div className="changes-commit-row">
            <input
              id={messageId}
              placeholder="Summarize your changes"
              value={title}
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy || readOnly}
              autoComplete="off"
              aria-describedby={helpId}
            />
            <button
              type="submit"
              className="button primary"
              disabled={!canShare}
              title="Commit and push changes to your team"
              aria-describedby={helpId}
            >
              {busy ? "Sharing…" : "Share"}
            </button>
          </div>
          <span id={helpId} className="sr-only">
            Share commits these changes with your message and pushes them to your team. Existing
            local commits keep their messages.
          </span>
        </form>
        {dirty ? (
          <p className="changes-blocker">Save your open file before sharing.</p>
        ) : readOnly ? (
          <p className="changes-blocker">This workspace is read-only.</p>
        ) : null}
        {error && (
          <p className="changes-blocker changes-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="changes-files">
        {!value && !error && (
          <p className="changes-empty" role="status">
            Loading changes…
          </p>
        )}
        {value && count === 0 && (
          <p className="changes-empty">
            {outgoing ? "Local commits are ready to push." : "No changes to share."}
          </p>
        )}
        {value?.files.map((file) => (
          <details className="file-diff" key={file.path} open>
            <summary>
              <ChevronRight className="diff-chevron" size={14} aria-hidden="true" />
              <code title={file.path}>{file.path}</code>
              <span className={`change-kind ${file.status}`} title={file.status}>
                <span aria-hidden="true">{file.status[0]?.toUpperCase()}</span>
                <span className="sr-only">{file.status}</span>
              </span>
            </summary>
            <pre className="live-diff">
              {diffLines(file.diff).map((line, index) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: Diff lines are stateless, including repeated blank lines.
                  key={index}
                  className={
                    line.startsWith("+")
                      ? "diff-add"
                      : line.startsWith("-")
                        ? "diff-remove"
                        : line.startsWith("@@")
                          ? "diff-hunk"
                          : ""
                  }
                >
                  {line || " "}
                </span>
              ))}
            </pre>
          </details>
        ))}
      </div>
      {toast}
    </section>
  );
}
