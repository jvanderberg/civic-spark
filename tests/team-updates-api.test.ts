import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentSessions } from "../apps/server/src/agents.ts";
import { createApp } from "../apps/server/src/app.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
it("team update API enforces ownership, active-turn/stale guards, and reauthorization after remote transfer", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibehack-team-api-"));
  const { app, service, authentication } = await createApp(
    root,
    false,
    "http://127.0.0.1:4310",
    undefined,
    "email",
  );
  try {
    const a = await testIdentity(authentication, "Team owner"),
      b = await testIdentity(authentication, "Team other"),
      outsider = await testIdentity(authentication, "Outside");
    if (!a.actor || !b.actor) throw new Error("No fixture identity");
    const alice = a.actor,
      bob = b.actor;
    const event = unwrap(
      service.createEvent(alice, {
        name: "Updates",
        date: "2026-10-03",
        timezone: "America/Chicago",
        location: "Test",
        capacity: 10,
        budget: 0,
        templateId: "blank",
      }),
    );
    const team = unwrap(
      service.createTeam(alice, { eventId: event.id, name: "Team", projectId: "data-starter" }),
    );
    unwrap(service.transition(alice, event.id, "registration"));
    const other = unwrap(service.joinTeam(bob, team.team.id));
    const dir = service.workspacePath(team.workspace.id);
    writeFileSync(join(dir, "team.txt"), "Shared update\n");
    unwrap(
      service.shareLocal(
        alice,
        team.workspace.id,
        "Team update",
        new WorkspaceFiles(dir).changes().revision as string,
      ),
    );
    const url = `/api/workspaces/${other.id}`;
    const get = (cookie: string) =>
      app.inject({ method: "GET", url: `${url}/team-status`, headers: { cookie } });
    expect((await get(outsider.cookie)).statusCode).toBe(404);
    const status = (await get(b.cookie)).json();
    expect(status.incoming).toBe(true);
    const post = (payload: object, cookie = b.cookie) =>
      app.inject({
        method: "POST",
        url: `${url}/team-update`,
        headers: { cookie, origin: "http://127.0.0.1:4310" },
        payload,
      });
    expect(
      (await post({ head: status.head, remote: "a".repeat(40), mode: "pull" })).statusCode,
    ).toBe(409);
    vi.spyOn(AgentSessions.prototype, "isWorking").mockReturnValue(true);
    expect(
      (await post({ head: status.head, remote: status.remote, mode: "pull" })).json().error,
    ).toContain("agent turn");
    vi.restoreAllMocks();
    const updated = await post({ head: status.head, remote: status.remote, mode: "pull" });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().status).toBe("updated");
    expect((await get(b.cookie)).json().incoming).toBe(false);
    expect(readFileSafe(service.workspacePath(other.id))).toBe("Shared update\n");
    writeFileSync(join(dir, "team.txt"), "Second update\n");
    unwrap(
      service.shareLocal(
        alice,
        team.workspace.id,
        "Second",
        new WorkspaceFiles(dir).changes().revision as string,
      ),
    );
    const remote = git(join(root, "repos", `${team.team.id}.git`), ["rev-parse", "main"])
      .toString()
      .trim();
    const head = git(service.workspacePath(other.id), ["rev-parse", "HEAD"]).toString().trim();
    service.setSprite(other.id, "vibehack-smoke-test", "ready", null);
    vi.spyOn(SpriteClient.prototype, "importTeam").mockImplementationOnce(async () => {
      unwrap(service.removeMember(alice, team.team.id, bob.id));
      return { ok: true, value: { imported: remote } };
    });
    const mutation = vi.spyOn(SpriteClient.prototype, "teamUpdate");
    expect((await post({ head, remote, mode: "pull" })).statusCode).toBe(404);
    expect(mutation).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import { readFileSync } from "node:fs";

function readFileSafe(root: string) {
  return readFileSync(join(root, "team.txt"), "utf8");
}
