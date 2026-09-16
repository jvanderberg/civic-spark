import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { flyConfig, secretInput, setupSchema } from "../scripts/fly-setup.ts";

afterEach(() => vi.unstubAllEnvs());
it("isolates public unverified demo sessions, limits writes, and preserves identity after restart", async () => {
  vi.stubEnv("CIVIC_SPARK_DEPLOYMENT", "hosted");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-demo-secret-".repeat(4));
  vi.stubEnv("CIVIC_SPARK_AUTH_REQUESTS_PER_MINUTE", "2");
  const root = mkdtempSync(join(tmpdir(), "civic-spark-demo-"));
  const origin = "https://demo.example.test";
  const headers = { host: "demo.example.test", origin };
  let demo = await createApp(root, false, origin, undefined, "demo");
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
    demo = await createApp(root, false, origin, undefined, "demo");
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
    vi.stubEnv("CIVIC_SPARK_EMAIL_PROVIDER", "resend");
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
it("requires explicit demo setup and no email credentials", () => {
  const input = {
    app: "civic-spark-demo",
    org: "operator",
    region: "ord",
    origin: "https://civic-spark-demo.fly.dev",
    spriteOrg: "runtime",
    proxyCidrs: ["172.19.0.0/16"],
  };
  expect(setupSchema.safeParse(input).success).toBe(false);
  const demo = setupSchema.parse({ ...input, authMode: "demo", maxSprites: 8, maxProvisioning: 2 });
  expect(flyConfig(demo)).toContain('CIVIC_SPARK_AUTH_MODE = "demo"');
  expect(flyConfig(demo)).not.toContain("EMAIL_PROVIDER");
  expect(
    secretInput(demo, {
      SPRITE_TOKEN: "runtime/org/token/value",
      BETTER_AUTH_SECRET: "x".repeat(40),
    }),
  ).toContain("CIVIC_SPARK_SECRETS_B64=");
});
