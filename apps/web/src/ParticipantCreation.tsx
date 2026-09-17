import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { type EventView, projectInputSchema } from "../../../packages/domain/src/access-types.ts";
import type { Event } from "../../../packages/domain/src/types.ts";
import { api } from "./api.ts";
import { Field, Modal } from "./components.tsx";

export type CreationRequest = {
  kind: "team" | "project";
  eventId: string;
  projectId?: string;
  fallbackProjectId?: string;
  opener?: HTMLElement;
};

export function ParticipantCreation({
  event,
  request,
  onClose,
  onProjectCreated,
  onTeamCreated,
  onDirtyChange,
}: {
  event: EventView;
  request: CreationRequest | null;
  onClose: () => void;
  onProjectCreated: (project: Event["projects"][number]) => void;
  onTeamCreated: (currentRequest: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [mode, setMode] = useState<"team" | "project">("team");
  const [teamName, setTeamName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const mounted = useRef(false);
  const currentRequest = useRef(request);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const opener = useRef<HTMLElement | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const teamInput = useRef<HTMLInputElement>(null);
  const projectSelect = useRef<HTMLSelectElement>(null);
  const guidanceId = useId();
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const returnToProject = useRef(false);
  useEffect(() => {
    if (error) errorMessage.current?.focus();
  }, [error]);
  const allowed =
    event.status === "registration" ||
    event.status === "live" ||
    (event.status === "draft" && event.role === "admin");
  const canJoin = allowed && !event.execution?.paused;
  const dirty = Boolean(name || brief || teamName);
  useEffect(() => {
    onDirtyChange(dirty);
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      onDirtyChange(false);
      window.removeEventListener("beforeunload", guard);
    };
  }, [dirty, onDirtyChange]);
  useLayoutEffect(() => {
    currentRequest.current = request;
    saving.current = false;
    setBusy(false);
    if (!request) {
      opener.current?.focus();
      return;
    }
    returnToProject.current = false;
    opener.current =
      request.opener ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setMode(request.kind);
    setError("");
    setProjectId((current) => request.projectId ?? (current || request.fallbackProjectId || ""));
  }, [request]);
  useEffect(() => {
    if (!request) return;
    if (mode === "project") nameInput.current?.focus();
    else if (returnToProject.current) projectSelect.current?.focus();
    else teamInput.current?.focus();
  }, [mode, request]);
  if (!request) return null;
  function close() {
    if (saving.current) return;
    if (mode === "project" && request?.kind === "team") {
      setMode("team");
      setError("");
      return;
    }
    onClose();
  }
  return (
    <Modal title={mode === "project" ? "Create project" : "Start a team"} onClose={close}>
      <form
        className="form project-editor participant-creation"
        onSubmit={async (e) => {
          e.preventDefault();
          if (saving.current) return;
          setError("");
          if (!allowed || (mode === "team" && !canJoin)) {
            setError("This event is no longer open for this action.");
            return;
          }
          const form = new FormData(e.currentTarget);
          const parsed = projectInputSchema.safeParse({
            name: form.get("projectName"),
            brief: form.get("brief"),
          });
          if (mode === "project" && !parsed.success) {
            setError(parsed.error.issues.map((issue) => issue.message).join(". "));
            return;
          }
          const isCurrent = () => mounted.current && currentRequest.current === request;
          saving.current = true;
          setBusy(true);
          try {
            if (mode === "project" && parsed.success) {
              const created = await api<{ id: string }>(
                `/events/${event.id}/projects`,
                "POST",
                parsed.data,
              );
              onProjectCreated({
                id: created.id,
                name: parsed.data.name,
                description: parsed.data.brief,
                tags: [],
                revision: 0,
              });
              if (!isCurrent()) return;
              setName("");
              setBrief("");
              if (request.kind === "team") {
                setProjectId(created.id);
                setMode("team");
              } else {
                onClose();
              }
            } else {
              if (!event.projects.some((project) => project.id === projectId)) {
                setError("Choose a project from this event.");
                return;
              }
              await api("/teams", "POST", { eventId: event.id, name: form.get("name"), projectId });
              onTeamCreated(isCurrent());
              if (!isCurrent()) return;
              setTeamName("");
              onClose();
            }
          } catch (cause) {
            if (isCurrent())
              setError(
                cause instanceof Error ? cause.message : "Could not save. Please try again.",
              );
          } finally {
            if (isCurrent()) {
              saving.current = false;
              setBusy(false);
            }
          }
        }}
      >
        <div className="project-editor-fields">
          {mode === "project" ? (
            <>
              <p className="form-intro">Add a project for people at this event to explore.</p>
              <Field label="Project title">
                <input
                  ref={nameInput}
                  name="projectName"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  minLength={2}
                  maxLength={100}
                  disabled={busy}
                />
              </Field>
              <p
                id={guidanceId}
                className="project-creation-guidance"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {event.projectBriefGuidance}
              </p>
              <Field label="Project brief (Markdown)">
                <textarea
                  name="brief"
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  required
                  minLength={20}
                  maxLength={10000}
                  rows={7}
                  aria-describedby={guidanceId}
                  disabled={busy}
                />
              </Field>
            </>
          ) : (
            <>
              <p className="form-intro">
                Choose a shared project for your team. You’ll join automatically and get your own
                workspace.
              </p>
              <Field label="Team name">
                <input
                  ref={teamInput}
                  name="name"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  required
                  minLength={2}
                  maxLength={80}
                  disabled={busy}
                />
              </Field>
              <Field label="Project">
                <select
                  ref={projectSelect}
                  value={projectId}
                  required
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.value === "new") {
                      returnToProject.current = true;
                      setError("");
                      setMode("project");
                    } else setProjectId(e.target.value);
                  }}
                >
                  <option value="" disabled>
                    Choose a project
                  </option>
                  {event.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                  <option value="new">New project</option>
                </select>
              </Field>
            </>
          )}
          {!allowed && (
            <p className="error" role="alert">
              This event is no longer open for project creation.
            </p>
          )}
          {error && (
            <p ref={errorMessage} className="error" role="alert" tabIndex={-1}>
              {error}
            </p>
          )}
        </div>
        <div className="form-actions">
          <button type="button" className="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !allowed || (mode === "team" && (!canJoin || !projectId))}
          >
            {busy ? "Saving…" : mode === "project" ? "Create project" : "Create and join team"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
