import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import type { Identity } from "../packages/domain/src/access-types.ts";
import { EventService } from "../packages/domain/src/service.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { testIdentity } from "./auth-fixture.ts";

const admin: Identity = {
  id: "admin",
  name: "Organizer",
  email: "admin@example.test",
  emailVerified: true,
};
const member: Identity = {
  id: "member",
  name: "Member",
  email: "member@example.test",
  emailVerified: true,
};
const outsider: Identity = {
  id: "outsider",
  name: "Other organizer",
  email: "other@example.test",
  emailVerified: true,
};
const eventInput = {
  name: "Repository day",
  date: "2026-10-03",
  timezone: "America/Chicago",
  location: "Library",
  capacity: 40,
  budget: 20,
  templateId: "blank" as const,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-admin-"));
  const service = new EventService(root);
  cleanups.push(() => {
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  const event = value(service.createEvent(admin, eventInput));
  value(service.transition(admin, event.id, "registration"));
  const { team, workspace } = value(
    service.createTeam(member, {
      eventId: event.id,
      name: "Original team",
      projectId: "data-starter",
    }),
  );
  const dir = service.workspacePath(workspace.id);
  const repo = join(root, "repos", `${team.id}.git`);
  return { root, service, event, team, workspace, dir, repo };
}
function share(service: EventService, id: string, title: string) {
  const changes = new WorkspaceFiles(service.workspacePath(id)).changes();
  return value(service.shareLocal(member, id, title, changes.revision ?? ""));
}
it("removes an event member across its teams, preserves other events and private work, and protects the last admin", () => {
  const { service, event, team, workspace, dir } = setup();
  const second = value(
    service.createTeam(member, {
      eventId: event.id,
      name: "Second team",
      projectId: "data-starter",
    }),
  );
  const other = value(service.createEvent(outsider, { ...eventInput, name: "Other event" }));
  value(service.transition(outsider, other.id, "registration"));
  const otherTeam = value(
    service.createTeam(member, {
      eventId: other.id,
      name: "Other team",
      projectId: "data-starter",
    }),
  );
  writeFileSync(join(dir, "private.txt"), "Unshared work");
  expect(service.removeEventMember(outsider, event.id, member.id)).toMatchObject({
    ok: false,
    status: 403,
  });
  expect(service.removeEventMember(admin, event.id, admin.id)).toMatchObject({
    ok: false,
    status: 409,
  });
  value(service.removeEventMember(admin, event.id, member.id));
  expect(service.workspace(member, workspace.id).ok).toBe(false);
  expect(service.workspace(member, second.workspace.id).ok).toBe(false);
  expect(service.workspace(member, otherTeam.workspace.id).ok).toBe(true);
  expect(service.portal(admin, false).members.some((m) => m.userId === member.id)).toBe(false);
  expect(readFileSync(join(dir, "private.txt"), "utf8")).toBe("Unshared work");
  value(service.joinTeam(member, team.id));
  expect(service.portal(admin, false).members.find((m) => m.userId === member.id)?.role).toBe(
    "member",
  );
  expect(value(service.workspace(member, workspace.id)).id).toBe(workspace.id);
});
it("deletes a team from discovery and denies all its access after reopening the store while retaining disk work", () => {
  const { service, root, event, team, workspace, dir, repo } = setup();
  const other = value(
    service.createTeam(member, {
      eventId: event.id,
      name: "Still here",
      projectId: "data-starter",
    }),
  );
  writeFileSync(join(dir, "shared.txt"), "Published");
  share(service, workspace.id, "Shared finding");
  expect(service.deleteTeam(member, team.id)).toMatchObject({ ok: false, status: 403 });
  value(service.deleteTeam(admin, team.id));
  expect(service.portal(admin, false).teams.map((t) => t.id)).toEqual([other.team.id]);
  expect(service.portal(admin, false).contributions).toHaveLength(0);
  expect(service.portal(member, false).myWorkspaces.map((w) => w.id)).toEqual([other.workspace.id]);
  expect(service.joinTeam(member, team.id).ok).toBe(false);
  expect(service.exportTeam(admin, team.id).ok).toBe(false);
  expect(service.copyTeam(admin, team.id, "Copy").ok).toBe(false);
  expect(existsSync(repo)).toBe(true);
  expect(existsSync(dir)).toBe(true);
  const reopened = new EventService(root);
  try {
    expect(reopened.workspace(member, workspace.id).ok).toBe(false);
    expect(reopened.repositoryHistory(admin, team.id, {}).ok).toBe(false);
    const next = value(
      reopened.createTeam(member, {
        eventId: event.id,
        name: "New team",
        projectId: "data-starter",
      }),
    );
    expect(next.team.number).toBe(3);
  } finally {
    reopened.close();
  }
});
it("copies only shared main history and the brief to an independent repository without members or private refs", () => {
  const { service, root, team, workspace, dir, repo } = setup();
  writeFileSync(join(dir, "finding.txt"), "Shared finding\n");
  const published = share(service, workspace.id, "Publish finding");
  writeFileSync(join(dir, "private.txt"), "Private draft");
  git(dir, ["add", "private.txt"]);
  git(dir, ["commit", "-m", "Private commit"]);
  git(dir, ["push", repo, "HEAD:refs/heads/private-test"]);
  expect(service.copyTeam(member, team.id, "Not allowed")).toMatchObject({
    ok: false,
    status: 403,
  });
  const copy = value(service.copyTeam(admin, team.id, "Split team"));
  const copyRepo = join(root, "repos", `${copy.id}.git`);
  expect(git(copyRepo, ["rev-parse", "main"]).toString().trim()).toBe(published.commit);
  expect(git(copyRepo, ["for-each-ref", "--format=%(refname)"]).toString().trim()).toBe(
    "refs/heads/main",
  );
  expect(service.portal(admin, false).teams.find((t) => t.id === copy.id)?.memberCount).toBe(0);
  const joined = value(service.joinTeam(outsider, copy.id));
  expect(readFileSync(join(service.workspacePath(joined.id), "finding.txt"), "utf8")).toBe(
    "Shared finding\n",
  );
  expect(existsSync(join(service.workspacePath(joined.id), "private.txt"))).toBe(false);
  expect(git(copyRepo, ["show", "main:PROJECT.md"]).toString()).toBe(
    git(repo, ["show", "main:PROJECT.md"]).toString(),
  );
  writeFileSync(join(dir, "private.txt"), "Still private");
  expect(git(copyRepo, ["rev-parse", "main"]).toString().trim()).toBe(published.commit);
});
it("restores with a new descendant commit, preserves private work and rejects stale, foreign and no-op targets", () => {
  const { service, team, workspace, dir, repo } = setup();
  const original = value(service.repositoryHistory(admin, team.id, {})).head;
  writeFileSync(join(dir, "finding.txt"), "A finding\n");
  const published = share(service, workspace.id, "New finding");
  writeFileSync(join(dir, "private.txt"), "Unsaved to Git");
  const input = { commit: original, expectedHead: published.commit, confirmed: true as const };
  expect(service.restoreRepository(member, team.id, input)).toMatchObject({
    ok: false,
    status: 403,
  });
  expect(
    service.restoreRepository(admin, team.id, { ...input, expectedHead: original }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  const restored = value(service.restoreRepository(admin, team.id, input));
  expect(
    git(repo, ["rev-parse", `${restored.commit}^`])
      .toString()
      .trim(),
  ).toBe(published.commit);
  expect(git(repo, ["rev-parse", `${restored.commit}^{tree}`]).toString()).toBe(
    git(repo, ["rev-parse", `${original}^{tree}`]).toString(),
  );
  expect(git(dir, ["rev-parse", "HEAD"]).toString().trim()).toBe(published.commit);
  expect(readFileSync(join(dir, "private.txt"), "utf8")).toBe("Unsaved to Git");
  expect(value(service.repositoryHistory(admin, team.id, {})).commits.map((c) => c.id)).toEqual([
    restored.commit,
    published.commit,
    original,
  ]);
  expect(
    service.restoreRepository(admin, team.id, { ...input, expectedHead: restored.commit }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("No restore") });
  const foreign = git(repo, ["commit-tree", `${original}^{tree}`, "-m", "Unpublished root"])
    .toString()
    .trim();
  expect(service.repositoryVersion(admin, team.id, foreign).ok).toBe(false);
  expect(
    service.restoreRepository(admin, team.id, {
      ...input,
      expectedHead: restored.commit,
      commit: foreign,
    }).ok,
  ).toBe(false);
  expect(git(repo, ["rev-parse", "main"]).toString().trim()).toBe(restored.commit);
});
it("browses each shared commit with bounded literal file previews and stable history pagination", () => {
  const { service, team, dir, repo } = setup();
  const first = value(service.repositoryHistory(admin, team.id, {})).head;
  expect(service.repositoryHistory(outsider, team.id, {})).toMatchObject({
    ok: false,
    status: 404,
  });
  expect(value(service.repositoryFile(admin, team.id, first, "README.md")).diff).toContain("+#");
  writeFileSync(join(dir, "literal[1].txt"), "One\n");
  writeFileSync(join(dir, "large.csv"), "x".repeat(1024 * 1024 + 1));
  writeFileSync(join(dir, "image.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(dir, ".env"), "fixture secret");
  symlinkSync(".env", join(dir, "link.txt"));
  git(dir, ["add", "literal[1].txt", "large.csv", "image.bin", "link.txt"]);
  git(dir, ["add", "-f", ".env"]);
  git(dir, ["commit", "-m", "Preview fixtures"]);
  git(dir, ["push", repo, "HEAD:main"]);
  const head = git(repo, ["rev-parse", "main"]).toString().trim();
  const version = value(service.repositoryVersion(admin, team.id, head));
  expect(version.files.some((f) => f.path === ".env" || f.path === "link.txt")).toBe(false);
  expect(service.repositoryFile(admin, team.id, head, ".env").ok).toBe(false);
  expect(service.repositoryFile(admin, team.id, head, "link.txt").ok).toBe(false);
  expect(value(service.repositoryFile(admin, team.id, head, "literal[1].txt")).diff).toContain(
    "+One",
  );
  expect(value(service.repositoryFile(admin, team.id, head, "large.csv")).notice).toContain(
    "1 MiB",
  );
  expect(value(service.repositoryFile(admin, team.id, head, "image.bin")).notice).toContain(
    "Binary",
  );
  for (let i = 0; i < 32; i++) {
    const next = git(repo, ["commit-tree", `${head}^{tree}`, "-p", "main", "-m", `History ${i}`])
      .toString()
      .trim();
    git(repo, ["update-ref", "refs/heads/main", next]);
  }
  const page = value(service.repositoryHistory(admin, team.id, {}));
  expect(page.commits).toHaveLength(30);
  expect(page.nextOffset).toBe(30);
  const extra = git(repo, ["commit-tree", `${head}^{tree}`, "-p", "main", "-m", "Arrived later"])
    .toString()
    .trim();
  git(repo, ["update-ref", "refs/heads/main", extra]);
  const rest = value(service.repositoryHistory(admin, team.id, { head: page.head, offset: 30 }));
  expect(rest.commits).toHaveLength(4);
  expect(rest.nextOffset).toBeNull();
  expect(new Set([...page.commits, ...rest.commits].map((c) => c.id)).size).toBe(34);
});

it.each(["overwritten", "deleted"])(
  "restores a %s data file without reverting newer UI or touching private work",
  (kind) => {
    const { service, team, workspace, dir, repo } = setup();
    const content = "year,count\n2025,123\n";
    writeFileSync(join(dir, "counts[1].csv"), content);
    writeFileSync(join(dir, "app.html"), "Original UI");
    const source = share(service, workspace.id, "Add dataset and UI").commit;
    if (kind === "deleted") unlinkSync(join(dir, "counts[1].csv"));
    else writeFileSync(join(dir, "counts[1].csv"), "Accidentally overwritten");
    writeFileSync(join(dir, "app.html"), "Newer UI to keep");
    const before = share(service, workspace.id, "Improve the UI").commit;
    writeFileSync(join(dir, "private.txt"), "Unshared private work");
    const input = {
      path: "counts[1].csv",
      commit: source,
      expectedHead: before,
      confirmed: true as const,
    };
    expect(service.restoreRepositoryFile(member, team.id, input)).toMatchObject({
      ok: false,
      status: 403,
    });
    const result = value(service.restoreRepositoryFile(admin, team.id, input));
    expect(git(repo, ["show", "main:counts[1].csv"]).toString()).toBe(content);
    expect(git(repo, ["show", "main:app.html"]).toString()).toBe("Newer UI to keep");
    expect(git(repo, ["diff", "--name-only", before, result.commit]).toString().trim()).toBe(
      "counts[1].csv",
    );
    expect(git(repo, ["rev-parse", "main^"]).toString().trim()).toBe(before);
    expect(git(dir, ["rev-parse", "HEAD"]).toString().trim()).toBe(before);
    expect(readFileSync(join(dir, "private.txt"), "utf8")).toBe("Unshared private work");
    expect(service.restoreRepositoryFile(admin, team.id, input)).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed"),
    });
    expect(
      service.restoreRepositoryFile(admin, team.id, { ...input, expectedHead: result.commit }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("No restore") });
  },
);

it("restores binary and large files/modes without previewing them and rejects path collisions, excluded and absent files", () => {
  const { service, team, workspace, dir, repo } = setup();
  const large = Buffer.alloc(1024 * 1024 + 1, 0);
  writeFileSync(join(dir, "dataset.bin"), large);
  chmodSync(join(dir, "dataset.bin"), 0o755);
  writeFileSync(join(dir, "old.txt"), "Original file");
  const source = share(service, workspace.id, "Add recovery sources").commit;
  writeFileSync(join(dir, "dataset.bin"), "Overwritten");
  chmodSync(join(dir, "dataset.bin"), 0o644);
  unlinkSync(join(dir, "old.txt"));
  mkdirSync(join(dir, "old.txt"));
  writeFileSync(join(dir, "old.txt", "keep.txt"), "New directory contents");
  const before = share(service, workspace.id, "New files").commit;
  const input = { commit: source, expectedHead: before, confirmed: true as const };
  for (const path of ["old.txt", ".env", "../outside", "missing.csv"]) {
    expect(service.restoreRepositoryFile(admin, team.id, { ...input, path }).ok).toBe(false);
    expect(git(repo, ["rev-parse", "main"]).toString().trim()).toBe(before);
  }
  const restored = value(
    service.restoreRepositoryFile(admin, team.id, { ...input, path: "dataset.bin" }),
  );
  expect(git(repo, ["show", "main:dataset.bin"])).toEqual(large);
  expect(git(repo, ["ls-tree", "main", "--", "dataset.bin"]).toString()).toMatch(/^100755 /);
  expect(git(repo, ["show", "main:old.txt/keep.txt"]).toString()).toBe("New directory contents");
  const unshared = git(repo, ["commit-tree", `${source}^{tree}`, "-m", "Unshared root"])
    .toString()
    .trim();
  expect(
    service.restoreRepositoryFile(admin, team.id, {
      ...input,
      expectedHead: restored.commit,
      commit: unshared,
      path: "dataset.bin",
    }).ok,
  ).toBe(false);
});

it("requires sessions, event admin authority, explicit confirmation and valid input at every new HTTP boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-admin-api-"));
  const { app, authentication } = await createApp(root, false);
  try {
    const owner = await testIdentity(authentication, "Owner");
    const person = await testIdentity(authentication, "Person");
    const headers = (cookie?: string) => ({
      host: "127.0.0.1:4311",
      ...(cookie ? { cookie } : {}),
    });
    const event = (
      await app.inject({
        method: "POST",
        url: "/api/events",
        headers: headers(owner.cookie),
        payload: eventInput,
      })
    ).json();
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/teams",
        headers: headers(owner.cookie),
        payload: { eventId: event.id, name: "API team", projectId: "data-starter" },
      })
    ).json();
    const base = `/api/teams/${created.team.id}`;
    const history = (
      await app.inject({ url: `${base}/repository`, headers: headers(owner.cookie) })
    ).json();
    for (const route of [
      { method: "GET" as const, url: `${base}/repository` },
      { method: "GET" as const, url: `${base}/repository/commits/${history.head}` },
      {
        method: "GET" as const,
        url: `${base}/repository/commits/${history.head}/file?path=README.md`,
      },
      { method: "DELETE" as const, url: base, payload: { confirmed: true } },
      { method: "POST" as const, url: `${base}/copy`, payload: { name: "Copy" } },
      {
        method: "POST" as const,
        url: `${base}/repository/restore`,
        payload: { commit: history.head, expectedHead: history.head, confirmed: true },
      },
      {
        method: "POST" as const,
        url: `${base}/repository/restore-file`,
        payload: {
          commit: history.head,
          expectedHead: history.head,
          path: "README.md",
          confirmed: true,
        },
      },
      {
        method: "DELETE" as const,
        url: `/api/events/${event.id}/members/${owner.user.id}`,
        payload: { confirmed: true },
      },
    ]) {
      expect((await app.inject({ ...route, headers: headers() })).statusCode).toBe(401);
      expect([403, 404]).toContain(
        (await app.inject({ ...route, headers: headers(person.cookie) })).statusCode,
      );
    }
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: base,
          headers: headers(owner.cookie),
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: `${base}/repository?offset=-1`, headers: headers(owner.cookie) }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `${base}/repository/commits/--all`,
          headers: headers(owner.cookie),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/copy`,
          headers: headers(owner.cookie),
          payload: { name: " " },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/copy`,
          headers: headers(owner.cookie),
          payload: { name: "API copy" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: base,
          headers: headers(owner.cookie),
          payload: { confirmed: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: `${base}/repository`, headers: headers(owner.cookie) })).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
