import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { FILE_LIMIT, TREE_LIMIT } from "../packages/workspace/src/types.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "civic-spark-file-limits-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
it("accepts exactly 25 MiB, rejects one extra byte without overwriting, retains 50 MiB scan and 1 MiB diff limits", () => {
  const dir = directory();
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["commit", "--allow-empty", "-m", "Start"]);
  const fs = new WorkspaceFiles(dir);
  const data = Buffer.alloc(FILE_LIMIT, "a");
  const result = fs.mutate({ path: "large.csv", revision: null, data: data.toString("base64") });
  expect(Buffer.from(fs.read("large.csv").data, "base64").equals(data)).toBe(true);
  expect(() =>
    fs.mutate({
      path: "large.csv",
      revision: result.revision,
      data: Buffer.alloc(FILE_LIMIT + 1, "b").toString("base64"),
    }),
  ).toThrow("25 MiB");
  expect(fs.read("large.csv").revision).toBe(result.revision);
  expect(fs.changes().files[0]?.diff).toContain("preview limited to files up to 1 MB");
  copyFileSync(join(dir, "large.csv"), join(dir, "second.csv"));
  expect(Object.values(fs.manifest().files).reduce((sum, f) => sum + f.size, 0)).toBe(TREE_LIMIT);
  writeFileSync(join(dir, "extra.txt"), "x");
  expect(() => fs.manifest()).toThrow("50 MiB");
}, 30000);

it("carries maximum-size base64 through HTTP and reads/saves large editor text with revision protection", async () => {
  const dir = directory();
  const { app, service, authentication } = await createApp(
    dir,
    false,
    "http://127.0.0.1:4310",
    undefined,
    "email",
  );
  try {
    const owner = await testIdentity(authentication, "Large files");
    if (!owner.actor) throw new Error("No owner");
    const event = unwrap(
      service.createEvent(owner.actor, {
        name: "File limits",
        date: "2026-10-03",
        timezone: "America/Chicago",
        location: "Test",
        capacity: 10,
        budget: 0,
        templateId: "blank",
      }),
    );
    const team = unwrap(
      service.createTeam(owner.actor, {
        eventId: event.id,
        name: "Data",
        projectId: "data-starter",
      }),
    );
    const url = `/api/workspaces/${team.workspace.id}`;
    const headers = { cookie: owner.cookie, origin: "http://127.0.0.1:4310" };
    const content = "x".repeat(FILE_LIMIT);
    const upload = await app.inject({
      method: "PUT",
      url: `${url}/blob`,
      headers,
      payload: { path: "large.csv", revision: null, data: Buffer.from(content).toString("base64") },
    });
    expect(upload.statusCode).toBe(200);
    const read = await app.inject({ url: `${url}/file?path=large.csv`, headers });
    expect(read.statusCode).toBe(200);
    expect(read.json().content).toBe(content);
    const saved = await app.inject({
      method: "PUT",
      url: `${url}/file`,
      headers,
      payload: {
        path: "large.csv",
        revision: read.json().revision,
        content: `y${content.slice(1)}`,
      },
    });
    expect(saved.statusCode).toBe(200);
    const tooLarge = await app.inject({
      method: "PUT",
      url: `${url}/blob`,
      headers,
      payload: {
        path: "large.csv",
        revision: saved.json().revision,
        data: Buffer.from(`${content}z`).toString("base64"),
      },
    });
    expect(tooLarge.statusCode).not.toBe(200);
    const oversizedText = await app.inject({
      method: "PUT",
      url: `${url}/file`,
      headers,
      payload: { path: "large.csv", revision: saved.json().revision, content: `${content}z` },
    });
    expect(oversizedText.statusCode).toBe(413);
    const stale = await app.inject({
      method: "PUT",
      url: `${url}/file`,
      headers,
      payload: { path: "large.csv", revision: read.json().revision, content },
    });
    expect(stale.statusCode).toBe(409);
    expect(readFileSync(join(service.workspacePath(team.workspace.id), "large.csv"), "utf8")).toBe(
      `y${content.slice(1)}`,
    );
    const download = await app.inject({ url: `${url}/blob?path=large.csv`, headers });
    expect(download.statusCode).toBe(200);
    expect(Buffer.from(download.json().data, "base64").toString()).toBe(`y${content.slice(1)}`);
  } finally {
    await app.close();
  }
}, 30000);

it("round-trips 25 MiB through SpriteClient and the real Python adapters, including escaped JSON, without raising Git/diff limits", async () => {
  const dir = directory();
  // Replace only the CLI transport and fixed project/lock paths. Run the actual trusted
  // adapter source in an isolated fixture; never execute project code or use a live Sprite.
  const executable = join(dir, "sprite");
  writeFileSync(
    executable,
    `#!/usr/bin/env python3\nimport sys\nscript = sys.argv[-1].replace('/home/sprite/project', ${JSON.stringify(dir)}).replace('/home/sprite/.civic-spark-file-lock', ${JSON.stringify(join(dir, ".file-lock"))})\nexec(compile(script, '<trusted-sprite-adapter>', 'exec'))\n`,
  );
  chmodSync(executable, 0o755);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
  git(dir, ["init", "--initial-branch=main"]);
  git(dir, ["add", "sprite"]);
  git(dir, ["commit", "-m", "Test fixture"]);
  const client = new SpriteClient();
  const name = "civic-spark-file-limit-test";
  const data = Buffer.alloc(FILE_LIMIT, "a");
  const created = unwrap(
    await client.mutateBlob(name, {
      path: "large.csv",
      revision: null,
      data: data.toString("base64"),
    }),
  );
  expect(unwrap(await client.readBlob(name, "large.csv")).data).toBe(data.toString("base64"));
  expect(unwrap(await client.readFile(name, "large.csv")).content).toBe(data.toString());
  const oversized = await client.mutateBlob(name, {
    path: "large.csv",
    revision: created.revision,
    data: Buffer.alloc(FILE_LIMIT + 1, "b").toString("base64"),
  });
  expect(oversized).toMatchObject({ ok: false, error: expect.stringContaining("25 MiB") });
  expect(unwrap(await client.readBlob(name, "large.csv")).revision).toBe(created.revision);
  expect(
    unwrap(await client.changes(name)).files.find((file) => file.path === "large.csv")?.diff,
  ).toContain("preview limited to files up to 1 MB");
  copyFileSync(join(dir, "large.csv"), join(dir, "second.csv"));
  expect(await client.manifest(name)).toMatchObject({
    ok: false,
    error: expect.stringContaining("50 MiB"),
  });
  unlinkSync(join(dir, "second.csv"));
  // Python JSON escapes these characters: the response exceeds the old 16 MiB CLI buffer.
  const escaped = "\u0001".repeat(3 * 1024 * 1024);
  const saved = unwrap(
    await client.saveFile(name, {
      path: "large.csv",
      content: escaped,
      revision: created.revision as string,
    }),
  );
  expect(saved.content).toBe(escaped);
  expect(unwrap(await client.readFile(name, "large.csv")).content).toBe(escaped);
  expect(
    await client.saveFile(name, {
      path: "large.csv",
      content: "é".repeat(FILE_LIMIT / 2 + 1),
      revision: saved.revision,
    }),
  ).toMatchObject({ ok: false, status: 413 });
  expect(unwrap(await client.readFile(name, "large.csv")).revision).toBe(saved.revision);
}, 60000);
