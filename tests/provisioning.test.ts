import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspaceProvisioning } from "../apps/server/src/provisioning.ts";
import {
  type SpriteCreationFailure,
  spriteCreationMessages,
} from "../packages/domain/src/provisioning.ts";
import { EventService } from "../packages/domain/src/service.ts";
import { fail, ok, type Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
afterEach(() => vi.restoreAllMocks());

it.each(["capacity", "rate", "auth", "transient", "unknown"] as const)(
  "retains original %s creation cause through missing/unknown retries and interrupted restart",
  async (kind: SpriteCreationFailure) => {
    const root = mkdtempSync(join(tmpdir(), "civic-spark-cause-"));
    let service = new EventService(root);
    const owner = {
      id: "cause-owner",
      name: "Owner",
      email: "cause@example.test",
      emailVerified: true as const,
    };
    const event = unwrap(
      service.createEvent(owner, {
        name: "Cause retention",
        date: "2026-10-03",
        timezone: "America/Chicago",
        location: "Test",
        capacity: 10,
        budget: 0,
        templateId: "blank",
      }),
    );
    const workspace = unwrap(
      service.createTeam(owner, {
        eventId: event.id,
        name: "Test team",
        projectId: "data-starter",
      }),
    ).workspace;
    const name = `civic-spark-${workspace.id}`;
    const client = new SpriteClient("test-org");
    const create = vi.spyOn(client, "create").mockResolvedValue({
      ok: false,
      status: 502,
      error: "UNTRUSTED stderr Bearer private-token",
      creationFailure: kind,
    });
    const exec = vi.spyOn(client, "exec").mockResolvedValue(fail("UNTRUSTED retry output"));
    const inspect = vi.spyOn(client, "inspectReservation").mockResolvedValue("missing");
    const upload = vi.spyOn(client, "uploadBundle").mockResolvedValue(ok(Buffer.from("")));
    const files = vi.spyOn(client, "files").mockResolvedValue(ok(["README.md"]));
    let provisioning = new WorkspaceProvisioning(service, root, client);
    const current = () => unwrap(service.workspace(owner, workspace.id));
    const head = () => git(service.workspacePath(workspace.id), ["rev-parse", "HEAD"]).toString();
    const originalHead = head();
    try {
      unwrap(await provisioning.start(current()));
      await provisioning.wait(workspace.id);
      expect(current()).toMatchObject({
        spriteCreationFailure: kind,
        spriteError: spriteCreationMessages[kind],
        spriteName: name,
      });
      for (const outcome of ["missing", "unknown", "missing"] as const) {
        inspect.mockResolvedValue(outcome);
        unwrap(await provisioning.start(current()));
        await provisioning.wait(workspace.id);
        expect(current().spriteCreationFailure).toBe(kind);
        expect(current().spriteError).toContain(spriteCreationMessages[kind]);
        expect(current().spriteError).toContain(
          outcome === "missing" ? "reserved workspace is missing" : "could not be reached",
        );
        expect(current().spriteError).not.toContain("UNTRUSTED");
      }
      expect(create).toHaveBeenCalledTimes(1);
      expect(upload).not.toHaveBeenCalled();
      expect(files).not.toHaveBeenCalled();
      expect(head()).toBe(originalHead);
      // Simulate crash after the retry cleared visible error for its new phase.
      unwrap(service.setSprite(workspace.id, name, "provisioning", null, "creating"));
      await provisioning.close();
      service.close();
      service = new EventService(root);
      provisioning = new WorkspaceProvisioning(service, root, client);
      expect(current()).toMatchObject({
        spriteStatus: "error",
        spriteName: name,
        spriteCreationFailure: kind,
      });
      expect(current().spriteError).toContain(spriteCreationMessages[kind]);
      expect(current().spriteError).toContain("interrupted");
      expect(head()).toBe(originalHead);
      // An existing same-identity Sprite may later reconnect; success clears cause.
      exec.mockResolvedValue(ok(Buffer.from("")));
      unwrap(await provisioning.start(current()));
      await provisioning.wait(workspace.id);
      expect(current()).toMatchObject({
        spriteStatus: "ready",
        spriteCreationFailure: null,
        spriteError: null,
        spriteName: name,
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(upload).toHaveBeenCalledTimes(1);
    } finally {
      await provisioning.close();
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("does not invent a cause or allocate a replacement for a legacy absent reservation", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-legacy-cause-"));
  const service = new EventService(root);
  const client = new SpriteClient();
  const owner = {
    id: "legacy-owner",
    name: "Owner",
    email: "legacy@example.test",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(owner, {
      name: "Legacy cause",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  const workspace = unwrap(
    service.createTeam(owner, {
      eventId: event.id,
      name: "Legacy team",
      projectId: "data-starter",
    }),
  ).workspace;
  const name = `civic-spark-${workspace.id}`;
  unwrap(
    service.setSprite(
      workspace.id,
      name,
      "error",
      "The reserved Sprite could not reconnect. Retry after checking provider access; it will not be replaced.",
      "creating",
    ),
  );
  const create = vi.spyOn(client, "create");
  vi.spyOn(client, "exec").mockResolvedValue(fail("Old reconnect failure"));
  vi.spyOn(client, "inspectReservation").mockResolvedValue("missing");
  const upload = vi.spyOn(client, "uploadBundle");
  const provisioning = new WorkspaceProvisioning(service, root, client);
  try {
    for (let retry = 0; retry < 2; retry++) {
      unwrap(await provisioning.start(unwrap(service.workspace(owner, workspace.id))));
      await provisioning.wait(workspace.id);
      const current = unwrap(service.workspace(owner, workspace.id));
      expect(current.spriteName).toBe(name);
      expect(current.spriteCreationFailure).toBeUndefined();
      expect(current.spriteError).toContain("reserved workspace is missing");
      expect(current.spriteError).toContain("Rebuild from shared work");
      expect(current.spriteError).not.toMatch(/quota|limit|credentials|provider access/);
    }
    expect(create).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  } finally {
    await provisioning.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
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
    await vi.waitFor(async () =>
      expect(await status()).toMatchObject({
        spriteStatus: "provisioning",
        spritePhase: "creating",
      }),
    );
    expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(202);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(`civic-spark-${id}`);
    finishCreate(fail("Provider connection failed; retry when connected", 502));
    await vi.waitFor(async () =>
      expect(await status()).toMatchObject({
        spriteStatus: "error",
        spriteError: expect.stringContaining("Workspace creation could not be confirmed"),
        spriteCreationFailure: "unknown",
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
    symlinkSync(join(root, "missing-private-project"), join(root, "project"));
    expect(run().status).not.toBe(0);
    expect(lstatSync(join(root, "project")).isSymbolicLink()).toBe(true);
    rmSync(join(root, "project"));
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
