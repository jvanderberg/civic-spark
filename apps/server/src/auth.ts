import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { magicLink } from "better-auth/plugins";
import Database from "better-sqlite3";
import { z } from "zod";
import { createEmailDelivery, type EmailDelivery } from "./email.ts";

export async function createAuthentication(
  root: string,
  baseURL: string,
  delivery: EmailDelivery = createEmailDelivery(),
  prototype = false,
) {
  const requestsPerMinute = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(process.env.VIBEHACK_AUTH_REQUESTS_PER_MINUTE ?? "120");
  mkdirSync(root, { recursive: true });
  const secretPath = join(root, "auth-secret");
  if (!process.env.BETTER_AUTH_SECRET && !existsSync(secretPath))
    writeFileSync(secretPath, randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
  const secret = process.env.BETTER_AUTH_SECRET ?? readFileSync(secretPath, "utf8");
  const database = new Database(join(root, "auth.sqlite"));
  database.pragma("journal_mode = WAL");
  const config: BetterAuthOptions = {
    appName: "VibeHack",
    baseURL,
    secret,
    database,
    trustedOrigins: [baseURL],
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      cookiePrefix: prototype ? "vibehack-prototype" : "better-auth",
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ["x-vibehack-client-ip"] },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: { ...user, name: user.name.trim() || user.email.split("@")[0] || "Participant" },
          }),
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: 600,
        storeToken: "hashed",
        rateLimit: { window: 60, max: requestsPerMinute },
        sendMagicLink: async ({ email, url }) => delivery.send({ email, url }),
      }),
    ],
  };
  const migration = await getMigrations(config);
  await migration.runMigrations();
  const auth = betterAuth(config);
  return { auth, emailSignIn: delivery.configured, close: () => database.close() };
}
export type Authentication = Awaited<ReturnType<typeof createAuthentication>>;
