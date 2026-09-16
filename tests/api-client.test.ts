import { afterEach, expect, it, vi } from "vitest";
import { api } from "../apps/web/src/api.ts";

afterEach(() => vi.unstubAllGlobals());
it("keeps JSON errors actionable and never retries a failed launch", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ error: "No web app exists yet. Create a Vite app first." }, { status: 409 }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(api("/workspaces/test/preview", "POST", { action: "start" })).rejects.toThrow(
    "No web app exists yet",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(["", "<html>proxy failure with private details</html>"])(
  "handles empty or non-JSON proxy failures without leaking the body",
  async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 502 })),
    );
    await expect(api("/workspaces/test/preview")).rejects.toThrow("HTTP 502");
    await expect(api("/workspaces/test/preview")).rejects.not.toThrow("private details");
  },
);
it("rejects an empty success as incomplete instead of claiming launch succeeded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 200 })),
  );
  await expect(api("/workspaces/test/preview")).rejects.toThrow("incomplete response");
});
it("supports deliberate no-content responses and normal JSON results", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ ready: true })),
  );
  await expect(api<void>("/action", "POST")).resolves.toBeUndefined();
  await expect(api("/preview")).resolves.toEqual({ ready: true });
});
it("reports an interrupted body without automatically repeating the action", async () => {
  const fetch = vi.fn(async () => ({
    status: 200,
    ok: true,
    text: async () => {
      throw new TypeError("terminated");
    },
  }));
  vi.stubGlobal("fetch", fetch);
  await expect(api("/preview", "POST", { action: "start" })).rejects.toThrow(
    "connection was interrupted",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
