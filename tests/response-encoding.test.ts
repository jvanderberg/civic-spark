import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, expect, it } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { testIdentity } from "./auth-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "civic-spark-encoding-test-"));
const built = await createApp(root, false);
const { app, authentication } = built;
const host = { host: "127.0.0.1:4311" };
afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

it("serves portal state without briefs, then 304 for unchanged polls and brotli/gzip for large bodies", async () => {
  const admin = await testIdentity(authentication, "Admin");
  const headers = { ...host, cookie: admin.cookie };
  const created = await app.inject({
    method: "POST",
    url: "/api/events",
    headers,
    payload: {
      name: "Encoding event",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Fixture",
      capacity: 20,
      budget: 0,
      templateId: "blank",
    },
  });
  expect(created.statusCode).toBe(200);
  const event = created.json();
  const brief = `# Brief\n\n${"Long project brief text. ".repeat(150)}`;
  const project = await app.inject({
    method: "POST",
    url: `/api/events/${event.id}/projects`,
    headers,
    payload: { name: "Encoded project", brief },
  });
  expect(project.statusCode).toBe(200);

  const state = await app.inject({ url: "/api/state", headers });
  expect(state.statusCode).toBe(200);
  expect(state.headers["content-encoding"]).toBeUndefined();
  const etag = String(state.headers.etag);
  expect(etag).toMatch(/^W\/"/);
  const summary = state.json().events.find((e: { id: string }) => e.id === event.id).projects[0];
  expect(summary).toMatchObject({ id: project.json().id, name: "Encoded project" });
  expect(summary).not.toHaveProperty("description");
  expect(JSON.stringify(state.json())).not.toContain("Long project brief text");

  const unchanged = await app.inject({
    url: "/api/state",
    headers: { ...headers, "if-none-match": etag },
  });
  expect(unchanged.statusCode).toBe(304);
  expect(unchanged.body).toBe("");

  const full = await app.inject({
    url: `/api/events/${event.id}/projects/${project.json().id}`,
    headers,
  });
  expect(full.statusCode).toBe(200);
  expect(full.json().description).toBe(brief);
  const br = await app.inject({
    url: `/api/events/${event.id}/projects/${project.json().id}`,
    headers: { ...headers, "accept-encoding": "gzip, deflate, br" },
  });
  expect(br.headers["content-encoding"]).toBe("br");
  expect(br.headers.vary).toBe("accept-encoding");
  expect(JSON.parse(brotliDecompressSync(br.rawPayload).toString()).description).toBe(brief);
  const gz = await app.inject({
    url: `/api/events/${event.id}/projects/${project.json().id}`,
    headers: { ...headers, "accept-encoding": "gzip" },
  });
  expect(gz.headers["content-encoding"]).toBe("gzip");
  expect(JSON.parse(gunzipSync(gz.rawPayload).toString()).description).toBe(brief);
  // Small bodies stay uncompressed; POST results carry no ETag.
  const session = await app.inject({
    url: "/api/session",
    headers: { ...headers, "accept-encoding": "br" },
  });
  expect(session.headers["content-encoding"]).toBeUndefined();

  const stranger = await testIdentity(authentication, "Stranger");
  const hidden = await app.inject({
    url: `/api/events/${event.id}/projects/${project.json().id}`,
    headers: { ...host, cookie: stranger.cookie },
  });
  expect(hidden.statusCode).toBe(404); // Draft events are invisible to non-admins.
  const missing = await app.inject({ url: `/api/events/${event.id}/projects/nope`, headers });
  expect(missing.statusCode).toBe(404);
});
