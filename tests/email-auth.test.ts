import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import type { LoginEmail } from "../apps/server/src/email.ts";

const origin = "http://127.0.0.1:4310";
const headers = { host: "127.0.0.1:4310", origin };

it("verifies email with hashed single-use links and preserves the account on return", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibehack-email-"));
  const outbox: LoginEmail[] = [];
  const { app } = await createApp(root, false, origin, {
    configured: true,
    async send(message) {
      outbox.push(message);
    },
  });
  const database = new Database(join(root, "auth.sqlite"));
  const requestLink = () =>
    app.inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      headers,
      payload: { email: "participant@example.test", callbackURL: origin, errorCallbackURL: origin },
    });
  const redeem = (message: LoginEmail) => {
    const url = new URL(message.url);
    return app.inject({ url: url.pathname + url.search, headers });
  };
  try {
    const sent = await requestLink();
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ status: true });
    expect((await app.inject({ url: "/api/state", headers })).statusCode).toBe(401);
    expect(database.prepare('SELECT count(*) AS n FROM "user"').get()).toEqual({ n: 0 });
    const message = outbox[0];
    if (!message) throw new Error("Missing test mail");
    const stored = database.prepare("SELECT identifier FROM verification").get() as {
      identifier: string;
    };
    expect(stored.identifier === new URL(message.url).searchParams.get("token")).toBe(false);
    const verified = await redeem(message);
    expect(verified.statusCode).toBe(302);
    expect(verified.headers.location).toBe(`${origin}/`);
    expect(verified.headers["cache-control"]).toBe("no-store");
    expect(verified.headers["referrer-policy"]).toBe("no-referrer");
    const cookie = verified.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const signed = { ...headers, cookie };
    const session = (await app.inject({ url: "/api/session", headers: signed })).json();
    expect(session.user).toMatchObject({
      email: "participant@example.test",
      emailVerified: true,
      name: "participant",
    });
    expect((await app.inject({ url: "/api/state", headers: signed })).statusCode).toBe(200);
    const replay = await redeem(message);
    expect(replay.headers.location).toContain("error=INVALID_TOKEN");
    expect(replay.cookies).toHaveLength(0);
    await app.inject({ method: "POST", url: "/api/auth/sign-out", headers: signed, payload: {} });
    expect((await app.inject({ url: "/api/state", headers: signed })).statusCode).toBe(401);
    await requestLink();
    const next = outbox[1];
    if (!next) throw new Error("Missing return mail");
    const returned = await redeem(next);
    const returnedCookie = returned.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const returning = (
      await app.inject({ url: "/api/session", headers: { ...headers, cookie: returnedCookie } })
    ).json();
    expect(returning.user.id).toBe(session.user.id);
    expect(database.prepare('SELECT count(*) AS n FROM "user"').get()).toEqual({ n: 1 });

    await requestLink();
    const expired = outbox[2];
    if (!expired) throw new Error("Missing expiry test mail");
    database.prepare("UPDATE verification SET expiresAt = ?").run(Date.now() - 1000);
    const denied = await redeem(expired);
    expect(denied.headers.location).toContain("error=INVALID_TOKEN");
    expect(denied.cookies).toHaveLength(0);

    await requestLink();
    const redirect = outbox[3];
    if (!redirect) throw new Error("Missing redirect test mail");
    const malicious = new URL(redirect.url);
    malicious.searchParams.set("callbackURL", "https://untrusted.example");
    const blocked = await redeem({ ...redirect, url: malicious.toString() });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.cookies).toHaveLength(0);
  } finally {
    database.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("fails explicitly when delivery is disabled or fails; never creates a session", async () => {
  for (const configured of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "vibehack-email-fail-"));
    const { app } = await createApp(root, false, origin, {
      configured,
      async send() {
        throw new Error("Email delivery failed");
      },
    });
    try {
      const sent = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/magic-link",
        headers,
        payload: { email: "person@example.test", callbackURL: origin },
      });
      expect(sent.statusCode).toBe(configured ? 500 : 503);
      expect(sent.cookies).toHaveLength(0);
      expect((await app.inject({ url: "/api/session", headers })).json().user).toBeNull();
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
