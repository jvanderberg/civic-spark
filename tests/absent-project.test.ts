import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessions } from "../apps/server/src/agents.ts";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspaceProvisioning } from "../apps/server/src/provisioning.ts";
import { EventService } from "../packages/domain/src/service.ts";
import { fail, ok, type Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "./auth-fixture.ts";

const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const unwrap = <T>(r: Result<T>) => {
  if (!r.ok) throw Error(r.error);
  return r.value;
};
function directory() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-absent-project-"));
  roots.push(root);
  return root;
}
const filesSource = readFileSync(
  new URL("../packages/sprites/src/files.py", import.meta.url),
  "utf8",
);
const checkoutSource = readFileSync(
  new URL("../packages/sprites/src/checkout.sh", import.meta.url),
  "utf8",
);
function listing(home: string, unreadable = false): Result<string[]> {
  const source = filesSource
    .replaceAll("/home/sprite", home)
    .replace(
      "request = json.loads",
      unreadable
        ? 'os.scandir = lambda path: (_ for _ in ()).throw(PermissionError("denied"))\n    request = json.loads'
        : "request = json.loads",
    );
  const p = spawnSync("python3", ["-c", source], {
    input: JSON.stringify({ operation: "list" }),
    encoding: "utf8",
  });
  expect(p.status).toBe(0);
  return JSON.parse(p.stdout);
}
function setProject(home: string, kind: string) {
  const project = join(home, "project");
  if (kind === "absent") return;
  if (kind === "file") return writeFileSync(project, "private-file");
  if (kind === "dangling") return symlinkSync(join(home, "missing"), project);
  if (kind === "symlink") {
    mkdirSync(join(home, "private"));
    writeFileSync(join(home, "private", "PRIVATE.txt"), "private");
    return symlinkSync(join(home, "private"), project);
  }
  mkdirSync(project);
  if (kind === "private") writeFileSync(join(project, "PRIVATE.txt"), "private");
  if (kind === "excluded") {
    mkdirSync(join(project, "node_modules"));
    writeFileSync(join(project, ".env"), "private");
  }
}
it.each(["absent", "empty", "private", "excluded", "file", "symlink", "dangling", "unreadable"])(
  "real files.py distinguishes %s project without touching it",
  (kind) => {
    const home = directory();
    setProject(home, kind);
    const result = listing(home, kind === "unreadable");
    if (kind === "absent") expect(result).toEqual(fail("Workspace project is absent", 404));
    else if (["file", "symlink", "dangling"].includes(kind))
      expect(result).toMatchObject({ ok: false, status: 409 });
    else if (kind === "unreadable") expect(result).toMatchObject({ ok: false, status: 400 });
    else expect(result).toEqual(ok(kind === "private" ? ["PRIVATE.txt"] : []));
    if (["symlink", "dangling"].includes(kind))
      expect(lstatSync(join(home, "project")).isSymbolicLink()).toBe(true);
  },
);

