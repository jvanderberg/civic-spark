import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceEngine as EventService } from "../packages/domain/src/engine.ts";
import { createEventSchema, type Result } from "../packages/domain/src/types.ts";

const dirs: string[] = [];
const services: EventService[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "vibehack-test-"));
  dirs.push(dir);
  const service = new EventService(dir);
  services.push(service);
  return { service, dir };
}
function value<T>(result: Result<T>) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
const input = {
  name: "Community lab",
  date: "2026-10-03",
  timezone: "America/Chicago",
  location: "Library",
  capacity: 2,
  budget: 10,
  templateId: "blank" as const,
};
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("event lifecycle", () => {
  it("creates a genuinely empty event and persists it across service restarts", () => {
    const { service, dir } = setup();
    const event = value(service.createEvent(input));
    expect(service.snapshot().participants).toHaveLength(0);
    service.close();
    services.splice(services.indexOf(service), 1);
    const restored = new EventService(dir);
    services.push(restored);
    expect(restored.snapshot().events[0]?.id).toBe(event.id);
  });
  it("rejects invalid dates and prevents skipping lifecycle transitions", () => {
    expect(createEventSchema.safeParse({ ...input, date: "2026-02-31" }).success).toBe(false);
    const { service } = setup();
    const event = value(service.createEvent(input));
    expect(service.transition(event.id, "closed").ok).toBe(false);
    expect(service.transition(event.id, "registration").ok).toBe(true);
    expect(service.transition(event.id, "live").ok).toBe(true);
  });
  it("enforces capacity, validates project ownership, and closes registration", () => {
    const { service } = setup();
    const e = value(service.createEvent(input));
    expect(service.createTeam(e.id, "Wrong", "missing").ok).toBe(false);
    const t = value(service.createTeam(e.id, "Team", "data-starter"));
    value(service.addParticipant(t.id, "Alice"));
    value(service.addParticipant(t.id, "Bob"));
    expect(service.addParticipant(t.id, "Cara").ok).toBe(false);
    value(service.transition(e.id, "registration"));
    value(service.transition(e.id, "live"));
    value(service.transition(e.id, "closed"));
    expect(service.createTeam(e.id, "Late", "data-starter").ok).toBe(false);
  });
});

describe("workspace revisions and Git collaboration", () => {
  function team() {
    const context = setup();
    const e = value(context.service.createEvent(input));
    const t = value(context.service.createTeam(e.id, "Data crew", "data-starter"));
    const a = value(context.service.addParticipant(t.id, "Alice"));
    const b = value(context.service.addParticipant(t.id, "Bob"));
    return { ...context, e, t, a, b };
  }
  it("rejects stale saves, traversal, hidden files, and symlink escape", () => {
    const { service, dir, a } = team();
    const original = value(service.readFile(a.id, "README.md"));
    value(service.saveFile(a.id, "README.md", "Alice edit", original.revision));
    expect(service.saveFile(a.id, "README.md", "stale", original.revision)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(service.readFile(a.id, "../state.sqlite").ok).toBe(false);
    expect(service.readFile(a.id, ".git/config").ok).toBe(false);
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "private");
    symlinkSync(outside, join(service.workspacePath(a.id), "escape.txt"));
    expect(service.readFile(a.id, "escape.txt").ok).toBe(false);
  });
  it("shares immutable commits, detects a conflict, and preserves the accepted version", () => {
    const { service, t, a, b } = team();
    const originalA = value(service.readFile(a.id, "README.md"));
    const originalB = value(service.readFile(b.id, "README.md"));
    value(service.saveFile(a.id, "README.md", "Alice's version\n", originalA.revision));
    const proposalA = value(service.propose(a.id, "Alice update"));
    value(service.accept(proposalA.id));
    value(service.saveFile(b.id, "README.md", "Bob's version\n", originalB.revision));
    const proposalB = value(service.propose(b.id, "Bob update"));
    expect(service.accept(proposalB.id)).toMatchObject({ ok: false, status: 409 });
    expect(service.teamFile(t.id, "README.md")).toContain("Alice's version");
    expect(value(service.readFile(b.id, "README.md")).content).toContain("Bob's version");
  });
  it("exports accepted code as a ZIP and rejects saving once a Sprite owns the workspace", () => {
    const { service, t, a } = team();
    expect(value(service.exportTeam(t.id)).subarray(0, 2).toString()).toBe("PK");
    value(service.setSprite(a.id, "vibehack-test", "ready", null));
    expect(service.saveFile(a.id, "README.md", "x", "old").ok).toBe(false);
  });
});
