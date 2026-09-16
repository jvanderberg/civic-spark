import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { AgentSessions } from "../apps/server/src/agents.ts";
import { createApp } from "../apps/server/src/app.ts";
import { TerminalSessions } from "../apps/server/src/terminal.ts";
import { testIdentity } from "./auth-fixture.ts";

it("keeps Sprite execution private even when harness tool permissions are bypassed", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-execution-access-"));
  const origin = "http://127.0.0.1:4310";
  // Never launch a Sprite, terminal, agent, or model in this authorization test.
  const agent = vi
    .spyOn(AgentSessions.prototype, "attach")
    .mockImplementation((_id, _sprite, socket) => socket.close(1000));
  const terminal = vi
    .spyOn(TerminalSessions.prototype, "attach")
    .mockImplementation((_id, _sprite, socket) => socket.close(1000));
  const prepare = vi.spyOn(AgentSessions.prototype, "prepare").mockResolvedValue(true);
  const { app, service, authentication } = await createApp(root, false, origin, undefined, "email");
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const admin = await testIdentity(authentication, "Execution admin");
    const owner = await testIdentity(authentication, "Execution owner");
    assert(admin.actor && owner.actor);
    const event = service.createEvent(admin.actor, {
      name: "Private execution",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 3,
      budget: 0,
      templateId: "blank",
    });
    assert(event.ok);
    assert(service.transition(admin.actor, event.value.id, "registration").ok);
    const team = service.createTeam(owner.actor, {
      eventId: event.value.id,
      name: "Private team",
      projectId: "data-starter",
    });
    assert(team.ok);
    const id = team.value.workspace.id;
    service.setSprite(id, "civic-spark-smoke-access", "ready", null);
    const headers = { host: "127.0.0.1:4310", origin };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/workspaces/${id}/agent/prepare`,
          headers: { ...headers, cookie: admin.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
    const closeCode = (path: string, cookie: string, requestOrigin = origin) =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(
          `${address.replace("http", "ws")}/api/workspaces/${id}/${path}`,
          { headers: { cookie, origin: requestOrigin } },
        );
        socket.once("unexpected-response", (_request, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
          socket.terminate();
        });
        socket.once("close", resolve);
        socket.once("error", reject);
      });
    for (const path of ["agent", "terminal"]) {
      expect(await closeCode(path, admin.cookie)).toBe(1008);
      expect(await closeCode(path, owner.cookie, "https://untrusted.example")).toBe(403);
      expect(await closeCode(path, owner.cookie)).toBe(1000);
    }
    expect(agent).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    assert(service.removeMember(admin.actor, team.value.team.id, owner.actor.id).ok);
    for (const path of ["agent", "terminal"])
      expect(await closeCode(path, owner.cookie)).toBe(1008);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
