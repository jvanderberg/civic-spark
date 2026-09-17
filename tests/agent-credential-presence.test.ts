import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentSessions } from "../apps/server/src/agents.ts";
import { createApp } from "../apps/server/src/app.ts";
import { loadCredentials, saveCredential } from "../packages/agents/src/credentials.ts";
import { testIdentity } from "./auth-fixture.ts";

it("checks native saved-key presence without installing a harness or disclosing keys", () => {
  const home = mkdtempSync(join(tmpdir(), "civic-spark-credential-presence-"));
  try {
    const source = readFileSync("packages/agents/runtime/credential-presence.py", "utf8").replace(
      "Path.home()",
      `Path(${JSON.stringify(home)})`,
    );
    const check = () => JSON.parse(execFileSync("python3", ["-c", source], { encoding: "utf8" }));
    expect(check()).toEqual({ savedProviders: [] });
    saveCredential(home, "claude", "fake-local-claude");
    expect(check()).toEqual({ savedProviders: ["claude"] });
    saveCredential(home, "opencode", "fake-local-router");
    expect(check()).toEqual({ savedProviders: ["opencode", "claude"] });
    expect(loadCredentials(home)).toEqual({
      claude: "fake-local-claude",
      opencode: "fake-local-router",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("keeps credential metadata owner-only and rechecks revocation after the Sprite read", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-key-status-api-"));
  const status = vi
    .spyOn(AgentSessions.prototype, "credentials")
    .mockResolvedValue({ savedProviders: [] });
  const { app, service, authentication } = await createApp(root, false);
  try {
    const identity = await testIdentity(authentication, "Key status owner");
    const stranger = await testIdentity(authentication, "Key status stranger");
    assert(identity.actor);
    const event = service.createEvent(identity.actor, {
      name: "Credential fixture",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 20,
      budget: 0,
      templateId: "blank",
    });
    assert(event.ok);
    const created = service.createTeam(identity.actor, {
      eventId: event.value.id,
      name: "Key status team",
      projectId: "data-starter",
    });
    assert(created.ok);
    const own = created.value.workspace;
    service.setSprite(own.id, `civic-spark-${own.id}`, "ready", null);
    const url = `/api/workspaces/${own.id}/agent/credentials`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { cookie: stranger.cookie } })).statusCode).toBe(404);
    expect(status).not.toHaveBeenCalled();
    const result = await app.inject({ url, headers: { cookie: identity.cookie } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ savedProviders: [] });
    expect(result.headers["cache-control"]).toBe("no-store");
    let release!: (value: { savedProviders: ("claude" | "opencode")[] }) => void;
    status.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = app.inject({ url, headers: { cookie: identity.cookie } });
    // Fastify injection begins when the thenable is observed.
    const response = Promise.resolve(pending);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(service.removeMember(identity.actor, own.teamId, identity.actor.id).ok).toBe(true);
    release({ savedProviders: ["claude"] });
    expect((await response).statusCode).toBe(404);
  } finally {
    status.mockRestore();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
