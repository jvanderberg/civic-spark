import { afterEach, expect, it, vi } from "vitest";
import { inspectRecoverySprite } from "../packages/backup/src/recovery.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";

const name = "civic-spark-membership-test";
const org = "test-org";
const token = `${org}/account/id/secret`;
const origin = "https://provider.example.test";
// Observed201 + exactGET + complete prefixList relationship, with synthetic identifiers.
const resource = { id: "stable-resource-id", name, organization: "personal" };
const certificate = {
  name: org,
  sprites: [resource],
  has_more: false,
  next_continuation_token: null,
};
const preliminary = {
  name: org,
  sprites: [{ name: "unrelated", organization: "personal" }],
  has_more: true,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function fixture(
  proof: unknown = certificate,
  target: unknown = resource,
  first: unknown = preliminary,
  proofStatus = 200,
  targetStatus = 200,
) {
  vi.stubEnv("SPRITE_TOKEN", token);
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", org);
  vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", origin);
  const request = vi.fn<typeof fetch>(async (url, options) => {
    if (options?.method === "POST") return Response.json(target, { status: 201 });
    const parsed = new URL(String(url));
    if (parsed.searchParams.has("prefix")) return Response.json(proof, { status: proofStatus });
    if (parsed.search) return Response.json(first);
    return Response.json(target, { status: targetStatus });
  });
  const logger = vi.fn();
  return { request, client: new SpriteClient(org, undefined, request, logger), logger };
}

it("accepts the observed opaque organization only with complete identical membership, through both GET callers and POST", async () => {
  const f = fixture();
  await expect(inspectRecoverySprite(name, org, origin, token, f.request)).resolves.toBe("present");
  await expect(f.client.inspectReservation(name, true)).resolves.toBe("present");
  await expect(f.client.inspectReservation(name)).resolves.toBe("present");
  await expect(f.client.create(name)).resolves.toEqual({ ok: true, value: name });
  expect(f.request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  expect(f.logger).toHaveBeenCalledWith(
    expect.objectContaining({
      httpStatus: 201,
      confirmed: true,
      response: expect.objectContaining({
        organizationMatchesOrg: false,
        organizationMatchesAccount: false,
      }),
    }),
  );
  for (const [url, options] of f.request.mock.calls) {
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe(origin);
    expect(options).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (parsed.searchParams.has("prefix")) {
      expect(parsed.searchParams.get("prefix")).toBe(name);
      expect(parsed.searchParams.get("max_results")).toBe("2");
    }
  }
});

it.each([
  ["explicit error envelope", { ...certificate, error: "permission_denied" }],
  ["wrong org", { ...certificate, name: "other-org" }],
  ["no org", { ...certificate, name: undefined }],
  ["incomplete", { ...certificate, has_more: true }],
  ["missing completeness", { ...certificate, has_more: undefined }],
  ["continuation", { ...certificate, next_continuation_token: "next" }],
  ["malformed continuation", { ...certificate, next_continuation_token: 4 }],
  ["no target", { ...certificate, sprites: [] }],
  ["null sprites", { ...certificate, sprites: null }],
  ["duplicate target", { ...certificate, sprites: [resource, resource] }],
  ["wrong ID", { ...certificate, sprites: [{ ...resource, id: "other" }] }],
  ["missing ID", { ...certificate, sprites: [{ ...resource, id: undefined }] }],
  ["empty ID", { ...certificate, sprites: [{ ...resource, id: "" }] }],
  ["prefix-only match", { ...certificate, sprites: [{ ...resource, name: `${name}-other` }] }],
  ["different organization", { ...certificate, sprites: [{ ...resource, organization: "other" }] }],
  ["explicit slug conflict", { ...certificate, sprites: [{ ...resource, org_slug: "other" }] }],
])(
  "fails closed on %s certificate for both GET callers and a single POST",
  async (_label, proof) => {
    const f = fixture(proof);
    await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow();
    expect(await f.client.inspectReservation(name, true)).toBe("unknown");
    expect(await f.client.create(name)).toMatchObject({ ok: false, creationFailure: "unknown" });
    expect(f.request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      1,
    );
  },
);

it.each([401, 403, 429, 500])(
  "membership HTTP%s never grants ownership or another POST",
  async (status) => {
    const f = fixture(certificate, resource, preliminary, status);
    await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow();
    expect(await f.client.inspectReservation(name, true)).toBe("unknown");
    expect(await f.client.create(name)).toMatchObject({ ok: false });
    expect(f.request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      1,
    );
  },
);

it.each(["personal", org])(
  "carries conflicting preliminary target evidence through the %s resource path",
  async (organization) => {
    const target = { ...resource, organization };
    const f = fixture({ ...certificate, sprites: [target] }, target, {
      name: org,
      sprites: [{ ...target, id: "contradictory-id" }],
    });
    await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow();
    expect(await f.client.inspectReservation(name, true)).toBe("unknown");
    expect(
      f.request.mock.calls.some(([url]) => new URL(String(url)).searchParams.has("prefix")),
    ).toBe(false);
  },
);

it("a witnessed target plus named404 stays unknown and forbids guarded creation", async () => {
  const f = fixture(certificate, null, certificate, 200, 404);
  await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow(
    "unknown",
  );
  expect(await f.client.inspectReservation(name, true)).toBe("unknown");
  expect(await f.client.create(name, async () => {}, true)).toMatchObject({ ok: false });
  expect(f.request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
});

it.each(["token", "origin", "org", "lease"])(
  "rejects %s changes while membership proof awaits",
  async (change) => {
    const f = fixture();
    const controller = new AbortController();
    const client = new SpriteClient(
      org,
      () => ({ signal: controller.signal, release() {} }),
      f.request,
      f.logger,
    );
    const original = f.request.getMockImplementation();
    f.request.mockImplementation(async (url, options) => {
      const result = await original?.(url, options);
      if (new URL(String(url)).searchParams.has("prefix")) {
        if (change === "token") vi.stubEnv("SPRITE_TOKEN", `${org}/other-account/id/rotated`);
        if (change === "origin")
          vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", "https://other.example.test");
        if (change === "org") vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "other-org");
        if (change === "lease") controller.abort();
      }
      if (!result) throw Error("Missing fixture response");
      return result;
    });
    expect(await client.create(name)).toMatchObject({ ok: false, creationFailure: "unknown" });
    expect(f.request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      1,
    );
  },
);

function delayedProof(action: () => void) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          action();
          controller.enqueue(new TextEncoder().encode(JSON.stringify(certificate)));
          controller.close();
        }, 5);
      },
    }),
  );
}

