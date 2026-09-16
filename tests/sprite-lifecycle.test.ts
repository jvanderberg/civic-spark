import { expect, it, vi } from "vitest";
import { cpuLifetimeCeiling, SpriteLifecycle } from "../packages/sprites/src/lifecycle.ts";

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
  expect(cpuLifetimeCeiling(null)).toBeNull();
  expect(
    cpuLifetimeCeiling("2026-09-16T00:00:00Z", Date.parse("2026-09-16T01:00:00Z")),
  ).toBeCloseTo(0.56);
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
