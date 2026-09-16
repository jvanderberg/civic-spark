import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { type Identity, projectInputSchema } from "../../../packages/domain/src/access-types.ts";
import type { EventService } from "../../../packages/domain/src/service.ts";
import type { Result } from "../../../packages/domain/src/types.ts";
import {
  commitIdSchema,
  historyQuerySchema,
  restoreFileInputSchema,
  restoreInputSchema,
} from "../../../packages/git/src/history.ts";
import { projectPath } from "../../../packages/workspace/src/types.ts";

export function registerAdminRoutes(app: FastifyInstance, service: EventService) {
  const actor = (value: Identity | null) => {
    if (!value) throw new Error("Missing session");
    return value;
  };
  const send = (reply: FastifyReply, result: Result<unknown>) =>
    result.ok ? reply.send(result.value) : reply.code(result.status).send({ error: result.error });
  const confirm = z.object({ confirmed: z.literal(true) });
  app.post<{ Params: { id: string } }>("/api/events/:id/projects", async (r, reply) =>
    send(
      reply,
      service.createProject(actor(r.actor), r.params.id, projectInputSchema.parse(r.body)),
    ),
  );
  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/events/:id/members/:userId",
    async (r, reply) => {
      confirm.parse(r.body);
      return send(reply, service.removeEventMember(actor(r.actor), r.params.id, r.params.userId));
    },
  );
  app.delete<{ Params: { id: string } }>("/api/teams/:id", async (r, reply) => {
    confirm.parse(r.body);
    return send(reply, service.deleteTeam(actor(r.actor), r.params.id));
  });
  app.post<{ Params: { id: string } }>("/api/teams/:id/copy", async (r, reply) => {
    const input = z.object({ name: z.string().trim().min(2).max(80) }).parse(r.body);
    return send(reply, service.copyTeam(actor(r.actor), r.params.id, input.name));
  });
  app.get<{ Params: { id: string } }>("/api/teams/:id/repository", async (r, reply) =>
    send(
      reply,
      service.repositoryHistory(actor(r.actor), r.params.id, historyQuerySchema.parse(r.query)),
    ),
  );
  app.get<{ Params: { id: string; commit: string } }>(
    "/api/teams/:id/repository/commits/:commit",
    async (r, reply) =>
      send(
        reply,
        service.repositoryVersion(
          actor(r.actor),
          r.params.id,
          commitIdSchema.parse(r.params.commit),
        ),
      ),
  );
  app.get<{ Params: { id: string; commit: string } }>(
    "/api/teams/:id/repository/commits/:commit/file",
    async (r, reply) => {
      const { path } = z
        .object({
          path: z.string().refine(projectPath, "File is excluded from repository browsing"),
        })
        .parse(r.query);
      return send(
        reply,
        service.repositoryFile(
          actor(r.actor),
          r.params.id,
          commitIdSchema.parse(r.params.commit),
          path,
        ),
      );
    },
  );
  app.post<{ Params: { id: string } }>("/api/teams/:id/repository/restore", async (r, reply) =>
    send(
      reply,
      service.restoreRepository(actor(r.actor), r.params.id, restoreInputSchema.parse(r.body)),
    ),
  );
  app.post<{ Params: { id: string } }>("/api/teams/:id/repository/restore-file", async (r, reply) =>
    send(
      reply,
      service.restoreRepositoryFile(
        actor(r.actor),
        r.params.id,
        restoreFileInputSchema.parse(r.body),
      ),
    ),
  );
}
