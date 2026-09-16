import {
  Cloud,
  Download,
  FileCode2,
  FilePlus2,
  RefreshCw,
  Save,
  Table2,
  Trash2,
  Upload,
} from "lucide-react";
import Papa from "papaparse";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace as PersonalWorkspace } from "../../../packages/domain/src/access-types.ts";
import type { FileContent } from "../../../packages/domain/src/types.ts";
import {
  FILE_LIMIT,
  type FileBlob,
  type Changes as WorkspaceChanges,
} from "../../../packages/workspace/src/types.ts";
import { Agent } from "./Agent.tsx";
import { api } from "./api.ts";
import { Changes } from "./Changes.tsx";
import { CodeEditor } from "./CodeEditor.tsx";
import { Badge } from "./components.tsx";
import { EnvironmentControls } from "./EnvironmentControls.tsx";
import { FileExplorer } from "./FileExplorer.tsx";
import { decode } from "./folder-sync.ts";
import { LocalSync } from "./LocalSync.tsx";
import { type ResolutionRequest, TeamUpdates } from "./TeamUpdates.tsx";
import { Terminal } from "./Terminal.tsx";
import { WorkspacePreparation } from "./WorkspacePreparation.tsx";

type WorkspaceView = "files" | "changes" | "agent" | "terminal" | "local";

