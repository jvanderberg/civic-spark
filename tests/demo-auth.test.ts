import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import type { LoginEmail } from "../apps/server/src/email.ts";
import { flyConfig, secretInput, setupSchema } from "../scripts/fly-setup.ts";

afterEach(() => vi.unstubAllEnvs());
const mailbox = (outbox: LoginEmail[] = []) => ({
  configured: true,
  async send(message: LoginEmail) {
    outbox.push(message);
  },
});
it("isolates public unverified demo sessions, limits writes, and preserves identity after restart", async () => {
  vi.stubEnv("CIVIC_SPARK_DEPLOYMENT", "hosted");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-demo-secret-".repeat(4));
  vi.stubEnv("CIVIC_SPARK_AUTH_REQUESTS_PER_MINUTE", "2");
  vi.stubEnv("CIVIC_SPARK_EMAIL_PROVIDER", "resend");
  vi.stubEnv("CIVIC_SPARK_OWNERS", "owner@example.test");
  const root = mkdtempSync(join(tmpdir(), "civic-spark-demo-"));
  const origin = "https://demo.example.test";
  const headers = { host: "demo.example.test", origin };
  let demo = await createApp(root, false, origin, mailbox(), "demo");
  const login = (email = "Demo@example.test", extra = {}) =>
    demo.app.inject({
      method: "POST",
      url: "/api/demo/sign-in",
      remoteAddress: "192.0.2.1",
      headers: { ...headers, ...extra },
      payload: { email },
    });
  try {
    const first = await login();
    expect(first.statusCode).toBe(200);
    expect(first.headers["set-cookie"]).toContain("__Secure-civic-spark-demo.session_token");
    expect(first.headers["set-cookie"]).toContain("; Secure");
    const cookie = first.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = async () =>
      (await demo.app.inject({ url: "/api/session", headers: { ...headers, cookie } })).json();
    const identity = (await session()).user;
    expect(identity).toMatchObject({
      email: "demo@example.test",
      emailVerified: false,
      authMode: "demo",
    });
    expect((await login()).statusCode).toBe(200);
    expect(
      (
        await login("other@example.test", {
          "x-civic-spark-client-ip": "192.0.2.99",
          "fly-client-ip": "192.0.2.99",
        })
      ).statusCode,
    ).toBe(429);
    const database = new Database(join(root, "demo/auth.sqlite"), { readonly: true });
    expect(database.prepare('SELECT count(*) AS n FROM "session"').get()).toEqual({ n: 2 });
    expect(database.prepare('SELECT count(*) AS n FROM "user"').get()).toEqual({ n: 1 });
    database.close();
    await demo.app.close();
    demo = await createApp(root, false, origin, mailbox(), "demo");
    expect((await session()).user).toEqual(identity);
    expect(
      (
        await demo.app.inject({
          method: "POST",
          url: "/api/demo/sign-in",
          headers: { ...headers, origin: "https://evil.example" },
          payload: { email: "evil@example.test" },
        })
      ).statusCode,
    ).toBe(403);
    const production = await createApp(
      root,
      false,
      origin,
      { configured: true, async send() {} },
      "email",
    );
    try {
      expect(
        (await production.app.inject({ url: "/api/state", headers: { ...headers, cookie } }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await production.app.inject({
            method: "POST",
            url: "/api/demo/sign-in",
            headers,
            payload: { email: identity.email },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await production.app.close();
    }
  } finally {
    await demo.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("requires explicit demo setup with owners and sign-in email", () => {
  const input = {
    app: "civic-spark-demo",
    org: "operator",
    region: "ord",
    origin: "https://civic-spark-demo.fly.dev",
    spriteOrg: "runtime",
    proxyCidrs: ["172.19.0.0/16"],
    authMode: "demo",
    emailProvider: "gmail",
    emailFrom: "Civic Spark <demo.signin@gmail.com>",
  };
  expect(setupSchema.safeParse(input).success).toBe(false);
  expect(
    setupSchema.safeParse({ ...input, owners: ["owner@example.test"], emailProvider: undefined })
      .success,
  ).toBe(false);
  const demo = setupSchema.parse({ ...input, owners: ["Owner@Example.test"], maxProvisioning: 2 });
  expect(flyConfig(demo)).toContain('CIVIC_SPARK_AUTH_MODE = "demo"');
  expect(flyConfig(demo)).toContain('CIVIC_SPARK_OWNERS = "owner@example.test"');
  expect(flyConfig(demo)).toContain('CIVIC_SPARK_EMAIL_PROVIDER = "smtp"');
  const secrets = { SPRITE_TOKEN: "runtime/org/token/value", BETTER_AUTH_SECRET: "x".repeat(40) };
  expect(() => secretInput(demo, secrets)).toThrow("SMTP_USER");
  expect(
    secretInput(demo, {
      ...secrets,
      SMTP_USER: "demo.signin@gmail.com",
      SMTP_PASSWORD: "abcdefghijklmnop",
    }),
  ).toContain("CIVIC_SPARK_SECRETS_B64=");
});
it("makes demo owners and event admins prove their email while participants skip it", async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-demo-owner-secret-".repeat(3));
  const root = mkdtempSync(join(tmpdir(), "civic-spark-demo-owner-"));
  const origin = "https://demo.example.test";
  const headers = { host: "demo.example.test", origin };
  const outbox: LoginEmail[] = [];
  const cookieOf = (response: { cookies: { name: string; value: string }[] }) =>
    response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  // Before owners existed, anyone could open the owner's demo account by typing its email.
  let demo = await createApp(root, false, "http://127.0.0.1:4310", mailbox(outbox), "demo");
  const local = { host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" };
  const impostor = await demo.app.inject({
    method: "POST",
    url: "/api/demo/sign-in",
    headers: local,
    payload: { email: "owner@example.test" },
  });
  const earlier = (
    await demo.app.inject({
      url: "/api/session",
      headers: { ...local, cookie: cookieOf(impostor) },
    })
  ).json().user;
  expect(earlier).toMatchObject({ emailVerified: false });
  await demo.app.close();

  vi.stubEnv("CIVIC_SPARK_DEPLOYMENT", "hosted");
  vi.stubEnv("CIVIC_SPARK_EMAIL_PROVIDER", "resend");
  vi.stubEnv("CIVIC_SPARK_OWNERS", "Owner@Example.test");
  demo = await createApp(root, false, origin, mailbox(outbox), "demo");
  const { app } = demo;
  const call = (method: string, url: string, cookie = "", payload?: object) =>
    app.inject({ method: method as "GET", url, headers: { ...headers, cookie }, payload });
  const demoSignIn = (email: string) => call("POST", "/api/demo/sign-in", "", { email });
  const enterCode = async (email: string) => {
    const message = outbox.findLast((entry) => entry.email === email);
    if (!message) throw new Error("Missing code email");
    return call("POST", "/api/auth/sign-in/email-otp", "", { email, otp: message.code });
  };
  try {
    expect((await call("GET", "/api/state", cookieOf(impostor))).statusCode).toBe(401);
    const asked = await demoSignIn("owner@example.test");
    expect(asked.json()).toEqual({ codeSent: true });
    expect(asked.cookies).toHaveLength(0);
    const owner = cookieOf(await enterCode("owner@example.test"));
    const ownerSession = (await call("GET", "/api/session", owner)).json();
    expect(ownerSession.user).toMatchObject({ id: earlier.id, emailVerified: true });
    expect(ownerSession.canCreateEvents).toBe(true);
    // Proving the email ended every session opened by typing it.
    expect((await call("GET", "/api/state", cookieOf(impostor))).statusCode).toBe(401);
    const created = await call("POST", "/api/events", owner, {
      name: "Demo day",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 10,
      budget: 10,
      templateId: "blank",
    });
    expect(created.statusCode).toBe(200);
    const eventId = created.json().id;

    const participantLogin = await demoSignIn("helper@example.test");
    const participant = cookieOf(participantLogin);
    expect(participantLogin.statusCode).toBe(200);
    const participantSession = (await call("GET", "/api/session", participant)).json();
    expect(participantSession).toMatchObject({
      user: { emailVerified: false },
      canCreateEvents: false,
    });
    expect((await call("GET", "/api/state", participant)).statusCode).toBe(200);
    const denied = await call("POST", "/api/events", participant, {
      name: "Unwanted",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Library",
      capacity: 10,
      budget: 10,
      templateId: "blank",
    });
    expect(denied.statusCode).toBe(403);
    const sent = outbox.length;
    const codeRequest = await call("POST", "/api/auth/sign-in/magic-link", "", {
      email: "helper@example.test",
      callbackURL: origin,
    });
    expect(codeRequest.statusCode).toBe(403);
    expect(outbox).toHaveLength(sent);

    // Becoming an event admin ends the typed-email session; a code restores access.
    expect(
      (await call("POST", `/api/events/${eventId}/admins`, owner, { email: "helper@example.test" }))
        .statusCode,
    ).toBe(200);
    expect((await call("GET", "/api/state", participant)).statusCode).toBe(401);
    expect((await demoSignIn("helper@example.test")).json()).toEqual({ codeSent: true });
    const helper = cookieOf(await enterCode("helper@example.test"));
    const helperState = (await call("GET", "/api/state", helper)).json();
    expect(helperState.user).toMatchObject({ id: participantSession.user.id, emailVerified: true });
    expect(helperState.events[0]).toMatchObject({ id: eventId, role: "admin" });
  } finally {
    await demo.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
