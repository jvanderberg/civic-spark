import { createHmac } from "node:crypto";
import type { Authentication } from "./auth.ts";

// Registered only in explicit prototype/demo modes, each with isolated data and cookies.
export async function prototypeSignIn(
  authentication: Authentication,
  email: string,
  name: string,
  demo = false,
  secure = false,
) {
  const context = await authentication.auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(email);
  const user =
    existing?.user ??
    (await context.internalAdapter.createUser(
      {
        email,
        name: name || email.split("@")[0] || email,
        emailVerified: !demo,
      },
      { method: demo ? "demo" : "prototype" },
    ));
  const session = await context.internalAdapter.createSession(user.id);
  const signature = createHmac("sha256", context.secret).update(session.token).digest("base64");
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? "; Secure" : ""}`;
}
