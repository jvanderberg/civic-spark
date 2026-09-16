import { createHmac } from "node:crypto";
import type { Authentication } from "./auth.ts";

// Only registered in explicit, loopback-only prototype mode with an isolated data directory.
export async function prototypeSignIn(authentication: Authentication, email: string, name: string) {
  const context = await authentication.auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(email);
  const user =
    existing?.user ??
    (await context.internalAdapter.createUser(
      {
        email,
        name: name || email.split("@")[0] || email,
        emailVerified: true,
      },
      { method: "prototype" },
    ));
  const session = await context.internalAdapter.createSession(user.id);
  const signature = createHmac("sha256", context.secret).update(session.token).digest("base64");
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
}
