import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spriteCreationMessages } from "../packages/domain/src/provisioning.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";

const name = "civic-spark-create-test";
const token = "test-org/org-id/token-id/private-token";
const secret = "Bearer secret-never-rendered $TOKEN `command` https://user:password@example.test";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function fixture(response: () => Response | Promise<Response>) {
  vi.stubEnv("SPRITE_TOKEN", token);
  vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", "https://provider.example.test");
  const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
  const client = new SpriteClient("test-org", undefined, request);
  const command = vi.spyOn(client, "command").mockRejectedValue(new Error("No CLI fallback"));
  return { client, request, command };
}

// Codes and JSON `error` field from superfly/sprites-go/errors.go. Free-form
// `message` and upgrade_url are intentionally never trusted, persisted or returned.
it.each([
  [429, { error: "concurrent_sprite_limit_exceeded", limit: 10, current_count: 10 }, "capacity"],
  [429, { error: "sprite_creation_rate_limited", retry_after_seconds: 30 }, "rate"],
  [429, {}, "rate"],
  [429, { error: "undocumented_warm_limit" }, "unknown"],
  [400, { error: "maximum_sprites" }, "unknown"],
  [401, { error: "concurrent_sprite_limit_exceeded" }, "auth"],
  [403, {}, "auth"],
  [408, {}, "transient"],
  [503, {}, "transient"],
  [409, {}, "unknown"],
  [400, { error: { code: "concurrent_sprite_limit_exceeded" } }, "unknown"],
  [400, { error: "quota reached; maximum 10 running sprites" }, "unknown"],
] as const)(
  "classifies provider HTTP%s %j as %s without leaking diagnostics",
  async (status, body, kind) => {
    const f = fixture(() =>
      Response.json({ ...body, message: secret, upgrade_url: secret }, { status }),
    );
    expect(await f.client.create(name)).toEqual({
      ok: false,
      status: 502,
      creationFailure: kind,
      error: spriteCreationMessages[kind],
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.command).not.toHaveBeenCalled();
  },
);

it("creates once using the configured origin, scoped credential and validated resource identity", async () => {
  const f = fixture(() =>
    Response.json({ name, organization: "test-org", status: "cold" }, { status: 201 }),
  );
  expect(await f.client.create(name)).toEqual({ ok: true, value: name });
  expect(String(f.request.mock.calls[0]?.[0])).toBe("https://provider.example.test/v1/sprites");
  expect(f.request.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    redirect: "error",
    body: JSON.stringify({ name }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.command).not.toHaveBeenCalled();
});

it.each([
  () => Response.json({ name: "different", organization: "test-org" }, { status: 201 }),
  () => Response.json({ name, organization: "different" }, { status: 201 }),
  () => Response.json({ name }, { status: 201 }),
  () => new Response(secret, { status: 200 }),
  () => new Response(secret.repeat(5000), { status: 201 }),
  () => new Response(null, { status: 302, headers: { Location: "https://other.test" } }),
])("never retries/falls back after an ambiguous create response", async (response) => {
  const f = fixture(response);
  expect(await f.client.create(name)).toMatchObject({ ok: false, creationFailure: "unknown" });
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.command).not.toHaveBeenCalled();
});

it("redacts thrown network diagnostics and does not retry the POST", async () => {
  const f = fixture(() => {
    throw Object.assign(new Error(secret), { stderr: secret, stdout: secret });
  });
  expect(await f.client.create(name)).toEqual({
    ok: false,
    status: 502,
    creationFailure: "transient",
    error: spriteCreationMessages.transient,
  });
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.command).not.toHaveBeenCalled();
});

it.each([
  "https://user:password@provider.example.test",
  "http://provider.example.test",
  "https://provider.example.test/path",
])("rejects unsafe origin %s before sending credentials", async (origin) => {
  const f = fixture(() => {
    throw Error("Unexpected request");
  });
  vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", origin);
  expect(await f.client.create(name)).toMatchObject({ ok: false });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.command).not.toHaveBeenCalled();
});

it("rejects mismatched token organization and invalid names before any provider call", async () => {
  const f = fixture(() => {
    throw Error("Unexpected request");
  });
  vi.stubEnv("SPRITE_TOKEN", "other/org/token/private");
  expect(await f.client.create(name)).toMatchObject({ ok: false, creationFailure: "auth" });
  expect(await f.client.create("../../outside")).toMatchObject({ ok: false });
  expect(f.request).not.toHaveBeenCalled();
});

it.each([
  [404, {}, "missing"],
  [401, {}, "unknown"],
  [403, {}, "unknown"],
  [429, {}, "unknown"],
  [503, {}, "unknown"],
  [200, { name, organization: "test-org" }, "present"],
  [200, { name: "different", organization: "test-org" }, "unknown"],
  [200, { name, organization: "different" }, "unknown"],
] as const)(
  "inspects exact reservation HTTP%s without mutating (%s)",
  async (status, body, outcome) => {
    const f = fixture(() => Response.json(body, { status }));
    expect(await f.client.inspectReservation(name)).toBe(outcome);
    expect(String(f.request.mock.calls[0]?.[0])).toBe(
      `https://provider.example.test/v1/sprites/${name}`,
    );
    expect(f.request.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.command).not.toHaveBeenCalled();
  },
);

it("does not guess provider codes or expose secrets from actual adversarial CLI stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-cli-errors-"));
  try {
    const binary = join(root, "sprite");
    writeFileSync(
      binary,
      `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(`${secret}\n{"error":"concurrent_sprite_limit_exceeded"}\nHTTP 401\n`)});process.exit(1);\n`,
    );
    chmodSync(binary, 0o700);
    vi.stubEnv("SPRITE_TOKEN", "");
    vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
    const request = vi.fn<typeof fetch>();
    const client = new SpriteClient("test-org", undefined, request);
    expect(await client.create(name)).toEqual({
      ok: false,
      status: 502,
      creationFailure: "unknown",
      error: spriteCreationMessages.unknown,
    });
    expect(JSON.stringify(await client.command(["create", "--skip-console", name]))).not.toContain(
      "secret-never-rendered",
    );
    expect(request).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
