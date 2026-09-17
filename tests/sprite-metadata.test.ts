import { afterEach, expect, it, vi } from "vitest";
import { inspectRecoverySprite } from "../packages/backup/src/recovery.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";

const org = "test-org";
const name = "civic-spark-recovery-contract";
const token = `${org}/account/token/private-value`;
const origin = "https://provider.example.test";
// Sanitized reproduction of the live List shape, not an accepted resource alias.
const liveList = {
  name: org,
  sprites: [{ id: "unrelated-id", name: "unrelated-sprite", organization: "unexplained-claim" }],
  has_more: true,
  next_continuation_token: "next-page",
};
afterEach(() => vi.unstubAllEnvs());

function fixture(list: unknown, resource: unknown = null, status = 404, listStatus = 200) {
  vi.stubEnv("SPRITE_TOKEN", token);
  vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", origin);
  const request = vi.fn<typeof fetch>(async (url) =>
    new URL(String(url)).search
      ? Response.json(list, { status: listStatus })
      : Response.json(resource, { status }),
  );
  return { request, client: new SpriteClient(org, undefined, request) };
}

it.each([
  ["live unrelated row", liveList],
  [
    "matching target and unrelated conflicting row",
    { ...liveList, sprites: [...liveList.sprites, { name, organization: org, org_slug: org }] },
  ],
  ["current empty list", { name: org, sprites: [] }],
  ["SDK null list with authenticated identity", { name: org, sprites: null }],
  ["legacy empty list", { sprites: [] }],
  ["legacy org_slug rows", { sprites: [{ name: "example", org_slug: org }] }],
])("both recovery boundaries accept %s and require a fresh named404", async (_label, list) => {
  const f = fixture(list);
  await expect(inspectRecoverySprite(name, org, origin, token, f.request)).resolves.toBe("missing");
  await expect(f.client.inspectReservation(name, true)).resolves.toBe("missing");
  expect(f.request.mock.calls.map(([url]) => String(url))).toEqual([
    `${origin}/v1/sprites?max_results=1`,
    `${origin}/v1/sprites/${name}`,
    `${origin}/v1/sprites?max_results=1`,
    `${origin}/v1/sprites/${name}`,
  ]);
  for (const [, options] of f.request.mock.calls)
    expect(options).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}` },
    });
});

it.each([
  ["wrong top-level identity", { ...liveList, name: "wrong-org" }],
  ["null identity", { name: null, sprites: [] }],
  ["unidentified null collection", { sprites: null }],
  ["missing collection", { name: org }],
  ["invalid collection", { name: org, sprites: {} }],
  ["invalid row", { name: org, sprites: [null] }],
  ["malformed row claim", { name: org, sprites: [{ name: "example", organization: 42 }] }],
  ["legacy conflict", { sprites: [{ name: "example", organization: "wrong-org" }] }],
])("both boundaries reject %s before exact resource lookup", async (_label, list) => {
  const f = fixture(list);
  await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow(
    "Provider organization",
  );
  await expect(f.client.inspectReservation(name, true)).resolves.toBe("unknown");
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.request.mock.calls.every(([url]) => new URL(String(url)).search !== "")).toBe(true);
});

it.each([
  [{ name, organization: "wrong-org" }],
  [{ name, org_slug: "wrong-org" }],
  [{ name, organization: org, org_slug: "wrong-org" }],
  [{ name, organization: "wrong-org", org_slug: org }],
  [
    { name, organization: org },
    { name, organization: "wrong-org" },
  ],
])("target ownership conflict blocks named404 and guarded POST: %j", async (...rows) => {
  const f = fixture({ ...liveList, sprites: [...liveList.sprites, ...rows] });
  await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow(
    "Provider organization",
  );
  await expect(f.client.inspectReservation(name, true)).resolves.toBe("unknown");
  const guard = vi.fn(async () => {});
  await expect(f.client.create(name, guard, true)).resolves.toMatchObject({
    ok: false,
    creationFailure: "unknown",
  });
  expect(guard).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenCalledTimes(3);
  for (const [url, options] of f.request.mock.calls) {
    expect(String(url)).toBe(`${origin}/v1/sprites?max_results=1`);
    expect(options?.method).toBe("GET");
  }
});

it.each([401, 403, 429, 503])("List HTTP%s cannot authenticate either boundary", async (status) => {
  const f = fixture(liveList, null, 404, status);
  await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow(
    "cannot be authenticated",
  );
  await expect(f.client.inspectReservation(name, true)).resolves.toBe("unknown");
  expect(f.request).toHaveBeenCalledTimes(2);
});

it.each([
  [200, { id: "sprite-id", name, organization: org }, "present"],
  [200, { id: "sprite-id", name, organization: org, org_slug: org }, "present"],
  [200, { id: "sprite-id", name, organization: "unexplained-claim" }, "unknown"],
  [200, { id: "sprite-id", name, organization: org, org_slug: "wrong-org" }, "unknown"],
  [200, { id: "sprite-id", name: "different", organization: org }, "unknown"],
  [200, { id: "sprite-id", name }, "unknown"],
  [401, null, "unknown"],
  [403, null, "unknown"],
  [429, null, "unknown"],
  [503, null, "unknown"],
] as const)(
  "List identity cannot override named HTTP%s ownership: %j",
  async (status, body, outcome) => {
    const f = fixture(liveList, body, status);
    if (outcome === "unknown")
      await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow();
    else
      await expect(inspectRecoverySprite(name, org, origin, token, f.request)).resolves.toBe(
        outcome,
      );
    await expect(f.client.inspectReservation(name, true)).resolves.toBe(outcome);
    expect(f.request).toHaveBeenCalledTimes(4);
  },
);

it.each(["matching", "conflicting"])(
  "guarded create passes List authentication but still requires %s returned resource claims",
  async (claim) => {
    const f = fixture(liveList);
    f.request.mockImplementation(async (url, options) => {
      if (options?.method === "POST")
        return Response.json(
          { name, organization: org, org_slug: claim === "matching" ? org : "wrong-org" },
          { status: 201 },
        );
      return new URL(String(url)).search
        ? Response.json(liveList)
        : Response.json(null, { status: 404 });
    });
    const guard = vi.fn(async () => {});
    const result = await f.client.create(name, guard, true);
    expect(result).toMatchObject(
      claim === "matching" ? { ok: true, value: name } : { ok: false, creationFailure: "unknown" },
    );
    expect(guard).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls.map(([, options]) => options?.method)).toEqual([
      "GET",
      "GET",
      "POST",
    ]);
  },
);

it("does not disclose adversarial metadata claims or malformed bodies", async () => {
  const secret = "Bearer private-token $TOKEN `command` https://user:password@example.test";
  const f = fixture({ ...liveList, name: secret });
  await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow(
    /^Provider organization mismatch or invalid metadata$/,
  );
  expect(await f.client.inspectReservation(name, true)).toBe("unknown");
  f.request.mockImplementation(async () => new Response(secret.repeat(5000)));
  await expect(inspectRecoverySprite(name, org, origin, token, f.request)).rejects.toThrow(
    /^Provider organization mismatch or invalid metadata$/,
  );
  expect(await f.client.inspectReservation(name, true)).toBe("unknown");
});
