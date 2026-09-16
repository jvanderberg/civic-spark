import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../apps/server/src/app.ts";
import type { FileContent, Result } from "../packages/domain/src/types.ts";
import { testIdentity } from "../tests/auth-fixture.ts";

const name = process.argv[process.argv.indexOf("--sprite") + 1];
if (!process.argv.includes("--sprite") || !name?.startsWith("vibehack-smoke-"))
  throw new Error(
    "Pass --sprite vibehack-smoke-NAME for an existing dedicated test Sprite. This test temporarily edits README.md and restores it.",
  );
function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
const root = mkdtempSync(join(tmpdir(), "vibehack-remote-files-"));
const { app, service, authentication } = await createApp(root, false);
let original: FileContent | null = null;
let saved: FileContent | null = null;
let workspaceId = "";
let cookie = "";
try {
  const owner = await testIdentity(authentication, "Owner");
  const stranger = await testIdentity(authentication, "Stranger");
  assert(owner.actor);
  cookie = owner.cookie;
  const event = value(
    service.createEvent(owner.actor, {
      name: "Remote file check",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 5,
      budget: 0,
      templateId: "blank",
    }),
  );
  const { workspace } = value(
    service.createTeam(owner.actor, {
      eventId: event.id,
      name: "Test team",
      projectId: "data-starter",
    }),
  );
  workspaceId = workspace.id;
  value(service.setSprite(workspaceId, name, "ready", null));
  const headers = { host: "127.0.0.1:4311", cookie };
  const files = await app.inject({ url: `/api/workspaces/${workspaceId}/files`, headers });
  assert.equal(files.statusCode, 200, files.body);
  assert(files.json().includes("README.md"));
  assert.equal(
    (
      await app.inject({
        url: `/api/workspaces/${workspaceId}/files`,
        headers: { ...headers, cookie: stranger.cookie },
      })
    ).statusCode,
    404,
  );
  const read = await app.inject({
    url: `/api/workspaces/${workspaceId}/file?path=README.md`,
    headers,
  });
  assert.equal(read.statusCode, 200, read.body);
  original = read.json<FileContent>();
  const update = await app.inject({
    method: "PUT",
    url: `/api/workspaces/${workspaceId}/file`,
    headers,
    payload: {
      ...original,
      content: `${original.content}\nTemporary authenticated editor verification.\n`,
    },
  });
  assert.equal(update.statusCode, 200, update.body);
  saved = update.json<FileContent>();
  const reread = await app.inject({
    url: `/api/workspaces/${workspaceId}/file?path=README.md`,
    headers,
  });
  assert.equal(reread.json<FileContent>().revision, saved.revision);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/api/workspaces/${workspaceId}/file`,
        headers,
        payload: { ...original, content: "stale overwrite" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ url: `/api/workspaces/${workspaceId}/file?path=.git/config`, headers }))
      .statusCode,
    404,
  );
  console.log(
    "PASS: authenticated API → real Sprite file listing, read, save, reread; denied another account, stale write, and hidden Git metadata. No models or new Sprites used.",
  );
} finally {
  if (original && saved) {
    const restored = await app.inject({
      method: "PUT",
      url: `/api/workspaces/${workspaceId}/file`,
      headers: { host: "127.0.0.1:4311", cookie },
      payload: { ...original, revision: saved.revision },
    });
    assert.equal(
      restored.statusCode,
      200,
      "Could not restore the temporary README edit; inspect test Sprite",
    );
    console.log("Restored the original README content.");
  }
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
