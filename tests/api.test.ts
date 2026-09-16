import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { testIdentity } from "./auth-fixture.ts";

it("requires real verified sessions, rejects identity spoofing and CSRF, and revokes logout", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-auth-test-"));
  const { app, authentication } = await createApp(root, false);
  try {
    const host = { host: "127.0.0.1:4311" };
    expect((await app.inject({ url: "/api/state", headers: host })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/state",
          headers: { ...host, "x-user-id": "admin", cookie: "better-auth.session_token=forged" },
        })
      ).statusCode,
    ).toBe(401);
    const unverified = await testIdentity(authentication, "Unverified", false);
    expect(
      (await app.inject({ url: "/api/state", headers: { ...host, cookie: unverified.cookie } }))
        .statusCode,
    ).toBe(401);
    const user = await testIdentity(authentication, "Alice");
    const headers = { ...host, cookie: user.cookie };
    expect((await app.inject({ url: "/api/state", headers })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/events",
          headers: { ...headers, origin: "https://evil.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: "/api/state", headers: { ...headers, host: "evil.example" } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/participants",
          headers,
          payload: { name: "Impersonated" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/sign-out",
          headers: { ...headers, origin: "http://127.0.0.1:4310" },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: "/api/state", headers })).statusCode).toBe(401);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("authorizes workspace owners and event admins at the HTTP boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-api-test-"));
  const { app, authentication } = await createApp(root, false);
  try {
    const alice = await testIdentity(authentication, "Alice");
    const bob = await testIdentity(authentication, "Bob");
    const headers = (cookie: string) => ({ host: "127.0.0.1:4311", cookie });
    const event = (
      await app.inject({
        method: "POST",
        url: "/api/events",
        headers: headers(alice.cookie),
        payload: {
          name: "Data day",
          date: "2026-10-03",
          timezone: "America/Chicago",
          location: "Library",
          capacity: 40,
          budget: 20,
          templateId: "blank",
        },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/events/${event.id}/status`,
      headers: headers(alice.cookie),
      payload: { status: "registration" },
    });
    const result = (
      await app.inject({
        method: "POST",
        url: "/api/teams",
        headers: headers(bob.cookie),
        payload: {
          eventId: event.id,
          name: "Bob's team",
          projectId: "data-starter",
          userId: alice.user.id,
        },
      })
    ).json();
    expect(result.workspace.userId).toBe(bob.user.id);
    for (const url of [
      `/api/workspaces/${result.workspace.id}/files`,
      `/api/workspaces/${result.workspace.id}/manifest`,
      `/api/workspaces/${result.workspace.id}/changes`,
      `/api/workspaces/${result.workspace.id}/blob?path=README.md`,
      `/api/workspaces/${result.workspace.id}/file?path=README.md`,
    ]) {
      expect((await app.inject({ url, headers: headers(alice.cookie) })).statusCode).toBe(404);
      expect((await app.inject({ url, headers: headers(bob.cookie) })).statusCode).toBe(200);
    }
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/workspaces/${result.workspace.id}/blob`,
          headers: headers(alice.cookie),
          payload: { path: "injected.txt", data: "", revision: null },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/workspaces/${result.workspace.id}/agent/prepare`,
          headers: headers(alice.cookie),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/workspaces/${result.workspace.id}/sprite`,
          headers: headers(alice.cookie),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/events/${event.id}/members/${bob.user.id}/role`,
          headers: headers(bob.cookie),
          payload: { role: "admin" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/teams/${result.team.id}/members/${bob.user.id}`,
          headers: headers(alice.cookie),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: `/api/workspaces/${result.workspace.id}/files`,
          headers: headers(bob.cookie),
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