export function Workspace({
  participant,
  onClose,
  onChanged,
  eventClosed,
  spritesEnabled,
}: {
  participant: PersonalWorkspace;
  eventClosed: boolean;
  spritesEnabled: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<WorkspaceView>(() => {
    try {
      const saved = localStorage.getItem(`vibehack:workspace:${participant.id}:tab`);
      if (saved && ["files", "changes", "agent", "terminal", "local"].includes(saved))
        return saved as WorkspaceView;
    } catch {
      // Storage may be unavailable; the workspace still works without preferences.
    }
    return "files";
  });
  useEffect(() => {
    try {
      localStorage.setItem(`vibehack:workspace:${participant.id}:tab`, view);
    } catch {
      // Preferences contain no files, messages, or credentials.
    }
  }, [participant.id, view]);
  const [agentWorking, setAgentWorking] = useState(false);
  const [outgoing, setOutgoing] = useState(false);
  const [teamUpdating, setTeamUpdating] = useState(false);
  const [teamRefresh, setTeamRefresh] = useState(0);
  const [resolutionRequest, setResolutionRequest] = useState<ResolutionRequest>();
  const [completedResolution, setCompletedResolution] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null);
  const [changesError, setChangesError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"edit" | "data">("edit");
  const dirty = file !== null && text !== file.content;
  const remote = participant.spriteStatus === "ready";
  const pending =
    participant.spriteStatus === "provisioning" || participant.spriteStatus === "error";
  const readOnly = pending || eventClosed || loading || teamUpdating;
  const current = useRef({ file, text });
  current.current = { file, text };
  const updating = useRef(false);
  const refreshFiles = useCallback(async () => {
    if (updating.current || document.hidden) return;
    updating.current = true;
    try {
      const [paths, diff] = await Promise.all([
        api<string[]>(`/workspaces/${participant.id}/files`),
        api<WorkspaceChanges>(`/workspaces/${participant.id}/changes`)
          .then((value) => {
            setChangesError("");
            return value;
          })
          .catch((e: Error) => {
            setChangesError(e.message);
            return null;
          }),
      ]);
      setFiles(paths);
      if (diff) setChanges(diff);
      const snapshot = current.current;
      if (snapshot.file && paths.includes(snapshot.file.path)) {
        const next = await api<FileContent>(
          `/workspaces/${participant.id}/file?path=${encodeURIComponent(snapshot.file.path)}`,
        );
        if (current.current.file?.path !== snapshot.file.path) return;
        if (
          current.current.text !== snapshot.file.content ||
          current.current.file.revision !== snapshot.file.revision
        ) {
          setExternalChange(next.revision !== current.current.file.revision);
        } else {
          setFile(next);
          setText(next.content);
          setExternalChange(false);
        }
      } else if (snapshot.file) setExternalChange(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      updating.current = false;
    }
  }, [participant.id]);
  const updated = useCallback(() => {
    void refreshFiles();
  }, [refreshFiles]);
  useEffect(() => {
    if (spritesEnabled && !remote) return;
    void refreshFiles();
    const timer = setInterval(() => void refreshFiles(), 5000);
    return () => clearInterval(timer);
  }, [refreshFiles, spritesEnabled, remote]);
  async function open(path: string) {
    if (dirty && !window.confirm("Discard unsaved edits and open another file?")) return;
    setLoading(true);
    try {
      const next = await api<FileContent>(
        `/workspaces/${participant.id}/file?path=${encodeURIComponent(path)}`,
      );
      setFile(next);
      setText(next.content);
      setExternalChange(false);
      setError("");
      setMessage("");
      setMode(path.endsWith(".csv") ? "data" : "edit");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (spritesEnabled && !remote) return;
    let active = true;
    setLoading(true);
    void api<string[]>(`/workspaces/${participant.id}/files`)
      .then(async (paths) => {
        if (!active) return;
        setFiles(paths);
        const path = paths[0];
        if (path) {
          const next = await api<FileContent>(
            `/workspaces/${participant.id}/file?path=${encodeURIComponent(path)}`,
          );
          if (active) {
            setFile(next);
            setText(next.content);
          }
        }
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [participant.id, spritesEnabled, remote]);
  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!file) return;
    const saved = await api<FileContent>(`/workspaces/${participant.id}/file`, "PUT", {
      path: file.path,
      content: text,
      revision: file.revision,
    });
    setFile(saved);
    setMessage("Saved to your workspace.");
    setExternalChange(false);
    await refreshFiles();
  }
  const csv = useMemo(
    () => Papa.parse<string[]>(text, { skipEmptyLines: true, preview: 501 }),
    [text],
  );
  const lines = csv.data;
  if (spritesEnabled && !remote)
    return (
      <WorkspacePreparation
        participant={participant}
        eventClosed={eventClosed}
        onClose={onClose}
        onChanged={onChanged}
      />
    );
  return (
    <main className="workspace-screen">
      <header className="workspace-header">
        <button
          type="button"
          className="button small"
          onClick={() => {
            if (!dirty || window.confirm("Discard unsaved edits and close?")) onClose();
          }}
        >
          ← Back to teams
        </button>
        <h1>{participant.teamName}</h1>
        <span className="workspace-privacy">Your private workspace</span>
        <Badge tone={pending ? "amber" : "green"}>
          {remote ? "Sprite running" : "Local checkout"}
        </Badge>
        <TeamUpdates
          workspace={participant.id}
          disabled={eventClosed || pending}
          dirty={dirty}
          working={agentWorking}
          refreshKey={teamRefresh}
          completedRequest={completedResolution}
          onBusy={setTeamUpdating}
          onOutgoing={setOutgoing}
          onUpdated={updated}
          onResolve={(request) => {
            setResolutionRequest(request);
            setView("agent");
          }}
        />
        {remote && (
          <EnvironmentControls
            workspace={participant.id}
            disabled={eventClosed || pending}
            dirty={dirty}
            working={agentWorking}
            onResolve={(request) => {
              setResolutionRequest(request);
              setView("agent");
            }}
          />
        )}
      </header>
      {spritesEnabled && !remote && (
        <div className="cloud-setup">
          <Cloud size={20} />
          <div>
            <strong>
              {pending ? "Preparing your cloud workspace" : "Move your project into your Sprite"}
            </strong>
            <p>
              {participant.spriteError ??
                "Your committed team checkout will be copied into a dedicated cloud workspace."}
            </p>
          </div>
          <button
            type="button"
            className="button primary"
            disabled={busy || dirty || pending || eventClosed}
            onClick={() =>
              void action(async () => {
                await api(`/workspaces/${participant.id}/sprite`, "POST");
                await onChanged();
              })
            }
          >
            {pending ? "Preparing…" : "Prepare my Sprite"}
          </button>
        </div>
      )}
      <nav className="workspace-tabs" aria-label="Workspace views">
        {(
          [
            ["files", "Files"],
            ["changes", "Changes"],
            ["agent", "Agent"],
            ["terminal", "Terminal"],
            ["local", "Local folder"],
          ] as const
        ).map(([id, label]) => (
          <button type="button" key={id} aria-pressed={view === id} onClick={() => setView(id)}>
            {label}
            {id === "changes" && changes?.files.length ? ` (${changes.files.length})` : ""}
          </button>
        ))}
      </nav>
      <section
        className="workspace-changes-view"
        aria-label="Changes view"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll region must support keyboard PageDown/End navigation.
        tabIndex={0}
        hidden={view !== "changes"}
      >
        <Changes
          value={changes}
          outgoing={outgoing}
          refresh={updated}
          dirty={dirty}
          workspace={participant.id}
          readOnly={readOnly || busy}
          onShared={async () => {
            setTeamRefresh((value) => value + 1);
            await onChanged();
          }}
          error={changesError}
        />
      </section>
      <section
        className="workspace-local-view"
        aria-label="Local folder sync"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded scroll region needs keyboard scrolling.
        tabIndex={0}
        hidden={view !== "local"}
      >
        <LocalSync
          workspace={participant.id}
          readOnly={eventClosed || pending || teamUpdating}
          dirty={dirty}
          onUpdated={updated}
        />
      </section>
      <Agent
        workspace={participant.id}
        available={remote && !eventClosed}
        visible={view === "agent"}
        dirty={dirty || teamUpdating}
        request={resolutionRequest}
        onWorkingChange={setAgentWorking}
        onRequestSent={() => setResolutionRequest(undefined)}
        onRequestCancelled={() => setResolutionRequest(undefined)}
        onRequestFinished={setCompletedResolution}
        onUpdated={updated}
        onReview={() => setView("changes")}
        onOpenFile={(path) => {
          setView("files");
          void open(path);
        }}
      />
      <Terminal
        workspace={participant.id}
        available={remote && !eventClosed}
        visible={view === "terminal"}
      />
      <div className="workspace-files" hidden={view !== "files"}>
        {externalChange && (
          <p className="auth-pending" role="status">
            This file changed outside the editor. Your text is preserved. Copy any unsaved work,
            then use Reload to get the current version.
          </p>
        )}
        <div className="file-actions" role="toolbar" aria-label="File actions">
          <button
            type="button"
            className="file-action"
            title="New file"
            aria-label="New file"
            disabled={readOnly || busy || dirty}
            onClick={() =>
              void action(async () => {
                const path = window.prompt("New file path, for example src/chart.ts");
                if (!path) return;
                await api(`/workspaces/${participant.id}/blob`, "PUT", {
                  path,
                  data: "",
                  revision: null,
                });
                await refreshFiles();
                await open(path);
              })
            }
          >
            <FilePlus2 size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-action"
            title="Upload file"
            aria-label="Upload file"
            disabled={readOnly || busy}
            onClick={() => uploadInput.current?.click()}
          >
            <Upload size={16} aria-hidden="true" />
          </button>
          <label className="sr-only" htmlFor={`workspace-upload-${participant.id}`}>
            Upload file
          </label>
          <input
            ref={uploadInput}
            id={`workspace-upload-${participant.id}`}
            type="file"
            hidden
            disabled={readOnly || busy}
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = "";
              if (!picked) return;
              void action(async () => {
                if (picked.size > FILE_LIMIT) throw new Error("File exceeds 25 MiB");
                const bytes = new Uint8Array(await picked.arrayBuffer());
                let data = "";
                for (let i = 0; i < bytes.length; i += 8192)
                  data += String.fromCharCode(...bytes.subarray(i, i + 8192));
                await api(`/workspaces/${participant.id}/blob`, "PUT", {
                  path: picked.name,
                  data: btoa(data),
                  revision: null,
                });
                await refreshFiles();
              });
            }}
          />
          <button
            type="button"
            className="file-action"
            title="Download file"
            aria-label="Download file"
            disabled={!file || busy}
            onClick={() =>
              void action(async () => {
                if (!file) return;
                const blob = await api<FileBlob>(
                  `/workspaces/${participant.id}/blob?path=${encodeURIComponent(file.path)}`,
                );
                const url = URL.createObjectURL(
                  new Blob([decode(blob.data) as Uint8Array<ArrayBuffer>]),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = file.path.split("/").pop() ?? "file";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              })
            }
          >
            <Download size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-action"
            title="Reload"
            aria-label="Reload"
            disabled={!file || busy || loading}
            onClick={() => file && void open(file.path)}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-action file-action-save"
            title="Save (⌘S / Ctrl+S)"
            aria-label="Save"
            disabled={!dirty || busy || readOnly}
            onClick={() => void action(save)}
          >
            <Save size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-action file-action-delete"
            title={dirty ? "Save or discard edits before deleting" : "Delete file"}
            aria-label="Delete file"
            disabled={!file || readOnly || busy || dirty}
            onClick={() => {
              const selected = file;
              if (!selected || dirty || !window.confirm(`Delete ${selected.path}?`)) return;
              void action(async () => {
                await api(`/workspaces/${participant.id}/blob`, "PUT", {
                  path: selected.path,
                  data: null,
                  revision: selected.revision,
                });
                setFiles((paths) => paths.filter((path) => path !== selected.path));
                // A response must never clear another file or a newer unsaved buffer.
                const active = current.current;
                if (
                  active.file?.path === selected.path &&
                  active.file.revision === selected.revision &&
                  active.text === selected.content
                ) {
                  current.current = { file: null, text: "" };
                  setFile(null);
                  setText("");
                  setExternalChange(false);
                }
                setMessage(`Deleted ${selected.path}.`);
                await refreshFiles();
              });
            }}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="workspace-layout">
          <FileExplorer
            workspace={participant.id}
            files={files}
            selected={file?.path}
            changes={changes}
            disabled={busy || loading}
            onOpen={(path) => void open(path)}
          />
          <section className="editor-area">
            <div className="editor-toolbar">
              <span>
                {file?.path ?? (loading ? "Loading…" : "No file selected")}
                {dirty && <span className="unsaved"> · Unsaved</span>}
              </span>
              <div className="button-row">
                {file?.path.endsWith(".csv") && (
                  <button
                    type="button"
                    className="button small"
                    onClick={() => setMode(mode === "data" ? "edit" : "data")}
                  >
                    {mode === "data" ? <FileCode2 size={15} /> : <Table2 size={15} />}{" "}
                    {mode === "data" ? "Edit CSV" : "Table view"}
                  </button>
                )}
              </div>
            </div>
            {mode === "data" ? (
              <div className="csv-view">
                <p>CSV preview · first 500 rows. The starter contains fictional sample data.</p>
                {csv.errors.length > 0 && (
                  <p role="alert" className="error">
                    Some CSV rows could not be parsed: {csv.errors[0]?.message}
                  </p>
                )}
                <table>
                  <thead>
                    <tr>
                      {lines[0]?.map((cell, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: Columns in this read-only table have no component state.
                        <th key={`${i}-${cell}`}>{cell}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.slice(1).map((line, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: Read-only CSV rows may be identical; their position is their identity.
                      <tr key={`${i}-${line.join(",")}`}>
                        {line.map((cell, j) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: Read-only cells are identified by column position.
                          <td key={`${j}-${cell}`}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <CodeEditor
                workspace={participant.id}
                path={file?.path ?? "untitled.txt"}
                value={text}
                readOnly={readOnly || busy || !file}
                onChange={setText}
                onSave={() => {
                  if (dirty && !busy && !readOnly) void action(save);
                }}
              />
            )}
          </section>
        </div>
      </div>
      {(error || message) && (
        <div className="workspace-status" role={error ? "alert" : "status"}>
          {error || message}
        </div>
      )}
    </main>
  );
}
