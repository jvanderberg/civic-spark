import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Runner, Setup } from "./fly-setup.ts";

export class PreviewSetupError extends Error {}

const repository = fileURLToPath(new URL("../", import.meta.url));
const slotSchema = z.object({
  app: z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}$/),
  origin: z.url(),
  created: z.boolean(),
  machineId: z.string().optional(),
  image: z.string().optional(),
  sourceHash: z.string().optional(),
});
const receiptSchema = z
  .object({
    app: z.string(),
    org: z.string(),
    region: z.string(),
    previewIngress: z.object({ version: z.literal(1), slots: z.array(slotSchema) }).optional(),
  })
  .passthrough();
type Receipt = z.infer<typeof receiptSchema>;
function save(path: string, value: Receipt) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
function read(input: Setup, directory: string) {
  const path = join(directory, "receipt.json");
  if (!existsSync(path))
    throw new PreviewSetupError("Provision the management app with its original receipt first");
  const receipt = receiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (receipt.app !== input.app || receipt.org !== input.org || receipt.region !== input.region)
    throw new PreviewSetupError("Preview receipt does not match this installation");
  const slots = receipt.previewIngress?.slots ?? [];
  const names = new Set<string>();
  for (const slot of slots) {
    if (
      slot.app === input.app ||
      slot.origin !== `https://${slot.app}.fly.dev` ||
      names.has(slot.app)
    )
      throw new PreviewSetupError("Preview receipt contains an invalid or duplicate origin");
    names.add(slot.app);
  }
  if (slots.length > input.previewPoolSize)
    throw new PreviewSetupError(
      "Cannot shrink the preview origin pool; retain its capacity and existing bindings",
    );
  return { path, receipt, slots };
}
export function previewPoolForAction(input: Setup, directory: string, action: string): string[] {
  if (!input.previewIngress || ["auth", "provision"].includes(action)) return [];
  if (action === "plan" && !existsSync(join(directory, "receipt.json"))) return [];
  return planPreviewPool(input, directory);
}

