import { Plus } from "lucide-react";
import { useState } from "react";
import type { Event } from "../../../packages/domain/src/types.ts";
import { api } from "./api.ts";
import { Field, Modal } from "./components.tsx";

export function AdminProjects({ event, refresh }: { event: Event; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function create() {
    setBusy(true);
    setError("");
    try {
      await api(`/events/${event.id}/projects`, "POST", { name, brief });
      setOpen(false);
      setName("");
      setBrief("");
      setNotice(`Created ${name.trim()}. Teams can now choose this project.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create project.");
    } finally {
      setBusy(false);
    }
  }
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
          onClick={() => {
            setError("");
            setNotice("");
            setOpen(true);
          }}
        >
          <Plus size={15} /> Create project
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && !open && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <Modal title="Create project" onClose={() => !busy && setOpen(false)}>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <p>Add a brief and data links for teams in {event.name}.</p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Field label="Project name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
                maxLength={100}
                disabled={busy}
              />
            </Field>
            <Field label="Project brief (Markdown)">
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                required
                minLength={20}
                maxLength={10000}
                rows={10}
                disabled={busy}
                aria-describedby="project-brief-help"
              />
            </Field>
            <p id="project-brief-help">New teams receive this brief in PROJECT.md.</p>
            <div className="form-actions">
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={busy || name.trim().length < 2 || brief.trim().length < 20}
              >
                {busy ? "Creating…" : "Create project"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
