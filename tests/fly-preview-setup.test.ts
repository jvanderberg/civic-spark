import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  planPreviewPool,
  previewIngressConfig,
  previewPoolForAction,
  previewRelaySecret,
  provisionPreviewPool,
  requirePreviewPoolReady,
} from "../scripts/fly-preview-setup.ts";
import { flyConfig, type Runner, secretInput, setupSchema } from "../scripts/fly-setup.ts";

const input = setupSchema.parse({
  app: "civic-spark-fixture",
  org: "fixture",
  region: "ord",
  origin: "https://portal.example.test",
  spriteOrg: "fixture",
  authMode: "demo",
  proxyCidrs: ["172.19.0.0/16"],
  maxSprites: 2,
  previewIngress: true,
});
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "civic-spark-preview-setup-"));
  directories.push(dir);
  writeFileSync(
    join(dir, "receipt.json"),
    JSON.stringify({
      app: input.app,
      org: input.org,
      region: input.region,
      operatorNote: "retain",
    }),
  );
  return dir;
}
function cloud() {
  const calls: { args: string[]; stdin?: string }[] = [];
  const apps = new Map<
    string,
    {
      machine?: {
        id: string;
        region: string;
        config: {
          env: Record<string, string>;
          image: string;
          services: {
            protocol: string;
            internal_port: number;
            autostop: string | boolean;
            autostart: boolean;
            min_machines_running: number;
            ports: { port: number; handlers: string[]; force_https?: boolean }[];
          }[];
          guest: { cpu_kind: string; cpus: number; memory_mb: number };
        };
      };
    }
  >();
  let deployed = 0;
  const run: Runner = (args, stdin) => {
    calls.push({ args: [...args], stdin });
    const app = args[args.indexOf("--app") + 1] ?? "";
    if (args[0] === "apps" && args[1] === "list")
      return JSON.stringify(
        [...apps].map(([Name]) => ({ Name, Organization: { Slug: input.org } })),
      );
    if (args[0] === "apps" && args[1] === "create") {
      apps.set(args[2] ?? "", {});
      return "{}";
    }
    if (args[0] === "volumes") return "[]";
    if (args[0] === "machine")
      return JSON.stringify(apps.get(app)?.machine ? [apps.get(app)?.machine] : []);
    if (args[0] === "secrets") return "";
    if (args[0] === "deploy") {
      const state = apps.get(app);
      if (!state) throw Error("No app");
      const config = readFileSync(args[args.indexOf("--config") + 1] ?? "", "utf8");
      expect(config).toContain(`Host = "${app}.fly.dev"`);
      expect(config).not.toContain("RELAY_SECRET");
      deployed++;
      state.machine = {
        id: state.machine?.id ?? `machine-${deployed}`,
        region: input.region,
        config: {
          env: {
            CIVIC_SPARK_PREVIEW_INGRESS_ORIGIN: `https://${app}.fly.dev`,
            CIVIC_SPARK_PREVIEW_INGRESS_TARGET: input.origin,
            CIVIC_SPARK_PORT: "4312",
          },
          image: "registry.fly.io/fixture@sha256:fixture",
          services: [
            {
              protocol: "tcp",
              internal_port: 4312,
              autostop: "stop",
              autostart: true,
              min_machines_running: 0,
              ports: [
                { port: 80, handlers: ["http"], force_https: true },
                { port: 443, handlers: ["http", "tls"] },
              ],
            },
          ],
          guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
        },
      };
      return "";
    }
    throw Error(`Unexpected operation ${args[0]}`);
  };
  return { apps, calls, run };
}
it("plans stable full capacity, retains unrelated receipt fields, grows without remapping and refuses shrink", () => {
  const dir = fixture();
  const origins = planPreviewPool(input, dir);
  expect(origins).toHaveLength(2);
  expect(new Set(origins).size).toBe(2);
  expect(planPreviewPool(input, dir)).toEqual(origins);
  expect(JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")).operatorNote).toBe("retain");
  expect(planPreviewPool({ ...input, maxSprites: 3 }, dir).slice(0, 2)).toEqual(origins);
  expect(() => planPreviewPool(input, dir)).toThrow("shrink");
  expect(() => planPreviewPool({ ...input, org: "different" }, dir)).toThrow("match");
});
it("keeps a private stable relay secret and never silently rotates a deployed pool", () => {
  const dir = fixture();
  planPreviewPool(input, dir);
  const secret = previewRelaySecret(dir);
  expect(secret).toMatch(/^[a-f0-9]{64}$/);
  expect(previewRelaySecret(dir)).toBe(secret);
  chmodSync(join(dir, "preview-relay-secret"), 0o644);
  expect(() => previewRelaySecret(dir)).toThrow("0600");
  chmodSync(join(dir, "preview-relay-secret"), 0o600);
  provisionPreviewPool(input, dir, secret, cloud().run);
  unlinkSync(join(dir, "preview-relay-secret"));
  expect(() => previewRelaySecret(dir)).toThrow("Restore");
});
it("provisions bounded single-Machine stateless ingress, uses stdin secrets, shares image and reruns without cloud writes", () => {
  const dir = fixture();
  planPreviewPool(input, dir);
  const secret = previewRelaySecret(dir);
  const mock = cloud();
  expect(() => requirePreviewPoolReady(input, dir)).toThrow("preview-provision");
  const origins = provisionPreviewPool(input, dir, secret, mock.run);
  expect(() => requirePreviewPoolReady(input, dir)).not.toThrow();
  expect(origins).toHaveLength(2);
  const deploys = mock.calls.filter((c) => c.args[0] === "deploy");
  expect(deploys).toHaveLength(2);
  expect(deploys[0]?.args).toContain("--remote-only");
  expect(deploys[1]?.args).toContain("--image");
  expect(mock.calls.some((c) => c.args.includes(secret))).toBe(false);
  expect(
    mock.calls
      .filter((c) => c.stdin)
      .every((c) => c.stdin === `CIVIC_SPARK_PREVIEW_RELAY_SECRET=${secret}\n`),
  ).toBe(true);
  const before = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
  mock.calls.length = 0;
  expect(provisionPreviewPool(input, dir, secret, mock.run)).toEqual(origins);
  expect(mock.calls.every((c) => ["list"].includes(c.args[1] ?? ""))).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"))).toEqual(before);
});
it("refuses unrelated apps and resource drift before any mutation", () => {
  const dir = fixture();
  planPreviewPool(input, dir);
  const secret = previewRelaySecret(dir);
  const mock = cloud();
  const slot = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8")).previewIngress.slots[0];
  mock.apps.set(slot.app, {});
  expect(() => provisionPreviewPool(input, dir, secret, mock.run)).toThrow("adopt");
  expect(mock.calls.every((c) => c.args[1] === "list")).toBe(true);
  mock.apps.clear();
  provisionPreviewPool(input, dir, secret, mock.run);
  const machine = mock.apps.get(slot.app)?.machine;
  if (!machine) throw Error("missing");
  machine.config.env.CIVIC_SPARK_PREVIEW_INGRESS_TARGET = "https://other.example.test";
  mock.calls.length = 0;
  expect(() => provisionPreviewPool(input, dir, secret, mock.run)).toThrow("resources");
  expect(mock.calls.every((c) => c.args[1] === "list")).toBe(true);
});
it("emits a portable public origin pool and permits only the dedicated optional app secret", () => {
  const dir = fixture();
  const pool = planPreviewPool(input, dir);
  const secret = previewRelaySecret(dir);
  expect(flyConfig(input, pool)).toContain("CIVIC_SPARK_PREVIEW_ORIGIN_POOL");
  const config = previewIngressConfig(input, "fixture-preview");
  expect(config).toContain("min_machines_running = 0");
  expect(config).toContain('auto_stop_machines = "stop"');
  expect(config).not.toContain("mounts");
  const envelope = secretInput(input, {
    SPRITE_TOKEN: "fixture/id/token/secret",
    BETTER_AUTH_SECRET: "a".repeat(32),
    CIVIC_SPARK_PREVIEW_RELAY_SECRET: secret,
  });
  expect(
    JSON.parse(Buffer.from(envelope.trim().split("=")[1] ?? "", "base64").toString())
      .CIVIC_SPARK_PREVIEW_RELAY_SECRET,
  ).toBe(secret);
  expect(() =>
    secretInput(input, {
      SPRITE_TOKEN: "fixture/id/token/secret",
      BETTER_AUTH_SECRET: "a".repeat(32),
      FLY_API_TOKEN: "not-permitted",
    }),
  ).toThrow("administration");
});

it("permits plan-first preview setup without minting an ownership receipt", () => {
  const dir = fixture();
  unlinkSync(join(dir, "receipt.json"));
  expect(previewPoolForAction(input, dir, "plan")).toEqual([]);
  expect(existsSync(join(dir, "receipt.json"))).toBe(false);
  expect(() => previewPoolForAction(input, dir, "preview-provision")).toThrow("original receipt");
});
it.each([
  "always-on",
  "no-autostart",
  "minimum-running",
  "wrong-port",
  "plaintext",
  "missing-machine",
])("rejects retained ingress drift: %s", (drift) => {
  const dir = fixture();
  planPreviewPool(input, dir);
  const secret = previewRelaySecret(dir);
  const mock = cloud();
  provisionPreviewPool(input, dir, secret, mock.run);
  const entry = [...mock.apps.values()][0];
  const service = entry?.machine?.config.services[0];
  const httpsPort = service?.ports[1];
  if (!entry || !service || !httpsPort) throw Error("missing fixture");
  if (drift === "always-on") service.autostop = false;
  if (drift === "no-autostart") service.autostart = false;
  if (drift === "minimum-running") service.min_machines_running = 1;
  if (drift === "wrong-port") service.internal_port = 9999;
  if (drift === "plaintext") httpsPort.handlers = ["http"];
  if (drift === "missing-machine") delete entry.machine;
  mock.calls.length = 0;
  expect(() => provisionPreviewPool(input, dir, secret, mock.run)).toThrow("resources");
  expect(mock.calls.every((c) => c.args[1] === "list")).toBe(true);
});

it("rejects managed preview pool and wildcard template together before setup actions", () => {
  expect(() =>
    setupSchema.parse({
      ...input,
      previewOriginTemplate: "https://{workspace}.preview.example.test",
    }),
  ).toThrow("either");
});
