import "./team-updates.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { useWorkspaceEvents } from "./workspace-events.ts";

type TeamStatus = {
  head: string;
  remote: string;
  incoming: boolean;
  outgoing?: boolean;
  agentWorking?: boolean;
  dirty: boolean;
  merging: boolean;
  conflicts: string[];
  resolution?: { head: string; remote: string };
};
type Update = Pick<TeamStatus, "head" | "remote"> & {
  status: "updated" | "conflict" | "agent";
  conflicts: string[];
  backup?: string;
  prompt?: string;
};
export type ResolutionRequest = { id: string; prompt: string };

export function TeamUpdates({
  workspace,
  disabled,
  dirty,
  working,
  refreshKey,
  completedRequest,
  onResolve,
  onUpdated,
  onBusy,
  onOutgoing,
}: {
  workspace: string;
  disabled: boolean;
  dirty: boolean;
  working: boolean;
  refreshKey: number;
  completedRequest: string | null;
  onResolve: (request: ResolutionRequest) => void;
  onUpdated: () => void;
  onBusy: (busy: boolean) => void;
  onOutgoing: (outgoing: boolean) => void;
}) {
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkError, setCheckError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<Update | null>(null);
  const polling = useRef(false);
  const resolution = useRef<{ id: string; head: string; remote: string } | null>(null);
  const lastCompleted = useRef<string | null>(null);
  const poll = useCallback(
    async (fresh = false) => {
      if (polling.current || document.hidden) return;
      polling.current = true;
      try {
        const next = await api<TeamStatus>(
          `/workspaces/${workspace}/team-status${fresh ? "?fresh=1" : ""}`,
        );
        setStatus(next);
        setCheckError("");
        onOutgoing(next.outgoing ?? false);
      } catch (e) {
        setCheckError(e instanceof Error ? e.message : "Could not check team updates.");
      } finally {
        polling.current = false;
      }
    },
    [workspace, onOutgoing],
  );
  // The server announces team repository changes, updates and finished agent
  // turns; the timer is a slow safety net while that channel is connected.
  const connected = useWorkspaceEvents(workspace, !disabled, (signal) => {
    if (signal === "team" || signal === "resync") void poll();
  });
  useEffect(() => {
    // Sharing or an agent edit prompts an immediate check in addition to the timer.
    void refreshKey;
    if (!disabled) void poll();
  }, [disabled, poll, refreshKey]);
  useEffect(() => {
    if (disabled) return;
    const timer = setInterval(() => void poll(), connected ? 120000 : 15000);
    return () => clearInterval(timer);
  }, [disabled, poll, connected]);
  const verify = useCallback(
    async (expected: { head: string; remote: string }) => {
      setBusy(true);
      onBusy(true);
      try {
        await api(`/workspaces/${workspace}/team-update/verify`, "POST", expected);
        resolution.current = null;
        setConflict(null);
        setNotice("Team updates merged locally. Review the changes, then Share when ready.");
        setError("");
        onUpdated();
      } catch (e) {
        setOpen(true);
        setError(
          e instanceof Error ? e.message : "The agent has not finished resolving the update.",
        );
      } finally {
        setBusy(false);
        onBusy(false);
        void poll();
      }
    },
    [workspace, onBusy, onUpdated, poll],
  );
  useEffect(() => {
    if (!completedRequest || completedRequest === lastCompleted.current) return;
    lastCompleted.current = completedRequest;
    const current = resolution.current;
    if (current?.id === completedRequest)
      void verify({ head: current.head, remote: current.remote });
  }, [completedRequest, verify]);

  async function update(mode: "pull" | "agent" | "replace") {
    if (disabled || dirty || working || status?.agentWorking || busy || !status) return;
    const expected = status.resolution ?? conflict ?? status;
    if (
      mode === "replace" &&
      !window.confirm(
        "Replace your project files with the team version? Your current commits and saved files will be backed up in this workspace first. Unsaved terminal or external-editor buffers are not included.",
      )
    )
      return;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    let request: ResolutionRequest | undefined;
    try {
      const result = await api<Update>(`/workspaces/${workspace}/team-update`, "POST", {
        head: expected.head,
        remote: expected.remote,
        mode,
      });
      if (result.status === "conflict") {
        setConflict(result);
        setOpen(true);
      } else if (result.status === "agent" && result.prompt) {
        const id = crypto.randomUUID();
        resolution.current = { id, head: expected.head, remote: expected.remote };
        setConflict(result);
        setOpen(false);
        request = { id, prompt: result.prompt };
      } else {
        setConflict(null);
        setNotice(
          result.backup
            ? `Team version loaded. Your previous work is saved at ${result.backup}.`
            : "Team updates loaded into your workspace.",
        );
        onUpdated();
      }
      await poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not get team updates.");
      setConflict(null);
      await poll(true);
    } finally {
      setBusy(false);
      onBusy(false);
      if (request) onResolve(request);
    }
  }
  const blocked = disabled || busy || dirty || working || status?.agentWorking;
  const conflicted = Boolean(conflict || status?.merging || status?.resolution);
  return (
    <div className="team-updates">
      <button
        type="button"
        className={`button small${status?.incoming || conflicted ? " primary" : ""}`}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          void poll(true);
        }}
      >
        {busy
          ? "Getting updates…"
          : conflicted
            ? "Resolve team updates"
            : status?.incoming
              ? "Team updates available"
              : error || checkError
                ? "Check team updates"
                : "Team updates"}
      </button>
      {open && (
        <section className="team-updates-menu" aria-label="Team updates">
          <strong>{conflicted ? "Some changes overlap" : "Team updates"}</strong>
          {(error || checkError) && (
            <p role="alert" className="error">
              {error || checkError}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {!status && !error && !checkError && <p role="status">Checking the shared repository…</p>}
          {dirty && <p>Save your browser edits before getting updates.</p>}
          {(working || status?.agentWorking) && (
            <p>Wait for your agent to finish before getting updates.</p>
          )}
          {conflicted ? (
            <>
              <p>
                Let your selected agent combine your work with the team’s changes. Review its result
                before sharing.
              </p>
              {status?.resolution && !status.merging && (
                <button
                  type="button"
                  className="button"
                  disabled={blocked}
                  onClick={() => {
                    if (status.resolution) void verify(status.resolution);
                  }}
                >
                  Check agent result
                </button>
              )}
              <div className="button-row">
                <button
                  type="button"
                  className="button primary"
                  disabled={blocked}
                  onClick={() => void update("agent")}
                >
                  Resolve with agent
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={blocked}
                  onClick={() => void update("replace")}
                >
                  Use team version
                </button>
              </div>
            </>
          ) : status?.incoming ? (
            <>
              <p>There are newer commits in the shared team repository.</p>
              {status.dirty && (
                <p>
                  Use Share to commit your saved edits first. If the push needs these updates, your
                  local commit stays safe; return here to get updates.
                </p>
              )}
              <button
                type="button"
                className="button primary"
                disabled={blocked || status.dirty}
                onClick={() => void update("pull")}
              >
                Get updates
              </button>
            </>
          ) : status ? (
            <p>Your workspace includes the latest team commits.</p>
          ) : null}
          <button type="button" className="button small" onClick={() => setOpen(false)}>
            Later
          </button>
        </section>
      )}
    </div>
  );
}
