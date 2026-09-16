import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "../../../packages/domain/src/access-types.ts";
import type { EventService } from "../../../packages/domain/src/service.ts";
import { fail, ok, type Result, type SpritePhase } from "../../../packages/domain/src/types.ts";
import { git } from "../../../packages/git/src/repository.ts";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";

export class WorkspaceProvisioning {
  private jobs = new Map<string, Promise<void>>();
  constructor(
    private service: EventService,
    private root: string,
  ) {}
  status(workspace: Workspace): Workspace {
    if (workspace.spriteStatus === "provisioning" && !this.jobs.has(workspace.id)) {
      const error =
        "Workspace preparation was interrupted by a server restart. Retry to resume safely.";
      this.service.setSprite(
        workspace.id,
        workspace.spriteName ?? `vibehack-${workspace.id.slice(0, 8)}`,
        "error",
        error,
      );
      return { ...workspace, spriteStatus: "error", spriteError: error };
    }
    return workspace;
  }
  start(workspace: Workspace): Result<{ preparing: boolean }> {
    if (workspace.spriteStatus === "ready") return ok({ preparing: false });
    if (this.jobs.has(workspace.id)) return ok({ preparing: true });
    const dir = this.service.workspacePath(workspace.id);
    if (git(dir, ["status", "--porcelain"]).toString().trim())
      return fail("Share saved changes before preparing your Sprite", 409);
    const name = workspace.spriteName ?? `vibehack-${workspace.id.slice(0, 8)}`;
    const bundle = join(this.root, `${workspace.id}.bundle`);
    const phase = (next: SpritePhase) => {
      const result = this.service.setSprite(workspace.id, name, "provisioning", null, next);
      if (!result.ok) throw new Error(result.error);
    };
    try {
      phase("bundling");
    } catch {
      return fail(
        "Could not record workspace preparation. Retry; if this continues, ask the event admin to check server storage.",
        503,
      );
    }
    // Defer the work until the job is registered, so repeated starts are idempotent.
    const job = Promise.resolve().then(async () => {
      const client = new SpriteClient();
      try {
        git(dir, ["bundle", "create", bundle, "--all"]);
        phase("creating");
        // A previous attempt may have created the Sprite before its connection was interrupted.
        const resumed = workspace.spriteName ? await client.exec(name, ["true"]) : null;
        if (!resumed?.ok) {
          const created = await client.create(name);
          if (!created.ok) throw new Error(created.error);
        }
        phase("checkout");
        const uploaded = await client.uploadBundle(name, bundle);
        if (!uploaded.ok) throw new Error(uploaded.error);
        phase("verifying");
        const verified = await client.files(name);
        if (!verified.ok) throw new Error(verified.error);
        this.service.setSprite(workspace.id, name, "ready", null, "ready");
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
    void job.finally(() => this.jobs.delete(workspace.id));
    return ok({ preparing: true });
  }
  async close() {
    await Promise.allSettled(this.jobs.values());
  }
}
