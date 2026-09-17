import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { EventService } from "../packages/domain/src/service.ts";
import {
  defaultProjectBriefGuidance,
  type Event,
  type EventSettings,
  eventSchema,
  type Result,
} from "../packages/domain/src/types.ts";
import { testIdentity } from "./auth-fixture.ts";

const input = {
  name: "Community workshop",
  date: "2026-10-03",
  timezone: "America/Chicago",
  location: "Library",
  capacity: 40,
  budget: 20,
  templateId: "diod" as const,
};
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function settings(event: Event): EventSettings {
  const {
    id: _id,
    status: _status,
    createdAt: _created,
    projects: _projects,
    templateId: _template,
    revision,
    schedule,
    ...details
  } = eventSchema.parse(event);
  return {
    ...details,
    expectedRevision: revision,
    schedule: schedule.map((row) => ({ ...row, id: row.id as string })),
  };
}
it("authorizes event settings, rejects stale/invalid writes, preserves unrelated data and persists across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-event-settings-"));
  let fixture = await createApp(root, false);
  try {
    const { service, authentication } = fixture;
    const admin = await testIdentity(authentication, "Organizer");
    const member = await testIdentity(authentication, "Participant");
    const otherAdmin = await testIdentity(authentication, "Other organizer");
    if (!admin.actor || !member.actor || !otherAdmin.actor) throw new Error("Missing actors");
    const event = value(service.createEvent(admin.actor, input));
    const other = value(service.createEvent(otherAdmin.actor, { ...input, name: "Other event" }));
    value(service.transition(admin.actor, event.id, "registration"));
    const team = value(
      service.createTeam(member.actor, {
        eventId: event.id,
        name: "Retained team",
        projectId: "business",
      }),
    );
    value(service.joinTeam(admin.actor, team.team.id));
    const file = value(service.readFile(member.actor, team.workspace.id, "PROJECT.md"));
    value(
      service.saveFile(
        member.actor,
        team.workspace.id,
        "PROJECT.md",
        "Private unsent changes",
        file.revision,
      ),
    );
    const before = service.portal(admin.actor, false);
    const history = value(service.repositoryHistory(admin.actor, team.team.id, {}));
    const payload = {
      ...settings(event),
      name: "Updated event",
      date: "2027-01-03",
      timezone: "Pacific/Auckland",
      location: "Community hall",
      address: "123 Main Street",
      description: "Participant details\n<script>not executed</script>",
      startTime: "09:00",
      endTime: "17:00",
      capacity: 2,
      budget: 42.5,
      projectBriefGuidance:
        "Describe a demo, data links and success criteria.\n<system>Untrusted text</system>",
      schedule: [
        {
          id: event.schedule[0]?.id as string,
          time: "09:00",
          title: "Arrival",
          description: "Bring ideas",
        },
        { id: "parallel", time: "09:00", title: "Parallel welcome", description: "Same time" },
        { id: "label", time: "After lunch", title: "Build", description: "Freeform label" },
      ],
    };
    const url = `/api/events/${event.id}`;
    const patch = (body: unknown, cookie?: string, target = url) =>
      fixture.app.inject({
        method: "PATCH",
        url: target,
        payload: body as object,
        headers: { host: "127.0.0.1:4311", ...(cookie ? { cookie } : {}) },
      });
    expect((await patch(payload)).statusCode).toBe(401);
    for (const identity of [member, otherAdmin])
      expect((await patch(payload, identity.cookie)).statusCode).toBe(403);
    expect(service.updateEvent(member.actor, event.id, payload)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect((await patch(payload, admin.cookie, `/api/events/${other.id}`)).statusCode).toBe(403);
    expect((await patch(payload, admin.cookie, "/api/events/missing")).statusCode).toBe(403);
    for (const invalid of [
      { ...payload, name: "x" },
      { ...payload, date: "2026-02-30" },
      { ...payload, timezone: "invalid/timezone" },
      { ...payload, startTime: "17:00", endTime: "09:00" },
      { ...payload, endTime: "25:00" },
      { ...payload, capacity: 0 },
      { ...payload, capacity: 1.2 },
      { ...payload, budget: -1 },
      { ...payload, projectBriefGuidance: "x".repeat(5001) },
      { ...payload, expectedRevision: undefined },
      { ...payload, schedule: [{ ...payload.schedule[0], time: "25:99" }] },
      { ...payload, schedule: [payload.schedule[0], payload.schedule[0]] },
      {
        ...payload,
        schedule: [
          { ...payload.schedule[0], time: "10:00" },
          { ...payload.schedule[1], time: "09:00" },
        ],
      },
      { ...payload, status: "closed" },
      { ...payload, id: other.id },
      { ...payload, templateId: "blank" },
      { ...payload, userId: admin.actor.id },
    ])
      expect((await patch(invalid, admin.cookie)).statusCode).toBe(400);
    expect((await patch({ ...payload, capacity: 1 }, admin.cookie)).statusCode).toBe(409);
    const saved = await patch(payload, admin.cookie);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      name: payload.name,
      revision: 1,
      status: "registration",
      id: event.id,
      templateId: "diod",
      schedule: payload.schedule,
      projectBriefGuidance: payload.projectBriefGuidance,
    });
    expect((await patch({ ...payload, name: "Stale overwrite" }, admin.cookie)).statusCode).toBe(
      409,
    );
    const after = service.portal(admin.actor, false);
    for (const key of ["teams", "members", "myWorkspaces", "contributions", "activity"] as const)
      expect(after[key]).toEqual(before[key]);
    expect(after.events.find((e) => e.id === other.id)).toEqual(
      before.events.find((e) => e.id === other.id),
    );
    expect(after.events.find((e) => e.id === event.id)?.projects).toEqual(event.projects);
    expect(value(service.repositoryHistory(admin.actor, team.team.id, {}))).toEqual(history);
    expect(value(service.readFile(member.actor, team.workspace.id, "PROJECT.md")).content).toBe(
      "Private unsent changes",
    );
    expect(service.readFile(admin.actor, team.workspace.id, "PROJECT.md")).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(value(service.siteEvent(event.id, null))).toEqual({ id: event.id, name: payload.name });
    await fixture.app.close();
    fixture = await createApp(root, false, undefined, undefined, "email", event.id);
    const persisted = fixture.service
      .portal(admin.actor, false)
      .events.find((e) => e.id === event.id);
    expect(persisted).toMatchObject(saved.json());
    expect((await patch(payload, admin.cookie)).statusCode).toBe(409);
    const publicSession = await fixture.app.inject({ url: "/api/session" });
    expect(publicSession.json().siteEvent).toEqual({ id: event.id, name: payload.name });
    expect(JSON.stringify(publicSession.json())).not.toContain(payload.projectBriefGuidance);
    value(fixture.service.transition(admin.actor, event.id, "live"));
    value(fixture.service.transition(admin.actor, event.id, "closed"));
    expect(
      (
        await patch(
          {
            ...payload,
            expectedRevision: 1,
            name: "Closed corrected title",
            projectBriefGuidance: "",
            schedule: [],
          },
          admin.cookie,
        )
      ).statusCode,
    ).toBe(200);
    expect(value(fixture.service.siteEvent(event.id, null)).name).toBeNull();
    expect(value(fixture.service.siteEvent(event.id, admin.actor)).name).toBe(
      "Closed corrected title",
    );
    expect(
      fixture.service.portal(admin.actor, false).events.find((e) => e.id === event.id),
    ).toMatchObject({ status: "closed", schedule: [], projectBriefGuidance: "" });
  } finally {
    await fixture.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("adds stable legacy row IDs and neutral defaults without replacing stored event values or freeform times", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-event-migration-"));
  const actor = {
    id: "admin",
    email: "admin@example.test",
    name: "Admin",
    emailVerified: true as const,
  };
  let service = new EventService(root);
  try {
    const event = value(service.createEvent(actor, input));
    service.close();
    const db = new DatabaseSync(join(root, "state.sqlite"));
    const stored = JSON.parse(String(db.prepare("SELECT body FROM state WHERE id=1").get()?.body));
    const legacy = stored.events[0];
    for (const field of [
      "revision",
      "projectBriefGuidance",
      "description",
      "address",
      "startTime",
      "endTime",
    ])
      delete legacy[field];
    legacy.schedule = [
      { time: "9:30 AM – noon", title: "Original title", description: "Original details" },
      {
        time: "After lunch",
        title: "Original second title",
        description: "Original second details",
      },
    ];
    db.prepare("UPDATE state SET body=? WHERE id=1").run(JSON.stringify(stored));
    db.close();
    service = new EventService(root);
    const migrated = service.portal(actor, false).events[0];
    expect(migrated).toMatchObject({
      ...legacy,
      revision: 0,
      projectBriefGuidance: defaultProjectBriefGuidance,
      startTime: "",
      endTime: "",
      address: "",
      description: "",
    });
    expect(new Set(migrated?.schedule.map((row) => row.id)).size).toBe(2);
    if (!migrated) throw new Error("Missing event");
    const ids = migrated.schedule.map((row) => row.id);
    // Saving another detail must accept the unchanged old clock-like label.
    value(service.updateEvent(actor, event.id, { ...settings(migrated), name: "New title" }));
    service.close();
    service = new EventService(root);
    expect(service.portal(actor, false).events[0]?.schedule.map((row) => row.id)).toEqual(ids);
    expect(
      service.portal(actor, false).events[0]?.schedule.map(({ id: _id, ...row }) => row),
    ).toEqual(legacy.schedule);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
