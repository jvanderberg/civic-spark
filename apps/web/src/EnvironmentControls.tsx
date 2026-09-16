import { ExternalLink, Play, RotateCw, Square, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import type { ResolutionRequest } from "./TeamUpdates.tsx";
import "./environment.css";

type Preview = { port: number; command: string[]; running: boolean; ready: boolean; logs?: string };
type Pending = {
  id: string;
  head: string;
  remote: string;
  conflicts: string[];
  status: "confirmation" | "resolving" | "declined";
};
export function EnvironmentControls({
  workspace,
  disabled,
  dirty,
  working,
  onResolve,
}: {
  workspace: string;
  disabled: boolean;
  dirty: boolean;
  working: boolean;
  onResolve: (request: ResolutionRequest) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    if (document.hidden) return;
    const result = await api<{ pending: Pending | null }>(`/workspaces/${workspace}/agent-git`);
    setPending(result.pending);
    try {
      setPreview(await api<Preview>(`/workspaces/${workspace}/preview`));
    } catch {
      /* No runtime configuration exists before the first preparation. Launch reports errors. */
    }
  }, [workspace]);
  useEffect(() => {
    if (disabled) return;
    void refresh().catch(() => undefined);
    const timer = setInterval(() => void refresh().catch(() => undefined), 10000);
    return () => clearInterval(timer);
  }, [disabled, refresh]);
  async function action(name: "start" | "restart" | "stop" | "logs" | "open") {
    setBusy(true);
    setError("");
    const popup = name === "open" ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    try {
      if (name === "open") {
        const result = await api<{ url: string }>(`/workspaces/${workspace}/preview`, "POST", {
          action: name,
        });
        if (popup) popup.location.replace(result.url);
        else throw new Error("Allow this site's popup to open the preview.");
      } else if (name === "logs") {
        setPreview(await api<Preview>(`/workspaces/${workspace}/preview?logs=1`));
        setDetails(true);
      } else {
        const result = await api<Preview>(`/workspaces/${workspace}/preview`, "POST", {
          action: name,
        });
        setPreview(result);
        if (name !== "stop" && !result.ready) {
          setError("The server has not responded yet. Check its logs.");
          setDetails(true);
        }
      }
    } catch (e) {
      popup?.close();
      setError(e instanceof Error ? e.message : "Web server action failed");
      setDetails(true);
    } finally {
      setBusy(false);
    }
  }
  async function confirm(allow: boolean) {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      await api(`/workspaces/${workspace}/agent-git/confirm`, "POST", { id: pending.id, allow });
      if (allow)
        onResolve({
          id: `publish-${pending.id}`,
          prompt:
            "I explicitly approve resolving the pending agent-publication rebase conflicts. Run vibehack git status to inspect the approved request. The controlled integration has begun the rebase and created a recovery reference. Reconcile both sides' intent, preserving unrelated work. Stage resolved paths and run GIT_EDITOR=true git rebase --continue until complete; run appropriate checks, summarize the resolved result, and ask me before publishing. This approval is for conflict resolution only. Run vibehack git publish only after I explicitly confirm publication of the resolved changes. Do not force push or discard either side wholesale. If unsafe or ambiguous, keep recovery intact and ask me.",
        });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conflict confirmation failed");
      setDetails(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="environment-controls">
      <button
        type="button"
        className="button small"
        disabled={disabled || busy}
        onClick={() => void action(preview?.running ? "restart" : "start")}
        title={preview?.command.join(" ") ?? "Launch the configured project web server"}
      >
        {preview?.running ? <RotateCw size={14} /> : <Play size={14} />}
        {busy ? "Working…" : preview?.running ? "Restart" : "Launch"}
      </button>
      {preview?.ready && (
        <button
          type="button"
          className="button small"
          disabled={busy}
          onClick={() => void action("open")}
        >
          <ExternalLink size={14} />
          Open preview
        </button>
      )}
      <button
        type="button"
        className="button small icon-button"
        aria-label="Web server details"
        title="Web server details"
        onClick={() => {
          setDetails(!details);
          if (!details) void action("logs");
        }}
      >
        <TerminalSquare size={15} />
      </button>
      {pending?.status === "confirmation" && (
        <button type="button" className="button small" onClick={() => setDetails(true)}>
          Confirm conflict resolution
        </button>
      )}
      {details && (
        <section className="environment-popover" aria-label="Web server and publishing">
          <div className="environment-heading">
            <strong>
              Web server
              {preview
                ? ` · ${preview.ready ? "Ready" : preview.running ? "Starting" : "Stopped"} · ${preview.port}`
                : ""}
            </strong>
            <button type="button" className="button small" onClick={() => setDetails(false)}>
              Close
            </button>
          </div>
          {preview && <code>{preview.command.join(" ")}</code>}
          <div className="environment-actions">
            <button
              type="button"
              className="button small"
              disabled={busy || !preview?.running}
              onClick={() => void action("stop")}
            >
              <Square size={12} />
              Stop
            </button>
            <button
              type="button"
              className="button small"
              disabled={busy}
              onClick={() => void action("logs")}
            >
              Refresh logs
            </button>
          </div>
          {pending?.status === "confirmation" && (
            <div className="environment-conflict">
              <strong>Allow the agent to resolve team conflicts?</strong>
              <p>
                Your checkout has not changed. Approval starts a recoverable rebase, then lets the
                agent resolve and publish.
              </p>
              {pending.conflicts.length > 0 && (
                <ul>
                  {pending.conflicts.slice(0, 20).map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              )}
              <div className="environment-actions">
                <button
                  type="button"
                  className="button primary small"
                  disabled={busy || dirty || working}
                  onClick={() => void confirm(true)}
                >
                  Resolve with agent
                </button>
                <button
                  type="button"
                  className="button small"
                  disabled={busy}
                  onClick={() => void confirm(false)}
                >
                  Decline
                </button>
              </div>
              {(dirty || working) && (
                <p>Save your file and wait for the current agent turn to finish first.</p>
              )}
            </div>
          )}
          {pending?.status === "resolving" && (
            <p>Conflict resolution approved. Continue the rebase in Agent, then publish.</p>
          )}
          {error && <p role="alert">{error}</p>}
          {preview?.logs && <pre>{preview.logs}</pre>}
        </section>
      )}
    </div>
  );
}
