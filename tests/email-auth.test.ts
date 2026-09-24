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
  const root = mkdtempSync(join(tmpdir(), "civic-spark-email-"));
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
    // The link is opened from a mail app: its redirect lands on the page as a cross-site
    // navigation, which must load. The API still refuses cross-site requests.
    const crossSite = { host: headers.host, cookie, "sec-fetch-site": "cross-site" };
    const landing = await app.inject({ url: "/", headers: crossSite });
    expect(landing.statusCode).not.toBe(403);
    expect(landing.body).not.toContain("Cross-origin requests are disabled");
    expect((await app.inject({ url: "/api/state", headers: crossSite })).statusCode).toBe(403);
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
    const root = mkdtempSync(join(tmpdir(), "civic-spark-email-fail-"));
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
      const code = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email-otp",
        headers,
        payload: { email: "person@example.test", otp: "123456" },
      });
      expect(code.statusCode).toBe(configured ? 400 : 503);
      expect(code.cookies).toHaveLength(0);
      expect((await app.inject({ url: "/api/session", headers })).json().user).toBeNull();
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

it("signs in with the emailed code in the requesting browser, once, with bounded attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-email-code-"));
  const outbox: LoginEmail[] = [];
  const { app } = await createApp(root, false, origin, {
    configured: true,
    async send(message) {
      outbox.push(message);
    },
  });
  const database = new Database(join(root, "auth.sqlite"));
  const email = "coder@example.test";
  const request = async () => {
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      headers,
      payload: { email, callbackURL: origin, errorCallbackURL: origin },
    });
    const message = outbox.at(-1);
    if (!message) throw new Error("Missing test mail");
    return message;
  };
  const enter = (otp: string, name?: string) =>
    app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email-otp",
      headers,
      payload: { email: "Coder@Example.test", otp, name },
    });
  const signedInAs = async (response: Awaited<ReturnType<typeof enter>>) => {
    const cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    return (await app.inject({ url: "/api/session", headers: { ...headers, cookie } })).json().user;
  };
  try {
    const first = await request();
    expect(first.code).toMatch(/^\d{6}$/);
    const stored = database.prepare("SELECT value FROM verification").all() as {
      value: string;
    }[];
    expect(stored.some((row) => row.value.includes(first.code))).toBe(false);
    const wrong = first.code === "000000" ? "111111" : "000000";
    expect((await enter(wrong)).statusCode).toBe(400);
    const accepted = await enter(first.code, "Casey Coder");
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(await signedInAs(accepted)).toMatchObject({
      email,
      emailVerified: true,
      name: "Casey Coder",
    });
    const replay = await enter(first.code);
    expect(replay.statusCode).toBe(400);
    expect(replay.cookies).toHaveLength(0);

    // A newer email replaces the older code.
    const older = await request();
    const newer = await request();
    if (older.code !== newer.code) expect((await enter(older.code)).statusCode).toBe(400);
    expect((await enter(newer.code)).statusCode).toBe(200);

    // Using the link leaves its code usable, so opening the link elsewhere first
    // does not break signing in here.
    const linked = await request();
    const url = new URL(linked.url);
    expect((await app.inject({ url: url.pathname + url.search, headers })).statusCode).toBe(302);
    expect((await enter(linked.code)).statusCode).toBe(200);

    // Five wrong guesses discard the code.
    const guarded = await request();
    const guess = guarded.code === "999999" ? "888888" : "999999";
    for (let attempt = 0; attempt < 5; attempt++) expect((await enter(guess)).statusCode).toBe(400);
    expect((await enter(guarded.code)).statusCode).toBe(403);

    const expiring = await request();
    database.prepare("UPDATE verification SET expiresAt = ?").run(Date.now() - 1000);
    expect((await enter(expiring.code)).statusCode).toBe(400);
    expect(database.prepare('SELECT count(*) AS n FROM "user"').get()).toEqual({ n: 1 });
  } finally {
    database.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps standalone code, password and email-change routes unreachable", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-email-routes-"));
  const outbox: LoginEmail[] = [];
  const { app } = await createApp(root, false, origin, {
    configured: true,
    async send(message) {
      outbox.push(message);
    },
  });
  try {
    for (const url of [
      "/api/auth/email-otp/send-verification-otp",
      "/api/auth/email-otp/check-verification-otp",
      "/api/auth/email-otp/verify-email",
      "/api/auth/email-otp/request-password-reset",
      "/api/auth/email-otp/reset-password",
      "/api/auth/email-otp/request-email-change",
      "/api/auth/email-otp/change-email",
      "/api/auth/forget-password/email-otp",
      "/api/auth//Email-OTP/send-verification-otp/",
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { email: "person@example.test", type: "sign-in", otp: "123456" },
      });
      expect(response.statusCode, url).toBe(404);
    }
    expect(outbox).toHaveLength(0);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
