import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { fromNodeHeaders } from "better-auth/node";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  demoIdentitySchema,
  type Identity,
  teamInputSchema,
  verifiedIdentitySchema,
} from "../../../packages/domain/src/access-types.ts";
import {
  lifecycleActionSchema,
  missingWorkspaceConfirmationSchema,
  spriteActionSchema,
} from "../../../packages/domain/src/lifecycle.ts";
import { EventService } from "../../../packages/domain/src/service.ts";
import {
  createEventSchema,
  eventSettingsSchema,
  fail,
  type Result,
} from "../../../packages/domain/src/types.ts";
import { gitAsync } from "../../../packages/git/src/async.ts";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";
import {
  SpriteLifecycle,
  type SpriteLifecycleProvider,
} from "../../../packages/sprites/src/lifecycle.ts";
import {
  BLOB_BODY_LIMIT,
  mutationSchema,
  TEXT_BODY_LIMIT,
} from "../../../packages/workspace/src/types.ts";
import { registerAdminRoutes } from "./admin.ts";
import { AgentSessions } from "./agents.ts";
import { createAuthentication } from "./auth.ts";
import {
  clientAddress,
  createStorageReadiness,
  storageHeadroom,
  validateDeployment,
} from "./deployment.ts";
import type { EmailDelivery } from "./email.ts";
import { WorkspaceIntegrations } from "./integrations.ts";
import { WorkspaceLifecycle } from "./lifecycle.ts";
import { inspectIdleWorkspaceForWake } from "./missing-workspace.ts";
import { prototypeSignIn } from "./prototype-auth.ts";
import { WorkspaceProvisioning } from "./provisioning.ts";
import { registerTeamUpdateRoutes } from "./team-updates.ts";
import { TerminalSessions } from "./terminal.ts";

