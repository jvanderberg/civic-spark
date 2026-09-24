import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { flyConfig, setupSchema } from "../scripts/fly-setup.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
afterEach(() => vi.unstubAllEnvs());
it("pins session and portal to the configured event across restart without leaking other admin contributions", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-site-test-"));
  let current = await createApp(root, false);
  try {
    const admin = await testIdentity(current.authentication, "Site organizer");
    const visitor = await testIdentity(current.authentication, "Site visitor");
    assertActor(admin.actor);
    const actor = admin.actor;
    const events = ["Other event", "Harbor Data Day"].map((name) => {
      const event = unwrap(
        current.service.createEvent(actor, {
          name,
          date: "2026-10-03",
          timezone: "America/Chicago",
          location: "Library",
          capacity: 40,
          budget: 20,
          templateId: "blank",
        }),
      );
      const { workspace } = unwrap(
        current.service.createTeam(actor, {
          eventId: event.id,
          name: `${name} team`,
          projectId: "data-starter",
        }),
      );
      writeFileSync(join(current.service.workspacePath(workspace.id), "notes.md"), `# ${name}\n`);
      unwrap(current.service.propose(actor, workspace.id, `${name} contribution`));
      return event;
    });
    const other = events[0];
    const pinned = events[1];
    if (!other || !pinned) throw new Error("Missing fixtures");
    expect(current.service.portal(actor, false).contributions).toHaveLength(2);
    const headers = { host: "127.0.0.1:4310" };
    expect(
      (await current.app.inject({ url: "/api/session", headers })).json().siteEvent,
    ).toBeNull();
    await current.app.close();
    vi.stubEnv("CIVIC_SPARK_SITE_EVENT_ID", pinned.id);
    current = await createApp(root, false);
    const session = async (cookie?: string) =>
      (
        await current.app.inject({
          url: "/api/session",
          headers: { ...headers, ...(cookie ? { cookie } : {}) },
        })
      ).json();
    expect((await session()).siteEvent).toEqual({ id: pinned.id, name: null });
    expect((await session(visitor.cookie)).siteEvent.name).toBeNull();
    expect((await session(admin.cookie)).siteEvent).toEqual({ id: pinned.id, name: pinned.name });
    unwrap(current.service.transition(actor, pinned.id, "registration"));
    expect((await session()).siteEvent).toEqual({ id: pinned.id, name: pinned.name });
    const response = await current.app.inject({
      url: "/api/state",
      headers: { ...headers, cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
    const state = response.json();
    expect(state.events.map((event: { id: string }) => event.id)).toEqual([pinned.id]);
    for (const key of ["teams", "myWorkspaces", "members", "contributions", "activity"]) {
      expect(state[key].length).toBeGreaterThan(0);
      expect(state[key].every((entry: { eventId: string }) => entry.eventId === pinned.id)).toBe(
        true,
      );
    }
    expect((await current.app.inject({ url: "/api/state", headers })).statusCode).toBe(401);
    // The installation does not redefine domain membership or destroy other work.
    expect(current.service.portal(actor, false).events).toHaveLength(2);
    unwrap(current.service.transition(actor, pinned.id, "live"));
    unwrap(current.service.transition(actor, pinned.id, "closed"));
    expect((await session()).siteEvent.name).toBeNull();
    expect((await session(visitor.cookie)).siteEvent.name).toBeNull();
    expect((await session(admin.cookie)).siteEvent.name).toBe(pinned.name);
  } finally {
    await current.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
function assertActor<T>(actor: T): asserts actor is NonNullable<T> {
  if (!actor) throw new Error("Missing test identity");
}
it("rejects malformed and missing configured events rather than falling back", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-missing-site-"));
  try {
    vi.stubEnv("CIVIC_SPARK_SITE_EVENT_ID", "not-an-event");
    await expect(createApp(root, false)).rejects.toThrow();
    vi.stubEnv("CIVIC_SPARK_SITE_EVENT_ID", randomUUID());
    await expect(createApp(root, false)).rejects.toThrow("configured site event was not found");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("validates optional setup event IDs and emits the runtime pin", () => {
  const input = {
    app: "civic-spark-test",
    org: "test-org",
    region: "ord",
    origin: "https://event.example.test",
    spriteOrg: "test-sprites",
    authMode: "demo",
    owners: ["owner@example.test"],
    emailProvider: "gmail",
    emailFrom: "Civic Spark <signin@gmail.com>",
    proxyCidrs: ["172.19.0.0/16"],
  };
  expect(flyConfig(setupSchema.parse(input))).not.toContain("CIVIC_SPARK_SITE_EVENT_ID");
  const siteEventId = randomUUID();
  expect(flyConfig(setupSchema.parse({ ...input, siteEventId }))).toContain(
    `CIVIC_SPARK_SITE_EVENT_ID = "${siteEventId}"`,
  );
  expect(() => setupSchema.parse({ ...input, siteEventId: "" })).toThrow();
});
