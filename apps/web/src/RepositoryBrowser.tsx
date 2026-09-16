import "./repository.css";
import { ArrowLeft, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { TeamView } from "../../../packages/domain/src/access-types.ts";
import type {
  RepositoryFileView,
  RepositoryHistory,
  RepositoryVersion,
} from "../../../packages/git/src/history.ts";
import { api } from "./api.ts";
import { Modal } from "./components.tsx";

export function RepositoryBrowser({ team, onClose }: { team: TeamView; onClose: () => void }) {
  const [history, setHistory] = useState<RepositoryHistory | null>(null);
  const [selected, setSelected] = useState("");
  const [version, setVersion] = useState<RepositoryVersion | null>(null);
  const [path, setPath] = useState("");
  const [file, setFile] = useState<RepositoryFileView | null>(null);
  const [mode, setMode] = useState<"changes" | "files">("changes");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/teams/${team.id}/repository`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads the current repository after refresh or restore.
  useEffect(() => {
    let active = true;
    setHistory(null);
    setSelected("");
    setError("");
    void api<RepositoryHistory>(endpoint)
      .then((data) => {
        if (active) {
          setHistory(data);
          setSelected(data.head);
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [endpoint, revision]);
  useEffect(() => {
    let active = true;
    setVersion(null);
    setPath("");
    setFile(null);
    if (selected)
      void api<RepositoryVersion>(`${endpoint}/commits/${selected}`)
        .then((data) => {
          if (active) {
            setVersion(data);
            setPath(
              data.files.find((f) =>
                mode === "files" ? f.status !== "deleted" : f.status !== "unchanged",
              )?.path ?? "",
            );
          }
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [endpoint, selected, mode]);
  useEffect(() => {
    let active = true;
    setFile(null);
    if (path && selected)
      void api<RepositoryFileView>(
        `${endpoint}/commits/${selected}/file?${new URLSearchParams({ path })}`,
      )
        .then((data) => {
          if (active) setFile(data);
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [endpoint, path, selected]);
  async function more() {
    if (!history || history.nextOffset === null || busy) return;
    setBusy(true);
    setError("");
    try {
      const page = await api<RepositoryHistory>(
        `${endpoint}?${new URLSearchParams({ head: history.head, offset: String(history.nextOffset) })}`,
      );
      setHistory({ ...page, commits: [...history.commits, ...page.commits] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load commits.");
    } finally {
      setBusy(false);
    }
  }
  async function restore(fileOnly = false) {
    if (!history || !version || busy) return;
    if (
      fileOnly &&
      (!path || !version.files.some((f) => f.path === path && f.status !== "deleted"))
    )
      return;
    if (
      !window.confirm(
        fileOnly
          ? `Restore “${path}” from ${selected.slice(0, 12)}?\n\nThis creates a new team commit. Other files are unchanged.`
          : `Restore ${team.name} to ${selected.slice(0, 12)} — ${version.commit.subject}?\n\nThis creates a new team commit restoring all files to this version. Existing history is kept.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`${endpoint}/${fileOnly ? "restore-file" : "restore"}`, "POST", {
        commit: selected,
        expectedHead: history.head,
        confirmed: true,
        ...(fileOnly ? { path } : {}),
      });
      setNotice(
        fileOnly
          ? `Restored only ${path} from ${selected.slice(0, 12)}. Other files are unchanged.`
          : `Restored ${team.name} to ${selected.slice(0, 12)} with a new shared commit.`,
      );
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed.");
    } finally {
      setBusy(false);
    }
  }
  const files =
    version?.files.filter((f) =>
      mode === "files" ? f.status !== "deleted" : f.status !== "unchanged",
    ) ?? [];
  return (
    <Modal title={`${team.name} · Repository`} wide onClose={() => !busy && onClose()}>
      <div className="repository-browser">
        <div className="repository-toolbar">
          <button type="button" className="button small" onClick={onClose} disabled={busy}>
            <ArrowLeft size={14} />
            Teams
          </button>
          <span>Shared main · {history?.head.slice(0, 12) ?? "Loading…"}</span>
          <button
            type="button"
            className="button small"
            disabled={busy}
            onClick={() => {
              setNotice("");
              setRevision((v) => v + 1);
            }}
          >
            <RefreshCw size={14} />
            Refresh repository
          </button>
          <a className="text-link" href={`/api/teams/${team.id}/export`}>
            Download current ZIP
          </a>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="repository-notice" role="status">
            {notice}
          </p>
        )}
        <div className="repository-layout">
          <nav className="repository-history" aria-label="Repository commits">
            <h3>Commits</h3>
            {!history && <p>Loading history…</p>}
            {history?.commits.map((commit) => (
              <button
                key={commit.id}
                type="button"
                className={`repository-commit ${selected === commit.id ? "selected" : ""}`}
                aria-current={selected === commit.id ? "true" : undefined}
                disabled={busy}
                onClick={() => {
                  setSelected(commit.id);
                  setError("");
                }}
              >
                <strong>{commit.subject}</strong>
                <span>
                  {commit.author} · {new Date(commit.date).toLocaleDateString()}
                </span>
                <code>{commit.id.slice(0, 12)}</code>
              </button>
            ))}
            {history?.nextOffset != null && (
              <button
                type="button"
                className="button small"
                disabled={busy}
                onClick={() => void more()}
              >
                {busy ? "Loading…" : "Load older commits"}
              </button>
            )}
          </nav>
          <section className="repository-detail" aria-label="Selected commit">
            {version ? (
              <>
                <header className="repository-version">
                  <div>
                    <h3>{version.commit.subject}</h3>
                    <p>
                      {version.commit.author} · {new Date(version.commit.date).toLocaleString()} ·{" "}
                      <code>{selected.slice(0, 12)}</code>
                    </p>
                  </div>
                  <button
                    type="button"
                    className="button small"
                    disabled={busy || selected === history?.head}
                    onClick={() => void restore()}
                  >
                    <RotateCcw size={14} />
                    Restore this version
                  </button>
                </header>
                <section className="repository-modes" aria-label="Repository view">
                  <button
                    className="button small"
                    type="button"
                    aria-pressed={mode === "changes"}
                    onClick={() => setMode("changes")}
                  >
                    Commit changes
                  </button>
                  <button
                    className="button small"
                    type="button"
                    aria-pressed={mode === "files"}
                    onClick={() => setMode("files")}
                  >
                    Files at this commit
                  </button>
                  <span>
                    {files.length} {files.length === 1 ? "file" : "files"}
                    {mode === "changes" && version.commit.parents.length > 1
                      ? " · Compared with first parent"
                      : ""}
                  </span>
                </section>
                <div className="repository-files">
                  <nav className="repository-paths" aria-label="Commit files">
                    {files.map((f) => (
                      <button
                        type="button"
                        key={f.path}
                        title={f.path}
                        className={path === f.path ? "selected" : ""}
                        aria-current={path === f.path ? "true" : undefined}
                        onClick={() => {
                          setPath(f.path);
                          setError("");
                        }}
                      >
                        <span>{f.path}</span>
                        {mode === "changes" && <small>{f.status}</small>}
                      </button>
                    ))}
                    {!files.length && <p>No file changes.</p>}
                  </nav>
                  <section className="repository-file-view" aria-label="File preview">
                    <div
                      className="repository-filename"
                      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}
                    >
                      <span style={{ flex: "1 1 140px", minWidth: 0 }}>
                        {path || "Select a file"}
                      </span>
                      {path && (
                        <button
                          type="button"
                          className="button small"
                          disabled={
                            busy ||
                            !file ||
                            selected === history?.head ||
                            version.files.find((f) => f.path === path)?.status === "deleted"
                          }
                          onClick={() => void restore(true)}
                          title="Restore only this file; keep all other current files"
                        >
                          <RotateCcw size={14} />
                          Restore this file
                        </button>
                      )}
                    </div>
                    {path && !file && <p>Loading file…</p>}
                    {file?.notice && <p>{file.notice}</p>}
                    {file && (
                      <pre className="repository-code">
                        {mode === "files"
                          ? file.content
                          : file.diff.split("\n").map((line, index) => (
                              <span
                                // biome-ignore lint/suspicious/noArrayIndexKey: Stateless diff lines include repeated blank lines.
                                key={index}
                                className={
                                  line.startsWith("+")
                                    ? "repo-add"
                                    : line.startsWith("-")
                                      ? "repo-remove"
                                      : line.startsWith("@@")
                                        ? "repo-hunk"
                                        : ""
                                }
                              >
                                {line || " "}
                              </span>
                            ))}
                      </pre>
                    )}
                  </section>
                </div>
              </>
            ) : (
              <p>{selected ? "Loading commit…" : "Choose a commit to inspect."}</p>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
