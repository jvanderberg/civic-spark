import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { validateSpriteToken } from "../../../packages/sprites/src/credentials.ts";

export function deploymentSettings(env: NodeJS.ProcessEnv = process.env) {
  const hosted = env.CIVIC_SPARK_DEPLOYMENT === "hosted" || env.NODE_ENV === "production";
  const host = env.CIVIC_SPARK_HOST ?? (hosted ? "0.0.0.0" : "127.0.0.1");
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(env.CIVIC_SPARK_PORT ?? "4311");
  const proxy = z.enum(["none", "fly"]).parse(env.CIVIC_SPARK_PROXY ?? "none");
  const peers = new BlockList();
  for (const cidr of (env.CIVIC_SPARK_TRUSTED_PROXY_CIDRS ?? "").split(",").filter(Boolean)) {
    const [address, prefix] = cidr.trim().split("/");
    const family = address && isIP(address);
    if (!address || !family) throw new Error("Invalid trusted proxy CIDR");
    peers.addSubnet(
      address,
      z.coerce
        .number()
        .int()
        .min(0)
        .max(family === 4 ? 32 : 128)
        .parse(prefix ?? (family === 4 ? 32 : 128)),
      family === 4 ? "ipv4" : "ipv6",
    );
  }
  if (hosted && proxy === "fly" && !env.CIVIC_SPARK_TRUSTED_PROXY_CIDRS)
    throw new Error("Hosted Fly requires explicit trusted proxy CIDRs");
  return { hosted, host, port, proxy, peers };
}

export function validateDeployment(
  root: string,
  baseURL: string,
  authMode: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (existsSync(join(root, ".civic-spark-recovery.json")))
    throw new Error("Restored installation is fenced pending operator resource reconciliation");
  const settings = deploymentSettings(env);
  const url = new URL(baseURL);
  if (
    authMode === "prototype" &&
    (settings.hosted || !["localhost", "127.0.0.1", "::1"].includes(settings.host))
  )
    throw new Error("Prototype sign-in requires a loopback bind and local deployment");
  if (!["email", "prototype", "demo"].includes(authMode))
    throw new Error("Unknown authentication mode");
  if (!settings.hosted) return settings;
  if (
    url.protocol !== "https:" ||
    url.origin !== baseURL ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Hosted deployment requires an exact public HTTPS BETTER_AUTH_URL origin");
  if (!isAbsolute(root)) throw new Error("Hosted data directory must be absolute");
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Hosted deployment requires BETTER_AUTH_SECRET (at least 32 characters)");
  if (authMode !== "demo" && !["smtp", "resend"].includes(env.CIVIC_SPARK_EMAIL_PROVIDER ?? ""))
    throw new Error("Hosted deployment requires configured SMTP or Resend email");
  if (env.FLY_API_TOKEN || env.FLY_ACCESS_TOKEN)
    throw new Error("Do not install Fly administration credentials in the control plane");
  if (env.CIVIC_SPARK_ENABLE_SPRITES === "1") {
    const org = env.CIVIC_SPARK_SPRITE_ORG;
    validateSpriteToken(env.SPRITE_TOKEN, org);
  }
  return settings;
}

// Only the explicitly trusted immediate peer can supply Fly's overwritten IP header.
// Forwarded host/proto/XFF never determine identity, cookie security or canonical origin.
export function clientAddress(
  peer: string,
  headers: IncomingHttpHeaders,
  settings: ReturnType<typeof deploymentSettings>,
) {
  const address = peer.replace(/^::ffff:/, "");
  const family = isIP(address);
  const trusted = family && settings.peers.check(address, family === 4 ? "ipv4" : "ipv6");
  const value = headers["fly-client-ip"];
  return settings.proxy === "fly" && trusted && typeof value === "string" && isIP(value)
    ? value
    : peer;
}

// A separate SQLite lock is released by the OS after SIGKILL. Never use a stale PID file.
export function acquireWriter(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, "control-plane-writer.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    db.close();
    throw new Error("The data directory already has an active control-plane writer");
  }
  return () => db.close();
}

export function storageReady(root: string) {
  const path = join(root, ".civic-spark-health");
  writeFileSync(path, "ready", { mode: 0o600 });
  rmSync(path);
}
