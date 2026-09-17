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
import {
  type SpriteCreationFailure,
  spriteCreationMessages,
  withCreationFailure,
} from "../../../packages/domain/src/provisioning.ts";
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
          withCreationFailure(
            workspace.spriteCreationFailure,
            "Workspace preparation was interrupted by a server restart. Retry to check the reserved workspace.",
          ),
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
      const error = withCreationFailure(
        workspace.spriteCreationFailure,
        "Workspace preparation was interrupted by a server restart. Retry to check the reserved workspace.",
      );
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
    authorize: () => Promise<Result<Workspace>> = async () => {
      const current = this.service.provisioningRecords().find((w) => w.id === workspace.id);
      return current ? ok({ ...workspace, ...current }) : fail("Workspace not found", 404);
    },
    retryInitialCreation = false,
  ): Promise<Result<{ preparing: boolean }>> {
    const pending = this.starts.get(workspace.id);
    if (pending) return pending;
    const expected = this.service.runtime(workspace.id);
    const started = this.prepare(workspace, authorize, retryInitialCreation)
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
    retryInitialCreation: boolean,
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
    const eventGeneration = this.service.execution(workspace.eventId).generation;
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
    const binding = this.client.provisioningBinding();
    const initial = this.service.initialCreation(workspace.id);
    const initialRetry =
      !recovery &&
      retryInitialCreation &&
      workspace.spriteName === name &&
      initial?.state === "creating" &&
      initial.name === name &&
      (workspace.spritePhase === "bundling" || workspace.spritePhase === "creating");
    const sameBinding = () =>
      binding !== null &&
      initial !== null &&
      initial.org === binding.org &&
      initial.apiOrigin === binding.apiOrigin &&
      initial.account === binding.account &&
      JSON.stringify(this.client.provisioningBinding()) === JSON.stringify(binding);
    if (initialRetry && !sameBinding())
      return denied(
        "Initial workspace creation belongs to a different provider configuration. Ask an event admin to investigate.",
        409,
      );
    const revalidate = async () => {
      const current = await authorize();
      if (!current.ok) throw new Error(current.error);
      if (!sameBinding())
        throw new Error("Provider configuration changed. Ask an event admin to investigate.");
      const runtime = this.service.runtime(workspace.id);
      if (
        current.value.spriteName !== name ||
        runtime.generation !== generation ||
        JSON.stringify(runtime.deletion) !== JSON.stringify(expected.deletion) ||
        this.service.execution(workspace.eventId).generation !== eventGeneration
      )
        throw new Error("Workspace access or state changed. Refresh before retrying preparation.");
      const allowed = this.service.executionAllowed(workspace.id);
      if (!allowed.ok) throw new Error(allowed.error);
    };
    const bundle = join(this.root, `${workspace.id}.bundle`);
    const phase = (next: SpritePhase) => {
      const allowed = this.service.executionAllowed(workspace.id);
      if (!allowed.ok) throw new Error(allowed.error);
      const result = this.service.setSprite(workspace.id, name, "provisioning", null, next);
      if (!result.ok) throw new Error(result.error);
    };
    try {
      if (!workspace.spriteName && binding)
        this.service.reserveInitialCreation(workspace.id, name, binding);
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
      let creationFailure = workspace.spriteCreationFailure;
      const create = async (guard?: () => Promise<void>) => {
        let currentFailure: SpriteCreationFailure = "unknown";
        try {
          const result = guard ? await client.create(name, guard) : await client.create(name);
          if (result.ok) return;
          currentFailure = result.creationFailure ?? "unknown";
        } catch {
          // Adapter exceptions carry no trusted provider classification.
        }
        creationFailure ??= currentFailure;
        // Even an unexpected adapter exception must not escape as raw diagnostics.
        throw new Error(spriteCreationMessages[currentFailure]);
      };
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
            await create();
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
          if (initialRetry) {
            const existence = await client.inspectReservation(name);
            await revalidate();
            if (existence === "unknown")
              throw new Error(
                "The provider could not confirm the reserved workspace's state. No workspace was created. Try again when provider access is restored.",
              );
            if (existence === "missing") {
              const guard = async () => {
                await revalidate();
                const current = this.service.initialCreation(workspace.id);
                if (!sameBinding() || current?.state !== "creating" || current.name !== name)
                  throw new Error("Initial creation eligibility changed.");
              };
              await guard();
              await create(guard);
            }
            await revalidate();
            // Seal eligibility before any checkout or private-project inspection.
            // A present resource may already contain private work, even if a prior
            // create response was lost. Never upload over an existing project.
            phase("checkout");
            const files = await client.files(name);
            if (!files.ok) {
              const absent = await client.exec(name, [
                "bash",
                "-lc",
                "test ! -e /home/sprite/project && test ! -L /home/sprite/project",
              ]);
              if (!absent.ok)
                throw new Error(
                  "The existing workspace could not be verified. Its files were not replaced.",
                );
              await revalidate();
              const uploaded = await client.uploadBundle(name, bundle);
              if (!uploaded.ok) throw new Error(uploaded.error);
            }
            await revalidate();
          } else {
            const resumed = workspace.spriteName ? await client.exec(name, ["true"]) : null;
            if (resumed && !resumed.ok) {
              const existence = await client.inspectReservation(name);
              throw new Error(
                existence === "missing"
                  ? "Workspace preparation did not complete, and the reserved Sprite is absent. Ask an event admin to investigate; retrying will not create a replacement."
                  : "The reserved workspace could not be reached. Ask an event admin to investigate; its identity and any existing work have been preserved.",
              );
            }
            if (!workspace.spriteName) {
              await create();
            }
            phase("checkout");
            const uploaded = await client.uploadBundle(name, bundle);
            if (!uploaded.ok) throw new Error(uploaded.error);
          }
        }
        phase("verifying");
        const verified = await client.files(name);
        if (!verified.ok) throw new Error(verified.error);
        if (initialRetry) await revalidate();
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
          withCreationFailure(
            creationFailure,
            error instanceof Error
              ? error.message
              : "Workspace preparation failed. Retry to resume safely.",
          ),
          undefined,
          creationFailure,
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
