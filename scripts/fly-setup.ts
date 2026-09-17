import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { validatePreviewOriginTemplate } from "../apps/server/src/preview-config.ts";
import { validateSpriteToken } from "../packages/sprites/src/credentials.ts";
import {
  PreviewSetupError,
  previewPoolForAction,
  previewRelaySecret,
  provisionPreviewPool,
  requirePreviewPoolReady,
} from "./fly-preview-setup.ts";

class SetupError extends Error {}
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}$/);
export const setupSchema = z
  .object({
    app: slug,
    org: slug,
    region: z.string().regex(/^[a-z]{3}$/),
    origin: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.origin === value &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      );
    }, "Use an exact public HTTPS origin"),
    spriteOrg: slug,
    authMode: z.enum(["email", "demo"]).default("email"),
    siteEventId: z.uuid().optional(),
    previewIngress: z.boolean().default(false),
    previewOriginTemplate: z.string().min(1).optional(),
    emailProvider: z.enum(["smtp", "resend"]).optional(),
    emailFrom: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[^\r\n]+$/)
      .optional(),
    proxyCidrs: z.array(z.string().regex(/^[a-fA-F0-9.:]+\/\d{1,3}$/)).min(1),
    volumeGb: z.number().int().min(1).max(100).default(10),
    volumeAutoExtend: z
      .discriminatedUnion("enabled", [
        z.object({ enabled: z.literal(false) }).strict(),
        z
          .object({
            enabled: z.literal(true),
            thresholdPercent: z.number().int().min(1).max(99),
            incrementGb: z.number().int().min(1).max(100),
            ceilingGb: z.number().int().min(1).max(1000),
          })
          .strict(),
      ])
      .default({ enabled: false }),
    managementCpus: z.number().int().min(1).max(8).default(1),
    managementMemoryMb: z.number().int().min(1024).max(32768).default(1024),
    previewPoolSize: z.number().int().min(1).max(10000).default(60),
    maxProvisioning: z.number().int().min(1).max(20).default(2),
    smtpHost: z
      .string()
      .regex(/^[a-zA-Z0-9.-]+$/)
      .optional(),
    smtpPort: z.union([z.literal(465), z.literal(587)]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.volumeAutoExtend.enabled &&
      value.volumeAutoExtend.ceilingGb < value.volumeGb + value.volumeAutoExtend.incrementGb
    )
      ctx.addIssue({
        code: "custom",
        path: ["volumeAutoExtend"],
        message: "The ceiling must allow at least one increment above the initial volume size",
      });
    if (value.previewIngress && value.previewOriginTemplate)
      ctx.addIssue({
        code: "custom",
        path: ["previewIngress"],
        message: "Choose either the managed preview ingress pool or a preview origin template",
      });
    if (value.previewOriginTemplate) {
      try {
        validatePreviewOriginTemplate(value.previewOriginTemplate, value.origin);
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["previewOriginTemplate"],
          message: "Use a separate HTTPS preview origin with one {workspace} hostname label",
        });
      }
    }
    if (value.authMode === "email" && (!value.emailProvider || !value.emailFrom))
      ctx.addIssue({ code: "custom", message: "Email mode requires emailProvider and emailFrom" });
    if (value.emailProvider === "smtp" && (!value.smtpHost || !value.smtpPort))
      ctx.addIssue({ code: "custom", message: "SMTP requires smtpHost and smtpPort" });
  });
