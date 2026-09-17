import { randomUUID } from "node:crypto";
import {
  existsSync,
  promises as fs,
  lstatSync,
  mkdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { validateSpriteToken } from "../../../packages/sprites/src/credentials.ts";

export function assertApplicationMode(env: NodeJS.ProcessEnv = process.env) {
  if (env.CIVIC_SPARK_MAINTENANCE !== undefined && env.CIVIC_SPARK_MAINTENANCE !== "off")
    throw new Error("Application startup is blocked by maintenance mode");
}

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
  assertApplicationMode(env);
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
  const path = join(root, "control-plane-writer.sqlite");
  try {
    if (!lstatSync(path).isFile())
      throw new Error("Writer lock must be a regular file, not a link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    db.close();
    throw new Error("The data directory already has an active control-plane writer");
  }
  return () => db.close();
}

export function storageReady(root: string) {
  storageHeadroom(root);
  const path = join(root, ".civic-spark-health");
  writeFileSync(path, "ready", { mode: 0o600 });
  rmSync(path);
}

/** Share only an in-flight probe; every later request performs a fresh check. */
export function createStorageReadiness(root: string) {
  let pending: Promise<void> | undefined;
  const probe = async () => {
    // Health must not hold the event loop in a filesystem write/journal wait.
    // Keep the same headroom and real-write requirements as startup readiness.
    const stats = await Promise.all([...new Set([root, tmpdir()])].map((path) => fs.statfs(path)));
    for (const stat of stats) requireHeadroom(stat);
    const path = join(root, `.civic-spark-health-${randomUUID()}`);
    const file = await fs.open(path, "wx", 0o600);
    try {
      await file.writeFile("ready");
    } finally {
      try {
        await file.close();
      } finally {
        await fs.rm(path, { force: true });
      }
    }
  };
  return () => {
    pending ??= probe().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

function requireHeadroom(stat: { bavail: number; bsize: number }, incomingBytes = 0) {
  const available = stat.bavail * stat.bsize;
  if (available < 128 * 1024 * 1024 + incomingBytes * 2)
    throw new Error(
      "Server storage is nearly full. Ask the event operator to add space, then retry.",
    );
}

/** Check both persistent data and temporary/root filesystem; growth of one cannot repair the other. */
export function storageHeadroom(root: string, incomingBytes = 0) {
  for (const path of new Set([root, tmpdir()])) {
    requireHeadroom(statfsSync(path), incomingBytes);
  }
}