it.each(["backup", "client", "create"] as const)(
  "%s rejects binding changes during the membership response body await",
  async (caller) => {
    for (const key of [
      "SPRITE_TOKEN",
      "CIVIC_SPARK_SPRITE_ORG",
      "CIVIC_SPARK_SPRITE_API_URL",
    ] as const) {
      const f = fixture();
      const original = f.request.getMockImplementation();
      if (!original) throw Error("Missing fixture request");
      f.request.mockImplementation(async (url, options) => {
        if (new URL(String(url)).searchParams.has("prefix"))
          return delayedProof(() =>
            vi.stubEnv(key, key === "SPRITE_TOKEN" ? `${org}/other/id/rotated` : "changed"),
          );
        return original(url, options);
      });
      if (caller === "backup")
        await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow();
      else if (caller === "client")
        expect(await f.client.inspectReservation(name, true)).toBe("unknown");
      else
        expect(await f.client.create(name)).toMatchObject({
          ok: false,
          creationFailure: "unknown",
        });
      expect(f.request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
        caller === "create" ? 1 : 0,
      );
    }
  },
);

it.each(["lease", "deadline", "proof-deadline"] as const)(
  "rejects %s abort during the POST membership body even if the transport still supplies valid JSON",
  async (kind) => {
    const f = fixture();
    const abort = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    if (kind !== "lease")
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
        ms === (kind === "deadline" ? 120000 : 15000) ? abort.signal : originalTimeout(ms),
      );
    const original = f.request.getMockImplementation();
    if (!original) throw Error("Missing fixture request");
    f.request.mockImplementation(async (url, options) => {
      if (new URL(String(url)).searchParams.has("prefix"))
        return delayedProof(() => abort.abort(new Error("private-abort-marker")));
      return original(url, options);
    });
    const client = new SpriteClient(
      org,
      kind === "lease" ? () => ({ signal: abort.signal, release() {} }) : undefined,
      f.request,
      f.logger,
    );
    expect(await client.create(name)).toMatchObject({ ok: false, creationFailure: "unknown" });
    expect(f.request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      1,
    );
    expect(JSON.stringify(f.logger.mock.calls)).not.toContain("private-abort-marker");
    expect(f.logger).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: false, creationFailure: "unknown" }),
    );
  },
);

