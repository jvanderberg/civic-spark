import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  applyPendingRestore,
  type BackupSummary,
  backupDirectoryFor,
  createLiveBackup,
  currentRelease,
  deleteBackup,
  discardPendingRestore,
  exportBackup,
  type Installation,
  importBackupTree,
  installationId,
  listBackups,
  type RestoreReport,
  readLastRestore,
  readPendingRestore,
  replacedRoots,
  stageRestore,
} from "../../../packages/backup/src/live.ts";
import { unzipFile } from "../../../packages/backup/src/zip.ts";
import type { Identity } from "../../../packages/domain/src/access-types.ts";
import type { EventService } from "../../../packages/domain/src/service.ts";
import { fail, ok, type Result } from "../../../packages/domain/src/types.ts";
import { storageHeadroom } from "./deployment.ts";

export type BackupStatus = {
  directory: string;
  operatorsRestricted: boolean;
  busy: boolean;
  backups: BackupSummary[];
  unreadable: string[];
  pending: { backupId: string; requestedAt: string } | null;
  lastRestore: RestoreReport | null;
  replacedRoots: string[];
  canRestart: boolean;
};
export type BackupManagerOptions = {
  base: string;
  authMode: Installation["authMode"];
  origin: string;
  service: EventService;
  env?: NodeJS.ProcessEnv;
  configuration?: Record<string, unknown>;
  /** Stops the application so a staged restore is applied on the next start. */
  restart?: () => void;
};
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** Installation-wide backup operations exposed to event admins of this installation. */
export class BackupManager {
  readonly base: string;
  readonly directory: string;
  private readonly env: NodeJS.ProcessEnv;
  private busy = false;
  // Downloads only read their archive, so they skip the lock; Delete waits for them.
  private readonly downloading = new Map<string, number>();
  private cached: Installation | null = null;
  constructor(private readonly options: BackupManagerOptions) {
    this.env = options.env ?? process.env;
    this.base = resolve(options.base);
    this.directory = resolve(this.env.CIVIC_SPARK_BACKUP_DIR ?? backupDirectoryFor(this.base));
  }
  installation(): Installation {
    this.cached ??= {
      id: installationId(this.base),
      authMode: this.options.authMode,
      release: currentRelease(this.env),
      origin: this.options.origin,
      spriteOrg: this.env.CIVIC_SPARK_SPRITE_ORG || null,
      spriteApiOrigin: this.env.CIVIC_SPARK_SPRITE_API_URL || "https://api.sprites.dev",
    };
    return this.cached;
  }
  private operators() {
    return (this.env.CIVIC_SPARK_BACKUP_OPERATORS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }
  /** Event admin access for the event being administered, optionally narrowed to listed operators. */
  authorize(actor: Identity, eventId: string): Result<true> {
    if (!this.options.service.isAdmin(actor, eventId))
      return fail("Event admin access required", 403);
    const operators = this.operators();
    if (operators.length && !operators.includes(actor.email.toLowerCase()))
      return fail("Backups are limited to the installation's listed backup operators", 403);
    return ok(true);
  }
  private async run<T>(task: () => Promise<T>): Promise<Result<T>> {
    if (this.busy) return fail("A backup or restore is already running. Retry shortly.", 409);
    this.busy = true;
    try {
      return ok(await task());
    } catch (error) {
      return fail(message(error, "The backup operation could not complete."), 400);
    } finally {
      this.busy = false;
    }
  }
  async status(): Promise<Result<BackupStatus>> {
    let backups: BackupSummary[] = [];
    let unreadable: string[] = [];
    try {
      ({ backups, unreadable } = await listBackups(this.directory));
    } catch (error) {
      return fail(message(error, "Backups could not be listed."), 500);
    }
    const pending = readPendingRestore(this.base);
    return ok({
      directory: this.directory,
      operatorsRestricted: this.operators().length > 0,
      busy: this.busy,
      backups,
      unreadable,
      pending: pending
        ? { backupId: pending.backupId, requestedAt: pending.report.requestedAt }
        : null,
      lastRestore: readLastRestore(this.base),
      replacedRoots: existsSync(this.base) ? replacedRoots(this.base) : [],
      canRestart: Boolean(this.options.restart),
    });
  }
  create(actor: Identity) {
    return this.run(async () => {
      if (readPendingRestore(this.base))
        throw new Error("A restore is waiting for the application to restart");
      return createLiveBackup({
        base: this.base,
        directory: this.directory,
        installation: this.installation(),
        configuration: {
          siteEventId: this.env.CIVIC_SPARK_SITE_EVENT_ID ?? null,
          spritesEnabled: this.env.CIVIC_SPARK_ENABLE_SPRITES === "1",
          ...this.options.configuration,
        },
        capturedBy: { id: actor.id, email: actor.email },
      });
    });
  }
  async remove(backupId: string): Promise<Result<{ deleted: boolean }>> {
    if (this.downloading.get(backupId))
      return fail("This backup is being downloaded. Delete it after the download finishes.", 409);
    return this.run(async () => {
      deleteBackup(this.directory, backupId);
      return { deleted: true };
    });
  }
  async download(backupId: string) {
    try {
      const exported = await exportBackup(this.directory, backupId);
      this.downloading.set(backupId, (this.downloading.get(backupId) ?? 0) + 1);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        const left = (this.downloading.get(backupId) ?? 1) - 1;
        if (left > 0) this.downloading.set(backupId, left);
        else this.downloading.delete(backupId);
      };
      exported.stream.once("close", finish);
      exported.stream.once("error", finish);
      return ok(exported);
    } catch (error) {
      return fail(message(error, "The backup could not be downloaded."), 400);
    }
  }
  upload(source: Readable, declaredBytes: number, actor: Identity) {
    return this.run(async () => {
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0)
        throw new Error("Upload requires a known size");
      if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      // The ZIP is saved, extracted and re-sealed: roughly three times its size.
      storageHeadroom(this.directory, declaredBytes * 3);
      const staged = mkdtempSync(join(this.directory, ".civic-spark-upload-partial-"));
      chmodSync(staged, 0o700);
      try {
        const zip = join(staged, "upload.zip");
        let received = 0;
        source.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > declaredBytes)
            source.destroy(new Error("Upload exceeds its declared size"));
        });
        await pipeline(source, createWriteStream(zip, { flags: "wx", mode: 0o600 }));
        const tree = join(staged, "tree");
        mkdirSync(tree, { mode: 0o700 });
        await unzipFile(zip, tree);
        rmSync(zip);
        return await importBackupTree(this.directory, tree, this.installation(), {
          id: actor.id,
          email: actor.email,
        });
      } finally {
        rmSync(staged, { recursive: true, force: true });
      }
    });
  }
  restore(actor: Identity, backupId: string) {
    return this.run(async () => {
      const report = await stageRestore({
        base: this.base,
        directory: this.directory,
        backupId,
        installation: this.installation(),
        liveReservations: this.options.service
          .provisioningRecords()
          .flatMap((w) => (w.spriteName ? [{ workspaceId: w.id, spriteName: w.spriteName }] : [])),
        requestedBy: { id: actor.id, email: actor.email },
      });
      const restart = this.options.restart;
      // Respond first; the swap happens after the application has stopped writing.
      if (restart) setTimeout(restart, 500).unref();
      return { ...report, restarting: Boolean(restart) };
    });
  }
  discard() {
    return this.run(async () => {
      discardPendingRestore(this.base);
      return { discarded: true };
    });
  }
}

