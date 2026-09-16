import { createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspaceProvisioning } from "../apps/server/src/provisioning.ts";
import { createBackup, restoreBackup } from "../packages/backup/src/backup.ts";
import { recoveryPermission, resumeRestore } from "../packages/backup/src/recovery.ts";
import { EventService } from "../packages/domain/src/service.ts";
import { fail, ok, type Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "./auth-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function unwrap<T>(result: Result<T>) {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function restoredFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "civic-spark-recovery-lifecycle-")));
  chmodSync(base, 0o700);
  roots.push(base);
  const root = join(base, "source");
  const origin = "http://127.0.0.1:4310";
  const source = await createApp(root, false, origin, undefined, "email");
  const owner = await testIdentity(source.authentication, "Recovery owner");
  if (!owner.actor) throw new Error("Missing owner");
  const event = unwrap(
    source.service.createEvent(owner.actor, {
      name: "Recovery lifecycle",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    source.service.createTeam(owner.actor, {
      eventId: event.id,
      name: "Shared recovery",
      projectId: "data-starter",
    }),
  );
  const workspace = team.workspace;
  const name = `civic-spark-${workspace.id}`;
  unwrap(source.service.setSprite(workspace.id, name, "ready", null, "ready"));
  unwrap(source.service.setExecution(owner.actor, event.id, true));
  writeFileSync(
    join(root, "preview-origins.json"),
    JSON.stringify({ [workspace.id]: "https://retained.example.test" }),
  );
  const sharedHead = git(source.service.sharedWorkspaceRepository(workspace.id), [
    "rev-parse",
    "main",
  ])
    .toString()
    .trim();
  writeFileSync(
    join(source.service.workspacePath(workspace.id), "PRIVATE-UNSHARED.txt"),
    "Private local source must not seed recovery",
  );
  await source.app.close();
  const operator = join(base, "operator");
  mkdirSync(operator, { mode: 0o700 });
  const operatorFiles = {
    configuration: "configuration.json",
    receipt: "receipt.json",
    secrets: "secrets.json",
  };
  for (const file of Object.values(operatorFiles))
    writeFileSync(join(operator, file), "{}", { mode: 0o600 });
  const keyFile = join(base, "key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const installation = {
    id: "recovery-fixture",
    authMode: "email" as const,
    release: "a".repeat(40),
    origin,
    spriteOrg: "test-org",
    spriteApiOrigin: "https://api.sprites.dev",
  };
  const archive = join(base, "archive");
  await createBackup({
    dataRoot: root,
    operatorRoot: operator,
    destination: archive,
    keyFile,
    installation,
    coordinatedOffline: true,
    operatorFiles,
  });
  const target = join(base, "restored");
  const restored = await restoreBackup({ archive, target, keyFile, installation });
  const data = join(target, "data");
  await expect(createApp(data, false, origin, undefined, "email")).rejects.toThrow(
    /recovery|reconcil/i,
  );
  const metadata = vi.fn<typeof fetch>(async (url) =>
    String(url).includes("?")
      ? Response.json({ sprites: [], has_more: false, next_continuation_token: null })
      : new Response(null, { status: 404 }),
  );
  await resumeRestore(
    {
      target,
      installation,
      backupId: restored.backupId,
      spriteOrg: "test-org",
      spriteApiOrigin: "https://api.sprites.dev",
      previewBindings: { [workspace.id]: "https://retained.example.test" },
      sourceWriterFenced: true,
      sharedGitReviewed: true,
      previewLedgerComplete: true,
      providerActivityReviewed: true,
      operatorCredentialsReviewed: true,
    },
    "test-org/id/token/value",
    metadata,
  );
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "test-org");
  vi.stubEnv("SPRITE_TOKEN", "test-org/id/token/value");
  const service = new EventService(data);
  const current = () =>
    service.provisioningRecords().find((w) => w.id === workspace.id) as typeof workspace;
  return { base, data, service, owner: owner.actor, event, workspace, name, current, sharedHead };
}

it("restores paused state, then explicitly recreates a confirmed missing reservation from shared Git with identity and origin intact", async () => {
  const f = await restoredFixture();
  const client = new SpriteClient();
  const create = vi.spyOn(client, "create").mockResolvedValue(ok(f.name));
  const inspect = vi.fn().mockResolvedValue("missing" as const);
  const uploaded: string[] = [];
  vi.spyOn(client, "uploadBundle").mockImplementation(async (_name, bundle) => {
    const checkout = join(f.base, "uploaded");
    git(f.base, ["clone", bundle, checkout]);
    uploaded.push(git(checkout, ["rev-parse", "HEAD"]).toString().trim());
    expect(git(checkout, ["ls-files"]).toString()).not.toContain("PRIVATE-UNSHARED");
    return ok(Buffer.from(""));
  });
  vi.spyOn(client, "files").mockResolvedValue(ok(["README.md"]));
  const provisioning = new WorkspaceProvisioning(f.service, f.data, client, inspect);
  try {
    expect(inspect).not.toHaveBeenCalled();
    expect(provisioning.start(f.current())).toMatchObject({ ok: false, status: 423 });
    expect(create).not.toHaveBeenCalled();
    unwrap(f.service.setExecution(f.owner, f.event.id, false));
    unwrap(f.service.wakeWorkspace(f.owner, f.workspace.id));
    unwrap(provisioning.start(f.current()));
    await provisioning.wait(f.workspace.id);
    expect(f.current()).toMatchObject({
      id: f.workspace.id,
      spriteName: f.name,
      spriteStatus: "ready",
    });
    expect(create).toHaveBeenCalledExactlyOnceWith(f.name);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(uploaded).toEqual([f.sharedHead]);
    expect(recoveryPermission(f.data, f.workspace.id, f.name, "test-org")).toBeNull();
    expect(JSON.parse(readFileSync(join(f.data, "preview-origins.json"), "utf8"))).toEqual({
      [f.workspace.id]: "https://retained.example.test",
    });
  } finally {
    await provisioning.close();
    f.service.close();
  }
}, 30000);

it("requires an authorized explicit owner HTTP reopen after restore and never provisions from polling", async () => {
  const f = await restoredFixture();
  f.service.close();
  const create = vi.spyOn(SpriteClient.prototype, "create").mockResolvedValue(ok(f.name));
  vi.spyOn(SpriteClient.prototype, "uploadBundle").mockResolvedValue(ok(Buffer.from("")));
  vi.spyOn(SpriteClient.prototype, "files").mockResolvedValue(ok(["README.md"]));
  const request = vi.fn<typeof fetch>(async (url) =>
    String(url).includes("?")
      ? Response.json({ sprites: [], has_more: false, next_continuation_token: null })
      : new Response(null, { status: 404 }),
  );
  vi.stubGlobal("fetch", request);
  const restored = await createApp(f.data, true, "http://127.0.0.1:4310", undefined, "email");
  try {
    const context = await restored.authentication.auth.$context;
    const session = await context.internalAdapter.createSession(f.owner.id);
    const signature = createHmac("sha256", context.secret).update(session.token).digest("base64");
    const headers = {
      cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
      origin: "http://127.0.0.1:4310",
    };
    const stranger = await testIdentity(restored.authentication, "Recovery stranger");
    const url = `/api/workspaces/${f.workspace.id}/wake`;
    expect(
      (
        await restored.app.inject({
          method: "POST",
          url,
          headers: { ...headers, cookie: stranger.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await restored.app.inject({
          method: "POST",
          url,
          headers: { ...headers, origin: "https://attacker.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await restored.app.inject({ method: "POST", url, headers })).statusCode).toBe(423);
    expect(
      (await restored.app.inject({ url: `/api/workspaces/${f.workspace.id}/sprite`, headers }))
        .statusCode,
    ).toBe(200);
    expect(request).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    unwrap(restored.service.setExecution(f.owner, f.event.id, false));
    expect(
      (await restored.app.inject({ url: `/api/workspaces/${f.workspace.id}/sprite`, headers }))
        .statusCode,
    ).toBe(200);
    expect(create).not.toHaveBeenCalled();
    expect((await restored.app.inject({ method: "POST", url, headers })).statusCode).toBe(202);
    await vi.waitFor(() =>
      expect(
        restored.service.provisioningRecords().find((w) => w.id === f.workspace.id)?.spriteStatus,
      ).toBe("ready"),
    );
    expect(create).toHaveBeenCalledExactlyOnceWith(f.name);
    expect(request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(recoveryPermission(f.data, f.workspace.id, f.name, "test-org")).toBeNull();
  } finally {
    await restored.app.close();
  }
}, 30000);

it("rechecks recovery on every retry, never overwrites a surviving Sprite, and respects a pause arriving during inspection", async () => {
  const f = await restoredFixture();
  const client = new SpriteClient();
  const create = vi.spyOn(client, "create").mockResolvedValue(ok(f.name));
  const upload = vi
    .spyOn(client, "uploadBundle")
    .mockResolvedValue(fail("Isolated upload failure"));
  vi.spyOn(client, "files").mockResolvedValue(ok(["private-existing.ts"]));
  const inspect = vi
    .fn()
    .mockRejectedValueOnce(new Error("Provider access unknown"))
    .mockImplementationOnce(async () => {
      unwrap(f.service.setExecution(f.owner, f.event.id, true));
      return "missing" as const;
    })
    .mockResolvedValueOnce("missing" as const)
    .mockResolvedValueOnce("present" as const);
  const provisioning = new WorkspaceProvisioning(f.service, f.data, client, inspect);
  try {
    const retry = async () => {
      unwrap(provisioning.start(f.current()));
      await provisioning.wait(f.workspace.id);
    };
    unwrap(f.service.setExecution(f.owner, f.event.id, false));
    unwrap(f.service.wakeWorkspace(f.owner, f.workspace.id));
    await retry();
    expect(create).not.toHaveBeenCalled();
    expect(f.current().spriteStatus).toBe("error");
    await retry();
    expect(create).not.toHaveBeenCalled();
    expect(f.service.execution(f.event.id).paused).toBe(true);
    expect(recoveryPermission(f.data, f.workspace.id, f.name, "test-org")).not.toBeNull();
    unwrap(f.service.setExecution(f.owner, f.event.id, false));
    await retry();
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.current().spriteStatus).toBe("error");
    expect(recoveryPermission(f.data, f.workspace.id, f.name, "test-org")).not.toBeNull();
    await retry();
    expect(create).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(4);
    expect(f.current().spriteStatus).toBe("ready");
    expect(recoveryPermission(f.data, f.workspace.id, f.name, "test-org")).toBeNull();
  } finally {
    await provisioning.close();
    f.service.close();
  }
}, 30000);