/** Local plan only. App names are allocated once, before any cloud mutation. */
export function planPreviewPool(input: Setup, directory: string): string[] {
  const { path, receipt, slots } = read(input, directory);
  const previous = slots.length;
  while (slots.length < input.previewPoolSize) {
    const app = `${input.app.slice(0, 35)}-preview-${slots.length + 1}-${randomBytes(5).toString("hex")}`;
    slots.push({ app, origin: `https://${app}.fly.dev`, created: false });
  }
  receipt.previewIngress = { version: 1, slots };
  if (slots.length !== previous) save(path, receipt);
  return slots.map((slot) => slot.origin);
}
export function previewRelaySecret(directory: string): string {
  const path = join(directory, "preview-relay-secret");
  if (!existsSync(path)) {
    const receipt = receiptSchema.parse(
      JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8")),
    );
    if (receipt.previewIngress?.slots.some((slot) => slot.created))
      throw new PreviewSetupError(
        "Restore the original preview relay secret; it will not be silently rotated",
      );
    writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
    throw new PreviewSetupError(
      "Preview relay secret must be a private regular file with mode 0600",
    );
  const value = readFileSync(path, "utf8");
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new PreviewSetupError("Invalid retained preview relay secret");
  return value;
}
export function previewIngressConfig(input: Setup, app: string) {
  const env = {
    NODE_ENV: "production",
    CIVIC_SPARK_PORT: "4312",
    CIVIC_SPARK_PREVIEW_INGRESS_ORIGIN: `https://${app}.fly.dev`,
    CIVIC_SPARK_PREVIEW_INGRESS_TARGET: input.origin,
  };
  return `# Generated stateless preview ingress; no credentials.\napp = ${JSON.stringify(app)}\nprimary_region = ${JSON.stringify(input.region)}\nkill_signal = "SIGTERM"\nkill_timeout = "15s"\n\n[env]\n${Object.entries(
    env,
  )
    .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
    .join(
      "\n",
    )}\n\n[http_service]\n  internal_port = 4312\n  force_https = true\n  auto_stop_machines = "stop"\n  auto_start_machines = true\n  min_machines_running = 0\n\n[[http_service.checks]]\n  grace_period = "15s"\n  interval = "30s"\n  timeout = "5s"\n  method = "GET"\n  path = "/__civic_spark_ingress_health"\n  [http_service.checks.headers]\n    Host = ${JSON.stringify(`${app}.fly.dev`)}\n\n[[vm]]\n  cpu_kind = "shared"\n  cpus = 1\n  memory = "256mb"\n`;
}
const appsSchema = z.array(
  z.object({ Name: z.string(), Organization: z.object({ Slug: z.string() }) }),
);
const machinesSchema = z.array(
  z.object({
    id: z.string(),
    region: z.string(),
    config: z.object({
      env: z.record(z.string(), z.string()),
      image: z.string(),
      mounts: z.array(z.unknown()).optional(),
      services: z
        .array(
          z.object({
            protocol: z.string(),
            internal_port: z.number(),
            autostop: z.union([z.boolean(), z.string()]).optional(),
            autostart: z.boolean().optional(),
            min_machines_running: z.number().optional(),
            ports: z.array(
              z.object({
                port: z.number(),
                handlers: z.array(z.string()),
                force_https: z.boolean().optional(),
              }),
            ),
          }),
        )
        .optional(),
      guest: z.object({ cpu_kind: z.string(), cpus: z.number(), memory_mb: z.number() }),
    }),
  }),
);
function inspect(input: Setup, slot: z.infer<typeof slotSchema>, run: Runner) {
  const volumes = z
    .array(z.unknown())
    .parse(JSON.parse(run(["volumes", "list", "--app", slot.app, "--json"])));
  const machines = machinesSchema.parse(
    JSON.parse(run(["machine", "list", "--app", slot.app, "--json"])),
  );
  if (
    volumes.length ||
    machines.length > 1 ||
    (slot.machineId && machines.length !== 1) ||
    machines.some(
      (machine) =>
        machine.region !== input.region ||
        machine.config.mounts?.length ||
        machine.config.env.CIVIC_SPARK_PREVIEW_INGRESS_ORIGIN !== slot.origin ||
        machine.config.env.CIVIC_SPARK_PREVIEW_INGRESS_TARGET !== input.origin ||
        machine.config.env.CIVIC_SPARK_PORT !== "4312" ||
        machine.config.services?.length !== 1 ||
        machine.config.services.some(
          (service) =>
            service.protocol !== "tcp" ||
            service.internal_port !== 4312 ||
            ![true, "stop"].includes(service.autostop ?? false) ||
            service.autostart !== true ||
            (service.min_machines_running ?? 0) !== 0 ||
            service.ports.length !== 2 ||
            !service.ports.some(
              (port) =>
                port.port === 80 &&
                port.handlers.length === 1 &&
                port.handlers[0] === "http" &&
                port.force_https === true,
            ) ||
            !service.ports.some(
              (port) =>
                port.port === 443 &&
                port.handlers.length === 2 &&
                port.handlers.includes("http") &&
                port.handlers.includes("tls"),
            ),
        ) ||
        machine.config.guest.cpu_kind !== "shared" ||
        machine.config.guest.cpus !== 1 ||
        machine.config.guest.memory_mb !== 256 ||
        (slot.machineId && slot.machineId !== machine.id),
    )
  )
    throw new PreviewSetupError(
      "Preview app resources do not match the retained stateless ingress receipt",
    );
  return machines;
}
function ingressSourceHash() {
  const sourceHash = createHash("sha256");
  for (const name of [
    "deploy/fly/preview-ingress.Dockerfile",
    "apps/server/src/preview-ingress.ts",
  ])
    sourceHash.update(name).update(readFileSync(resolve(repository, name)));
  return sourceHash.digest("hex");
}
export function requirePreviewPoolReady(input: Setup, directory: string) {
  const { slots } = read(input, directory);
  const fingerprint = ingressSourceHash();
  if (
    slots.length !== input.previewPoolSize ||
    slots.some((slot) => !slot.created || !slot.machineId || slot.sourceHash !== fingerprint)
  )
    throw new PreviewSetupError(
      "Run preview-provision for the complete current ingress pool before deploying the gateway",
    );
  previewRelaySecret(directory);
}

/** Operator-only provisioning. No Fly credential is staged in either runtime. */
export function provisionPreviewPool(input: Setup, directory: string, secret: string, run: Runner) {
  planPreviewPool(input, directory);
  if (!/^[a-f0-9]{64}$/.test(secret))
    throw new PreviewSetupError("Invalid preview relay credential");
  const { path, receipt, slots } = read(input, directory);
  const apps = appsSchema.parse(JSON.parse(run(["apps", "list", "--json"])));
  // Check every existing slot before the first cloud write.
  for (const slot of slots) {
    const existing = apps.find((app) => app.Name === slot.app);
    if (existing && (!slot.created || existing.Organization.Slug !== input.org))
      throw new PreviewSetupError(
        "Refusing to adopt an existing preview app without its original creation receipt",
      );
    if (!existing && slot.created)
      throw new PreviewSetupError(
        "A retained preview app is missing; operator recovery is required",
      );
    if (existing) inspect(input, slot, run);
  }
  const fingerprint = ingressSourceHash();
  let image = slots.find((slot) => slot.sourceHash === fingerprint)?.image;
  for (const slot of slots) {
    if (!slot.created) {
      run([
        "apps",
        "create",
        slot.app,
        "--org",
        input.org,
        "--network",
        input.app,
        "--yes",
        "--json",
      ]);
      slot.created = true;
      save(path, receipt);
    }
    const machines = inspect(input, slot, run);
    if (
      machines.length === 1 &&
      slot.sourceHash === fingerprint &&
      machines[0]?.config.image === slot.image
    )
      continue;
    const config = join(directory, `${slot.app}.toml`);
    writeFileSync(config, previewIngressConfig(input, slot.app), { mode: 0o600 });
    chmodSync(config, 0o600);
    run(
      ["secrets", "import", "--app", slot.app, "--stage"],
      `CIVIC_SPARK_PREVIEW_RELAY_SECRET=${secret}\n`,
    );
    run([
      "deploy",
      repository,
      "--app",
      slot.app,
      "--config",
      config,
      ...(image
        ? ["--image", image]
        : [
            "--dockerfile",
            resolve(repository, "deploy/fly/preview-ingress.Dockerfile"),
            "--remote-only",
          ]),
      "--ha=false",
      "--strategy",
      "immediate",
      "--yes",
    ]);
    const machine = inspect(input, slot, run)[0];
    if (!machine)
      throw new PreviewSetupError("Preview ingress deployment did not create its single Machine");
    slot.machineId = machine.id;
    slot.image = machine.config.image;
    slot.sourceHash = fingerprint;
    image = slot.image;
    save(path, receipt);
  }
  return slots.map((slot) => slot.origin);
}