declare module "fastify" {
  interface FastifyRequest {
    actor: Identity | null;
    capacityBodyBytes: number;
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
  authMode = z
    .enum(["email", "prototype", "demo"])
    .parse(process.env.CIVIC_SPARK_AUTH_MODE ?? "email"),
  siteEventId = z.uuid().optional().parse(process.env.CIVIC_SPARK_SITE_EVENT_ID),
  lifecycleProvider?: SpriteLifecycleProvider,
) {
  const deployment = validateDeployment(root, baseURL, authMode);
  const prototype = authMode === "prototype";
  const demo = authMode === "demo";
  const unverifiedSignIn = prototype || demo;
  if (demo) root = join(root, "demo");
  if (prototype) {
    if (!["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname))
      throw new Error("Prototype sign-in requires a localhost browser origin");
    root = join(root, "prototype");
  }
  const service = new EventService(root);
  if (siteEventId) {
    const site = service.siteEvent(siteEventId, null);
    if (!site.ok) {
      service.close();
      throw new Error(site.error);
    }
  }
  const app = Fastify({ logger: false, bodyLimit: 1500000 });
  let incomingBodyBytes = 0;
  app.decorateRequest("capacityBodyBytes", 0);
  const releaseBody = (request: { capacityBodyBytes: number }) => {
    incomingBodyBytes -= request.capacityBodyBytes;
    request.capacityBodyBytes = 0;
  };
  app.addHook("onResponse", async (request) => releaseBody(request));
  app.addHook("onRequestAbort", async (request) => releaseBody(request));
  app.addHook("onError", async (request) => releaseBody(request));
  await app.register(websocket, { options: { maxPayload: 6 * 1024 * 1024 } });
  const allowed = (id: string) => service.executionAllowed(id).ok;
  const client: SpriteClient = new SpriteClient(undefined, (name, passive) =>
    lifecycle.acquire(name, passive),
  );
  const terminals = new TerminalSessions(allowed, client);
  const agents = new AgentSessions(client, allowed, (id) => lifecycle.touch(id));
  const sharing = new Set<string>();
  const integrations = new WorkspaceIntegrations(service, root, sharing, client);
  const lifecycle: WorkspaceLifecycle = new WorkspaceLifecycle(
    service,
    lifecycleProvider ?? new SpriteLifecycle(),
    (id) => {
      agents.stop(id);
      terminals.stop(id);
      integrations.stop(id);
    },
    (id) => agents.isWorking(id),
    (id) =>
      terminals.recentlyUsed(id, lifecycle.idleMinutes * 60000) ||
      agents.isPreparing(service.provisioningRecords().find((w) => w.id === id)?.spriteName ?? ""),
    (id) => provisioning.wait(id),
  );
  const provisioning: WorkspaceProvisioning = new WorkspaceProvisioning(
    service,
    root,
    client,
    undefined,
    (id) => lifecycle.hasActiveWork(id),
  );
  const authentication = await createAuthentication(
    root,
    baseURL,
    unverifiedSignIn
      ? {
          configured: false,
          async send() {
            throw new Error("Prototype mode does not send email");
          },
        }
      : delivery,
    demo ? "demo" : prototype,
  );
  const { auth } = authentication;
  app.decorateRequest("actor", null);
  app.addHook("onRequest", async (request) => {
    // Replace, never trust, a caller-supplied IP hint. Deployment proxy trust must be configured explicitly.
    request.headers["x-civic-spark-client-ip"] = clientAddress(
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
    if (unverifiedSignIn && request.url === `/api/${authMode}/sign-in`) return;
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    const parsed = (demo ? demoIdentitySchema : verifiedIdentitySchema).safeParse(
      session?.user && prototype
        ? { ...session.user, id: session.user.email.toLowerCase() }
        : session?.user && demo
          ? { ...session.user, authMode: "demo" }
          : session?.user,
    );
    request.actor = parsed.success ? parsed.data : null;
    if (request.url.split("?")[0] !== "/api/session" && !request.actor)
      return reply.code(401).send({ error: "Verify your email to sign in and continue" });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      try {
        const declared = Number(request.headers["content-length"] ?? 0);
        storageHeadroom(root, Number.isFinite(declared) && declared > 0 ? declared : 0);
      } catch {
        return reply.code(503).header("Retry-After", "10").send({
          error:
            "Server storage is nearly full or unavailable. Your request has not started; retry after the operator restores space.",
        });
      }
      const length = Number(request.headers["content-length"]);
      const reserved =
        Number.isFinite(length) && length >= 0 ? length : request.routeOptions.bodyLimit;
      if (incomingBodyBytes + reserved > 256 * 1024 * 1024)
        return reply
          .code(429)
          .header("Retry-After", "2")
          .send({ error: "File transfers are busy. Retry shortly." });
      request.capacityBodyBytes = reserved;
      incomingBodyBytes += reserved;
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: error.issues.map((i) => i.message).join(". ") });
    return reply
      .code(500)
      .send({ error: "The operation could not complete. Your saved work is preserved." });
  });
  app.addHook("onClose", async () => {
    lifecycle.close();
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
  // Per-process, fixed-window demo limiter. Bound both sessions per client and
  // limiter memory; proxy-normalized IP is set by our first onRequest hook.
  const demoAttempts = new Map<string, { count: number; expires: number }>();
  const demoBudget = z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .parse(process.env.CIVIC_SPARK_AUTH_REQUESTS_PER_MINUTE ?? "20");
  if (unverifiedSignIn)
    app.post(`/api/${authMode}/sign-in`, async (r, reply) => {
      if (demo) {
        const now = Date.now();
        for (const [key, entry] of demoAttempts) if (entry.expires <= now) demoAttempts.delete(key);
        const address = String(r.headers["x-civic-spark-client-ip"]);
        const entry = demoAttempts.get(address);
        if ((entry && entry.count >= demoBudget) || (!entry && demoAttempts.size >= 10000))
          return reply
            .code(429)
            .header("Retry-After", "60")
            .send({ error: "Too many sign-in attempts. Try again in a minute." });
        if (entry) entry.count++;
        else demoAttempts.set(address, { count: 1, expires: now + 60000 });
      }
      const input = z
        .object({
          email: z.email().transform((v) => v.toLowerCase()),
          name: z.string().trim().max(80).default(""),
        })
        .parse(r.body);
      reply.header("Cache-Control", "no-store");
      reply.header(
        "set-cookie",
        await prototypeSignIn(
          authentication,
          input.email,
          input.name,
          demo,
          new URL(baseURL).protocol === "https:",
        ),
      );
      return { signedIn: true };
    });
  const checkStorageReadiness = createStorageReadiness(root);
  app.get("/api/health", async (_request, reply) => {
    try {
      service.checkHealth();
      authentication.checkHealth();
      await checkStorageReadiness();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.get("/api/session", async (r, reply) => {
    const site = siteEventId ? service.siteEvent(siteEventId, r.actor) : null;
    if (site && !site.ok) return send(reply, site);
    return {
      user: r.actor,
      emailSignIn: authentication.emailSignIn,
      authMode,
      siteEvent: site?.value ?? null,
    };
  });
  // Authentication hook guarantees actor for all routes below; no user IDs from
  // request bodies, query parameters, or custom headers establish identity.
  const actor = (value: Identity | null): Identity => {
    if (!value) throw new Error("Missing session");
    return value;
  };
  // Keep the whole request in the drain, including gaps between remote commands
  // and asynchronous Git/authorization callbacks. Do not release on client disconnect.
  const requestLeases = new WeakMap<FastifyRequest, ReturnType<typeof lifecycle.acquire>>();
  const releaseRequest = (request: FastifyRequest) => {
    requestLeases.get(request)?.release();
    requestLeases.delete(request);
  };
  app.addHook("onSend", async (request, _reply, payload) => {
    releaseRequest(request);
    return payload;
  });
  app.addHook("onError", async (request) => releaseRequest(request));
  // Every workspace route is owner-authorized before the execution gate. Only
  // metadata and explicit wake bypass runtime gating, never private file reads.
  app.addHook("preHandler", async (r, reply) => {
    const match = /^\/api\/workspaces\/([^/]+)\/([^?]+)/.exec(r.url);
    if (!match) return;
    // req.ws is set by Fastify only for a real upgraded socket. These two
    // handlers enforce owner/execution access and close rejected sockets.
    if (
      r.ws &&
      ["/api/workspaces/:id/agent", "/api/workspaces/:id/terminal"].includes(
        r.routeOptions.url ?? "",
      )
    )
      return;
    const workspace = service.workspace(actor(r.actor), match[1] as string);
    if (!workspace.ok) return send(reply, workspace);
    if (match[2] === "sprite" || match[2] === "wake") return;
    const access = service.executionAllowed(workspace.value.id);
    if (!access.ok) return send(reply, access);
    if (workspace.value.spriteName)
      requestLeases.set(
        r,
        lifecycle.acquire(workspace.value.spriteName, r.method === "GET" || r.method === "HEAD"),
      );
  });
  app.get<{ Params: { id: string } }>("/api/events/:id/sprites", async (r, reply) =>
    send(reply, await lifecycle.inventory(actor(r.actor), r.params.id)),
  );
  app.post<{ Params: { id: string; workspaceId: string } }>(
    "/api/events/:id/sprites/:workspaceId",
    async (r, reply) => {
      const input = spriteActionSchema.parse(r.body);
      return send(
        reply,
        await lifecycle.changeSprite(
          actor(r.actor),
          r.params.id,
          r.params.workspaceId,
          input.action,
          input.generation,
        ),
      );
    },
  );
  app.post<{ Params: { id: string } }>("/api/events/:id/execution", async (r, reply) => {
    const input = lifecycleActionSchema.parse(r.body);
    return send(reply, await lifecycle.change(actor(r.actor), r.params.id, input.action));
  });
  const authorizePreparation = async (r: FastifyRequest, id: string, waking = false) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(r.headers),
      query: { disableCookieCache: true },
    });
    if (
      !session ||
      (!unverifiedSignIn && !session.user.emailVerified) ||
      (prototype ? session.user.email.toLowerCase() : session.user.id) !== actor(r.actor).id
    )
      return fail("Sign in again before preparing your workspace.", 401);
    return service.workspace(actor(r.actor), id, true, waking);
  };
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/wake", async (r, reply) => {
    if (!spritesEnabled)
      return reply
        .code(409)
        .send({ error: "Cloud workspaces are not enabled for this installation yet" });
    if (service.runtime(r.params.id).deletion?.ownerRecovery)
      return send(
        reply,
        fail("Confirm Rebuild from shared work to recover this missing workspace.", 409),
      );
    const before = service.workspace(actor(r.actor), r.params.id, true, true);
    if (!before.ok) return send(reply, before);
    const runtime = service.runtime(r.params.id);
    const input = z
      .object({ action: z.literal("connect-new"), generation: z.number().int().nonnegative() })
      .strict()
      .optional()
      .parse(r.body);
    if (runtime.reset && (!input || input.generation !== runtime.generation))
      return send(reply, fail("Choose Connect new Sprite to start from shared team work.", 409));
    if (input && (!runtime.reset || input.generation !== runtime.generation))
      return send(reply, fail("Workspace changed. Refresh before connecting.", 409));
    if (
      runtime.held &&
      runtime.reason === "idle" &&
      before.value.spriteStatus === "error" &&
      !runtime.projectRepair
    )
      return { awake: false, recoveryRequired: true };
    const eventGeneration = service.execution(before.value.eventId).generation;
    const inspected = await inspectIdleWorkspaceForWake(
      service,
      client,
      actor(r.actor),
      before.value,
      () => authorizePreparation(r, r.params.id, true),
      () => lifecycle.hasActiveWork(r.params.id),
    );
    if (!inspected.ok) return send(reply, inspected);
    if (inspected.value.missing) return { awake: false, recoveryRequired: true };
    if (
      service.runtime(r.params.id).generation !== runtime.generation ||
      service.execution(before.value.eventId).generation !== eventGeneration
    )
      return send(reply, fail("Workspace state changed. Refresh before resuming.", 409));
    const workspace = service.wakeWorkspace(actor(r.actor), r.params.id);
    if (!workspace.ok) return send(reply, workspace);
    const prepared = await provisioning.start(
      workspace.value,
      () => authorizePreparation(r, r.params.id),
      false,
      undefined,
      true,
    );
    if (!prepared.ok) return send(reply, prepared);
    if (prepared.value.preparing) return reply.code(202).send(prepared.value);
    if (workspace.value.spriteName && workspace.value.spriteStatus === "ready") {
      const awake = await client.exec(workspace.value.spriteName, ["true"]);
      if (!awake.ok) return send(reply, awake);
    }
    return { awake: true };
  });
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/activity", async (r) => {
    lifecycle.touch(r.params.id);
    return { recorded: true };
  });
  registerAdminRoutes(app, service);
  app.get("/api/state", async (r) => service.portal(actor(r.actor), spritesEnabled, siteEventId));
  app.post("/api/events", async (r, reply) =>
    send(reply, service.createEvent(actor(r.actor), createEventSchema.parse(r.body))),
  );
  app.patch<{ Params: { id: string } }>("/api/events/:id", async (r, reply) =>
    send(
      reply,
      service.updateEvent(actor(r.actor), r.params.id, eventSettingsSchema.parse(r.body)),
    ),
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
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/agent/credentials", async (r, reply) => {
    reply.header("Cache-Control", "no-store");
    const owner = actor(r.actor);
    const p = service.workspace(owner, r.params.id, true);
    if (!p.ok) return send(reply, p);
    if (p.value.spriteStatus !== "ready" || !p.value.spriteName)
      return reply.code(409).send({ error: "Agent execution needs a running Sprite" });
    try {
      const status = await agents.credentials(p.value.spriteName);
      const session = await auth.api.getSession({ headers: fromNodeHeaders(r.headers) });
      if (!session || (prototype ? session.user.email.toLowerCase() : session.user.id) !== owner.id)
        return reply.code(401).send({ error: "Sign in to continue" });
      const current = service.workspace(owner, r.params.id, true);
      if (!current.ok) return send(reply, current);
      if (!allowed(r.params.id)) return send(reply, service.executionAllowed(r.params.id));
      return status;
    } catch {
      return reply
        .code(502)
        .send({ error: "Could not check saved agent keys. Retry to check again." });
    }
  });
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/agent/prepare", async (r, reply) => {
    const p = service.workspace(actor(r.actor), r.params.id, true);
    if (!p.ok) return send(reply, p);
    if (p.value.spriteStatus !== "ready" || !p.value.spriteName)
      return reply.code(409).send({ error: "Agent execution needs a running Sprite" });
    const generation = service.runtime(r.params.id).generation;
    const prepared = await agents.prepare(p.value.spriteName);
    if (service.runtime(r.params.id).generation !== generation)
      return reply.code(409).send({ error: "Workspace changed. Reconnect to continue." });
    if (prepared && !allowed(r.params.id))
      return send(reply, service.executionAllowed(r.params.id));
    if (prepared) {
      const owner = actor(r.actor);
      integrations.ensure(r.params.id, owner, p.value.spriteName, async () => {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(r.headers) });
        return Boolean(
          session &&
            (prototype ? session.user.email.toLowerCase() : session.user.id) === owner.id &&
            service.workspace(owner, r.params.id, true).ok &&
            allowed(r.params.id),
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
    if (!spritesEnabled)
      return reply
        .code(409)
        .send({ error: "Cloud workspaces are not enabled for this installation yet" });
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
            service.workspace(owner, r.params.id, true).ok &&
            allowed(r.params.id),
        );
      };
      if (input.action === "open")
        return await integrations.openPreview(r.params.id, owner, authorized);
      if (!(await authorized())) throw new Error("Workspace access ended.");
      return await integrations.preview(r.params.id, owner, input.action, undefined, authorized);
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
        !allowed(r.params.id) ||
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
              service.workspace(owner, r.params.id, true).ok &&
              allowed(r.params.id),
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
        !allowed(r.params.id) ||
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
              service.workspace(owner, r.params.id, true).ok &&
              allowed(r.params.id),
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
        return send(reply, await client[operation](p.value.spriteName));
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
        return send(reply, await client.readBlob(p.value.spriteName, path));
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
        return send(reply, await client.mutateBlob(p.value.spriteName, input));
      return send(reply, service.workspaceFiles(actor(r.actor), r.params.id, "mutate", input));
    },
  );
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/files", async (r, reply) => {
    const p = service.workspace(actor(r.actor), r.params.id);
    if (!p.ok) return send(reply, p);
    if (p.value.spriteStatus === "ready" && p.value.spriteName)
      return send(reply, await client.files(p.value.spriteName));
    return send(reply, service.files(actor(r.actor), r.params.id));
  });
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/workspaces/:id/file",
    async (r, reply) => {
      const path = z.string().parse(r.query.path);
      const p = service.workspace(actor(r.actor), r.params.id);
      if (!p.ok) return send(reply, p);
      if (p.value.spriteStatus === "ready" && p.value.spriteName)
        return send(reply, await client.readFile(p.value.spriteName, path));
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
        return send(reply, await client.saveFile(p.value.spriteName, b));
      return send(
        reply,
        service.saveFile(actor(r.actor), r.params.id, b.path, b.content, b.revision),
      );
    },
  );
  const teamUpdates = registerTeamUpdateRoutes(app, service, agents, sharing, client);
  app.post<{ Params: { id: string } }>("/api/workspaces/:id/share", async (r, reply) => {
    const input = z
      .object({
        title: z.string().trim().min(1).max(160),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(r.body);
    const sessionActive = async () => {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(r.headers),
        query: { disableCookieCache: true },
      });
      if (!session || (!unverifiedSignIn && !session.user.emailVerified)) return false;
      return (prototype ? session.user.email.toLowerCase() : session.user.id) === actor(r.actor).id;
    };
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
          await service.shareLocalAsync(
            actor(r.actor),
            r.params.id,
            input.title,
            input.revision,
            sessionActive,
          ),
        );
      if (p.value.spriteStatus !== "ready" || !p.value.spriteName)
        return reply
          .code(409)
          .send({ error: "Wait for your workspace to be ready before sharing." });
      const result = await client.share(p.value.spriteName, input.title, input.revision);
      if (!result.ok) return send(reply, result);
      // Reauthorize after remote I/O: removed members and closed events cannot publish.
      const access = service.workspace(actor(r.actor), r.params.id, true);
      if (!access.ok) return send(reply, access);
      temp = mkdtempSync(join(tmpdir(), "civic-spark-incoming-"));
      const bundle = join(temp, "contribution.bundle");
      const data = Buffer.from(result.value.bundle, "base64");
      if (data.length > 10 * 1024 * 1024 || data.toString("base64") !== result.value.bundle)
        throw new Error("Invalid contribution transfer");
      writeFileSync(bundle, data, { mode: 0o600 });
      const repo = join(temp, "repository.git");
      await gitAsync(temp, ["init", "--bare", repo]);
      await gitAsync(repo, ["bundle", "verify", bundle]);
      await gitAsync(repo, ["fetch", bundle, `${result.value.ref}:refs/heads/incoming`]);
      const commit = (await gitAsync(repo, ["rev-parse", "refs/heads/incoming"])).toString().trim();
      if (commit !== result.value.commit || result.value.revision !== input.revision)
        throw new Error("Invalid contribution transfer");
      const published = await service.publishSnapshotAsync(
        actor(r.actor),
        r.params.id,
        input.title,
        input.revision,
        repo,
        commit,
        sessionActive,
      );
      if (!published.ok) return send(reply, published);
      const acknowledged = await client.acknowledgeShare(
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
    const input = z
      .union([
        z
          .object({
            action: z.literal("retry-initial-creation").optional(),
            generation: z.number().int().nonnegative().optional(),
          })
          .strict(),
        z
          .object({ action: z.literal("connect-new"), generation: z.number().int().nonnegative() })
          .strict(),
        missingWorkspaceConfirmationSchema,
      ])
      .parse(r.body ?? {});
    const workspace = service.workspace(actor(r.actor), r.params.id, true, true);
    if (!workspace.ok) return send(reply, workspace);
    if (!spritesEnabled)
      return reply
        .code(409)
        .send({ error: "Cloud workspaces are not enabled for this installation yet" });
    const runtime = service.runtime(r.params.id);
    if (
      runtime.reset &&
      (input.generation !== runtime.generation ||
        (!workspace.value.spriteName && input.action !== "connect-new"))
    )
      return send(reply, fail("Choose Connect new Sprite to start from shared team work.", 409));
    if (
      input.action === "connect-new" &&
      (!runtime.reset || input.generation !== runtime.generation)
    )
      return send(reply, fail("Workspace changed. Refresh before connecting.", 409));
    if (input.action === "recover-missing") {
      if (
        workspace.value.spriteName !== input.name ||
        service.runtime(r.params.id).generation !== input.generation
      )
        return send(reply, fail("Workspace state changed. Refresh before rebuilding.", 409));
      const result = await provisioning.start(
        workspace.value,
        () => authorizePreparation(r, r.params.id, true),
        false,
        actor(r.actor),
      );
      return result.ok
        ? reply.code(result.value.preparing ? 202 : 200).send(result.value)
        : send(reply, result);
    }
    if (service.runtime(r.params.id).deletion?.ownerRecovery)
      return send(
        reply,
        fail("Confirm Rebuild from shared work to recover this missing workspace.", 409),
      );
    const waking = service.wakeWorkspace(actor(r.actor), r.params.id);
    if (!waking.ok) return send(reply, waking);
    const result = await provisioning.start(
      workspace.value,
      () => authorizePreparation(r, r.params.id),
      input.action === "retry-initial-creation",
      undefined,
      true,
    );
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
