import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentSessions } from "../apps/server/src/agents.ts";
import { createApp } from "../apps/server/src/app.ts";
import { ok, type Result } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { testIdentity } from "./auth-fixture.ts";

const unwrap = <T>(result: Result<T>) => {
  if (!result.ok) throw Error(result.error);
  return result.value;
};
afterEach(() => vi.restoreAllMocks());
it.each([true, false])(
  "joined owner Launch honors feature flag %s without harness/model; rejects cross-owner/event and pause",
  async (enabled) => {
    const root = mkdtempSync(join(tmpdir(), "civic-spark-launch-api-"));
    const prepare = vi
      .spyOn(AgentSessions.prototype, "prepare")
      .mockRejectedValue(Error("Harness must not run"));
    const transport = vi.spyOn(SpriteClient.prototype, "preview").mockResolvedValue(
      ok({
        port: 5173,
        command: ["npm", "run", "dev"],
        running: true,
        ready: true,
        phase: "ready",
      }),
    );
    const { app, service, authentication } = await createApp(
      root,
      enabled,
      "http://127.0.0.1:4310",
    );
    try {
      const admin = await testIdentity(authentication, "Preview admin"),
        member = await testIdentity(authentication, "Preview member"),
        stranger = await testIdentity(authentication, "Other event owner");
      if (!admin.actor || !member.actor || !stranger.actor) throw Error();
      const input = {
        name: "Shared preview",
        date: "2026-10-03",
        timezone: "America/Chicago",
        location: "Test",
        capacity: 10,
        budget: 0,
        templateId: "blank" as const,
      };
      const event = unwrap(service.createEvent(admin.actor, input));
      unwrap(service.createEvent(stranger.actor, { ...input, name: "Another event" }));
      unwrap(service.transition(admin.actor, event.id, "registration"));
      const team = unwrap(
        service.createTeam(admin.actor, {
          eventId: event.id,
          name: "Shared demo",
          projectId: "data-starter",
        }),
      );
      const workspace = unwrap(service.joinTeam(member.actor, team.team.id));
      service.setSprite(workspace.id, `civic-spark-${workspace.id}`, "ready", null);
      const request = (cookie: string) =>
        app.inject({
          method: "POST",
          url: `/api/workspaces/${workspace.id}/preview`,
          headers: { cookie, origin: "http://127.0.0.1:4310" },
          payload: { action: "start" },
        });
      if (!enabled) {
        expect((await request(member.cookie)).statusCode).toBe(409);
        expect(transport).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        return;
      }
      expect((await request(member.cookie)).json()).toMatchObject({ ready: true });
      expect(transport).toHaveBeenCalledExactlyOnceWith(
        `civic-spark-${workspace.id}`,
        "start",
        undefined,
      );
      expect(prepare).not.toHaveBeenCalled();
      for (const identity of [admin, stranger])
        expect((await request(identity.cookie)).statusCode).toBe(404);
      unwrap(service.setExecution(admin.actor, event.id, true));
      expect((await request(member.cookie)).statusCode).toBe(423);
      expect(transport).toHaveBeenCalledTimes(1);
      unwrap(service.setExecution(admin.actor, event.id, false));
      let finish: (() => void) | undefined;
      transport.mockImplementation(async (_name, operation) => {
        if (operation === "start")
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        if (operation === "stop") finish?.();
        return ok({
          port: 5173,
          command: ["npm", "run", "dev"],
          running: false,
          ready: false,
          phase: "stopped",
        });
      });
      const pending = request(member.cookie).then((value) => value);
      await vi.waitFor(() => expect(finish).toBeDefined());
      unwrap(service.removeMember(admin.actor, team.team.id, member.actor.id));
      expect((await pending).statusCode).toBe(409);
      expect(transport).toHaveBeenLastCalledWith(`civic-spark-${workspace.id}`, "stop");
    } finally {
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("sends only fixed preview code and committed defaults to the owner Sprite with a bounded preparation timeout", async () => {
  const command = vi.spyOn(SpriteClient.prototype, "command").mockResolvedValue(
    ok(
      Buffer.from(
        JSON.stringify({
          ok: true,
          value: {
            port: 5173,
            command: ["npm", "run", "dev"],
            running: true,
            ready: true,
            phase: "ready",
          },
        }),
      ),
    ),
  );
  const client = new SpriteClient();
  expect((await client.preview("civic-spark-owner-fixture", "start")).ok).toBe(true);
  const call = command.mock.calls[0];
  expect(call?.[0].slice(0, 7)).toEqual([
    "-s",
    "civic-spark-owner-fixture",
    "exec",
    "--no-port-forward",
    "--",
    "python3",
    "-c",
  ]);
  expect(call?.[1]).toBe(360000);
  expect(JSON.parse(call?.[2] ?? "")).toMatchObject({
    operation: "start",
    defaults: {
      port: 5173,
      command: ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
    },
  });
  expect(call?.[0]).not.toContain("bash");
});