export type Setup = z.infer<typeof setupSchema>;
const volumeName = "civic_spark_data";
const quote = (value: string) => JSON.stringify(value);
export function flyConfig(input: Setup, previewOriginPool: string[] = []) {
  const growth = input.volumeAutoExtend;
  const autoExtend = growth.enabled
    ? `  auto_extend_size_threshold = ${growth.thresholdPercent}\n  auto_extend_size_increment = "${growth.incrementGb}GB"\n  auto_extend_size_limit = "${growth.ceilingGb}GB"\n`
    : "";
  const env: Record<string, string> = {
    NODE_ENV: "production",
    CIVIC_SPARK_DEPLOYMENT: "hosted",
    CIVIC_SPARK_AUTH_MODE: input.authMode,
    CIVIC_SPARK_HOST: "0.0.0.0",
    CIVIC_SPARK_PORT: "4311",
    CIVIC_SPARK_DATA_DIR: "/data/civic-spark",
    BETTER_AUTH_URL: input.origin,
    CIVIC_SPARK_ENABLE_SPRITES: "1",
    CIVIC_SPARK_SPRITE_ORG: input.spriteOrg,
    CIVIC_SPARK_PROXY: "fly",
    CIVIC_SPARK_TRUSTED_PROXY_CIDRS: input.proxyCidrs.join(","),
    CIVIC_SPARK_MAX_PROVISIONING: String(input.maxProvisioning),
  };
  if (input.siteEventId) env.CIVIC_SPARK_SITE_EVENT_ID = input.siteEventId;
  if (previewOriginPool.length)
    env.CIVIC_SPARK_PREVIEW_ORIGIN_POOL = JSON.stringify(previewOriginPool);
  if (input.previewOriginTemplate)
    env.CIVIC_SPARK_PREVIEW_ORIGIN_TEMPLATE = input.previewOriginTemplate;
  if (input.authMode === "email")
    Object.assign(env, {
      CIVIC_SPARK_EMAIL_PROVIDER: input.emailProvider,
      CIVIC_SPARK_EMAIL_FROM: input.emailFrom,
    });
  if (input.emailProvider === "smtp")
    Object.assign(env, {
      SMTP_HOST: input.smtpHost,
      SMTP_PORT: String(input.smtpPort),
      SMTP_SECURE: String(input.smtpPort === 465),
    });
  return `# Generated by scripts/fly-setup.ts; no credentials.\napp = ${quote(input.app)}\nprimary_region = ${quote(input.region)}\nkill_signal = "SIGTERM"\nkill_timeout = "30s"\n\n[build]\n  dockerfile = ${quote(relative(resolve(repositoryRoot, ".data/fly", input.app), resolve(repositoryRoot, "deploy/fly/Dockerfile")))}\n\n[env]\n${Object.entries(
    env,
  )
    .map(([k, v]) => `  ${k} = ${quote(v)}`)
    .join(
      "\n",
    )}\n\n[deploy]\n  strategy = "immediate"\n\n[[mounts]]\n  source = "${volumeName}"\n  destination = "/data"\n${autoExtend}\n[http_service]\n  internal_port = 4311\n  force_https = true\n  auto_stop_machines = "off"\n  auto_start_machines = true\n  min_machines_running = 1\n\n[[http_service.checks]]\n  grace_period = "30s"\n  interval = "15s"\n  timeout = "5s"\n  method = "GET"\n  path = "/api/health"\n  [http_service.checks.headers]\n    Host = ${quote(new URL(input.origin).host)}\n\n[[vm]]\n  cpu_kind = "shared"\n  cpus = ${input.managementCpus}\n  memory = "${input.managementMemoryMb}mb"\n`;
}
export type Runner = (args: string[], input?: string) => string;
let checkedFlyVersion = false;
export const runFly: Runner = (args, input) => {
  if (!checkedFlyVersion) {
    const version = spawnSync("fly", ["version"], { encoding: "utf8", timeout: 30000 });
    if (version.status !== 0 || !/^fly v0\.4\.104(?: |$)/.test(version.stdout))
      throw new SetupError("Install the reviewed Fly CLI version 0.4.104 before setup");
    checkedFlyVersion = true;
  }
  const result = spawnSync("fly", args, {
    input,
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  // Never print stderr/stdout on failure: CLI diagnostics can contain secret input.
  if (result.status !== 0)
    throw new SetupError(
      `Fly ${args[0]} ${args[1] ?? ""} failed; check CLI authentication, permissions and configuration`,
    );
  return result.stdout;
};
const appSchema = z.object({ Name: z.string(), Organization: z.object({ Slug: z.string() }) });
const volumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  region: z.string(),
  size_gb: z.number(),
  attached_machine_id: z.string().nullable().optional(),
});
const machineSchema = z.object({
  id: z.string(),
  config: z
    .object({
      env: z.record(z.string(), z.string()).optional(),
      mounts: z.array(z.object({ volume: z.string() })).optional(),
    })
    .optional(),
});
const receiptSchema = z
  .object({
    app: z.string(),
    org: z.string(),
    region: z.string(),
    volume: z.object({ id: z.string(), observedGb: z.number().int().positive() }).optional(),
  })
  .passthrough();
