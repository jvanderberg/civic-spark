import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Identity } from "../../../packages/domain/src/access-types.ts";
import type { EventService } from "../../../packages/domain/src/service.ts";
import type { Result } from "../../../packages/domain/src/types.ts";
import { gitAsync } from "../../../packages/git/src/async.ts";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";
import { type TeamStatus, teamUpdateSchema } from "../../../packages/workspace/src/team-git.ts";
import type { AgentSessions } from "./agents.ts";
import { type ChangeNotifier, silentNotifier } from "./events.ts";

function send(reply: FastifyReply, result: Result<unknown>) {
  return result.ok
    ? reply.send(result.value)
    : reply.code(result.status).send({ error: result.error });
}
function actor(value: Identity | null) {
  if (!value) throw new Error("Sign in required");
  return value;
}
export function registerTeamUpdateRoutes(
  app: FastifyInstance,
  service: EventService,
  agents: AgentSessions,
  busy: Set<string>,
  client = new SpriteClient(),
  notify: ChangeNotifier = silentNotifier,
) {
  const cache = new Map<
    string,
    { at: number; remote: string; value: TeamStatus; generation: number }
  >();
  const pending = new Map<string, Promise<Result<TeamStatus>>>();
  const invalidate = (id: string) => {
    cache.delete(id);
  };
  app.get<{ Params: { id: string }; Querystring: { fresh?: string } }>(
    "/api/workspaces/:id/team-status",
    async (r, reply) => {
      const p = await service.teamReferenceAsync(actor(r.actor), r.params.id);
      if (!p.ok) return send(reply, p);
      const { workspace, remote } = p.value;
      const generation = service.runtime(r.params.id).generation;
      const pendingKey = `${r.params.id}:${generation}`;
      const saved = cache.get(r.params.id);
      if (
        r.query.fresh !== "1" &&
        saved?.generation === generation &&
        saved.remote === remote &&
        Date.now() - saved.at < 10000
      )
        return { ...saved.value, agentWorking: agents.isWorking(r.params.id) };
      let request = pending.get(pendingKey);
      if (!request) {
        request =
          workspace.spriteStatus === "local"
            ? Promise.resolve(service.localTeamStatus(actor(r.actor), r.params.id, remote))
            : workspace.spriteStatus === "ready" && workspace.spriteName
              ? client.teamStatus(workspace.spriteName, remote)
              : Promise.resolve({
                  ok: false,
                  error: "Wait for the workspace to be ready.",
                  status: 409,
                });
        pending.set(pendingKey, request);
      }
      const result = await request.finally(() => pending.delete(pendingKey));
      const authorized = service.workspace(actor(r.actor), r.params.id);
      if (!authorized.ok) return send(reply, authorized);
      if (!result.ok) return send(reply, result);
      if (service.runtime(r.params.id).generation !== generation)
        return reply.code(409).send({ error: "Workspace changed. Refresh its status." });
      cache.set(r.params.id, {
        at: Date.now(),
        remote: result.value.remote,
        value: result.value,
        generation,
      });
      if (cache.size > 200) {
        const first = cache.keys().next().value;
        if (first) cache.delete(first);
      }
      return { ...result.value, agentWorking: agents.isWorking(r.params.id) };
    },
  );
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/team-update", async (r, reply) => {
    const input = teamUpdateSchema.parse(r.body);
    const p = await service.teamReferenceAsync(actor(r.actor), r.params.id, true);
    if (!p.ok) return send(reply, p);
    if (p.value.remote !== input.remote)
      return reply
        .code(409)
        .send({ error: "The team repository changed since the preview. Check for updates again." });
    if (agents.isWorking(r.params.id))
      return reply
        .code(409)
        .send({ error: "Wait for the current agent turn to finish before getting team updates." });
    if (busy.has(r.params.id))
      return reply
        .code(409)
        .send({ error: "A Git operation is already in progress. Wait for it to finish." });
    busy.add(r.params.id);
    agents.setGitUpdating(r.params.id, true);
    let temp: string | undefined;
    try {
      temp = mkdtempSync(join(tmpdir(), "civic-spark-team-"));
      const bundle = join(temp, "team.bundle");
      await gitAsync(p.value.repo, ["bundle", "create", bundle, "main"]);
      if (statSync(bundle).size > 10 * 1024 * 1024)
        return reply
          .code(413)
          .send({ error: "The compressed team update exceeds the 10 MB transfer limit." });
      const workspace = p.value.workspace;
      if (workspace.spriteStatus === "local")
        return send(reply, service.localTeamUpdate(actor(r.actor), r.params.id, input, bundle));
      if (workspace.spriteStatus !== "ready" || !workspace.spriteName)
        return reply.code(409).send({ error: "Wait for the workspace to be ready." });
      const imported = await client.importTeam(workspace.spriteName, bundle, input.remote);
      if (!imported.ok) return send(reply, imported);
      const fresh = await service.teamReferenceAsync(actor(r.actor), r.params.id, true);
      if (!fresh.ok) return send(reply, fresh);
      if (fresh.value.remote !== input.remote)
        return reply
          .code(409)
          .send({ error: "The team repository changed during transfer. Check for updates again." });
      if (agents.isWorking(r.params.id))
        return reply.code(409).send({
          error: "The agent started working during transfer. Wait for its turn to finish.",
        });
      return send(reply, await client.teamUpdate(workspace.spriteName, input));
    } catch {
      return reply.code(502).send({
        error:
          "The team update could not finish. Your workspace and recovery copies are preserved.",
      });
    } finally {
      busy.delete(r.params.id);
      agents.setGitUpdating(r.params.id, false);
      invalidate(r.params.id);
      notify.changed(r.params.id, "files");
      notify.changed(r.params.id, "team");
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
  });
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/team-update/verify",
    async (r, reply) => {
      const input = z
        .object({
          head: z.string().regex(/^[a-f0-9]{40}$/),
          remote: z.string().regex(/^[a-f0-9]{40}$/),
        })
        .parse(r.body);
      const p = service.workspace(actor(r.actor), r.params.id, true);
      if (!p.ok) return send(reply, p);
      if (agents.isWorking(r.params.id))
        return reply
          .code(409)
          .send({ error: "Wait for the agent turn to finish before checking its merge." });
      invalidate(r.params.id);
      const verified =
        p.value.spriteStatus === "local"
          ? service.verifyLocalTeamUpdate(actor(r.actor), r.params.id, input.head, input.remote)
          : p.value.spriteStatus === "ready" && p.value.spriteName
            ? await client.verifyTeamUpdate(p.value.spriteName, input.head, input.remote)
            : { ok: false as const, error: "Wait for the workspace to be ready.", status: 409 };
      notify.changed(r.params.id, "files");
      notify.changed(r.params.id, "team");
      return send(reply, verified);
    },
  );
  return { invalidate };
}
