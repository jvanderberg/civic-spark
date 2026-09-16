import { createHmac } from "node:crypto";
import type { Authentication } from "../apps/server/src/auth.ts";
import { identitySchema } from "../packages/domain/src/access-types.ts";

// Test-only fixture, never imported by application code or exposed as a route.
// It creates real database sessions and signed cookies without sending email.
export async function testIdentity(
  authentication: Authentication,
  name: string,
  emailVerified = true,
) {
  const context = await authentication.auth.$context;
  const user = await context.internalAdapter.createUser(
    { name, email: `${name.toLowerCase().replaceAll(" ", ".")}@example.test`, emailVerified },
    { method: "admin" },
  );
  const session = await context.internalAdapter.createSession(user.id);
  const signature = createHmac("sha256", context.secret).update(session.token).digest("base64");
  const value = encodeURIComponent(`${session.token}.${signature}`);
  const cookieName = context.authCookies.sessionToken.name;
  return {
    user,
    actor: emailVerified ? identitySchema.parse(user) : null,
    cookie: `${cookieName}=${value}`,
    browserCookie: {
      name: cookieName,
      value,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax" as const,
    },
  };
}