function fixture(kind = "absent", ready = false) {
  vi.stubEnv("SPRITE_TOKEN", "test-org/account/id/secret");
  vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "test-org");
  const root = directory();
  const home = join(root, "sprite");
  mkdirSync(home);
  setProject(home, kind);
  let service = new EventService(root);
  const owner = {
    id: "owner",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(owner, {
      name: "Repair",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  const workspace = unwrap(
    service.createTeam(owner, { eventId: event.id, name: "Team", projectId: "data-starter" }),
  ).workspace;
  const name = `civic-spark-${workspace.id}`;
  unwrap(
    service.setSprite(
      workspace.id,
      name,
      ready ? "ready" : "error",
      null,
      ready ? "ready" : "creating",
    ),
  );
  if (!ready)
    service.setRuntime(workspace.id, {
      deletion: {
        state: "deleted",
        changedAt: new Date().toISOString(),
        replacementReserved: true,
        error: null,
        org: "test-org",
        apiOrigin: "https://api.sprites.dev",
      },
    });
  writeFileSync(
    join(service.workspacePath(workspace.id), "PRIVATE.txt"),
    "management private must never seed",
  );
  const client = new SpriteClient();
  let queued: (() => Promise<void>) | undefined;
  const command = vi
    .spyOn(client, "command")
    .mockImplementation(async (args, _timeout, input, _max, beforeDispatch) => {
      const uploading = args.includes("--file");
      if (uploading) await queued?.();
      await beforeDispatch?.();
      if (uploading) {
        const source = args[args.indexOf("--file") + 1]?.split(":")[0];
        if (!source) throw Error("Missing test bundle");
        copyFileSync(source, join(home, "seed.bundle"));
      }
      const tail = args.slice(args.indexOf("--") + 1);
      const script = (tail.at(-1) ?? "")
        .replaceAll("/home/sprite", home)
        .replaceAll("/tmp/civic-spark-seed.bundle", join(home, "seed.bundle"));
      const p = spawnSync(tail[0] as string, [...tail.slice(1, -1), script], {
        input,
      });
      return p.status === 0 ? ok(p.stdout) : fail("Trusted fixture command failed", 502);
    });
  const create = vi
    .spyOn(client, "create")
    .mockRejectedValue(Error("No provider creation permitted"));
  const upload = vi.spyOn(client, "uploadBundle");
  const inspect = vi.spyOn(client, "inspectReservation").mockResolvedValue("present");
  let active = false;
  const inspectExisting = vi.fn(async () => "present" as "present" | "missing");
  let provisioning = new WorkspaceProvisioning(
    service,
    root,
    client,
    inspectExisting,
    () => active,
  );
  const current = () => unwrap(service.workspace(owner, workspace.id));
  let authorized = true;
  const authorize = async () =>
    authorized ? service.workspace(owner, workspace.id, true) : fail("Session revoked", 401);
  const start = () => provisioning.start(current(), authorize, false, undefined, ready);
  cleanups.push(async () => {
    await provisioning.close();
    service.close();
  });
  return {
    root,
    home,
    get service() {
      return service;
    },
    owner,
    event,
    workspace,
    name,
    client,
    command,
    create,
    upload,
    inspect,
    get provisioning() {
      return provisioning;
    },
    inspectExisting,
    current,
    start,
    async restart() {
      await provisioning.close();
      service.close();
      service = new EventService(root);
      provisioning = new WorkspaceProvisioning(
        service,
        root,
        client,
        inspectExisting,
        () => active,
      );
    },
    setActive: (v: boolean) => {
      active = v;
    },
    revoke: () => {
      authorized = false;
    },
    queue: (fn: () => Promise<void>) => {
      queued = fn;
    },
  };
}

it.each([false, true])(
  "real absent-root recovery (previously ready=%s) seeds shared Git exactly once without creating a provider resource",
  async (ready) => {
    const f = fixture("absent", ready);
    const beforeHead = git(f.service.sharedWorkspaceRepository(f.workspace.id), [
      "rev-parse",
      "main",
    ]).toString();
    const results = await Promise.all([f.start(), f.start()]);
    for (const result of results)
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        value: { preparing: true },
      });
    await f.provisioning.wait(f.workspace.id);
    expect(f.current(), f.current().spriteError ?? "").toMatchObject({
      spriteStatus: "ready",
      spriteName: f.name,
    });
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.create).not.toHaveBeenCalled();
    expect(git(join(f.home, "project"), ["rev-parse", "HEAD"]).toString()).toBe(beforeHead);
    expect(existsSync(join(f.home, "project", "PRIVATE.txt"))).toBe(false);
    expect(readFileSync(join(f.service.workspacePath(f.workspace.id), "PRIVATE.txt"), "utf8")).toBe(
      "management private must never seed",
    );
    expect(f.service.runtime(f.workspace.id).projectRepair).toBeUndefined();
  },
);

it.each(["empty", "private", "excluded", "file", "symlink", "dangling"])(
  "existing %s project is never seeded/overwritten",
  async (kind) => {
    const f = fixture(kind);
    unwrap(await f.start());
    await f.provisioning.wait(f.workspace.id);
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.current().spriteStatus, f.current().spriteError ?? "").toBe(
      ["empty", "private", "excluded"].includes(kind) ? "ready" : "error",
    );
    if (["symlink", "dangling"].includes(kind))
      expect(lstatSync(join(f.home, "project")).isSymbolicLink()).toBe(true);
    if (kind === "private")
      expect(readFileSync(join(f.home, "project", "PRIVATE.txt"), "utf8")).toBe("private");
  },
);