type Receipt = z.infer<typeof receiptSchema>;
function saveReceipt(path: string, receipt: Receipt) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flush: true });
  renameSync(temporary, path);
}
function inspect(input: Setup, run: Runner, receipt?: Receipt, allowExtend = false) {
  const volumes = z
    .array(volumeSchema)
    .parse(JSON.parse(run(["volumes", "list", "--app", input.app, "--json"])));
  const machines = z
    .array(machineSchema)
    .parse(JSON.parse(run(["machine", "list", "--app", input.app, "--json"])));
  if (
    volumes.length > 1 ||
    (receipt?.volume && volumes.length !== 1) ||
    volumes.some(
      (v) =>
        v.name !== volumeName ||
        v.region !== input.region ||
        (receipt?.volume && v.id !== receipt.volume.id) ||
        (!allowExtend && v.size_gb < input.volumeGb) ||
        v.size_gb < (receipt?.volume?.observedGb ?? 0) ||
        v.size_gb >
          Math.max(
            input.volumeGb,
            receipt?.volume?.observedGb ?? 0,
            input.volumeAutoExtend.enabled ? input.volumeAutoExtend.ceilingGb : 0,
          ),
    )
  )
    throw new SetupError(
      "Existing volume does not match this single-writer deployment; no changes made",
    );
  if (
    machines.length > 1 ||
    machines.some(
      (m) =>
        m.config?.env?.CIVIC_SPARK_DEPLOYMENT !== "hosted" ||
        !volumes[0] ||
        m.config?.mounts?.length !== 1 ||
        m.config.mounts[0]?.volume !== volumes[0].id,
    )
  )
    throw new SetupError(
      "Existing Machines do not match this single-writer deployment; no changes made",
    );
  return { volumes, machines };
}
export function authorizeExisting(input: Setup, receiptPath: string, run: Runner = runFly) {
  if (!existsSync(receiptPath))
    throw new SetupError("Original setup receipt is required before modifying an existing app");
  const receipt = receiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
  if (receipt.app !== input.app || receipt.org !== input.org || receipt.region !== input.region)
    throw new SetupError("Setup receipt does not match requested app/org/region");
  const apps = z.array(appSchema).parse(JSON.parse(run(["apps", "list", "--json"])));
  const existing = apps.find((app) => app.Name === input.app);
  if (!existing || existing.Organization.Slug !== input.org)
    throw new SetupError("Remote app is missing or belongs to a different organization");
  const result = inspect(input, run, receipt);
  const volume = result.volumes[0];
  if (volume && (!receipt.volume || receipt.volume.observedGb !== volume.size_gb))
    saveReceipt(receiptPath, { ...receipt, volume: { id: volume.id, observedGb: volume.size_gb } });
  return result;
}

