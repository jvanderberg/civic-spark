import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  completeRecovery,
  inspectRecoverySprite,
  recoveryPermission,
} from "../../../packages/backup/src/recovery.ts";
import type { Identity, Workspace } from "../../../packages/domain/src/access-types.ts";
import type { WorkspaceRuntime } from "../../../packages/domain/src/lifecycle.ts";
import {
  legacyMissingWorkspaceMessage,
  missingWorkspaceMessage,
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
    private hasActiveWork: (id: string) => boolean = () => false,
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
    const initial = this.service.initialCreation(workspace.id);
    const runtime = this.service.runtime(workspace.id);
    workspace = {
      ...workspace,
      preparationAction:
        workspace.spriteName &&
        workspace.spriteStatus === "error" &&
        !runtime.projectRepair &&
        !runtime.reset &&
        (runtime.deletion?.ownerRecovery ||
          (!runtime.deletion &&
            !(
              initial?.state === "creating" &&
              (workspace.spritePhase === "bundling" || workspace.spritePhase === "creating")
            )))
          ? "recover-missing"
          : "retry",
    };

    if (workspace.preparationAction === "recover-missing" && workspace.spriteError)
      workspace = {
        ...workspace,
        spriteError: workspace.spriteError.replace(
          legacyMissingWorkspaceMessage,
          missingWorkspaceMessage,
        ),
      };
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
      return this.status({ ...workspace, spriteStatus: "error", spriteError: error });
    }
    return workspace;
  }
  needsRecovery(workspace: Workspace) {
    const reset = this.service.runtime(workspace.id).reset;
    if (reset) {
      if (
        reset.org !== (process.env.CIVIC_SPARK_SPRITE_ORG ?? "") ||
        reset.apiOrigin !== (process.env.CIVIC_SPARK_SPRITE_API_URL ?? "https://api.sprites.dev")
      )
        throw new Error("Fresh Sprite provider mismatch");
      return reset;
    }
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
    missingOwner?: Identity,
    repairReadyProject = false,
  ): Promise<Result<{ preparing: boolean }>> {
    const pending = this.starts.get(workspace.id);
    if (pending) return pending;
    const expected = this.service.runtime(workspace.id);
    const started = this.prepare(
      workspace,
      authorize,
      retryInitialCreation,
      missingOwner,
      repairReadyProject,
    )
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
      (expected.deletion || expected.reset) &&
      current.generation === expected.generation &&
      JSON.stringify(current.deletion) === JSON.stringify(expected.deletion)
    )
      this.service.setRuntime(id, { held: true, reason: "admin" });
  }
  private async prepare(
    workspace: Workspace,
    authorize: () => Promise<Result<Workspace>>,
    retryInitialCreation: boolean,
    missingOwner?: Identity,
    repairReadyProject = false,
  ): Promise<Result<{ preparing: boolean }>> {
    if (this.jobs.has(workspace.id)) return ok({ preparing: true });
    const limits = this.limits();
    if (
      missingOwner &&
      new Set([...this.jobs.keys(), ...this.starts.keys()]).size >= limits.concurrent
    ) {
      this.restoreRecoveryHold(workspace.id, this.service.runtime(workspace.id));
      return fail("Workspace preparation is busy. Retry shortly.", 429);
    }
    if (
      missingOwner &&
      workspace.runtime?.generation !== this.service.runtime(workspace.id).generation
    )
      return fail("Workspace state changed. Refresh before rebuilding.", 409);
    if (
      missingOwner &&
      this.service.runtime(workspace.id).deletion &&
      !this.service.runtime(workspace.id).deletion?.ownerRecovery
    )
      return fail("This workspace has a different recovery operation. Refresh its status.", 409);
    if (missingOwner && !this.service.runtime(workspace.id).deletion) {
      const before = this.service.runtime(workspace.id);
      const eventGeneration = this.service.execution(workspace.eventId).generation;
      const binding = this.client.provisioningBinding();
      if (
        !binding ||
        !workspace.spriteName ||
        workspace.spriteStatus !== "error" ||
        before.stopState === "pending"
      )
        return fail("This workspace cannot be rebuilt now. Refresh its status.", 409);
      const fresh = await authorize();
      if (!fresh.ok) return fresh;
      const existence = await this.client.inspectReservation(workspace.spriteName, true);
      const observedAt = new Date().toISOString();
      const current = await authorize();
      if (!current.ok) return current;
      if (existence !== "missing")
        return fail(
          existence === "present"
            ? "This workspace still exists. Its files were preserved; rebuilding was cancelled."
            : "The provider could not confirm that this workspace is missing. Nothing was rebuilt. Try again when provider access is restored.",
          409,
        );
      if (
        process.env.CIVIC_SPARK_SPRITE_ORG !== binding.org ||
        JSON.stringify(this.client.provisioningBinding()) !== JSON.stringify(binding)
      )
        return fail("Provider configuration changed. Refresh before rebuilding.", 409);
      const recorded = this.service.confirmMissingWorkspace(missingOwner, workspace.id, {
        ...binding,
        name: workspace.spriteName,
        generation: before.generation,
        eventGeneration,
        observedAt,
        httpStatus: 404,
      });
      if (!recorded.ok) return recorded;
      workspace = recorded.value;
    }
    let expected = this.service.runtime(workspace.id);
    if (expected.deletion?.ownerRecovery && !missingOwner)
      return fail("Confirm Rebuild from shared work to recover this missing workspace.", 409);
    if (missingOwner && expected.deletion?.ownerRecovery) {
      const current = await authorize();
      if (!current.ok) return current;
      if (this.service.runtime(workspace.id).generation !== expected.generation)
        return fail("Workspace state changed. Refresh before rebuilding.", 409);
    }
    // An explicitly confirmed retry can wake its existing recovery hold only.
    if (missingOwner && expected.deletion?.ownerRecovery && expected.held) {
      const waking = this.service.wakeWorkspace(missingOwner, workspace.id);
      if (!waking.ok) return waking;
      expected = this.service.runtime(workspace.id);
    }
    const allowed = this.service.executionAllowed(workspace.id);
    if (!allowed.ok) return allowed;
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
    // Only an explicit owner wake/retry may repair a falsely ready absent checkout.
    // Reads/status polling never enter this path. Persist the shared-only source before work.
    if (workspace.spriteStatus === "ready" && !recovery && !expected.projectRepair) {
      if (!repairReadyProject) return ok({ preparing: false });
      const name = workspace.spriteName;
      const binding = this.client.provisioningBinding();
      if (!name) return denied("Workspace reservation is missing.", 409);
      const configuredOrg = process.env.CIVIC_SPARK_SPRITE_ORG;
      const eventGeneration = this.service.execution(workspace.eventId).generation;
      const validate = async () => {
        const current = await authorize();
        if (!current.ok) throw Error(current.error);
        if (
          current.value.spriteName !== name ||
          current.value.spriteStatus !== "ready" ||
          this.service.runtime(workspace.id).generation !== expected.generation ||
          this.service.runtime(workspace.id).deletion ||
          this.service.execution(workspace.eventId).generation !== eventGeneration ||
          process.env.CIVIC_SPARK_SPRITE_ORG !== configuredOrg ||
          JSON.stringify(this.client.provisioningBinding()) !== JSON.stringify(binding) ||
          !this.service.executionAllowed(workspace.id).ok
        )
          throw Error("Workspace state or active work changed. Refresh before retrying.");
      };
      await validate();
      if (this.hasActiveWork(workspace.id)) return ok({ preparing: false });
      const files = await this.client.files(name);
      await validate();
      if (files.ok || this.hasActiveWork(workspace.id)) return ok({ preparing: false });
      // Listing limits and uncertain reads deny repair, not ordinary ready Resume.
      if (files.status !== 404 || files.error !== "Workspace project is absent")
        return ok({ preparing: false });
      if (!binding) return denied("Workspace provider could not be authenticated.", 409);
      if ((await this.client.inspectReservation(name, true)) !== "present")
        return denied(
          "The provider could not confirm the existing workspace. Nothing was rebuilt.",
          409,
        );
      await validate();
      if (this.hasActiveWork(workspace.id)) return ok({ preparing: false });
      const absent = await this.client.exec(name, [
        "bash",
        "-lc",
        "test ! -e /home/sprite/project && test ! -L /home/sprite/project",
      ]);
      await validate();
      if (this.hasActiveWork(workspace.id)) return ok({ preparing: false });
      if (!absent.ok)
        return denied("The project is no longer absent. Its files were preserved.", 409);
      expected = this.service.setRuntime(workspace.id, {
        projectRepair: { ...binding, name },
      });
    }
    const projectRepair = expected.projectRepair;
    if (this.jobs.has(workspace.id)) return ok({ preparing: true });
    if (
      new Set([...this.jobs.keys(), ...this.starts.keys()].filter((id) => id !== workspace.id))
        .size >= limits.concurrent
    )
      return denied("Workspace preparation is busy. Retry shortly.", 429);
    const deletion = expected.deletion;
    const dir = this.service.workspacePath(workspace.id);
    const generation = expected.generation;
    const eventGeneration = this.service.execution(workspace.eventId).generation;
    // Reject unshared local edits before reserving any provider identity or phase.
    // The in-memory start entry deduplicates/bounds this asynchronous preflight.
    if (
      !recovery &&
      !projectRepair &&
      (await gitAsync(dir, ["status", "--porcelain"])).toString().trim()
    )
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
    const name = workspace.spriteName ?? expected.reset?.name ?? `civic-spark-${workspace.id}`;
    const binding = this.client.provisioningBinding();
    const initial = this.service.initialCreation(workspace.id);
    const initialRetry =
      !recovery &&
      retryInitialCreation &&
      workspace.spriteName === name &&
      initial?.state === "creating" &&
      initial.name === name &&
      (workspace.spritePhase === "bundling" || workspace.spritePhase === "creating");
    const ownerRecovery = expected.deletion?.ownerRecovery;
    const storedBinding =
      projectRepair ??
      (ownerRecovery && expected.deletion
        ? { ...expected.deletion, ...ownerRecovery }
        : recovery && binding
          ? { ...binding, ...recovery }
          : initial);
    const sameBinding = () =>
      binding !== null &&
      storedBinding != null &&
      storedBinding.org === binding.org &&
      storedBinding.apiOrigin === binding.apiOrigin &&
      storedBinding.account === binding.account &&
      process.env.CIVIC_SPARK_SPRITE_ORG === binding.org &&
      JSON.stringify(this.client.provisioningBinding()) === JSON.stringify(binding);
    if (
      (initialRetry || recovery || projectRepair) &&
      (!sameBinding() ||
        (ownerRecovery && ownerRecovery.name !== name) ||
        (projectRepair && projectRepair.name !== name))
    )
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
        JSON.stringify(runtime.projectRepair) !== JSON.stringify(projectRepair) ||
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
      if (this.service.runtime(workspace.id).generation !== generation)
        throw new Error("Workspace generation changed");
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
      const create = async (guard?: () => Promise<void>, requireMissing = false) => {
        let currentFailure: SpriteCreationFailure = "unknown";
        try {
          const result = guard
            ? await client.create(name, guard, requireMissing)
            : await client.create(name);
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
        if (recovery || projectRepair) {
          await revalidate();
          await gitAsync(this.service.sharedWorkspaceRepository(workspace.id), [
            "bundle",
            "create",
            bundle,
            "main",
            "HEAD",
          ]);
          phase("creating");
          if (ownerRecovery) {
            await revalidate();
            await create(revalidate, true);
            await revalidate();
            phase("checkout");
            const uploaded = await client.uploadBundle(name, bundle, revalidate);
            if (!uploaded.ok) throw new Error(uploaded.error);
            await revalidate();
          } else {
            const existence = await this.inspectRecovery(
              name,
              process.env.CIVIC_SPARK_SPRITE_ORG ?? "",
              process.env.CIVIC_SPARK_SPRITE_API_URL ?? "https://api.sprites.dev",
              process.env.SPRITE_TOKEN ?? "",
            );
            await revalidate();
            phase("creating"); // Pause may have arrived during the provider existence check.
            if (existence === "missing" && projectRepair)
              throw Error("The reserved workspace is missing. No replacement was created.");
            if (existence === "missing") {
              await create();
              phase("checkout");
              const uploaded = await client.uploadBundle(name, bundle, revalidate);
              if (!uploaded.ok) throw new Error(uploaded.error);
              await revalidate();
            } else {
              // Existing private work always wins over recovery source. Only seed
              // an absent project after a previous create interrupted before checkout.
              const files = await client.files(name);
              await revalidate();
              if (!files.ok) {
                phase("checkout");
                const absent = await client.exec(name, [
                  "bash",
                  "-lc",
                  "test ! -e /home/sprite/project && test ! -L /home/sprite/project",
                ]);
                await revalidate();
                if (!absent.ok)
                  throw new Error(
                    "The existing recovery Sprite could not reconnect. Its files were not replaced.",
                  );
                const uploaded = await client.uploadBundle(name, bundle, revalidate);
                if (!uploaded.ok) throw new Error(uploaded.error);
                await revalidate();
              }
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
                  ? missingWorkspaceMessage
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
        if (initialRetry || recovery || projectRepair) await revalidate();
        phase("verifying");
        const saved = this.service.setSprite(workspace.id, name, "ready", null, "ready");
        if (!saved.ok) throw new Error(saved.error);
        if (projectRepair) this.service.setRuntime(workspace.id, { projectRepair: undefined });
        if (recovery) {
          if (expected.reset) this.service.setRuntime(workspace.id, { reset: undefined });
          else completeRecovery(this.root, workspace.id, name);
          const runtime = this.service.runtime(workspace.id);
          if (runtime.deletion?.state === "deleted")
            this.service.setRuntime(workspace.id, {
              deletion: null,
              generation: runtime.generation + 1,
            });
        }
      } catch (error) {
        if (
          this.service.runtime(workspace.id).generation !== generation ||
          this.service.provisioningRecords().find((w) => w.id === workspace.id)?.spriteName !== name
        )
          return;
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
