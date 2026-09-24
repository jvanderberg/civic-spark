import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP, magicLink } from "better-auth/plugins";
import Database from "better-sqlite3";
import { z } from "zod";
import { createEmailDelivery, type EmailDelivery } from "./email.ts";

export async function createAuthentication(
  root: string,
  baseURL: string,
  delivery: EmailDelivery = createEmailDelivery(),
  mode: boolean | "demo" = false,
) {
  const requestsPerMinute = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(process.env.CIVIC_SPARK_AUTH_REQUESTS_PER_MINUTE ?? "120");
  mkdirSync(root, { recursive: true });
  const secretPath = join(root, "auth-secret");
  if (!process.env.BETTER_AUTH_SECRET && !existsSync(secretPath))
    writeFileSync(secretPath, randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
  const secret = process.env.BETTER_AUTH_SECRET ?? readFileSync(secretPath, "utf8");
  const database = new Database(join(root, "auth.sqlite"));
  // One email carries both credentials: the link, and a code for when a phone
  // opens the link in a different browser from the one that asked for it.
  const codeIdentifier = (email: string) => `sign-in-otp-${email.toLowerCase()}`;
  let createCode: ((email: string) => Promise<string>) | undefined;
  database.pragma("journal_mode = WAL");
  const config = {
    appName: "Civic Spark",
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
      useSecureCookies: new URL(baseURL).protocol === "https:",
      cookiePrefix:
        mode === "demo" ? "civic-spark-demo" : mode ? "civic-spark-prototype" : "better-auth",
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ["x-civic-spark-client-ip"] },
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
        sendMagicLink: async ({ email, url }, ctx) => {
          if (!createCode || !ctx) throw new Error("Authentication is not ready");
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(codeIdentifier(email));
          await delivery.send({ email, url, code: await createCode(email) });
        },
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 600,
        allowedAttempts: 5,
        storeOTP: "hashed",
        rateLimit: { window: 60, max: requestsPerMinute },
        // Codes are only issued inside the sign-in link email above.
        sendVerificationOTP: async () => {
          throw new Error("Standalone email codes are not supported");
        },
      }),
    ],
  } satisfies BetterAuthOptions;
  const migration = await getMigrations(config);
  await migration.runMigrations();
  const auth = betterAuth(config);
  createCode = (email) => auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  return {
    auth,
    emailSignIn: delivery.configured,
    checkHealth: () => database.prepare("SELECT 1").get(),
    close: () => database.close(),
  };
}
export type Authentication = Awaited<ReturnType<typeof createAuthentication>>;