it.each(["listing-limit", "transport", "active-turn", "pending-turn", "late-active"])(
  "ready %s preserves ordinary Resume without repair",
  async (kind) => {
    const f = fixture("empty", true);
    const files = vi.spyOn(f.client, "files");
    if (kind === "listing-limit") files.mockResolvedValue(fail("Too many files to browse", 413));
    if (kind === "transport") files.mockResolvedValue(fail("Unavailable", 502));
    if (kind === "active-turn" || kind === "pending-turn") f.setActive(true);
    if (kind === "late-active")
      files.mockImplementation(async () => {
        f.setActive(true);
        return fail("Workspace project is absent", 404);
      });
    expect(await f.start()).toEqual(ok({ preparing: false }));
    expect(f.service.runtime(f.workspace.id).projectRepair).toBeUndefined();
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
    if (["active-turn", "pending-turn"].includes(kind)) expect(files).not.toHaveBeenCalled();
  },
);

it.each(["pause", "revoke", "org", "generation"])(
  "queued repair upload revalidates %s before mutation",
  async (change) => {
    const f = fixture();
    f.queue(async () => {
      if (change === "pause") unwrap(f.service.setExecution(f.owner, f.event.id, true));
      if (change === "revoke") f.revoke();
      if (change === "org") vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "rotated");
      if (change === "generation")
        f.service.setRuntime(f.workspace.id, {
          generation: f.service.runtime(f.workspace.id).generation + 1,
        });
    });
    unwrap(await f.start());
    await f.provisioning.wait(f.workspace.id);
    expect(existsSync(join(f.home, "project"))).toBe(false);
    expect(existsSync(join(f.home, "seed.bundle"))).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
  },
);

it.each(["directory", "symlink", "dangling"])(
  "atomic checkout refuses a %s appearing at final publication",
  (kind) => {
    const home = directory();
    const seed = join(home, "seed");
    mkdirSync(seed);
    git(seed, ["init", "--initial-branch=main"]);
    writeFileSync(join(seed, "README.md"), "shared");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", "Seed"]);
    const bundle = join(home, "seed.bundle");
    git(seed, ["bundle", "create", bundle, "--all"]);
    const other = join(home, "private");
    mkdirSync(other);
    writeFileSync(join(other, "PRIVATE.txt"), "private");
    const race =
      kind === "directory"
        ? "os.mkdir(sys.argv[2])"
        : `os.symlink(${JSON.stringify(kind === "symlink" ? other : join(home, "not-present"))}, sys.argv[2])`;
    const script = checkoutSource
      .replaceAll("/home/sprite", home)
      .replaceAll("/tmp/civic-spark-seed.bundle", bundle)
      .replace("libc = ctypes.CDLL", `${race}\nlibc = ctypes.CDLL`);
    const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(readFileSync(join(other, "PRIVATE.txt"), "utf8")).toBe("private");
    if (kind === "directory") expect(readdirSync(join(home, "project"))).toEqual([]);
    else expect(lstatSync(join(home, "project")).isSymbolicLink()).toBe(true);
    expect(readdirSync(other)).toEqual(["PRIVATE.txt"]);
  },
);

it("persists shared-only repair across failure/restart without gaining provider creation permission", async () => {
  const f = fixture("absent", true);
  f.queue(async () => {
    throw Error("Interrupted upload");
  });
  unwrap(await f.start());
  await f.provisioning.wait(f.workspace.id);
  expect(f.current().spriteStatus).toBe("error");
  expect(f.service.runtime(f.workspace.id).projectRepair).toMatchObject({
    name: f.name,
    org: "test-org",
  });
  await f.restart();
  expect(f.provisioning.status(f.current()).preparationAction).toBe("retry");
  f.inspectExisting.mockResolvedValue("missing");
  unwrap(await f.start());
  await f.provisioning.wait(f.workspace.id);
  expect(f.current().spriteStatus).toBe("error");
  expect(f.create).not.toHaveBeenCalled();
  f.inspectExisting.mockResolvedValue("present");
  f.queue(async () => {});
  unwrap(await f.start());
  await f.provisioning.wait(f.workspace.id);
  expect(f.current().spriteStatus).toBe("ready");
  expect(f.service.runtime(f.workspace.id).projectRepair).toBeUndefined();
  expect(existsSync(join(f.home, "project", "PRIVATE.txt"))).toBe(false);
});

