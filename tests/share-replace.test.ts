import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
it("replaces a diverged team repository only on explicit request and keeps the displaced head", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-share-replace-"));
  const { app, service, authentication } = await createApp(
    root,
    false,
    "http://127.0.0.1:4311",
    undefined,
    "email",
  );
  try {
    const owner = await testIdentity(authentication, "Replace owner");
    const teammate = await testIdentity(authentication, "Replace teammate");
    if (!owner.actor || !teammate.actor) throw new Error("No identities");
    const event = unwrap(
      service.createEvent(owner.actor, {
        name: "Replace API",
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
        name: "Replace team",
        projectId: "data-starter",
      }),
    );
    const repo = join(root, "repos", `${team.team.id}.git`);
    const id = team.workspace.id;
    const dir = service.workspacePath(id);
    unwrap(service.transition(owner.actor, event.id, "registration"));
    const other = unwrap(service.joinTeam(teammate.actor, team.team.id));
    const otherDir = service.workspacePath(other.id);
    writeFileSync(join(otherDir, "teammate.txt"), "Teammate work\n");
    const theirs = unwrap(
      service.shareLocal(
        teammate.actor,
        other.id,
        "Teammate work",
        new WorkspaceFiles(otherDir).changes().revision ?? "",
      ),
    );
    expect(git(repo, ["rev-parse", "main"]).toString().trim()).toBe(theirs.commit);

    writeFileSync(join(dir, "mine.txt"), "Owner work\n");
    const revision = new WorkspaceFiles(dir).changes().revision ?? "";
    const share = (payload: object) =>
      app.inject({
        method: "POST",
        url: `/api/workspaces/${id}/share`,
        headers: { cookie: owner.cookie, origin: "http://127.0.0.1:4311" },
        payload,
      });
    const refused = await share({ title: "Owner work", revision });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/team repository/);
    expect(git(repo, ["rev-parse", "main"]).toString().trim()).toBe(theirs.commit);
    expect((await share({ title: "Owner work", revision, replaceShared: false })).statusCode).toBe(
      400,
    );
    // The retry reuses the local commit from the refused attempt.
    const mine = git(dir, ["rev-parse", "HEAD"]).toString().trim();
    const replaced = await share({ title: "Owner work", revision, replaceShared: true });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().commit).toBe(mine);
    expect(git(repo, ["rev-parse", "main"]).toString().trim()).toBe(mine);
    const backups = git(repo, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/civic-spark/replaced/",
    ])
      .toString()
      .trim()
      .split("\n");
    expect(backups).toHaveLength(1);
    expect(backups[0]?.endsWith(` ${theirs.commit}`)).toBe(true);
    const portal = service.portal(owner.actor, false);
    expect(portal.contributions).toHaveLength(2);
    expect(
      portal.activity.some(
        (a) =>
          a.message.includes("replaced the team repository") &&
          a.message.includes(backups[0]?.split(" ")[0] ?? "missing"),
      ),
    ).toBe(true);
    // The teammate now sees a diverged team head, never a silent rewrite of their copy.
    expect(git(otherDir, ["rev-parse", "HEAD"]).toString().trim()).toBe(theirs.commit);
    // Replacing again with the same head is a no-op that reports the same commit.
    const again = await share({ title: "Owner work", revision, replaceShared: true });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().commit).toBe(mine);
    expect(git(repo, ["rev-parse", "main"]).toString().trim()).toBe(mine);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
