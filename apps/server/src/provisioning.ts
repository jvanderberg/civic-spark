import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  completeRecovery,
  inspectRecoverySprite,
  recoveryPermission,
} from "../../../packages/backup/src/recovery.ts";
import type { Workspace } from "../../../packages/domain/src/access-types.ts";
import type { WorkspaceRuntime } from "../../../packages/domain/src/lifecycle.ts";
import type { EventService } from "../../../packages/domain/src/service.ts";
import { fail, ok, type Result, type SpritePhase } from "../../../packages/domain/src/types.ts";
import { gitAsync } from "../../../packages/git/src/async.ts";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";

export class WorkspaceProvisioning {
  private jobs = new Map<string, Promise<void>>();
  private starts = new Map<string, Promise<Result<{ preparing: boolean }>>>();
  constructor(
    private service: EventService,
    private root: string,
    private client = new SpriteClient(),
    private inspectRecovery = inspectRecoverySprite,
  ) {
    for (const workspace of service.provisioningRecords()) {
      if (workspace.spriteStatus === "provisioning" && workspace.spriteName)
        service.setSprite(
          workspace.id,
          workspace.spriteName,
          "error",
          "Workspace preparation was interrupted by a server restart. Retry to resume safely.",
        );
    }
  }
  private limits() {
    return {
      concurrent: z.coerce
        .number()
        .int()
        .min(1)
        .max(20)
        .parse(process.env.CIVIC_SPARK_MAX_PROVISIONING ?? "2"),
    };
  }
  status(workspace: Workspace): Workspace {
    if (workspace.spriteStatus === "provisioning" && !this.jobs.has(workspace.id)) {
      const error =
        "Workspace preparation was interrupted by a server restart. Retry to resume safely.";
      this.service.setSprite(
        workspace.id,
        workspace.spriteName ?? `civic-spark-${workspace.id}`,
        "error",
        error,
      );
      return { ...workspace, spriteStatus: "error", spriteError: error };
    }
    return workspace;
  }
  needsRecovery(workspace: Workspace) {
    const deletion = this.service.runtime(workspace.id).deletion;
    if (deletion?.state === "deleted") {
      if (
        deletion.org !== (process.env.CIVIC_SPARK_SPRITE_ORG ?? "") ||
        deletion.apiOrigin !== (process.env.CIVIC_SPARK_SPRITE_API_URL ?? "https://api.sprites.dev")
      )
        throw new Error("Deleted Sprite recovery provider mismatch");
      return deletion;
    }
    return workspace.spriteName
      ? recoveryPermission(
          this.root,
          workspace.id,
          workspace.spriteName,
          process.env.CIVIC_SPARK_SPRITE_ORG ?? "",
          process.env.CIVIC_SPARK_SPRITE_API_URL ?? "https://api.sprites.dev",
        )
      : null;
  }
  start(
    workspace: Workspace,
    authorize: () => Promise<Result<Workspace>> = async () => ok(workspace),
  ): Promise<Result<{ preparing: boolean }>> {
    const pending = this.starts.get(workspace.id);
    if (pending) return pending;
    const expected = this.service.runtime(workspace.id);
    const started = this.prepare(workspace, authorize)
      .catch(() => {
        this.restoreRecoveryHold(workspace.id, expected);
        return fail(
          "Workspace preparation could not start. Check installation configuration and retry.",
          503,
        );
      })
      .finally(() => this.starts.delete(workspace.id));
    this.starts.set(workspace.id, started);
    return started;
  }
  private restoreRecoveryHold(id: string, expected: WorkspaceRuntime) {
    const current = this.service.runtime(id);
    // Undo only this recovery attempt's wake, never a newer lifecycle decision.
    if (
      expected.deletion &&
      current.generation === expected.generation &&
      JSON.stringify(current.deletion) === JSON.stringify(expected.deletion)
    )
      this.service.setRuntime(id, { held: true, reason: "admin" });
  }
  private async prepare(
    workspace: Workspace,
    authorize: () => Promise<Result<Workspace>>,
  ): Promise<Result<{ preparing: boolean }>> {
    const allowed = this.service.executionAllowed(workspace.id);
    if (!allowed.ok) return allowed;
    let expected = this.service.runtime(workspace.id);
    const denied = (error: string, status: number) => {
      this.restoreRecoveryHold(workspace.id, expected);
      return fail(error, status);
    };
    let recovery: ReturnType<WorkspaceProvisioning["needsRecovery"]>;
    try {
      recovery = this.needsRecovery(workspace);
    } catch {
      return denied(
        "Recovery reservation does not match this installation. Ask the operator to reconcile it.",
        409,
      );
    }
    if (workspace.spriteStatus === "ready" && !recovery) return ok({ preparing: false });
    if (this.jobs.has(workspace.id)) return ok({ preparing: true });
    const limits = this.limits();
    if (new Set([...this.jobs.keys(), ...this.starts.keys()]).size >= limits.concurrent)
      return denied("Workspace preparation is busy. Retry shortly.", 429);
    const deletion = expected.deletion;
    const dir = this.service.workspacePath(workspace.id);
    const generation = expected.generation;
    // Reject unshared local edits before reserving any provider identity or phase.
    // The in-memory start entry deduplicates/bounds this asynchronous preflight.
    if (!recovery && (await gitAsync(dir, ["status", "--porcelain"])).toString().trim())
      return fail("Share saved changes before preparing your Sprite", 409);
    const fresh = await authorize();
    if (!fresh.ok) return denied(fresh.error, fresh.status);
    if (
      fresh.value.spriteName !== workspace.spriteName ||
      fresh.value.spriteStatus !== workspace.spriteStatus ||
      this.service.runtime(workspace.id).generation !== generation ||
      JSON.stringify(this.service.runtime(workspace.id).deletion) !== JSON.stringify(deletion)
    )
      return denied("Workspace state changed. Refresh and retry preparation.", 409);
    const name = workspace.spriteName ?? `civic-spark-${workspace.id}`;
    const bundle = join(this.root, `${workspace.id}.bundle`);
    const phase = (next: SpritePhase) => {
      const allowed = this.service.executionAllowed(workspace.id);
      if (!allowed.ok) throw new Error(allowed.error);
      const result = this.service.setSprite(workspace.id, name, "provisioning", null, next);
      if (!result.ok) throw new Error(result.error);
    };
    try {
      if (deletion?.state === "deleted" && !deletion.replacementReserved)
        expected = this.service.setRuntime(workspace.id, {
          deletion: { ...deletion, replacementReserved: true },
        });
      phase("bundling");
    } catch {
      return denied(
        "Could not record workspace preparation. Retry; if this continues, ask the event admin to check server storage.",
        503,
      );
    }
    // Defer the work until the job is registered, so repeated starts are idempotent.
    const job = Promise.resolve().then(async () => {
      const client = this.client;
      try {
        if (recovery) {
          await gitAsync(this.service.sharedWorkspaceRepository(workspace.id), [
            "bundle",
            "create",
            bundle,
            "main",
            "HEAD",
          ]);
          phase("creating");
          const existence = await this.inspectRecovery(
            name,
            process.env.CIVIC_SPARK_SPRITE_ORG ?? "",
            process.env.CIVIC_SPARK_SPRITE_API_URL ?? "https://api.sprites.dev",
            process.env.SPRITE_TOKEN ?? "",
          );
          phase("creating"); // Pause may have arrived during the provider existence check.
          if (existence === "missing") {
            const created = await client.create(name);
            if (!created.ok) throw new Error(created.error);
            phase("checkout");
            const uploaded = await client.uploadBundle(name, bundle);
            if (!uploaded.ok) throw new Error(uploaded.error);
          } else {
            // Existing private work always wins over recovery source. Only seed
            // an absent project after a previous create interrupted before checkout.
            const files = await client.files(name);
            if (!files.ok) {
              phase("checkout");
              const absent = await client.exec(name, ["test", "!", "-e", "/home/sprite/project"]);
              if (!absent.ok)
                throw new Error(
                  "The existing recovery Sprite could not reconnect. Its files were not replaced.",
                );
              const uploaded = await client.uploadBundle(name, bundle);
              if (!uploaded.ok) throw new Error(uploaded.error);
            }
          }
        } else {
          await gitAsync(dir, ["bundle", "create", bundle, "--all"]);
          phase("creating");
          const resumed = workspace.spriteName ? await client.exec(name, ["true"]) : null;
          if (resumed && !resumed.ok)
            throw new Error(
              "The reserved Sprite could not reconnect. Retry after checking provider access; it will not be replaced.",
            );
          if (!workspace.spriteName) {
            const created = await client.create(name);
            if (!created.ok) throw new Error(created.error);
          }
          phase("checkout");
          const uploaded = await client.uploadBundle(name, bundle);
          if (!uploaded.ok) throw new Error(uploaded.error);
        }
        phase("verifying");
        const verified = await client.files(name);
        if (!verified.ok) throw new Error(verified.error);
        phase("verifying");
        const saved = this.service.setSprite(workspace.id, name, "ready", null, "ready");
        if (!saved.ok) throw new Error(saved.error);
        if (recovery) {
          completeRecovery(this.root, workspace.id, name);
          const runtime = this.service.runtime(workspace.id);
          if (runtime.deletion?.state === "deleted")
            this.service.setRuntime(workspace.id, {
              deletion: null,
              generation: runtime.generation + 1,
            });
        }
      } catch (error) {
        this.service.setSprite(
          workspace.id,
          name,
          "error",
          error instanceof Error
            ? error.message
            : "Workspace preparation failed. Retry to resume safely.",
        );
      } finally {
        try {
          rmSync(bundle, { force: true });
        } catch {
          /* A stale seed bundle is safe to replace on retry. */
        }
      }
    });
    this.jobs.set(workspace.id, job);
    // Handle both paths: persistence may also fail while recording a provider error.
    // Never leave the cleanup promise rejected and crash the management process.
    void job.then(
      () => this.jobs.delete(workspace.id),
      () => this.jobs.delete(workspace.id),
    );
    return ok({ preparing: true });
  }
  async wait(id: string) {
    await this.starts.get(id);
    await this.jobs.get(id);
  }
  async close() {
    await Promise.allSettled(this.starts.values());
    await Promise.allSettled(this.jobs.values());
  }
}
