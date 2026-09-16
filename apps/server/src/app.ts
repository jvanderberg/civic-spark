import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { fromNodeHeaders } from "better-auth/node";
import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import {
  type Identity,
  identitySchema,
  teamInputSchema,
} from "../../../packages/domain/src/access-types.ts";
import { EventService } from "../../../packages/domain/src/service.ts";
import { createEventSchema, type Result } from "../../../packages/domain/src/types.ts";
import { git } from "../../../packages/git/src/repository.ts";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";
import {
  BLOB_BODY_LIMIT,
  mutationSchema,
  TEXT_BODY_LIMIT,
} from "../../../packages/workspace/src/types.ts";
import { registerAdminRoutes } from "./admin.ts";
import { AgentSessions } from "./agents.ts";
import { createAuthentication } from "./auth.ts";
import { clientAddress, storageReady, validateDeployment } from "./deployment.ts";
import type { EmailDelivery } from "./email.ts";
import { WorkspaceIntegrations } from "./integrations.ts";
import { prototypeSignIn } from "./prototype-auth.ts";
import { WorkspaceProvisioning } from "./provisioning.ts";
import { registerTeamUpdateRoutes } from "./team-updates.ts";
import { TerminalSessions } from "./terminal.ts";

declare module "fastify" {
  interface FastifyRequest {
    actor: Identity | null;
  }
}
function send(reply: FastifyReply, result: Result<unknown>) {
  return result.ok
    ? reply.send(result.value)
    : reply.code(result.status).send({ error: result.error });
}
export async function createApp(
  root = resolve(process.env.CIVIC_SPARK_DATA_DIR ?? ".data"),
  spritesEnabled = process.env.CIVIC_SPARK_ENABLE_SPRITES === "1",
  baseURL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:4310",
  delivery?: EmailDelivery,
  authMode = z.enum(["email", "prototype"]).parse(process.env.CIVIC_SPARK_AUTH_MODE ?? "email"),
) {
  const deployment = validateDeployment(root, baseURL, authMode);
  const prototype = authMode === "prototype";
  if (prototype) {
    if (!["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname))
      throw new Error("Prototype sign-in requires a localhost browser origin");
    root = join(root, "prototype");
  }
  const app = Fastify({ logger: false, bodyLimit: 1500000 });
  await app.register(websocket, { options: { maxPayload: 65536 } });
  const terminals = new TerminalSessions();
  const agents = new AgentSessions();
  const service = new EventService(root);
  const sharing = new Set<string>();
  const integrations = new WorkspaceIntegrations(service, root, sharing, baseURL);
  const provisioning = new WorkspaceProvisioning(service, root);
  const authentication = await createAuthentication(
    root,
    baseURL,
    prototype
      ? {
          configured: false,
          async send() {
            throw new Error("Prototype mode does not send email");
          },
        }
      : delivery,
    prototype,
  );
  const { auth } = authentication;
  app.decorateRequest("actor", null);
  app.addHook("onRequest", async (request) => {
    // Replace, never trust, a caller-supplied IP hint. Deployment proxy trust must be configured explicitly.
    request.headers["x-vibehack-client-ip"] = clientAddress(
      request.ip,
      request.headers,
      deployment,
    );
    delete request.headers["x-forwarded-for"];
    delete request.headers["x-forwarded-host"];
    delete request.headers["x-forwarded-proto"];
  });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host?.split(":")[0];
    if (
      prototype &&
      (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip) ||
        !["127.0.0.1", "localhost"].includes(host ?? ""))
    )
      return reply.code(403).send({ error: "Prototype mode is local only" });
    if (
      !(
        deployment.hosted
          ? [new URL(baseURL).hostname]
          : ["127.0.0.1", "localhost", new URL(baseURL).hostname]
      ).includes(host ?? "")
    )
      return reply.code(403).send({ error: "Unrecognized host" });
    // Better Auth validates magic-link tokens and auth CSRF/origin rules.
    if (request.url.startsWith("/api/auth/")) return;
    const origin = request.headers.origin;
    if (
      (origin &&
        !(deployment.hosted ? [baseURL] : [baseURL, `http://${request.headers.host}`]).includes(
          origin,
        )) ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      return reply.code(403).send({ error: "Cross-origin requests are disabled" });
    if (!request.url.startsWith("/api/")) return;
    if (request.url.split("?")[0] === "/api/health") return;
    if (prototype && request.url === "/api/prototype/sign-in") return;
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    const parsed = identitySchema.safeParse(
      session?.user && prototype
        ? { ...session.user, id: session.user.email.toLowerCase() }
        : session?.user,
    );
    request.actor = parsed.success ? parsed.data : null;
    if (request.url.split("?")[0] !== "/api/session" && !request.actor)
      return reply.code(401).send({ error: "Verify your email to sign in and continue" });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: error.issues.map((i) => i.message).join(". ") });
    return reply
      .code(500)
      .send({ error: "The operation could not complete. Your saved work is preserved." });
  });
  app.addHook("onClose", async () => {
    terminals.close();
    agents.close();
    integrations.close();
    await provisioning.close();
    service.close();
    authentication.close();
  });
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (request, reply) => {
      if (
        request.url.split("?")[0] === "/api/auth/sign-in/magic-link" &&
        !authentication.emailSignIn
      )
        return reply.code(503).send({ error: "Email sign-in is not configured yet" });
      reply.header("Cache-Control", "no-store");
      reply.header("Referrer-Policy", "no-referrer");
      const headers = fromNodeHeaders(request.headers);
      const body =
        typeof request.body === "string"
          ? request.body
          : request.body
            ? JSON.stringify(request.body)
            : undefined;
      const response = await auth.handler(
        new Request(new URL(request.url, baseURL), { method: request.method, headers, body }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      if (response.headers.getSetCookie().length)
        reply.header("set-cookie", response.headers.getSetCookie());
      return reply.send(await response.text());
    },
  });
  if (prototype)
    app.post("/api/prototype/sign-in", async (r, reply) => {
      const input = z
        .object({
          email: z.email().transform((v) => v.toLowerCase()),
          name: z.string().trim().max(80).default(""),
        })
        .parse(r.body);
      reply.header("Cache-Control", "no-store");
      reply.header("set-cookie", await prototypeSignIn(authentication, input.email, input.name));
      return { signedIn: true };
    });
  app.get("/api/health", async (_request, reply) => {
    try {
      service.checkHealth();
      authentication.checkHealth();
      storageReady(root);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.get("/api/session", async (r) => ({
    user: r.actor,
    emailSignIn: authentication.emailSignIn,
    authMode,
  }));
  // Authentication hook guarantees actor for all routes below; no user IDs from
  // request bodies, query parameters, or custom headers establish identity.
  const actor = (value: Identity | null): Identity => {
    if (!value) throw new Error("Missing session");
    return value;
  };
  registerAdminRoutes(app, service);
  app.get("/api/state", async (r) => service.portal(actor(r.actor), spritesEnabled));
  app.post("/api/events", async (r, reply) =>
    send(reply, service.createEvent(actor(r.actor), createEventSchema.parse(r.body))),
  );
  app.post<{ Params: { id: string } }>("/api/events/:id/status", async (r, reply) =>
    send(
      reply,
      service.transition(
        actor(r.actor),
        r.params.id,
        z.object({ status: z.enum(["draft", "registration", "live", "closed"]) }).parse(r.body)
          .status,
      ),
    ),
  );
  app.post<{ Params: { id: string; userId: string } }>(
    "/api/events/:id/members/:userId/role",
    async (r, reply) =>
      send(
        reply,
        service.setRole(
          actor(r.actor),
          r.params.id,
          r.params.userId,
          z.object({ role: z.enum(["admin", "member"]) }).parse(r.body).role,
        ),
      ),
  );
  app.post("/api/teams", async (r, reply) =>
    send(reply, service.createTeam(actor(r.actor), teamInputSchema.parse(r.body))),
  );
  app.post<{ Params: { id: string } }>("/api/events/:id/admins", async (r, reply) =>
    send(
      reply,
      service.addAdmin(
        actor(r.actor),
        r.params.id,
        z.object({ email: z.email() }).parse(r.body).email,
      ),
    ),
  );
  app.post<{ Params: { id: string } }>("/api/teams/:id/join", async (r, reply) =>
    send(reply, service.joinTeam(actor(r.actor), r.params.id)),
  );
  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/teams/:id/members/:userId",
    async (r, reply) =>
      send(reply, service.removeMember(actor(r.actor), r.params.id, r.params.userId)),
  );
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/agent/prepare", async (r, reply) => {
    const p = service.workspace(actor(r.actor), r.params.id, true);
    if (!p.ok) return send(reply, p);
    if (p.value.spriteStatus !== "ready" || !p.value.spriteName)
      return reply.code(409).send({ error: "Agent execution needs a running Sprite" });
    const prepared = await agents.prepare(p.value.spriteName);
    if (prepared) {
      const owner = actor(r.actor);
      integrations.ensure(r.params.id, owner, p.value.spriteName, async () => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(r.headers) });
        return Boolean(
          session &&
            (prototype ? session.user.email.toLowerCase() : session.user.id) === owner.id &&
            service.workspace(owner, r.params.id, true).ok,
        );
      });
    }
    return prepared
      ? { ready: true }
      : reply.code(502).send({
          error:
            "The Sprite tools could not be installed or verified. Check the Sprite connection, then reconnect to retry setup.",
        });
  });
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/agent-git", async (r) => ({
    pending: integrations.pending(r.params.id, actor(r.actor)),
  }));
  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/agent-git/confirm",
    async (r, reply) => {
      const input = z.object({ id: z.uuid(), allow: z.boolean() }).parse(r.body);
      if (agents.isWorking(r.params.id))
        return reply
          .code(409)
          .send({ error: "Wait for the agent to finish before starting conflict resolution." });
      try {
        return await integrations.confirm(r.params.id, actor(r.actor), input.id, input.allow);
      } catch (e) {
        return reply
          .code(409)
          .send({ error: e instanceof Error ? e.message : "Conflict confirmation failed" });
      }
    },
  );
  app.get<{ Params: { id: string }; Querystring: { logs?: string } }>(
    "/api/workspaces/:id/preview",
    async (r, reply) => {
      try {
        return await integrations.preview(
          r.params.id,
          actor(r.actor),
          r.query.logs === "1" ? "logs" : "status",
        );
      } catch (e) {
        return reply
          .code(409)
          .send({ error: e instanceof Error ? e.message : "Preview unavailable" });
      }
    },
  );
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/preview", async (r, reply) => {
    const input = z.object({ action: z.enum(["start", "restart", "stop", "open"]) }).parse(r.body);
    const owner = actor(r.actor);
    try {
      const workspace = service.workspace(owner, r.params.id, true);
      if (!workspace.ok) return send(reply, workspace);
      if (!workspace.value.spriteName)
        return reply.code(409).send({ error: "Preview needs a running Sprite" });
      const authorized = async () => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(r.headers) });
        return Boolean(
          session &&
            (prototype ? session.user.email.toLowerCase() : session.user.id) === owner.id &&
            service.workspace(owner, r.params.id, true).ok,
        );
      };
      if (input.action === "open")
        return await integrations.openPreview(r.params.id, owner, authorized);
      if (!(await agents.prepare(workspace.value.spriteName)))
        throw new Error("Runtime setup failed. Retry after checking the Sprite connection.");
      integrations.ensure(r.params.id, owner, workspace.value.spriteName, authorized);
      return await integrations.preview(r.params.id, owner, input.action);
    } catch (e) {
      return reply
        .code(409)
        .send({ error: e instanceof Error ? e.message : "Preview action failed" });
    }
  });
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/agent",
    { websocket: true },
    (socket, r) => {
      const p = service.workspace(actor(r.actor), r.params.id, true);
      if (
        r.headers.origin !== baseURL ||
        !p.ok ||
        !p.value.spriteName ||
        p.value.spriteStatus !== "ready"
      ) {
        socket.close(1008, "Agent unavailable");
        return;
      }
      const owner = actor(r.actor);
      try {
        agents.attach(r.params.id, p.value.spriteName, socket, async () => {
          const session = await auth.api.getSession({ headers: fromNodeHeaders(r.headers) });
          return Boolean(
            session &&
              (prototype ? session.user.email.toLowerCase() : session.user.id) === owner.id &&
              service.workspace(owner, r.params.id, true).ok,
          );
        });
      } catch {
        socket.close(1011, "Agent runner could not start");
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/terminal",
    { websocket: true },
    (socket, r) => {
      const p = service.workspace(actor(r.actor), r.params.id, true);
      if (
        r.headers.origin !== baseURL ||
        !p.ok ||
        !p.value.spriteName ||
        p.value.spriteStatus !== "ready"
      ) {
        socket.close(1008, "Terminal unavailable");
        return;
      }
      const owner = actor(r.actor);
      try {
        terminals.attach(r.params.id, p.value.spriteName, socket, async () => {
          const session = await auth.api.getSession({ headers: fromNodeHeaders(r.headers) });
          return Boolean(
            session &&
              (prototype ? session.user.email.toLowerCase() : session.user.id) === owner.id &&
              service.workspace(owner, r.params.id, true).ok,
          );
        });
      } catch {
        socket.close(1011, "Sprite terminal could not start");
      }
    },
  );
  for (const operation of ["manifest", "changes"] as const) {
    app.get<{ Params: { id: string } }>(`/api/workspaces/:id/${operation}`, async (r, reply) => {
      const p = service.workspace(actor(r.actor), r.params.id);
      if (!p.ok) return send(reply, p);
      if (p.value.spriteStatus === "ready" && p.value.spriteName)
        return send(reply, await new SpriteClient()[operation](p.value.spriteName));
      return send(reply, service.workspaceFiles(actor(r.actor), r.params.id, operation));
    });
  }
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/workspaces/:id/blob",
    async (r, reply) => {
      const p = service.workspace(actor(r.actor), r.params.id);
      if (!p.ok) return send(reply, p);
      const path = z.string().parse(r.query.path);
      if (p.value.spriteStatus === "ready" && p.value.spriteName)
        return send(reply, await new SpriteClient().readBlob(p.value.spriteName, path));
      return send(reply, service.workspaceFiles(actor(r.actor), r.params.id, "read", path));
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/workspaces/:id/blob",
    { bodyLimit: BLOB_BODY_LIMIT },
    async (r, reply) => {
      const p = service.workspace(actor(r.actor), r.params.id, true);
      if (!p.ok) return send(reply, p);
      const input = mutationSchema.parse(r.body);
      if (p.value.spriteStatus === "ready" && p.value.spriteName)
        return send(reply, await new SpriteClient().mutateBlob(p.value.spriteName, input));
      return send(reply, service.workspaceFiles(actor(r.actor), r.params.id, "mutate", input));
    },
  );
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/files", async (r, reply) => {
    const p = service.workspace(actor(r.actor), r.params.id);
    if (!p.ok) return send(reply, p);
    if (p.value.spriteStatus === "ready" && p.value.spriteName)
      return send(reply, await new SpriteClient().files(p.value.spriteName));
    return send(reply, service.files(actor(r.actor), r.params.id));
  });
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/workspaces/:id/file",
    async (r, reply) => {
      const path = z.string().parse(r.query.path);
      const p = service.workspace(actor(r.actor), r.params.id);
      if (!p.ok) return send(reply, p);
      if (p.value.spriteStatus === "ready" && p.value.spriteName)
        return send(reply, await new SpriteClient().readFile(p.value.spriteName, path));
      return send(reply, service.readFile(actor(r.actor), r.params.id, path));
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/workspaces/:id/file",
    { bodyLimit: TEXT_BODY_LIMIT },
    async (r, reply) => {
      const b = z
        .object({ path: z.string(), content: z.string(), revision: z.string() })
        .parse(r.body);
      const p = service.workspace(actor(r.actor), r.params.id, true);
      if (!p.ok) return send(reply, p);
      if (p.value.spriteStatus === "ready" && p.value.spriteName)
        return send(reply, await new SpriteClient().saveFile(p.value.spriteName, b));
      return send(
        reply,
        service.saveFile(actor(r.actor), r.params.id, b.path, b.content, b.revision),
      );
    },
  );
  const teamUpdates = registerTeamUpdateRoutes(app, service, agents, sharing);
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/share", async (r, reply) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(160),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(r.body);
    const p = service.workspace(actor(r.actor), r.params.id, true);
    if (!p.ok) return send(reply, p);
    if (sharing.has(r.params.id))
      return reply
        .code(409)
        .send({ error: "A share is already in progress. Wait for it to finish." });
    sharing.add(r.params.id);
    let temp: string | undefined;
    try {
      if (p.value.spriteStatus === "local")
        return send(
          reply,
          service.shareLocal(actor(r.actor), r.params.id, input.title, input.revision),
        );
      if (p.value.spriteStatus !== "ready" || !p.value.spriteName)
        return reply
          .code(409)
          .send({ error: "Wait for your workspace to be ready before sharing." });
      const result = await new SpriteClient().share(
        p.value.spriteName,
        input.title,
        input.revision,
      );
      if (!result.ok) return send(reply, result);
      // Reauthorize after remote I/O: removed members and closed events cannot publish.
      const access = service.workspace(actor(r.actor), r.params.id, true);
      if (!access.ok) return send(reply, access);
      temp = mkdtempSync(join(tmpdir(), "vibehack-incoming-"));
      const bundle = join(temp, "contribution.bundle");
      const data = Buffer.from(result.value.bundle, "base64");
      if (data.length > 10 * 1024 * 1024 || data.toString("base64") !== result.value.bundle)
        throw new Error("Invalid contribution transfer");
      writeFileSync(bundle, data, { mode: 0o600 });
      const repo = join(temp, "repository.git");
      git(temp, ["init", "--bare", repo]);
      git(repo, ["bundle", "verify", bundle]);
      git(repo, ["fetch", bundle, `${result.value.ref}:refs/heads/incoming`]);
      const commit = git(repo, ["rev-parse", "refs/heads/incoming"]).toString().trim();
      if (commit !== result.value.commit || result.value.revision !== input.revision)
        throw new Error("Invalid contribution transfer");
      const published = service.publishSnapshot(
        actor(r.actor),
        r.params.id,
        input.title,
        input.revision,
        repo,
        commit,
      );
      if (!published.ok) return send(reply, published);
      const acknowledged = await new SpriteClient().acknowledgeShare(
        p.value.spriteName,
        input.revision,
        commit,
      );
      return reply.send({
        ...published.value,
        notice: acknowledged.ok
          ? undefined
          : "Shared with your team. The workspace preview could not refresh its baseline; reconnect to retry.",
      });
    } catch {
      return reply.code(502).send({
        error:
          "Sharing could not complete. Your files and any local commit are preserved; retry Share.",
      });
    } finally {
      sharing.delete(r.params.id);
      teamUpdates.invalidate(r.params.id);
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
  });
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/contributions", async (r, reply) =>
    send(
      reply,
      service.propose(
        actor(r.actor),
        r.params.id,
        z.object({ title: z.string().trim().min(1).max(160) }).parse(r.body).title,
      ),
    ),
  );
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/sync", async (r, reply) =>
    send(reply, service.sync(actor(r.actor), r.params.id)),
  );
  app.post<{ Params: { id: string } }>("/api/contributions/:id/accept", async (r, reply) =>
    send(reply, service.accept(actor(r.actor), r.params.id)),
  );
  app.get<{ Params: { id: string } }>("/api/teams/:id/export", async (r, reply) => {
    const result = service.exportTeam(actor(r.actor), r.params.id);
    if (!result.ok) return send(reply, result);
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", 'attachment; filename="team-project.zip"')
      .send(result.value);
  });
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/sprite", async (r, reply) => {
    const workspace = service.workspace(actor(r.actor), r.params.id);
    if (!workspace.ok) return send(reply, workspace);
    return provisioning.status(workspace.value);
  });
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/sprite", async (r, reply) => {
    const workspace = service.workspace(actor(r.actor), r.params.id, true);
    if (!workspace.ok) return send(reply, workspace);
    if (!spritesEnabled)
      return reply
        .code(409)
        .send({ error: "Cloud workspaces are not enabled for this installation yet" });
    const result = provisioning.start(workspace.value);
    if (result.ok) return reply.code(result.value.preparing ? 202 : 200).send(result.value);
    return send(reply, result);
  });
  const web = resolve("dist/web");
  if (existsSync(web)) {
    app.register(fastifyStatic, { root: web });
    app.setNotFoundHandler((r, reply) =>
      r.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  return { app, service, authentication };
}