it("rejects explicit preliminary errors before named404 can authorize creation", async () => {
  const f = fixture(certificate, null, { ...preliminary, error: "permission_denied" }, 200, 404);
  await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow();
  expect(await f.client.inspectReservation(name, true)).toBe("unknown");
  expect(await f.client.create(name, async () => {}, true)).toMatchObject({
    ok: false,
    creationFailure: "unknown",
  });
  expect(f.request.mock.calls).toHaveLength(3);
  expect(
    f.request.mock.calls.every(
      ([url, options]) =>
        new URL(String(url)).searchParams.get("max_results") === "1" && options?.method === "GET",
    ),
  ).toBe(true);
});

it.each([org, "personal"])(
  "rejects explicit resource errors on the %s path",
  async (organization) => {
    const f = fixture(certificate, { ...resource, organization, error: "permission_denied" });
    await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow();
    expect(await f.client.inspectReservation(name, true)).toBe("unknown");
    expect(await f.client.create(name)).toMatchObject({ ok: false, creationFailure: "unknown" });
    expect(
      f.request.mock.calls.some(([url]) => new URL(String(url)).searchParams.has("prefix")),
    ).toBe(false);
  },
);

it("returns unknown on proof network failure without exposing the thrown content or posting again", async () => {
  const f = fixture();
  const original = f.request.getMockImplementation();
  if (!original) throw Error("Missing fixture request");
  f.request.mockImplementation(async (url, options) => {
    if (new URL(String(url)).searchParams.has("prefix"))
      throw Error(`private-proof-marker ${token}`);
    return original(url, options);
  });
  const result = await f.client.create(name);
  expect(result).toMatchObject({ ok: false, creationFailure: "unknown" });
  expect(f.request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  expect(JSON.stringify([result, f.logger.mock.calls])).not.toMatch(
    /private-proof-marker|\/secret/,
  );
});

it("retains explicit constructor org semantics but refuses stale default configuration before dispatch", async () => {
  const f = fixture();
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "other-default");
  expect(await f.client.create(name)).toMatchObject({ ok: true });
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", org);
  const defaults = new SpriteClient(undefined, undefined, f.request, f.logger);
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "rotated-default");
  f.request.mockClear();
  expect(await defaults.create(name)).toMatchObject({ ok: false, creationFailure: "unknown" });
  expect(await defaults.inspectReservation(name, true)).toBe("unknown");
  expect(f.request).not.toHaveBeenCalled();
});

it.each([200, 201])(
  "guarded creation retains its201 requirement with opaque HTTP%s resource identity",
  async (status) => {
    const f = fixture(certificate, resource, preliminary, 200, 404);
    const original = f.request.getMockImplementation();
    if (!original) throw Error("Missing fixture request");
    f.request.mockImplementation(async (url, options) =>
      options?.method === "POST" ? Response.json(resource, { status }) : original(url, options),
    );
    const result = await f.client.create(name, async () => {}, true);
    expect(result).toMatchObject(
      status === 201 ? { ok: true } : { ok: false, creationFailure: "unknown" },
    );
    expect(f.request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
      1,
    );
  },
);

it("revalidates configured organization after the guarded pre-dispatch callback", async () => {
  const f = fixture(certificate, resource, preliminary, 200, 404);
  let calls = 0;
  expect(
    await f.client.create(
      name,
      async () => {
        if (++calls === 2) vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "rotated-org");
      },
      true,
    ),
  ).toMatchObject({ ok: false, creationFailure: "unknown" });
  expect(calls).toBe(2);
  expect(f.request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
});
