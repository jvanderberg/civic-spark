import { useEffect, useRef, useState } from "react";
import type { Event, EventSettings } from "../../../packages/domain/src/types.ts";

// Settings never include the project list, so summaries and full events both fit.
type EventDetails = Omit<Event, "projects">;

import { api } from "./api.ts";
import { Field, Modal } from "./components.tsx";

export function eventSettings(event: EventDetails): EventSettings {
  return {
    name: event.name,
    date: event.date,
    timezone: event.timezone,
    location: event.location,
    address: event.address,
    description: event.description,
    startTime: event.startTime,
    endTime: event.endTime,
    capacity: event.capacity,
    budget: event.budget,
    projectBriefGuidance: event.projectBriefGuidance,
    expectedRevision: event.revision,
    schedule: event.schedule.map((row) => ({ ...row, id: row.id ?? crypto.randomUUID() })),
  };
}
export function AdminEventDetails({
  event,
  refresh,
  onDirtyChange,
}: {
  event: EventDetails;
  refresh: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const feedback = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<EventSettings | null>(null);
  const [original, setOriginal] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (error) feedback.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  const dirty = !!draft && JSON.stringify(draft) !== original;
  const stale = !!draft && draft.expectedRevision !== event.revision;
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
  function load() {
    const value = eventSettings(event);
    setDraft(value);
    setOriginal(JSON.stringify(value));
    setError("");
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await api<Event>(`/events/${event.id}`, "PATCH", draft);
      setDraft(null);
      setOpen(false);
      setNotice("Event details saved.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save event details.");
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  function move(index: number, direction: number) {
    if (!draft) return;
    const schedule = [...draft.schedule];
    const row = schedule[index];
    if (!row) return;
    schedule.splice(index, 1);
    schedule.splice(index + direction, 0, row);
    setDraft({ ...draft, schedule });
  }
  return (
    <section className="section">
      <div className="section-heading">
        <div>
          <h2>Event details</h2>
          <p>Update event information and the participant schedule.</p>
        </div>
      </div>
      {notice && <p role="status">{notice}</p>}
      <button
        type="button"
        className="button"
        onClick={() => {
          if (!draft) load();
          setNotice("");
          setOpen(true);
        }}
      >
        {dirty ? "Resume event draft" : "Edit event details"}
      </button>
      {open && draft && (
        <Modal title="Edit event details" onClose={() => !busy && setOpen(false)}>
          <form
            className="form project-editor event-settings"
            onFocusCapture={(e) => {
              if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
                e.target.scrollIntoView({ block: "nearest" });
            }}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="project-editor-fields">
              <div ref={feedback}>
                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
                {stale && (
                  <div role="status">
                    <p>A newer version is available. Your draft has been kept.</p>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Discard this event draft and load the latest saved details?",
                          )
                        )
                          load();
                      }}
                    >
                      Load latest version
                    </button>
                  </div>
                )}
              </div>
              <Field label="Event name">
                <input
                  required
                  minLength={2}
                  maxLength={100}
                  disabled={busy}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <div className="form-grid">
                <Field label="Date">
                  <input
                    type="date"
                    required
                    disabled={busy}
                    value={draft.date}
                    onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                  />
                </Field>
                <Field label="Timezone">
                  <input
                    required
                    maxLength={100}
                    disabled={busy}
                    value={draft.timezone}
                    onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                  />
                </Field>
                <Field label="Start time (optional)">
                  <input
                    type="time"
                    disabled={busy}
                    value={draft.startTime}
                    onChange={(e) => setDraft({ ...draft, startTime: e.target.value })}
                  />
                </Field>
                <Field label="End time (optional)">
                  <input
                    type="time"
                    disabled={busy}
                    value={draft.endTime}
                    onChange={(e) => setDraft({ ...draft, endTime: e.target.value })}
                  />
                </Field>
              </div>
              <p>
                Times use the event date and timezone. End time must follow start time on the same
                date.
              </p>
              <Field label="Venue">
                <input
                  required
                  minLength={2}
                  maxLength={160}
                  disabled={busy}
                  value={draft.location}
                  onChange={(e) => setDraft({ ...draft, location: e.target.value })}
                />
              </Field>
              <Field label="Address">
                <input
                  maxLength={300}
                  disabled={busy}
                  value={draft.address}
                  onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                />
              </Field>
              <Field label="Participant description">
                <textarea
                  rows={4}
                  maxLength={10000}
                  disabled={busy}
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </Field>
              <div className="form-grid">
                <Field label="Participant capacity">
                  <input
                    type="number"
                    required
                    min={1}
                    max={500}
                    disabled={busy}
                    value={draft.capacity}
                    onChange={(e) => setDraft({ ...draft, capacity: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Planned model budget ($)">
                  <input
                    type="number"
                    required
                    min={0}
                    max={10000}
                    step="0.01"
                    disabled={busy}
                    value={draft.budget}
                    onChange={(e) => setDraft({ ...draft, budget: Number(e.target.value) })}
                  />
                </Field>
              </div>
              <Field label="New project guidance">
                <textarea
                  rows={5}
                  maxLength={5000}
                  disabled={busy}
                  value={draft.projectBriefGuidance}
                  onChange={(e) => setDraft({ ...draft, projectBriefGuidance: e.target.value })}
                />
              </Field>
              <h3>Schedule</h3>
              <p>Use 24-hour times (HH:mm) in chronological order, or descriptive labels.</p>
              {draft.schedule.map((row, index) => (
                <fieldset className="schedule-editor-row" key={row.id}>
                  <legend>Entry {index + 1}</legend>
                  <Field label="Title">
                    <input
                      required
                      maxLength={200}
                      disabled={busy}
                      value={row.title}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          schedule: draft.schedule.map((s) =>
                            s.id === row.id ? { ...s, title: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field label="Time or label">
                    <input
                      required
                      maxLength={100}
                      disabled={busy}
                      value={row.time}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          schedule: draft.schedule.map((s) =>
                            s.id === row.id ? { ...s, time: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field label="Details">
                    <textarea
                      rows={2}
                      maxLength={5000}
                      disabled={busy}
                      value={row.description}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          schedule: draft.schedule.map((s) =>
                            s.id === row.id ? { ...s, description: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </Field>
                  <div className="button-row">
                    <button
                      type="button"
                      className="button"
                      disabled={busy || index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={`Move entry ${index + 1} up`}
                    >
                      Move up
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy || index === draft.schedule.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={`Move entry ${index + 1} down`}
                    >
                      Move down
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove schedule entry ${index + 1}? Save event details to apply this change.`,
                          )
                        )
                          setDraft({
                            ...draft,
                            schedule: draft.schedule.filter((s) => s.id !== row.id),
                          });
                      }}
                      aria-label={`Remove entry ${index + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                </fieldset>
              ))}
              <button
                type="button"
                className="button"
                disabled={busy || draft.schedule.length >= 100}
                onClick={() =>
                  setDraft({
                    ...draft,
                    schedule: [
                      ...draft.schedule,
                      { id: crypto.randomUUID(), title: "", time: "", description: "" },
                    ],
                  })
                }
              >
                Add schedule entry
              </button>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Close
              </button>
              <button type="submit" className="button primary" disabled={busy || !dirty}>
                {busy ? "Saving…" : "Save event details"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