/** Apply a staged restore before the application opens any store; used by startup and shutdown. */
export function completePendingRestore(base: string) {
  const report = applyPendingRestore(base);
  if (report)
    console.log(
      `Civic Spark restored backup ${report.backupId}; previous data retained at ${report.replacedRoot}`,
    );
  return report;
}

export function registerBackupRoutes(app: FastifyInstance, manager: BackupManager) {
  const actor = (value: Identity | null) => {
    if (!value) throw new Error("Missing session");
    return value;
  };
  const send = (reply: FastifyReply, result: Result<unknown>) =>
    result.ok ? reply.send(result.value) : reply.code(result.status).send({ error: result.error });
  const confirm = z.object({ confirmed: z.literal(true) });
  const denied = (reply: FastifyReply, r: { actor: Identity | null; params: { id: string } }) => {
    const access = manager.authorize(actor(r.actor), r.params.id);
    if (!access.ok) {
      void reply.code(access.status).send({ error: access.error });
      return true;
    }
    return false;
  };
  for (const type of ["application/zip", "application/x-zip-compressed"])
    app.addContentTypeParser(type, (_request, payload, done) => done(null, payload));
  app.get<{ Params: { id: string } }>("/api/events/:id/backups", async (r, reply) => {
    if (denied(reply, r)) return;
    return send(reply, await manager.status());
  });
  app.post<{ Params: { id: string } }>("/api/events/:id/backups", async (r, reply) => {
    if (denied(reply, r)) return;
    return send(reply, await manager.create(actor(r.actor)));
  });
  app.post<{ Params: { id: string } }>("/api/events/:id/backups/upload", async (r, reply) => {
    if (denied(reply, r)) return;
    const body = r.body as Readable | undefined;
    if (!body || typeof body !== "object" || typeof body.pipe !== "function")
      return reply.code(415).send({ error: "Upload a backup ZIP downloaded from Civic Spark" });
    return send(
      reply,
      await manager.upload(body, Number(r.headers["content-length"]), actor(r.actor)),
    );
  });
  app.post<{ Params: { id: string } }>(
    "/api/events/:id/backups/pending/discard",
    async (r, reply) => {
      if (denied(reply, r)) return;
      confirm.parse(r.body);
      return send(reply, await manager.discard());
    },
  );
  app.delete<{ Params: { id: string; backupId: string } }>(
    "/api/events/:id/backups/:backupId",
    async (r, reply) => {
      if (denied(reply, r)) return;
      confirm.parse(r.body);
      return send(reply, await manager.remove(z.uuid().parse(r.params.backupId)));
    },
  );
  app.get<{ Params: { id: string; backupId: string } }>(
    "/api/events/:id/backups/:backupId/download",
    async (r, reply) => {
      if (denied(reply, r)) return;
      const backupId = z.uuid().parse(r.params.backupId);
      const result = await manager.download(backupId);
      if (!result.ok) return send(reply, result);
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${result.value.filename}"`)
        .header("Cache-Control", "no-store")
        .send(result.value.stream);
    },
  );
  app.post<{ Params: { id: string; backupId: string } }>(
    "/api/events/:id/backups/:backupId/restore",
    async (r, reply) => {
      if (denied(reply, r)) return;
      confirm.parse(r.body);
      return send(reply, await manager.restore(actor(r.actor), z.uuid().parse(r.params.backupId)));
    },
  );
}
