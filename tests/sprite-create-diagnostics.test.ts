import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import type { SpriteCreateDiagnostic } from "../packages/sprites/src/create-diagnostics.ts";

const name = "civic-spark-observer-test";
const org = "test-org";
const account = "private-account";
const token = `${org}/${account}/private-token-id/private-token-value`;
const secret = "Bearer PRIVATE-DIAGNOSTIC $TOKEN `command` https://user:password@example.test";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function fixture(request: typeof fetch, lease?: AbortController) {
  vi.stubEnv("SPRITE_TOKEN", token);
  vi.stubEnv("CIVIC_SPARK_SPRITE_API_URL", "https://provider.example.test");
  const logger = vi.fn<(record: SpriteCreateDiagnostic) => void>();
  const release = vi.fn();
  const client = new SpriteClient(
    org,
    lease ? () => ({ signal: lease.signal, release }) : undefined,
    request,
    logger,
  );
  return { client, logger, release };
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected diagnostic value");
  return value;
}
function safe(record: SpriteCreateDiagnostic) {
  const encoded = JSON.stringify(record);
  for (const value of [
    token,
    account,
    name,
    org,
    secret,
    "private-token",
    "provider.example.test",
    "password",
  ])
    expect(encoded).not.toContain(value);
  expect(encoded.length).toBeLessThan(1500);
  expect(record.reservationHash).toBe(createHash("sha256").update(name).digest("hex"));
  expect(record.durationMs).toBeGreaterThanOrEqual(0);
}

it.each([200, 201])("records successful HTTP%s without provider values", async (status) => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json(
      { id: secret, name, organization: org, org_slug: org, message: secret },
      { status },
    ),
  );
  const f = fixture(request);
  expect(await f.client.create(name)).toEqual({ ok: true, value: name });
  expect(request).toHaveBeenCalledTimes(1);
  expect(f.logger).toHaveBeenCalledTimes(1);
  const record = required(f.logger.mock.calls[0])[0];
  expect(record).toMatchObject({
    event: "sprite.create",
    httpStatus: status,
    requireMissing: false,
    stage: "complete",
    confirmed: true,
    creationFailure: null,
    abortKind: null,
    abortElapsedMs: null,
    response: {
      bodyType: "object",
      idType: "string",
      nameType: "string",
      organizationType: "string",
      nameMatches: true,
      organizationMatchesOrg: true,
      organizationMatchesAccount: false,
      orgSlugMatchesOrg: true,
    },
  });
  expect(record.headersElapsedMs).toBeGreaterThanOrEqual(0);
  expect(record.bodyElapsedMs).toBeGreaterThanOrEqual(required(record.headersElapsedMs));
  expect(record.validationElapsedMs).toBeGreaterThanOrEqual(required(record.bodyElapsedMs));
  expect(record.durationMs).toBeGreaterThanOrEqual(required(record.validationElapsedMs));
  safe(record);
});

it.each([
  [201, { name: secret, organization: account, org_slug: { secret } }, "unknown"],
  [429, { error: "concurrent_sprite_limit_exceeded", message: secret }, "capacity"],
  [401, { error: secret }, "auth"],
  [503, { error: secret }, "transient"],
] as const)(
  "records HTTP%s and safe schema matches on rejected creation",
  async (status, body, failure) => {
    const request = vi.fn<typeof fetch>(async () => Response.json(body, { status }));
    const f = fixture(request);
    expect(await f.client.create(name)).toMatchObject({ ok: false, creationFailure: failure });
    const record = required(f.logger.mock.calls[0])[0];
    expect(record).toMatchObject({
      httpStatus: status,
      confirmed: false,
      creationFailure: failure,
      stage: "complete",
    });
    if (status === 201)
      expect(record.response).toMatchObject({
        nameType: "string",
        orgSlugType: "object",
        nameMatches: false,
        organizationMatchesOrg: false,
        organizationMatchesAccount: true,
      });
    expect(request).toHaveBeenCalledTimes(1);
    expect(f.logger).toHaveBeenCalledTimes(1);
    safe(record);
  },
);

it.each(["invalid-json", "oversized"])("never emits %s response bodies", async (kind) => {
  const f = fixture(
    async () => new Response(kind === "oversized" ? secret.repeat(2000) : secret, { status: 201 }),
  );
  expect(await f.client.create(name)).toMatchObject({ ok: false, creationFailure: "unknown" });
  const record = required(f.logger.mock.calls[0])[0];
  expect(record).toMatchObject({
    httpStatus: 201,
    response: { bodyType: "null", nameType: "absent", nameMatches: false },
  });
  safe(record);
});

