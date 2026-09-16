import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../apps/server/src/app.ts";

it("uses normalized email identity only in isolated local prototype mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-prototype-"));
  const origin = "http://127.0.0.1:4310";
  const headers = { host: "127.0.0.1:4310", origin };
  const prototype = await createApp(root, false, origin, undefined, "prototype");
  const production = await createApp(root, false, origin, undefined, "email");
  try {
    const login = () =>
      prototype.app.inject({
        method: "POST",
        url: "/api/prototype/sign-in",
        headers,
        payload: { email: "Person@Example.test", name: "Person" },
      });
    const first = await login();
    expect(first.statusCode).toBe(200);
    expect(first.cookies.some((c) => c.name === "civic-spark-prototype.session_token")).toBe(true);
    const cookie = first.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const session = (
      await prototype.app.inject({ url: "/api/session", headers: { ...headers, cookie } })
    ).json();
    expect(session.authMode).toBe("prototype");
    expect(session.user.id).toBe("person@example.test");
    const second = await login();
    const nextCookie = second.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    expect(
      (
        await prototype.app.inject({
          url: "/api/session",
          headers: { ...headers, cookie: nextCookie },
        })
      ).json().user.id,
    ).toBe(session.user.id);
    expect(
      (await production.app.inject({ url: "/api/state", headers: { ...headers, cookie } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await production.app.inject({
          method: "POST",
          url: "/api/prototype/sign-in",
          headers,
          payload: { email: "person@example.test" },
        })
      ).statusCode,
    ).not.toBe(200);
    expect(
      (
        await prototype.app.inject({
          method: "POST",
          url: "/api/prototype/sign-in",
          remoteAddress: "192.0.2.10",
          headers,
          payload: { email: "person@example.test" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await prototype.app.inject({
          method: "POST",
          url: "/api/prototype/sign-in",
          headers: { ...headers, origin: "https://evil.example" },
          payload: { email: "person@example.test" },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await prototype.app.close();
    await production.app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
