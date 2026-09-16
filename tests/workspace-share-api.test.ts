import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
it("Share API requires an owner and description, publishes main, and rechecks membership after Sprite transfer", async () => {
  const root = mkdtempSync(join(tmpdir(), "vibehack-share-api-"));
  const { app, service, authentication } = await createApp(
    root,
    false,
    "http://127.0.0.1:4310",
    undefined,
    "email",
  );
  try {
    const owner = await testIdentity(authentication, "Share owner");
    const outsider = await testIdentity(authentication, "Share outsider");
    if (!owner.actor) throw new Error("No owner");
    const actor = owner.actor;
    const event = unwrap(
      service.createEvent(actor, {
        name: "Share API",
        date: "2026-10-03",
        timezone: "America/Chicago",
        location: "Test",
        capacity: 10,
        budget: 0,
        templateId: "blank",
      }),
    );
    const team = unwrap(
      service.createTeam(actor, { eventId: event.id, name: "API team", projectId: "data-starter" }),
    );
    const id = team.workspace.id;
    const dir = service.workspacePath(id);
    writeFileSync(join(dir, "api.txt"), "Shared through API\n");
    const revision = new WorkspaceFiles(dir).changes().revision;
    const request = (cookie: string, title = "Share API update") =>
      app.inject({
        method: "POST",
        url: `/api/workspaces/${id}/share`,
        headers: { cookie, origin: "http://127.0.0.1:4310" },
        payload: { title, revision },
      });
    expect((await request(outsider.cookie)).statusCode).toBe(404);
    expect((await request(owner.cookie, "  ")).statusCode).toBe(400);
    const response = await request(owner.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("accepted");
    expect(service.portal(actor, false).contributions).toHaveLength(1);
    service.setSprite(id, "vibehack-smoke-test", "ready", null);
    vi.spyOn(SpriteClient.prototype, "share").mockImplementationOnce(async () => {
      unwrap(service.removeMember(actor, team.team.id, actor.id));
      return {
        ok: true,
        value: {
          commit: "a".repeat(40),
          ref: `refs/vibehack/share/${revision}`,
          revision: revision as string,
          bundle: "",
        },
      };
    });
    expect((await request(owner.cookie)).statusCode).toBe(404);
    expect(service.portal(actor, false).contributions).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