export function provision(input: Setup, receiptPath: string, run: Runner = runFly) {
  const apps = z.array(appSchema).parse(JSON.parse(run(["apps", "list", "--json"])));
  const existing = apps.find((a) => a.Name === input.app);
  if (existing && existing.Organization.Slug !== input.org)
    throw new SetupError("App belongs to a different organization");
  if (!existing && existsSync(receiptPath))
    throw new SetupError(
      "The recorded app is missing. Recover the original deployment; setup will not recreate its identity automatically.",
    );
  if (existing && !existsSync(receiptPath))
    throw new SetupError(
      "Existing app has no local setup receipt. Refusing to adopt it automatically; recover the original receipt or coordinate manual adoption.",
    );
  let receipt: Receipt = { app: input.app, org: input.org, region: input.region };
  if (existsSync(receiptPath)) {
    receipt = receiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
    if (receipt.app !== input.app || receipt.org !== input.org || receipt.region !== input.region)
      throw new SetupError("Setup receipt does not match requested app/org/region");
  }
  if (!existing) {
    // Dedicated network avoids sharing trust with unrelated organization workloads.
    run([
      "apps",
      "create",
      input.app,
      "--org",
      input.org,
      "--network",
      input.app,
      "--yes",
      "--json",
    ]);
    saveReceipt(receiptPath, receipt);
  }
  const { volumes } = inspect(input, run, receipt, true);
  if (!volumes.length)
    run([
      "volumes",
      "create",
      volumeName,
      "--app",
      input.app,
      "--region",
      input.region,
      "--size",
      String(input.volumeGb),
      "--snapshot-retention",
      "7",
      "--yes",
      "--json",
    ]);
  else if (volumes[0] && volumes[0].size_gb < input.volumeGb)
    run([
      "volumes",
      "extend",
      volumes[0].id,
      "--app",
      input.app,
      "--size",
      String(input.volumeGb),
      "--yes",
      "--json",
    ]);
  // Re-inspect after creation/extension; record the immutable identity and size.
  // A timed-out provider mutation is never inferred successful from its request.
  authorizeExisting(input, receiptPath, run);
}
export function secretInput(input: Setup, secrets: Record<string, string>) {
  const allowed = new Set([
    "SPRITE_TOKEN",
    "BETTER_AUTH_SECRET",
    ...(secrets.CIVIC_SPARK_PREVIEW_RELAY_SECRET === undefined
      ? []
      : ["CIVIC_SPARK_PREVIEW_RELAY_SECRET"]),
    ...(input.authMode === "demo"
      ? []
      : input.emailProvider === "smtp"
        ? ["SMTP_USER", "SMTP_PASSWORD"]
        : ["RESEND_API_KEY"]),
  ]);
  if (Object.keys(secrets).some((k) => !allowed.has(k)))
    throw new SetupError(
      "Unsupported secret name; Fly administration credentials must never enter the app",
    );
  for (const name of allowed)
    if (!secrets[name] || /[\r\n\0]/.test(secrets[name]))
      throw new SetupError(`Missing or multiline ${name}`);
  if ((secrets.BETTER_AUTH_SECRET?.length ?? 0) < 32)
    throw new SetupError("BETTER_AUTH_SECRET must contain at least 32 characters");
  if (
    secrets.CIVIC_SPARK_PREVIEW_RELAY_SECRET &&
    secrets.CIVIC_SPARK_PREVIEW_RELAY_SECRET.length < 43
  )
    throw new SetupError(
      "Preview relay secret must contain at least 32 random bytes encoded for transport",
    );
  validateSpriteToken(secrets.SPRITE_TOKEN, input.spriteOrg);
  const envelope = Buffer.from(JSON.stringify(secrets)).toString("base64");
  if (envelope.length > 60000)
    throw new SetupError("Managed credentials exceed the supported secret import size");
  return `CIVIC_SPARK_SECRETS_B64=${envelope}\n`;
}
async function main() {
  const [action, path, ...flags] = process.argv.slice(2);
  if (!action || !path || flags.some((flag) => flag !== "--ambient"))
    throw new SetupError(
      "Usage: npx tsx scripts/fly-setup.ts plan|auth|provision|preview-provision|secrets|verify-sprites|deploy <public-config.json> [--ambient]",
    );
  const input = setupSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const directory = resolve(repositoryRoot, ".data/fly", input.app);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const config = resolve(directory, "fly.toml");
  const previewPool = previewPoolForAction(input, directory, action);
  writeFileSync(config, flyConfig(input, previewPool), { mode: 0o600 });
  chmodSync(config, 0o600);
  if (action === "plan") {
    console.log(`Configuration written: ${config}\nNo cloud resources changed.`);
    console.log(
      `Persistent volume: ${input.volumeGb} GB initially. Auto-extension: ${input.volumeAutoExtend.enabled ? `${input.volumeAutoExtend.thresholdPercent}% used, +${input.volumeAutoExtend.incrementGb} GB, ceiling ${input.volumeAutoExtend.ceilingGb} GB` : "disabled"}. Management: ${input.managementCpus} shared CPUs / ${input.managementMemoryMb} MB.`,
    );
    if (input.previewIngress)
      console.log(
        `Permanent preview origins: ${input.previewPoolSize} total. For 60 additional personal workspaces, retain all existing origins and add at least 60 slots. Origins are never recycled; this is separate from Sprite allocation. Run provision, then preview-provision explicitly to prepare the planned pool. Owned wildcard DNS/TLS with previewOriginTemplate avoids a preallocated pool.`,
      );
    return;
  }
  if (action === "auth") {
    if (!flags.includes("--ambient")) {
      for (const [command, args] of [
        ["fly", ["auth", "login"]],
        ["sprite", ["org", "auth", "--org", input.spriteOrg]],
      ] as const) {
        if (spawnSync(command, args, { stdio: "inherit" }).status !== 0)
          throw new SetupError("Interactive authentication failed");
      }
    }
    runFly(["auth", "whoami"]);
    const result = spawnSync("sprite", ["-o", input.spriteOrg, "list"], {
      stdio: "pipe",
      timeout: 30000,
    });
    if (result.status !== 0) throw new SetupError("Sprite CLI authentication check failed");
    console.log("CLI authentication checked. Use a dedicated Sprite token for hosted secrets.");
    return;
  }
  if (action === "provision") {
    provision(input, resolve(directory, "receipt.json"));
    console.log("App and single volume are ready; no deployment performed.");
    return;
  }
  if (action === "preview-provision") {
    if (!input.previewIngress)
      throw new SetupError("Set previewIngress to true before provisioning preview capacity");
    authorizeExisting(input, resolve(directory, "receipt.json"));
    const secrets = z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(0, "utf8")));
    const relay = previewRelaySecret(directory);
    const envelope = secretInput(input, { ...secrets, CIVIC_SPARK_PREVIEW_RELAY_SECRET: relay });
    provisionPreviewPool(input, directory, relay, runFly);
    runFly(["secrets", "import", "--app", input.app, "--stage"], envelope);
    console.log(
      "Preview capacity provisioned; gateway credentials staged. Deploy the management app when active turns are idle.",
    );
    return;
  }
  if (action === "secrets") {
    authorizeExisting(input, resolve(directory, "receipt.json"));
    // JSON arrives on stdin from a password manager or private file outside this repository.
    const secrets = z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(0, "utf8")));
    if (input.previewIngress)
      secrets.CIVIC_SPARK_PREVIEW_RELAY_SECRET = previewRelaySecret(directory);
    runFly(["secrets", "import", "--app", input.app, "--stage"], secretInput(input, secrets));
    console.log("Secrets staged; deploy to activate. No secret values logged.");
    return;
  }
  if (action === "verify-sprites") {
    const secret =
      process.env.SPRITE_TOKEN ??
      z.object({ SPRITE_TOKEN: z.string() }).parse(JSON.parse(readFileSync(0, "utf8")))
        .SPRITE_TOKEN;
    const token = validateSpriteToken(secret, input.spriteOrg);
    const response = await fetch("https://api.sprites.dev/v1/sprites?max_results=1", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new SetupError("Sprite token API authentication failed");
    // Deliberately discard the response: names and workspace metadata stay private.
    await response.body?.cancel();
    console.log("Sprite API accepted the credential; no resources changed.");
    return;
  }
  if (action === "deploy") {
    if (input.previewIngress) requirePreviewPoolReady(input, directory);
    if (!existsSync(resolve(directory, "receipt.json")))
      throw new SetupError("Run provision with the original setup receipt before deploying");
    const { volumes } = authorizeExisting(input, resolve(directory, "receipt.json"));
    if (volumes.length !== 1) throw new SetupError("Exactly one persistent volume is required");
    runFly([
      "deploy",
      repositoryRoot,
      "--dockerfile",
      resolve(repositoryRoot, "deploy/fly/Dockerfile"),
      "--app",
      input.app,
      "--config",
      config,
      "--remote-only",
      "--ha=false",
      "--strategy",
      "immediate",
      "--yes",
    ]);
    authorizeExisting(input, resolve(directory, "receipt.json"));
    console.log(
      "Deployment complete. Run the documented live verification before inviting participants.",
    );
    return;
  }
  throw new SetupError("Unknown setup action");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error: unknown) => {
    console.error(
      error instanceof SetupError || error instanceof PreviewSetupError
        ? error.message
        : "Invalid configuration or unreadable input. Check setup JSON, secret names and file permissions; provider diagnostics and secret values were suppressed.",
    );
    process.exitCode = 1;
  });
