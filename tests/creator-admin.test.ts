import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import type { LoginEmail } from "../apps/server/src/email.ts";
import type { PortalState, SessionView } from "../packages/domain/src/access-types.ts";
import type { Event, EventInput, Result } from "../packages/domain/src/types.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { testIdentity } from "./auth-fixture.ts";

const origin = "http://127.0.0.1:4310";
const eventInput: EventInput = {
  name: "Creator access rehearsal",
  date: "2026-10-03",
  timezone: "America/Chicago",
  location: "Library",
  capacity: 40,
  budget: 20,
  templateId: "blank",
};
const headers = (cookie = "") => ({ host: "127.0.0.1:4310", origin, cookie });
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

it.each(["email", "prototype", "demo"] as const)(
  "%s retains the creating account's event admin across login and restart without promoting other accounts",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "civic-spark-creator-admin-"));
    const outbox: LoginEmail[] = [];
    const delivery = {
      configured: true,
      async send(message: LoginEmail) {
        outbox.push(message);
      },
    };
    let current = await createApp(root, false, origin, delivery, mode);
    const signIn = async (email: string) => {
      let response = await current.app.inject({
        method: "POST",
        url: mode === "email" ? "/api/auth/sign-in/magic-link" : `/api/${mode}/sign-in`,
        headers: headers(),
        payload: { email, callbackURL: origin },
      });
      expect(response.statusCode).toBe(200);
      if (mode === "email") {
        const message = outbox.pop();
        if (!message) throw new Error("Missing test email");
        const url = new URL(message.url);
        response = await current.app.inject({ url: url.pathname + url.search, headers: headers() });
        expect(response.statusCode).toBe(302);
      }
      const cookie = response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      const session = (
        await current.app.inject({ url: "/api/session", headers: headers(cookie) })
      ).json<SessionView>();
      if (!session.user) throw new Error("Missing signed-in account");
      expect(session.user.emailVerified).toBe(mode !== "demo");
      return { cookie, user: session.user };
    };
    const state = async (cookie: string) => {
      const response = await current.app.inject({ url: "/api/state", headers: headers(cookie) });
      expect(response.statusCode).toBe(200);
      return response.json<PortalState>();
    };
    const post = (cookie: string, url: string, payload: object) =>
      current.app.inject({ method: "POST", url, headers: headers(cookie), payload });
    try {
      // Neither the installation's first account nor its latest account is an owner heuristic.
      const earlier = await signIn("earlier@example.test");
      await state(earlier.cookie);
      const creator = await signIn("Creator@example.test");
      const response = await post(creator.cookie, "/api/events", {
        ...eventInput,
        userId: earlier.user.id,
        email: earlier.user.email,
        role: "member",
      });
      expect(response.statusCode).toBe(200);
      const event = response.json<Event>();
      expect((await state(creator.cookie)).events).toMatchObject([{ id: event.id, role: "admin" }]);
      expect((await state(earlier.cookie)).events).toEqual([]);
      const later = await signIn("later@example.test");
      expect((await state(later.cookie)).events).toEqual([]);
      expect(
        (await post(creator.cookie, `/api/events/${event.id}/status`, { status: "registration" }))
          .statusCode,
      ).toBe(200);
      for (const unrelated of [earlier, later]) {
        expect((await state(unrelated.cookie)).events[0]?.role).toBe("visitor");
        for (const [url, payload] of [
          [`/api/events/${event.id}/status`, { status: "live" }],
          [`/api/events/${event.id}/admins`, { email: unrelated.user.email }],
          [`/api/events/${event.id}/members/${creator.user.id}/role`, { role: "member" }],
        ] as const) {
          const denied = await current.app.inject({
            method: "POST",
            url,
            headers: { ...headers(unrelated.cookie), "x-user-id": creator.user.id },
            payload: { ...payload, userId: creator.user.id, actor: creator.user },
          });
          expect(denied.statusCode).toBe(403);
        }
      }
      expect(
        (await post("", "/api/events", { ...eventInput, userId: creator.user.id })).statusCode,
      ).toBe(401);
      const logout = await post(creator.cookie, "/api/auth/sign-out", {});
      expect(logout.statusCode).toBe(200);
      expect(
        (await current.app.inject({ url: "/api/state", headers: headers(creator.cookie) }))
          .statusCode,
      ).toBe(401);
      const returning = await signIn("creator@example.test");
      expect(returning.user.id).toBe(creator.user.id);
      expect((await state(returning.cookie)).events[0]?.role).toBe("admin");
      await current.app.close();
      current = await createApp(root, false, origin, delivery, mode, event.id);
      expect((await state(returning.cookie)).events).toMatchObject([
        { id: event.id, role: "admin" },
      ]);
      expect((await state(earlier.cookie)).events[0]?.role).toBe("visitor");
      expect((await state(later.cookie)).events[0]?.role).toBe("visitor");
      const nextLogin = await signIn("CREATOR@example.test");
      expect(nextLogin.user.id).toBe(creator.user.id);
      expect(
        (await post(nextLogin.cookie, `/api/events/${event.id}/status`, { status: "live" }))
          .statusCode,
      ).toBe(200);
      expect((await state(nextLogin.cookie)).myWorkspaces).toEqual([]);
    } finally {
      await current.app.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("grants only the specified existing account admin while preserving work and history across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-admin-grant-"));
  let current = await createApp(root, false, origin, undefined, "email");
  try {
    const importer = await testIdentity(current.authentication, "Importer");
    const target = await testIdentity(current.authentication, "Participant");
    const unrelated = await testIdentity(current.authentication, "Unrelated");
    if (!importer.actor || !target.actor || !unrelated.actor) throw new Error("Missing actors");
    const { service } = current;
    const event = value(service.createEvent(importer.actor, eventInput));
    const otherEvent = value(
      service.createEvent(importer.actor, { ...eventInput, name: "Other event" }),
    );
    value(service.transition(importer.actor, event.id, "registration"));
    value(service.transition(importer.actor, otherEvent.id, "registration"));
    const { team, workspace } = value(
      service.createTeam(target.actor, {
        eventId: event.id,
        name: "Existing work",
        projectId: "data-starter",
      }),
    );
    value(service.joinTeam(unrelated.actor, team.id));
    const initial = value(service.readFile(target.actor, workspace.id, "README.md"));
    value(
      service.saveFile(target.actor, workspace.id, "README.md", "Shared work", initial.revision),
    );
    const changes = new WorkspaceFiles(service.workspacePath(workspace.id)).changes();
    if (!changes.revision) throw new Error("Missing change revision");
    value(
      service.shareLocal(target.actor, workspace.id, "Existing shared history", changes.revision),
    );
    const shared = value(service.readFile(target.actor, workspace.id, "README.md"));
    value(
      service.saveFile(target.actor, workspace.id, "README.md", "Private draft", shared.revision),
    );
    const before = service.portal(target.actor, false);
    const fileBefore = value(service.readFile(target.actor, workspace.id, "README.md"));
    const historyBefore = service.repositoryHistory(target.actor, team.id, {});
    expect(historyBefore.ok).toBe(true);
    const grant = (cookie: string, email: string) =>
      current.app.inject({
        method: "POST",
        url: `/api/events/${event.id}/admins`,
        headers: headers(cookie),
        payload: { email },
      });
    expect((await grant(target.cookie, target.user.email)).statusCode).toBe(403);
    expect((await grant(importer.cookie, "unknown@example.test")).statusCode).toBe(404);
    // Repeat the supported correction safely; it updates a role, never creates/merges accounts.
    for (let attempt = 0; attempt < 2; attempt++) {
      const granted = await grant(importer.cookie, target.user.email.toUpperCase());
      expect(granted.statusCode).toBe(200);
      expect(granted.json()).toEqual({ userId: target.user.id, role: "admin" });
    }
    await current.app.close();
    current = await createApp(root, false, origin, undefined, "email");
    const response = await current.app.inject({
      url: "/api/state",
      headers: headers(target.cookie),
    });
    expect(response.statusCode).toBe(200);
    const after = response.json<PortalState>();
    expect(after.user).toEqual(before.user);
    expect(after.myWorkspaces).toEqual(before.myWorkspaces);
    expect(after.teams).toEqual(before.teams);
    expect(after.contributions).toEqual(before.contributions);
    expect(after.events.find((e) => e.id === event.id)?.role).toBe("admin");
    expect(after.events.find((e) => e.id === otherEvent.id)?.role).toBe("visitor");
    expect(
      after.members.filter((m) => m.eventId === event.id && m.userId === target.user.id),
    ).toHaveLength(1);
    expect(
      current.service.portal(importer.actor, false).events.every((e) => e.role === "admin"),
    ).toBe(true);
    expect(
      current.service.portal(unrelated.actor, false).events.find((e) => e.id === event.id)?.role,
    ).toBe("member");
    expect(value(current.service.readFile(target.actor, workspace.id, "README.md"))).toEqual(
      fileBefore,
    );
    expect(current.service.repositoryHistory(target.actor, team.id, {})).toEqual(historyBefore);
    expect(current.service.readFile(importer.actor, workspace.id, "README.md")).toMatchObject({
      ok: false,
      status: 404,
    });
  } finally {
    await current.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
