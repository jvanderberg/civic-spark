import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { fail, ok, type Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
afterEach(() => vi.restoreAllMocks());
it("persists real provisioning phases, deduplicates starts, exposes errors and safely resumes after interruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-provision-"));
  const { app, service, authentication } = await createApp(
    root,
    true,
    "http://127.0.0.1:4310",
    undefined,
    "email",
  );
  let finishCreate!: (value: Result<string>) => void;
  const create = vi.spyOn(SpriteClient.prototype, "create").mockImplementation(
    () =>
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
  );
  const resume = vi.spyOn(SpriteClient.prototype, "exec").mockResolvedValue(ok(Buffer.from("")));
  const upload = vi
    .spyOn(SpriteClient.prototype, "uploadBundle")
    .mockResolvedValue(ok(Buffer.from("")));
  vi.spyOn(SpriteClient.prototype, "files").mockResolvedValue(ok(["README.md"]));
  try {
    const owner = await testIdentity(authentication, "Provision owner");
    const other = await testIdentity(authentication, "Other owner");
    if (!owner.actor) throw new Error("No actor");
    const event = unwrap(
      service.createEvent(owner.actor, {
        name: "Provisioning",
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
        name: "Fresh team",
        projectId: "data-starter",
      }),
    );
    const id = team.workspace.id;
    const url = `/api/workspaces/${id}/sprite`;
    const headers = { cookie: owner.cookie, origin: "http://127.0.0.1:4310" };
    const status = async () => (await app.inject({ url, headers })).json();
    expect(
      (await app.inject({ url, headers: { ...headers, cookie: other.cookie } })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(202);
    expect(await status()).toMatchObject({ spriteStatus: "provisioning", spritePhase: "creating" });
    expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(202);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(`civic-spark-${id}`);
    finishCreate(fail("Provider connection failed; retry when connected", 502));
    await vi.waitFor(async () =>
      expect(await status()).toMatchObject({
        spriteStatus: "error",
        spriteError: expect.stringContaining("Provider connection failed"),
      }),
    );
    expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(202);
    await vi.waitFor(async () =>
      expect(await status()).toMatchObject({ spriteStatus: "ready", spritePhase: "ready" }),
    );
    expect(resume).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(200);
    expect(upload).toHaveBeenCalledTimes(1);
    const persisted = service.portal(owner.actor, true).myWorkspaces.find((w) => w.id === id);
    expect(persisted?.spriteUpdatedAt).toBeTruthy();
    service.setSprite(id, persisted?.spriteName as string, "provisioning", null, "checkout");
    expect(await status()).toMatchObject({
      spriteStatus: "error",
      spriteError: expect.stringContaining("interrupted"),
    });
    expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(202);
    await vi.waitFor(async () => expect(await status()).toMatchObject({ spriteStatus: "ready" }));
  } finally {
    finishCreate?.(fail("Test shutdown"));
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("the checkout script is repeatable and preserves existing edits; unrelated projects are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-checkout-"));
  try {
    git(root, ["init", "--initial-branch=main"]);
    writeFileSync(join(root, "README.md"), "Seed\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "Seed"]);
    const bundle = join(root, "seed.bundle");
    git(root, ["bundle", "create", bundle, "--all"]);
    const script = readFileSync(
      new URL("../packages/sprites/src/checkout.sh", import.meta.url),
      "utf8",
    )
      .replaceAll("/tmp/civic-spark-seed.bundle", bundle)
      .replaceAll("/home/sprite", root);
    const run = () => spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(run().status).toBe(0);
    writeFileSync(join(root, "project", "README.md"), "Participant edit\n");
    expect(run().status).toBe(0);
    expect(readFileSync(join(root, "project", "README.md"), "utf8")).toBe("Participant edit\n");
    git(join(root, "project"), ["checkout", "--orphan", "unrelated"]);
    git(join(root, "project"), ["add", "README.md"]);
    git(join(root, "project"), ["commit", "-m", "Unrelated"]);
    expect(run().status).not.toBe(0);
    expect(readFileSync(join(root, "project", "README.md"), "utf8")).toBe("Participant edit\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
