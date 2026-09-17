import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Event } from "../../../packages/domain/src/types.ts";
import { api } from "./api.ts";
import { Field, Modal } from "./components.tsx";
import { ProjectBrief } from "./ProjectBrief.tsx";

type Project = Event["projects"][number];
type Draft = {
  id: string | null;
  name: string;
  brief: string;
  revision: number;
  originalName: string;
  originalBrief: string;
};
export function AdminProjects({
  event,
  refresh,
  onDirtyChange,
}: {
  event: Event;
  refresh: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty =
    !!draft && (draft.name !== draft.originalName || draft.brief !== draft.originalBrief);
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
  function edit(project?: Project) {
    if (draft && draft.id === (project?.id ?? null)) {
      setOpen(true);
      return;
    }
    if (dirty && !window.confirm("Discard your unsaved project draft and open another project?"))
      return;
    setDraft({
      id: project?.id ?? null,
      name: project?.name ?? "",
      brief: project?.description ?? "",
      revision: project?.revision ?? 0,
      originalName: project?.name ?? "",
      originalBrief: project?.description ?? "",
    });
    setError("");
    setNotice("");
    setOpen(true);
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/events/${event.id}/projects${draft.id ? `/${draft.id}` : ""}`,
        draft.id ? "PATCH" : "POST",
        {
          name: draft.name,
          brief: draft.brief,
          ...(draft.id ? { expectedRevision: draft.revision } : {}),
        },
      );
      setNotice(`${draft.id ? "Saved" : "Created"} ${draft.name.trim()}.`);
      setDraft(null);
      setOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save project.");
    } finally {
      setBusy(false);
    }
  }
  const latest = event.projects.find((p) => p.id === draft?.id);
  const stale = !!latest && (latest.revision ?? 0) !== draft?.revision;
  return (
    <section className="section">
      <div className="section-heading">
        <div>
          <h2>Projects</h2>
          <p>{event.projects.length} projects available to teams.</p>
        </div>
        <button
          type="button"
          className="button"
          disabled={event.status === "closed"}
          onClick={() => edit()}
        >
          <Plus size={15} /> Create project
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {draft && !open && (
        <button type="button" className="button" onClick={() => setOpen(true)}>
          Resume project draft
        </button>
      )}
      <div className="project-grid">
        {event.projects.map((project) => (
          <article className="project-card" key={project.id}>
            <h3>{project.name}</h3>
            <ProjectBrief markdown={project.description} />
            <footer>
              <button
                type="button"
                className="button"
                disabled={event.status === "closed"}
                onClick={() => edit(project)}
              >
                Edit project
              </button>
            </footer>
          </article>
        ))}
      </div>
      {open && draft && (
        <Modal
          title={draft.id ? "Edit project" : "Create project"}
          onClose={() => !busy && setOpen(false)}
        >
          <form
            className="form project-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="project-editor-fields">
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              {stale && (
                <div role="status">
                  <p>A newer version is available. Your draft has been kept.</p>
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      if (!window.confirm("Discard this draft and load the latest saved project?"))
                        return;
                      setDraft({
                        id: latest.id,
                        name: latest.name,
                        brief: latest.description,
                        revision: latest.revision ?? 0,
                        originalName: latest.name,
                        originalBrief: latest.description,
                      });
                      setError("");
                    }}
                  >
                    Load latest version
                  </button>
                </div>
              )}
              <Field label="Project name">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  required
                  minLength={2}
                  maxLength={100}
                  disabled={busy}
                />
              </Field>
              <Field label="Project brief (Markdown)">
                <textarea
                  value={draft.brief}
                  onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
                  required
                  minLength={20}
                  maxLength={10000}
                  rows={10}
                  disabled={busy}
                />
              </Field>
            </div>
            <div className="form-actions">
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Close
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={
                  busy ||
                  event.status === "closed" ||
                  draft.name.trim().length < 2 ||
                  draft.brief.trim().length < 20
                }
              >
                {busy ? "Saving…" : draft.id ? "Save project" : "Create project"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
