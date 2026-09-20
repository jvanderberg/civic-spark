import { useCallback, useEffect, useRef, useState } from "react";
import type { Workspace } from "../../../packages/domain/src/access-types.ts";
import { api, apiStatus } from "./api.ts";

const phases = [
  ["bundling", "Preparing the team repository"],
  ["creating", "Creating your personal Sprite"],
  ["checkout", "Copying and checking out the project"],
  ["verifying", "Checking file access"],
] as const;
export function WorkspacePreparation({
  participant,
  eventClosed,
  onClose,
  onChanged,
}: {
  participant: Workspace;
  eventClosed: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [workspace, setWorkspace] = useState(participant);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [waitingSlot, setWaitingSlot] = useState(false);
  const [now, setNow] = useState(Date.now());
  const attempted = useRef(false);
  const busyRetries = useRef(0);
  const busyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (busyTimer.current) clearTimeout(busyTimer.current);
    },
    [],
  );
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const readStatus = useCallback(async () => {
    const next = await api<Workspace>(`/workspaces/${participant.id}/sprite`);
    setWorkspace(next);
    if (next.spriteStatus === "provisioning" || next.spriteStatus === "ready") setError("");
    if (next.spriteStatus === "ready") await changed.current();
    return next;
  }, [participant.id]);
  const start = useCallback(
    async (explicitRetry = false, automatic = false) => {
      const recover = explicitRetry && workspace.preparationAction === "recover-missing";
      if (
        recover &&
        !automatic &&
        !window.confirm(
          "Rebuild from shared work? Only work shared to your team’s Git repository will be restored. Unshared files, commits and workspace history are unavailable if the workspace is missing. Any existing workspace will be preserved.",
        )
      )
        return;
      setStarting(true);
      setError("");
      try {
        await api(
          `/workspaces/${participant.id}/sprite`,
          "POST",
          recover
            ? {
                action: "recover-missing",
                confirmSharedWork: true,
                name: workspace.spriteName,
                generation: workspace.runtime?.generation ?? 0,
              }
            : explicitRetry
              ? {
                  action: "retry-initial-creation",
                  ...(workspace.runtime?.reset ? { generation: workspace.runtime.generation } : {}),
                }
              : undefined,
        );
        await readStatus();
        busyRetries.current = 0;
        setWaitingSlot(false);
      } catch (cause) {
        // The preparation limit answers 429 while other workspaces are being set
        // up. Keep waiting and retry automatically instead of asking the person to.
        if (apiStatus(cause) === 429 && busyRetries.current < 60) {
          busyRetries.current += 1;
          setWaitingSlot(true);
          if (busyTimer.current) clearTimeout(busyTimer.current);
          busyTimer.current = setTimeout(
            () => void start(explicitRetry, true),
            Math.min(20000, 3000 * 2 ** Math.min(busyRetries.current - 1, 3)),
          );
          return;
        }
        busyRetries.current = 0;
        setWaitingSlot(false);
        setError(
          cause instanceof Error
            ? cause.message
            : "Preparation could not start. Retry when connected.",
        );
      } finally {
        setStarting(false);
      }
    },
    [
      participant.id,
      readStatus,
      workspace.preparationAction,
      workspace.spriteName,
      workspace.runtime?.generation,
      workspace.runtime?.reset,
    ],
  );
  useEffect(() => {
    if (!attempted.current && participant.spriteStatus === "local" && !eventClosed) {
      attempted.current = true;
      void start();
    }
  }, [participant.spriteStatus, eventClosed, start]);
  useEffect(() => {
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling || document.hidden) return;
      polling = true;
      try {
        await readStatus();
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Connection lost. Checking again shortly.",
          );
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      setNow(Date.now());
      void poll();
    }, 2000);
    window.addEventListener("online", poll);
    document.addEventListener("visibilitychange", poll);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("online", poll);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [readStatus]);
  const failed = workspace.spriteStatus === "error";
  const running = workspace.spriteStatus === "provisioning" || starting || waitingSlot;
  const index = phases.findIndex(([phase]) => phase === workspace.spritePhase);
  const seconds = workspace.spriteUpdatedAt
    ? Math.max(0, Math.floor((now - Date.parse(workspace.spriteUpdatedAt)) / 1000))
    : 0;
  return (
    <main className="workspace-screen">
      <header className="workspace-header">
        <button type="button" className="button small" onClick={onClose}>
          Back to teams
        </button>
        <h1>{participant.teamName}</h1>
      </header>
      <section className="workspace-preparation" aria-labelledby="preparation-title">
        <h2 id="preparation-title">
          {failed
            ? "Workspace preparation stopped"
            : running
              ? "Preparing your personal workspace"
              : "Start your personal workspace"}
        </h2>
        <p>
          Your project will open here once its files are ready. You can leave this page and return.
        </p>
        <ol aria-label="Workspace preparation progress">
          {phases.map(([phase, label], i) => (
            <li key={phase} data-current={i === index}>
              <span>
                {i < index
                  ? "Done"
                  : i === index
                    ? failed
                      ? "Stopped"
                      : "In progress"
                    : "Waiting"}
              </span>
              {label}
            </li>
          ))}
        </ol>
        {waitingSlot && workspace.spriteStatus !== "provisioning" ? (
          <p role="status">Waiting for a free preparation slot. Retrying automatically.</p>
        ) : (
          running && (
            <p role="status">
              {index >= 0 ? phases[index]?.[1] : "Starting preparation"}
              {seconds > 0 ? ` · ${seconds}s in this step` : ""}
            </p>
          )
        )}
        {running && seconds >= 45 && (
          <p>
            This step is taking longer than usual. We’re still checking its status; any failure will
            appear here.
          </p>
        )}
        {(error || workspace.spriteError) && (
          <p className="error" role="alert">
            {error || workspace.spriteError}
          </p>
        )}
        {eventClosed && (
          <p>This event has ended. Ask an event admin to reopen it before preparing a workspace.</p>
        )}
        {workspace.preparationAction === "recover-missing" && !running && (
          <p>
            Rebuild a missing workspace from your team’s shared Git work. Unshared files, commits
            and workspace history are unavailable. We’ll check that it is missing first; any
            existing workspace will be preserved.
          </p>
        )}
        {(!running || error) && (
          <button
            className="button primary"
            type="button"
            disabled={starting || eventClosed}
            onClick={() => void start(true)}
          >
            {workspace.preparationAction === "recover-missing"
              ? "Rebuild from shared work"
              : failed || error
                ? "Retry preparation"
                : "Start workspace"}
          </button>
        )}
      </section>
    </main>
  );
}
