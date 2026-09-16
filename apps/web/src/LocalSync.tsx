import "./local-sync.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncStep } from "../../../packages/workspace/src/sync.ts";
import { directorySupport, FolderSync, pickDirectory } from "./folder-sync.ts";

export function LocalSync({
  workspace,
  readOnly,
  dirty,
  onUpdated,
}: {
  workspace: string;
  readOnly: boolean;
  dirty: boolean;
  onUpdated: () => void;
}) {
  const connection = useRef<FolderSync | null>(null);
  const busyRef = useRef(false);
  const initialized = useRef(false);
  const reviewRequired = useRef(false);
  const [folder, setFolder] = useState("");
  const [status, setStatus] = useState("Not connected");
  const [error, setError] = useState("");
  const [steps, setSteps] = useState<SyncStep[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [choices, setChoices] = useState<Record<string, "upload" | "download">>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
    path: string | null;
  } | null>(null);
  const enabled = useRef(!readOnly && !dirty);
  enabled.current = !readOnly && !dirty;
  const refresh = useCallback(
    async (mode: "preview" | "manual" | "automatic" = "preview") => {
      const sync = connection.current;
      if (
        !sync ||
        busyRef.current ||
        !enabled.current ||
        document.hidden ||
        (mode === "automatic" && reviewRequired.current)
      )
        return;
      busyRef.current = true;
      setBusy(true);
      setError("");
      setStatus("Syncing");
      setProgress(null);
      try {
        const preview = await sync.preview();
        if (connection.current !== sync) return;
        reviewRequired.current =
          !initialized.current ||
          preview.steps.some(
            (s) =>
              s.direction === "conflict" ||
              (s.direction === "upload" && s.local === null) ||
              (s.direction === "download" && s.remote === null),
          );
        setSteps(preview.steps);
        setSkipped([...new Set([...preview.local.skipped, ...preview.remote.skipped])]);
        setChoices({});
        if (
          (initialized.current || mode === "manual") &&
          !preview.steps.some(
            (s) =>
              s.direction === "conflict" ||
              (s.deletion &&
                ((s.direction === "upload" && s.local === null) ||
                  (s.direction === "download" && s.remote === null))),
          )
        ) {
          const final = await sync.apply(preview.steps, {}, setProgress);
          if (connection.current !== sync) return;
          initialized.current = true;
          reviewRequired.current = false;
          setSteps(final.steps);
          setStatus(final.steps.length ? "Changes ready" : "Synced");
          onUpdated();
        } else
          setStatus(
            preview.steps.some((s) => s.direction === "conflict")
              ? "Conflicts"
              : preview.steps.length
                ? "Review sync"
                : initialized.current
                  ? "Synced"
                  : "Ready to connect",
          );
      } catch (e) {
        if (connection.current === sync) {
          setStatus("Sync paused");
          setError(e instanceof Error ? e.message : "Folder access lost");
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onUpdated],
  );
  useEffect(() => {
    const timer = setInterval(() => void refresh("automatic"), 5000);
    const resumed = () => void refresh("automatic");
    document.addEventListener("visibilitychange", resumed);
    window.addEventListener("online", resumed);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resumed);
      window.removeEventListener("online", resumed);
    };
  }, [refresh]);
  useEffect(
    () => () => {
      connection.current = null;
    },
    [],
  );
  async function connect() {
    try {
      const root = await pickDirectory();
      const sync: FolderSync = new FolderSync(
        root,
        workspace,
        () => connection.current === sync && enabled.current && !document.hidden,
      );
      await sync.connect();
      connection.current = sync;
      initialized.current = false;
      reviewRequired.current = false;
      setFolder(root.name);
      await refresh();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        setError(e instanceof Error ? e.message : "Cannot open folder");
    }
  }
  const needsReview = steps.some(
    (step) =>
      step.direction === "conflict" ||
      (step.direction === "upload" && step.local === null) ||
      (step.direction === "download" && step.remote === null),
  );
  const unresolved = steps.some((step) => step.direction === "conflict" && !choices[step.path]);
  async function syncNow() {
    if (!needsReview) return refresh("manual");
    if (unresolved) return;
    const deletions = steps.filter((step) => {
      const direction = step.direction === "conflict" ? choices[step.path] : step.direction;
      return direction === "upload" ? step.local === null : step.remote === null;
    });
    if (
      deletions.length &&
      !window.confirm(
        `Sync will delete ${deletions.length} ${deletions.length === 1 ? "file" : "files"}:\n${deletions.map((step) => step.path).join("\n")}\nContinue?`,
      )
    )
      return;
    await apply();
  }
  async function apply() {
    const sync = connection.current;
    if (!sync || busyRef.current || !enabled.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setStatus("Syncing");
    setProgress(null);
    try {
      const final = await sync.apply(steps, choices, setProgress);
      if (connection.current !== sync) return;
      initialized.current = true;
      reviewRequired.current = false;
      setSteps(final.steps);
      setStatus(final.steps.length ? "Review sync" : "Synced");
      onUpdated();
    } catch (e) {
      setStatus("Sync paused");
      setError(e instanceof Error ? e.message : "Sync failed");
      // Refresh stale choices without clearing the actionable failure.
      try {
        const fresh = await sync.preview();
        if (connection.current === sync) {
          setSteps(fresh.steps);
          setChoices({});
        }
      } catch {
        // Preserve the original transfer error; retry can recover connectivity.
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="workspace-panel local-sync">
      <h2>Work in your local editor</h2>
      <p>
        Connect a project folder. Saved edits sync both ways while this workspace is open and
        active. Reconnect the same folder after reopening; it remembers the last successful sync.
      </p>
      {!directorySupport() ? (
        <p role="status">
          Folder sync needs desktop Chrome or Edge. You can edit here, upload files, or download the
          team ZIP instead.
        </p>
      ) : (
        <div className="button-row">
          {!folder ? (
            <button
              type="button"
              className="button primary"
              disabled={readOnly}
              onClick={() => void connect()}
            >
              Connect local folder
            </button>
          ) : (
            <>
              <strong>{folder}</strong>
              <span role="status">
                {dirty
                  ? "Sync paused · save your browser edits first"
                  : readOnly
                    ? "Sync paused · read-only workspace"
                    : busy && progress
                      ? `Syncing ${progress.completed} of ${progress.total} files${progress.path ? ` · ${progress.path}` : ""}`
                      : status}
              </span>
              <button
                type="button"
                className="button"
                disabled={busy || readOnly || dirty || unresolved}
                title={unresolved ? "Choose a version for each conflict first" : undefined}
                onClick={() => void syncNow()}
              >
                Sync now
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  connection.current = null;
                  initialized.current = false;
                  reviewRequired.current = false;
                  setFolder("");
                  setSteps([]);
                  setStatus("Not connected");
                }}
              >
                Disconnect folder
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {folder && (
        <>
          <p className="small-text muted">
            Project files up to 25 MiB each, 50 MiB total. Git metadata, hidden files, credentials,
            dependencies, and build output are excluded. Team sharing is separate.
          </p>
          <ul className="sync-plan">
            {steps.map((s) => (
              <li key={s.path}>
                <code>{s.path}</code>
                <span>
                  {s.direction === "conflict"
                    ? "Both copies changed"
                    : s.direction === "upload"
                      ? s.local === null
                        ? "Delete from workspace"
                        : "Local → workspace"
                      : s.remote === null
                        ? "Delete local file"
                        : "Workspace → local"}
                </span>
                {s.direction === "conflict" && (
                  <select
                    aria-label={`Resolve ${s.path}`}
                    value={choices[s.path] ?? ""}
                    onChange={(e) =>
                      setChoices({ ...choices, [s.path]: e.target.value as "upload" | "download" })
                    }
                  >
                    <option value="" disabled>
                      Choose a version
                    </option>
                    <option value="upload">
                      Use local version{s.local === null ? " (delete)" : ""}
                    </option>
                    <option value="download">
                      Use workspace version{s.remote === null ? " (delete)" : ""}
                    </option>
                  </select>
                )}
              </li>
            ))}
          </ul>
          {skipped.length > 0 && (
            <details>
              <summary>{skipped.length} excluded paths</summary>
              <ul>
                {skipped.map((p) => (
                  <li key={p}>
                    <code>{p}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
