import { useEffect, useState } from "react";
import type { Event } from "../../../packages/domain/src/types.ts";
import { api } from "./api.ts";
import { ProjectBrief } from "./ProjectBrief.tsx";

// Briefs are fetched once per project revision and shared across every card
// and team that shows the same project.
const briefs = new Map<string, Promise<string>>();
export function loadProjectBrief(eventId: string, projectId: string, revision?: number) {
  const key = `${eventId}:${projectId}:${revision ?? "current"}`;
  let pending = briefs.get(key);
  if (!pending) {
    pending = api<Event["projects"][number]>(`/events/${eventId}/projects/${projectId}`).then(
      (project) => project.description,
    );
    pending.catch(() => briefs.delete(key));
    briefs.set(key, pending);
  }
  return pending;
}
export function ProjectBriefLoader({
  eventId,
  projectId,
  revision,
}: {
  eventId: string;
  projectId: string;
  revision?: number;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setMarkdown(null);
    setFailed(false);
    loadProjectBrief(eventId, projectId, revision)
      .then((text) => {
        if (active) setMarkdown(text);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [eventId, projectId, revision]);
  if (failed) return <p className="project-brief-status">Brief unavailable. Refresh to retry.</p>;
  if (markdown === null) return <p className="project-brief-status">Loading brief…</p>;
  return <ProjectBrief markdown={markdown} />;
}
