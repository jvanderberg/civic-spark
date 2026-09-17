import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import { WorkspaceIntegrations } from "../apps/server/src/integrations.ts";
import { EventService } from "../packages/domain/src/service.ts";
import { testIdentity } from "./auth-fixture.ts";

it("preview and confirmation API deny signed-out callers, other team members, and cross-origin approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-integration-auth-"));
  const { app, service, authentication } = await createApp(
    root,
    false,
    "http://127.0.0.1:4310",
    undefined,
    "email",
  );
  try {
    const owner = await testIdentity(authentication, "Preview owner");
    const other = await testIdentity(authentication, "Other member");
    if (!owner.actor || !other.actor) throw new Error("identity");
    const event = service.createEvent(owner.actor, {
      name: "Preview test",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 4,
      budget: 0,
      templateId: "blank",
    });
    if (!event.ok) throw new Error(event.error);
    service.transition(owner.actor, event.value.id, "registration");
    const team = service.createTeam(owner.actor, {
      eventId: event.value.id,
      name: "Team",
      projectId: "data-starter",
    });
    if (!team.ok) throw new Error(team.error);
    service.joinTeam(other.actor, team.value.team.id);
    const id = team.value.workspace.id;
    for (const path of ["preview", "agent-git"]) {
      const out = await app.inject({
        url: `/api/workspaces/${id}/${path}`,
        headers: { host: "127.0.0.1:4310" },
      });
      expect(out.statusCode).toBe(401);
      const denied = await app.inject({
        url: `/api/workspaces/${id}/${path}`,
        headers: { host: "127.0.0.1:4310", cookie: other.cookie },
      });
      expect(denied.statusCode).toBeGreaterThanOrEqual(400);
    }
    const cross = await app.inject({
      method: "POST",
      url: `/api/workspaces/${id}/agent-git/confirm`,
      headers: { host: "127.0.0.1:4310", cookie: owner.cookie, origin: "https://attacker.test" },
      payload: { id: randomUUID(), allow: true },
    });
    expect(cross.statusCode).toBe(403);
    const forged = await app.inject({
      method: "POST",
      url: `/api/workspaces/${id}/agent-git/confirm`,
      headers: { host: "127.0.0.1:4310", cookie: owner.cookie },
      payload: { id: randomUUID(), allow: true },
    });
    expect(forged.statusCode).toBe(409);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("a conflict ticket survives control-plane restart and only its owner can decline it", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-integration-ticket-"));
  const service = new EventService(root);
  const owner = {
    id: "owner",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: true as const,
  };
  const other = {
    id: "other",
    name: "Other",
    email: "other@example.test",
    emailVerified: true as const,
  };
  let integrations = new WorkspaceIntegrations(service, root, new Set());
  try {
    const event = service.createEvent(owner, {
      name: "Test",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 4,
      budget: 0,
      templateId: "blank",
    });
    if (!event.ok) throw new Error(event.error);
    const team = service.createTeam(owner, {
      eventId: event.value.id,
      name: "Team",
      projectId: "data-starter",
    });
    if (!team.ok) throw new Error(team.error);
    const id = team.value.workspace.id;
    const ticket = randomUUID();
    writeFileSync(
      join(root, "agent-integrations", `${id}.json`),
      JSON.stringify({
        id: ticket,
        owner: owner.id,
        head: "a".repeat(40),
        remote: "b".repeat(40),
        status: "confirmation",
        conflicts: ["chart.tsx"],
      }),
    );
    integrations.close();
    integrations = new WorkspaceIntegrations(service, root, new Set());
    expect(integrations.pending(id, owner)?.id).toBe(ticket);
    await expect(integrations.confirm(id, other, ticket, false)).rejects.toThrow();
    expect(integrations.pending(id, owner)?.status).toBe("confirmation");
    await expect(integrations.confirm(id, owner, randomUUID(), false)).rejects.toThrow(
      "no longer pending",
    );
    expect(await integrations.confirm(id, owner, ticket, false)).toEqual({ status: "declined" });
    await expect(integrations.publish(id, owner, async () => true)).rejects.toThrow("declined");
  } finally {
    integrations.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
