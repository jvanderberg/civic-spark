import { expect, it, vi } from "vitest";
import { SpriteLifecycle, spriteEstimate } from "../packages/sprites/src/lifecycle.ts";

it("reads only named management metadata without exposing commands, URLs or credentials", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        status: "warm",
        created_at: "2026-09-16T00:00:00Z",
        updated_at: "2026-09-16T01:00:00Z",
        name: "civic-spark-fixture",
        url: "https://private.example",
        secret: "do-not-return",
      }),
    ),
  );
  const provider = new SpriteLifecycle("fixture-token", "https://api.example", request);
  const info = await provider.inspect("civic-spark-fixture");
  expect(info.status).toBe("warm");
  expect(JSON.stringify(info)).not.toMatch(/private|secret|token/);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0]).toBe("https://api.example/v1/sprites/civic-spark-fixture");
  expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
});
it("does not wake a sleeping Sprite even to enumerate sessions or stop work", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response('{"status":"cold"}'));
  const managed = vi.fn();
  await new SpriteLifecycle("fixture", "https://api.example", request, managed).stop(
    "civic-spark-fixture",
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(managed).not.toHaveBeenCalled();
});
it("stops services and exec sessions without deleting or recreating the Sprite and surfaces partial failures", async () => {
  const requests: string[] = [];
  const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push(`${init?.method} ${path}`);
    if (path.endsWith("/services"))
      return Response.json([{ name: "web", env: { secret: "private" } }, { name: "worker" }]);
    if (path.endsWith("/exec"))
      return Response.json([{ id: 123, command: "SECRET=private run" }, { id: 456 }]);
    if (path.endsWith("/worker/stop"))
      return new Response("private provider diagnostics", { status: 502 });
    if (path.endsWith("/kill") || path.endsWith("/stop"))
      return new Response('{"type":"complete"}\n');
    return Response.json({ status: "running" });
  });
  const managed = vi.fn().mockResolvedValue(undefined);
  await expect(
    new SpriteLifecycle("fixture", "https://api.example", request, managed).stop(
      "civic-spark-fixture",
    ),
  ).rejects.toThrow("Some Sprite work could not be stopped");
  expect(managed).toHaveBeenCalledWith("civic-spark-fixture");
  expect(requests.filter((path) => path.endsWith("/kill"))).toHaveLength(2);
  expect(requests.every((path) => !path.startsWith("DELETE") && !path.endsWith("/sprites"))).toBe(
    true,
  );
});
it("rejects unsafe API origins, malformed metadata and missing dates without invented costs", async () => {
  expect(() => new SpriteLifecycle("x", "http://provider.example")).toThrow("HTTPS");
  expect(() => new SpriteLifecycle("x", "https://user:secret@provider.example")).toThrow("HTTPS");
  const provider = new SpriteLifecycle(
    "x",
    "https://api.example",
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: "running", created_at: "invalid", token: "secret" }),
      ),
  );
  expect(await provider.inspect("civic-spark-fixture")).toMatchObject({
    status: "unknown",
    createdAt: null,
  });
  expect(spriteEstimate(null).estimatedUsd).toBeNull();
  expect(
    spriteEstimate("2026-09-16T00:00:00Z", Date.parse("2026-09-16T01:00:00Z")).estimatedUsd,
  ).toBeCloseTo(0.11131);
});

it.each([
  '{"type":"stopping"}\n{"type":"error","data":"PRIVATE"}\n{"type":"complete"}\n',
  '{"type":"stopping"}\n',
])(
  "treats streamed provider failures and missing completion as retryable even with HTTP 200",
  async (stream) => {
    const request = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/services")) return Response.json([{ name: "web" }]);
      if (path.endsWith("/exec")) return Response.json([]);
      if (path.endsWith("/stop")) return new Response(stream);
      return Response.json({ status: "running" });
    });
    await expect(
      new SpriteLifecycle("fixture", "https://api.example", request, async () => {}).stop(
        "civic-spark-fixture",
      ),
    ).rejects.toThrow("Some Sprite work could not be stopped");
  },
);

it.each(["array", "envelope"])(
  "stops every validated exec session in the %s response, including is_active:false",
  async (shape) => {
    const sessions = [
      { id: 123, is_active: true },
      { id: "session-456", is_active: false, command: "PRIVATE command" },
    ];
    const kills: string[] = [];
    const request = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/services")) return Response.json([]);
      if (path.endsWith("/exec"))
        return Response.json(shape === "array" ? sessions : { count: 2, sessions });
      if (path.endsWith("/kill")) {
        kills.push(path);
        return new Response('{"type":"signal"}\n{"type":"complete"}\n');
      }
      return Response.json({ status: "running" });
    });
    const managed = vi.fn(async () => {});
    await new SpriteLifecycle("fixture", "https://api.example", request, managed).stop(
      "civic-spark-fixture",
    );
    expect(managed).toHaveBeenCalledOnce();
    expect(kills).toEqual([
      "/v1/sprites/civic-spark-fixture/exec/123/kill",
      "/v1/sprites/civic-spark-fixture/exec/session-456/kill",
    ]);
  },
);

it("accepts an empty exec envelope without requesting any kills", async () => {
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.method).toBe("GET");
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/services")) return Response.json([]);
    if (path.endsWith("/exec")) return Response.json({ count: 0, sessions: [] });
    return Response.json({ status: "running" });
  });
  await new SpriteLifecycle("fixture", "https://api.example", request, async () => {}).stop(
    "civic-spark-fixture",
  );
  expect(request).toHaveBeenCalledTimes(3);
});

it.each([
  { count: 2, sessions: [{ id: 123 }, { id: "../another-resource" }] },
  { count: 1, sessions: [{ is_active: false }] },
  { count: 1, sessions: null },
  { count: -1, sessions: [] },
  { count: "1", sessions: [{ id: 123 }] },
  { count: 0 },
])("rejects a malformed exec envelope before killing any session", async (body) => {
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.method).toBe("GET");
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/services")) return Response.json([]);
    if (path.endsWith("/exec")) return Response.json(body);
    return Response.json({ status: "running" });
  });
  await expect(
    new SpriteLifecycle("fixture", "https://api.example", request, async () => {}).stop(
      "civic-spark-fixture",
    ),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(3);
});