it.each([
  ["timeout", "headers"],
  ["timeout", "body"],
  ["lease", "headers"],
  ["lease", "body"],
] as const)(
  "records %s during %s without changing existing failure handling",
  async (kind, stage) => {
    const abort = new AbortController();
    if (kind === "timeout") vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
    const request = vi.fn<typeof fetch>(async (_url, options) => {
      const signal = required(options?.signal);
      setTimeout(() => abort.abort(new Error(secret)), 5);
      if (stage === "headers")
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error(secret)), { once: true }),
        );
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(new Error(secret)), {
              once: true,
            });
          },
        }),
        { status: 201 },
      );
    });
    const f = fixture(request, kind === "lease" ? abort : undefined);
    const failure = kind === "timeout" && stage === "headers" ? "transient" : "unknown";
    expect(await f.client.create(name)).toMatchObject({ ok: false, creationFailure: failure });
    const record = required(f.logger.mock.calls[0])[0];
    expect(record).toMatchObject({
      abortKind: kind,
      abortStage: stage,
      confirmed: false,
      creationFailure: failure,
    });
    expect(record.abortElapsedMs).toBeGreaterThanOrEqual(0);
    expect(record.durationMs).toBeGreaterThanOrEqual(required(record.abortElapsedMs));
    if (stage === "headers")
      expect(record).toMatchObject({
        httpStatus: null,
        headersElapsedMs: null,
        bodyElapsedMs: null,
        validationElapsedMs: null,
        response: null,
      });
    else {
      expect(record.httpStatus).toBe(201);
      expect(record.headersElapsedMs).toBeLessThanOrEqual(required(record.abortElapsedMs));
      expect(record.bodyElapsedMs).toBeGreaterThanOrEqual(required(record.abortElapsedMs));
    }
    expect(request).toHaveBeenCalledTimes(1);
    expect(f.logger).toHaveBeenCalledTimes(1);
    if (kind === "lease") expect(f.release).toHaveBeenCalledTimes(1);
    safe(record);
  },
);

it("distinguishes a transport failure without signal abort", async () => {
  const f = fixture(async () => {
    throw new Error(secret);
  });
  expect(await f.client.create(name)).toMatchObject({ ok: false, creationFailure: "transient" });
  const record = required(f.logger.mock.calls[0])[0];
  expect(record).toMatchObject({
    httpStatus: null,
    stage: "headers",
    abortKind: null,
    confirmed: false,
  });
  safe(record);
});

it("retains201-only guarded creation and logs only its POST", async () => {
  const request = vi.fn<typeof fetch>(async (url, options) =>
    options?.method === "POST"
      ? Response.json({ name, organization: org }, { status: 200 })
      : new URL(String(url)).search
        ? Response.json({ name: org, sprites: [] })
        : new Response(null, { status: 404 }),
  );
  const f = fixture(request);
  expect(await f.client.create(name, async () => {}, true)).toMatchObject({
    ok: false,
    creationFailure: "unknown",
  });
  expect(f.logger).toHaveBeenCalledTimes(1);
  expect(required(f.logger.mock.calls[0])[0]).toMatchObject({
    httpStatus: 200,
    requireMissing: true,
    confirmed: false,
    response: { nameMatches: true, organizationMatchesOrg: true },
  });
  expect(request.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "GET", "POST"]);
  safe(required(f.logger.mock.calls[0])[0]);
});

it("does not log an outbound POST when admission rejects it", async () => {
  const request = vi.fn<typeof fetch>();
  const f = fixture(request);
  expect(
    await f.client.create(name, async () => {
      throw new Error(secret);
    }),
  ).toMatchObject({ ok: false });
  expect(request).not.toHaveBeenCalled();
  expect(f.logger).not.toHaveBeenCalled();
});

it("uses one safe JSON console record by default and isolates logger exceptions", async () => {
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ name, organization: org, environment: secret }, { status: 201 }),
  );
  const f = fixture(request);
  const consoleLog = vi.spyOn(console, "info").mockImplementation(() => {});
  const client = new SpriteClient(org, undefined, request);
  expect(await client.create(name)).toEqual({ ok: true, value: name });
  expect(consoleLog).toHaveBeenCalledTimes(1);
  safe(JSON.parse(String(required(consoleLog.mock.calls[0])[0])));
  f.logger.mockImplementation(() => {
    throw new Error(secret);
  });
  expect(await f.client.create(name)).toEqual({ ok: true, value: name });
  expect(request).toHaveBeenCalledTimes(2);
});
