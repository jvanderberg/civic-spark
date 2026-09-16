import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Identity } from "../packages/domain/src/access-types.ts";
import { EventService } from "../packages/domain/src/service.ts";
import type { Result } from "../packages/domain/src/types.ts";

const admin: Identity = {
  id: "admin",
  name: "Organizer",
  email: "admin@example.test",
  emailVerified: true,
};
const alice: Identity = {
  id: "alice",
  name: "Alice",
  email: "alice@example.test",
  emailVerified: true,
};
const bob: Identity = { id: "bob", name: "Bob", email: "bob@example.test", emailVerified: true };
const opened: { root: string; service: EventService }[] = [];
function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
function setup(capacity = 40) {
  const root = mkdtempSync(join(tmpdir(), "vibehack-members-"));
  const service = new EventService(root);
  opened.push({ root, service });
  const event = value(
    service.createEvent(admin, {
      name: "Our event",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity,
      budget: 20,
      templateId: "blank",
    }),
  );
  return { root, service, event };
}
afterEach(() => {
  for (const { root, service } of opened.splice(0)) {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("assigns the creator admin, hides drafts, and prevents privilege escalation or last-admin removal", () => {
  const { service, event } = setup();
  expect(service.portal(admin, false).events[0]?.role).toBe("admin");
  expect(service.portal(alice, false).events).toHaveLength(0);
  expect(service.transition(alice, event.id, "registration")).toMatchObject({
    ok: false,
    status: 403,
  });
  expect(service.setRole(admin, event.id, admin.id, "member")).toMatchObject({
    ok: false,
    status: 409,
  });
  value(service.transition(admin, event.id, "registration"));
  const { team } = value(
    service.createTeam(alice, { eventId: event.id, name: "Crew", projectId: "data-starter" }),
  );
  value(service.setRole(admin, event.id, alice.id, "admin"));
  expect(service.portal(alice, false).events[0]?.role).toBe("admin");
  value(service.setRole(alice, event.id, admin.id, "member"));
  expect(service.removeMember(admin, team.id, alice.id)).toMatchObject({ ok: false, status: 403 });
});
it("counts people once across teams and creates independent membership workspaces", () => {
  const { service, event } = setup(1);
  value(service.transition(admin, event.id, "registration"));
  const first = value(
    service.createTeam(alice, { eventId: event.id, name: "One", projectId: "data-starter" }),
  );
  const second = value(
    service.createTeam(alice, { eventId: event.id, name: "Two", projectId: "data-starter" }),
  );
  expect(first.workspace.id).not.toBe(second.workspace.id);
  expect(service.portal(alice, false).myWorkspaces).toHaveLength(2);
  expect(value(service.joinTeam(alice, first.team.id)).id).toBe(first.workspace.id);
  expect(service.joinTeam(bob, first.team.id)).toMatchObject({ ok: false, status: 409 });
});
it("separates private files from admin overview and revokes removed memberships without deleting work", () => {
  const { service, event } = setup();
  value(service.transition(admin, event.id, "registration"));
  const { team, workspace } = value(
    service.createTeam(alice, { eventId: event.id, name: "Crew", projectId: "data-starter" }),
  );
  value(service.joinTeam(bob, team.id));
  const file = value(service.readFile(alice, workspace.id, "README.md"));
  value(service.saveFile(alice, workspace.id, "README.md", "Private draft", file.revision));
  expect(service.readFile(admin, workspace.id, "README.md")).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(service.readFile(bob, workspace.id, "README.md")).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(service.portal(admin, false).myWorkspaces).toHaveLength(0);
  expect(JSON.stringify(service.portal(bob, false))).not.toContain(alice.email);
  value(service.removeMember(admin, team.id, alice.id));
  expect(service.readFile(alice, workspace.id, "README.md")).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(service.portal(alice, false).myWorkspaces).toHaveLength(0);
  value(service.joinTeam(alice, team.id));
  expect(value(service.readFile(alice, workspace.id, "README.md")).content).toBe("Private draft");
});
it("saves a custom project brief into the checked-out team repository and rejects late joins", () => {
  const { service, event } = setup();
  value(service.transition(admin, event.id, "registration"));
  const brief = "Explore bus stops near libraries and build a useful neighborhood map.";
  const { workspace, team } = value(
    service.createTeam(alice, {
      eventId: event.id,
      name: "Map crew",
      customProject: { name: "Library connections", brief },
    }),
  );
  expect(value(service.readFile(alice, workspace.id, "PROJECT.md")).content).toContain(brief);
  value(service.transition(admin, event.id, "live"));
  value(service.transition(admin, event.id, "closed"));
  expect(service.joinTeam(bob, team.id).ok).toBe(false);
  expect(service.saveFile(alice, workspace.id, "README.md", "late", "old").ok).toBe(false);
});

it("adds an already signed-in admin by verified email without requiring a team", () => {
  const { service, event } = setup();
  service.portal(bob, false);
  expect(service.addAdmin(alice, event.id, bob.email)).toMatchObject({ ok: false, status: 403 });
  value(service.addAdmin(admin, event.id, bob.email));
  expect(service.portal(bob, false).events[0]?.role).toBe("admin");
  expect(service.portal(bob, false).myWorkspaces).toHaveLength(0);
});