it("polling and ordinary internal start never repair a ready workspace", async () => {
  const f = fixture("absent", true);
  expect(f.provisioning.status(f.current()).spriteStatus).toBe("ready");
  expect(await f.provisioning.start(f.current())).toEqual(ok({ preparing: false }));
  expect(f.command).not.toHaveBeenCalled();
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it.each(["repair", "listing-limit", "active-turn", "pending-turn"])(
  "owner HTTP wake preserves the %s path and never recreates",
  async (kind) => {
    vi.stubEnv("SPRITE_TOKEN", "test-org/account/id/secret");
    vi.stubEnv("CIVIC_SPARK_SPRITE_ORG", "test-org");
    let name = "";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => {
        expect(init?.method).toBe("GET");
        return Response.json(
          new URL(String(url)).search
            ? { name: "test-org", sprites: [] }
            : { name, organization: "test-org", id: "stable-id" },
        );
      }),
    );
    const create = vi
      .spyOn(SpriteClient.prototype, "create")
      .mockRejectedValue(Error("No creation"));
    const files = vi
      .spyOn(SpriteClient.prototype, "files")
      .mockResolvedValue(
        kind === "repair"
          ? fail("Workspace project is absent", 404)
          : fail("Too many files to browse", 413),
      );
    vi.spyOn(SpriteClient.prototype, "inspectReservation").mockResolvedValue("present");
    const exec = vi.spyOn(SpriteClient.prototype, "exec").mockResolvedValue(ok(Buffer.alloc(0)));
    const upload = vi
      .spyOn(SpriteClient.prototype, "uploadBundle")
      .mockImplementation(async (_name, _bundle, guard) => {
        await guard?.();
        files.mockResolvedValue(ok(["README.md"]));
        return ok(Buffer.alloc(0));
      });
    vi.spyOn(AgentSessions.prototype, "isWorking").mockReturnValue(kind === "active-turn");
    vi.spyOn(AgentSessions.prototype, "isPreparing").mockReturnValue(kind === "pending-turn");
    const stop = vi.spyOn(AgentSessions.prototype, "stop");
    const { app, service, authentication } = await createApp(
      directory(),
      true,
      "http://127.0.0.1:4310",
      undefined,
      "email",
    );
    try {
      const owner = await testIdentity(authentication, "Repair owner");
      const other = await testIdentity(authentication, "Other owner");
      if (!owner.actor) throw Error("No owner");
      const actor = owner.actor;
      const event = unwrap(
        service.createEvent(owner.actor, {
          name: "Repair HTTP",
          date: "2026-10-03",
          timezone: "America/Chicago",
          location: "Test",
          capacity: 10,
          budget: 0,
          templateId: "blank",
        }),
      );
      const workspace = unwrap(
        service.createTeam(owner.actor, {
          eventId: event.id,
          name: "Team",
          projectId: "data-starter",
        }),
      ).workspace;
      name = `civic-spark-${workspace.id}`;
      unwrap(service.setSprite(workspace.id, name, "ready", null, "ready"));
      const url = `/api/workspaces/${workspace.id}`;
      const headers = { cookie: owner.cookie, origin: "http://127.0.0.1:4310" };
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${url}/wake`,
            headers: { ...headers, cookie: other.cookie },
          })
        ).statusCode,
      ).toBe(404);
      expect(files).not.toHaveBeenCalled();
      expect((await app.inject({ url: `${url}/sprite`, headers })).json().spriteStatus).toBe(
        "ready",
      );
      expect(files).not.toHaveBeenCalled();
      const response = await app.inject({ method: "POST", url: `${url}/wake`, headers });
      expect(response.statusCode, response.body).toBe(kind === "repair" ? 202 : 200);
      if (kind === "repair") {
        await vi.waitFor(() =>
          expect(unwrap(service.workspace(actor, workspace.id)).spriteStatus).toBe("ready"),
        );
        expect(upload).toHaveBeenCalledTimes(1);
      } else {
        expect(response.json()).toEqual({ awake: true });
        expect(upload).not.toHaveBeenCalled();
        expect(exec).toHaveBeenCalledWith(name, ["true"]);
        if (kind !== "listing-limit") expect(files).not.toHaveBeenCalled();
      }
      expect(service.runtime(workspace.id).projectRepair).toBeUndefined();
      expect(create).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
