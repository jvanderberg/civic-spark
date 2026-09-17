import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PreviewOriginPool } from "../apps/server/src/preview-origins.ts";
import { planPreviewPool } from "../scripts/fly-preview-setup.ts";
import {
  authorizeExisting,
  flyConfig,
  provision,
  type Runner,
  setupSchema,
} from "../scripts/fly-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const setup = setupSchema.parse({
  app: "capacity-fixture",
  org: "fixture",
  region: "ord",
  origin: "https://portal.example.test",
  spriteOrg: "fixture",
  authMode: "demo",
  proxyCidrs: ["127.0.0.1/32"],
  volumeGb: 10,
  volumeAutoExtend: { enabled: true, thresholdPercent: 80, incrementGb: 5, ceilingGb: 50 },
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-capacity-setup-"));
  roots.push(root);
  const receipt = join(root, "receipt.json");
  writeFileSync(
    receipt,
    JSON.stringify({
      app: setup.app,
      org: setup.org,
      region: setup.region,
      retained: "operator field",
      volume: { id: "vol_fixture", observedGb: 1 },
    }),
  );
  return { root, receipt };
}
it("renders explicit disk growth choices and resource sizes without a Sprite quota", () => {
  const config = flyConfig({ ...setup, managementCpus: 2, managementMemoryMb: 2048 });
  expect(config).toContain("auto_extend_size_threshold = 80");
  expect(config).toContain('auto_extend_size_increment = "5GB"');
  expect(config).toContain('auto_extend_size_limit = "50GB"');
  expect(config).toContain('memory = "2048mb"');
  expect(config).not.toContain("MAX_SPRITES");
  expect(flyConfig({ ...setup, volumeAutoExtend: { enabled: false } })).not.toContain(
    "auto_extend_size_",
  );
  expect(() =>
    setupSchema.parse({
      ...setup,
      volumeAutoExtend: { enabled: true, thresholdPercent: 100, incrementGb: 5, ceilingGb: 10 },
    }),
  ).toThrow();
  expect(() => setupSchema.parse({ ...setup, maxSprites: 8 })).toThrow();
});
it("extends only the retained volume explicitly, tolerates bounded growth, and rejects identity/size drift", () => {
  const { receipt } = fixture();
  let size = 1;
  let id = "vol_fixture";
  const mutations: string[][] = [];
  const run: Runner = (args) => {
    switch (args.slice(0, 2).join(" ")) {
      case "apps list":
        return JSON.stringify([{ Name: setup.app, Organization: { Slug: setup.org } }]);
      case "volumes list":
        return JSON.stringify([{ id, name: "civic_spark_data", region: "ord", size_gb: size }]);
      case "machine list":
        return JSON.stringify([
          {
            id: "machine_fixture",
            config: { env: { CIVIC_SPARK_DEPLOYMENT: "hosted" }, mounts: [{ volume: id }] },
          },
        ]);
      case "volumes extend":
        mutations.push(args);
        size = Number(args[args.indexOf("--size") + 1]);
        return "{}";
      default:
        throw new Error("Unexpected provider operation");
    }
  };
  expect(() => authorizeExisting(setup, receipt, run)).toThrow("volume");
  provision(setup, receipt, run);
  provision(setup, receipt, run);
  expect(mutations).toHaveLength(1);
  expect(size).toBe(10);
  size = 15;
  authorizeExisting(setup, receipt, run);
  const saved = JSON.parse(readFileSync(receipt, "utf8"));
  expect(saved).toMatchObject({
    retained: "operator field",
    volume: { id: "vol_fixture", observedGb: 15 },
  });
  authorizeExisting({ ...setup, volumeAutoExtend: { enabled: false } }, receipt, run);
  id = "replacement";
  expect(() => authorizeExisting(setup, receipt, run)).toThrow("volume");
  id = "vol_fixture";
  size = 51;
  expect(() => authorizeExisting(setup, receipt, run)).toThrow("volume");
  size = 10;
  expect(() => authorizeExisting(setup, receipt, run)).toThrow("volume");
});
it("plans and reuses 60 additional origins beyond eight permanent retained bindings without cloud calls", () => {
  const { root, receipt } = fixture();
  const initial = { ...setup, previewIngress: true, previewPoolSize: 8 };
  const old = planPreviewPool(initial, root);
  const ledger = new PreviewOriginPool(old, root, setup.origin);
  const workspaces = Array.from({ length: 8 }, () => randomUUID());
  for (const id of workspaces) ledger.assign(id);
  expect(() => ledger.assign(randomUUID())).toThrow("capacity");
  const expanded = planPreviewPool({ ...initial, previewPoolSize: 68 }, root);
  expect(planPreviewPool({ ...initial, previewPoolSize: 68 }, root)).toEqual(expanded);
  expect(expanded.slice(0, 8)).toEqual(old);
  const restarted = new PreviewOriginPool(expanded, root, setup.origin);
  expect(workspaces.map((id) => restarted.assign(id))).toEqual(old);
  const newOrigins = Array.from({ length: 60 }, () => restarted.assign(randomUUID()));
  expect(new Set([...old, ...newOrigins]).size).toBe(68);
  expect(() => restarted.assign(randomUUID())).toThrow("capacity");
  expect(JSON.parse(readFileSync(receipt, "utf8")).retained).toBe("operator field");
});
