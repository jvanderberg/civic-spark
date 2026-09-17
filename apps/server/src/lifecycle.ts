import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { discardWorkspaceRecovery } from "../../../packages/backup/src/recovery.ts";
import type { Identity } from "../../../packages/domain/src/access-types.ts";
import type { SpriteInventory } from "../../../packages/domain/src/lifecycle.ts";
import type { EventService } from "../../../packages/domain/src/service.ts";
import { fail, ok } from "../../../packages/domain/src/types.ts";
import type { SpriteLease } from "../../../packages/sprites/src/client.ts";
import {
  type SpriteLifecycleProvider,
  spriteEstimate,
} from "../../../packages/sprites/src/lifecycle.ts";

export class WorkspaceLifecycle {
  readonly idleMinutes = z.coerce
    .number()
    .int()
    .min(1)
    .max(120)
    .parse(process.env.CIVIC_SPARK_WORKSPACE_IDLE_MINUTES ?? "5");
  private operations = new Map<
    string,
    Set<{ controller: AbortController; done: Promise<void>; passive: boolean }>
  >();
  private changing = new Set<string>();
  private timer: NodeJS.Timeout;
  constructor(
    private service: EventService,
    private provider: SpriteLifecycleProvider,
    private disconnect: (id: string) => void,
    private working: (id: string) => boolean,
    private protectedUse: (id: string) => boolean = () => false,
    private drain: (id: string) => Promise<void> = async () => {},
  ) {
    this.timer = setInterval(() => this.releaseIdle(), 15000);
    this.timer.unref();
    // Durable gate already prevents wake after restart. Never silently clear a
    // pending stop or contact a live provider during constructor reconciliation.
    for (const w of service.provisioningRecords()) {
      const runtime = service.runtime(w.id);
      if (runtime.deletion?.state === "deleted" && runtime.deletion.reset) {
        this.finishDeletion(w.id);
        continue;
      }
      if (runtime.deletion?.state === "pending")
        service.setRuntime(w.id, {
          held: true,
          deletion: {
            ...runtime.deletion,
            state: "failed",
            error: "Deletion was interrupted. Retry delete to finish.",
            changedAt: new Date().toISOString(),
          },
        });
      if (runtime.stopState === "pending")
        service.setRuntime(w.id, {
          stopState: "failed",
          stopError: "Pause was interrupted by a server restart. Retry pause to finish.",
        });
    }
  }
  private finishDeletion(id: string) {
    const reset = this.service.runtime(id).deletion?.reset;
    if (!reset) throw new Error("Missing deletion receipt");
    discardWorkspaceRecovery(this.service.root, id);
    rmSync(join(this.service.root, "agent-integrations", `${id}.json`), { force: true });
    this.service.finishSpriteDeletion(id);
  }
  touch(id: string) {
    if (this.service.executionAllowed(id).ok)
      this.service.setRuntime(id, { lastUsedAt: new Date().toISOString() });
  }
  hasActiveWork(id: string) {
    const name = this.service.provisioningRecords().find((w) => w.id === id)?.spriteName;
    return (
      this.working(id) ||
      this.protectedUse(id) ||
      [...(this.operations.get(name ?? "") ?? [])].some((operation) => !operation.passive)
    );
  }
  releaseIdle(now = Date.now()) {
    for (const w of this.service.provisioningRecords()) {
      const runtime = this.service.runtime(w.id);
      if (
        !w.spriteName ||
        w.spriteStatus !== "ready" ||
        runtime.held ||
        !runtime.lastUsedAt ||
        now - Date.parse(runtime.lastUsedAt) < this.idleMinutes * 60000 ||
        this.working(w.id) ||
        this.protectedUse(w.id) ||
        [...(this.operations.get(w.spriteName) ?? [])].some((operation) => !operation.passive)
      )
        continue;
      // Release our polling/connections, not arbitrary user processes. Provider
      // activity detection decides when the VM can safely suspend.
      this.service.setRuntime(w.id, { held: true, reason: "idle" });
      this.disconnect(w.id);
    }
  }
  acquire = (name: string, passive = false): SpriteLease => {
    const workspace = this.service.provisioningRecords().find((w) => w.spriteName === name);
    if (!workspace) throw new Error("Sprite is not allocated to this installation.");
    const allowed = this.service.executionAllowed(workspace.id);
    if (!allowed.ok) throw new Error(allowed.error);
    const controller = new AbortController();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = { controller, done, passive };
    const entries = this.operations.get(name) ?? new Set();
    entries.add(operation);
    this.operations.set(name, entries);
    return {
      signal: controller.signal,
      release: () => {
        entries.delete(operation);
        release();
        if (!entries.size) this.operations.delete(name);
      },
    };
  };
  async inventory(actor: Identity, eventId: string) {
    const records = this.service.spriteInventory(actor, eventId);
    if (!records.ok) return records;
    const sprites: SpriteInventory["sprites"] = [];
    // Bounded event allocation inventory; never list unrelated organization Sprites.
    for (const row of records.value) {
      const provider =
        row.runtime.deletion?.state === "deleted" && !row.runtime.deletion.replacementReserved
          ? {
              status: "deleted",
              createdAt: null,
              updatedAt: null,
              observedAt: new Date().toISOString(),
              error: null,
            }
          : await this.provider.inspect(row.spriteName);
      sprites.push({
        ...row,
        provider,
        working: this.working(row.workspaceId),
        ...spriteEstimate(provider.createdAt),
      });
    }
    // Roles can be revoked while metadata requests are outstanding.
    if (!this.service.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    return ok({ event: this.service.execution(eventId), idleMinutes: this.idleMinutes, sprites });
  }
  async changeSprite(
    actor: Identity,
    eventId: string,
    id: string,
    action: "pause" | "delete",
    generation: number,
  ) {
    if (!this.service.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    if (this.changing.has(eventId))
      return fail("A Sprite operation is in progress. Retry shortly.", 409);
    const receipt = this.service.runtime(id);
    if (action === "delete" && receipt.deletion?.state === "deleted" && receipt.deletion.reset) {
      if (
        receipt.generation !== generation ||
        !this.service.provisioningRecords().some((w) => w.id === id && w.eventId === eventId)
      )
        return fail("This Sprite changed. Refresh status before trying again.", 409);
      this.changing.add(eventId);
      try {
        this.finishDeletion(id);
        return ok({ failures: 0 });
      } catch {
        return ok({ failures: 1 });
      } finally {
        this.changing.delete(eventId);
      }
    }
    const org = process.env.CIVIC_SPARK_SPRITE_ORG ?? "";
    const apiOrigin = process.env.CIVIC_SPARK_SPRITE_API_URL ?? "https://api.sprites.dev";
    if (action === "delete" && !org) return fail("Sprite organization is not configured.", 503);
    const held = this.service.holdSprite(
      actor,
      eventId,
      id,
      generation,
      action === "delete" ? { org, apiOrigin } : undefined,
    );
    if (!held.ok) return held;
    const heldGeneration = this.service.runtime(id).generation;
    const current = () =>
      this.service.runtime(id).generation === heldGeneration &&
      this.service.provisioningRecords().find((w) => w.id === id)?.spriteName ===
        held.value.spriteName;
    this.changing.add(eventId);
    try {
      this.disconnect(id);
      const entries = this.operations.get(held.value.spriteName as string);
      if (entries) {
        for (const operation of entries) operation.controller.abort();
        await Promise.all([...entries].map((op) => op.done));
      }
      await this.drain(id);
      // No await separates this authorization check and the provider action.
      if (!this.service.isAdmin(actor, eventId) || !current())
        throw new Error("Authorization changed");
      if (action === "delete") {
        await this.provider.destroy(held.value.spriteName as string);
        const deletion = this.service.runtime(id).deletion;
        if (!current()) throw new Error("Workspace changed during deletion");
        if (!deletion) throw new Error("Missing deletion state");
        this.service.setRuntime(id, {
          held: true,
          deletion: {
            ...deletion,
            state: "deleted",
            reset: {
              previousName: held.value.spriteName as string,
              nextName: `civic-spark-${randomUUID()}`,
            },
            error: null,
            changedAt: new Date().toISOString(),
          },
        });
        this.finishDeletion(id);
      } else {
        await this.provider.stop(held.value.spriteName as string);
        this.service.setRuntime(id, {
          stopState: "stopped",
          stopError: null,
          stoppedAt: new Date().toISOString(),
        });
      }
      return ok({ failures: 0 });
    } catch {
      if (!current()) return ok({ failures: 1 });
      if (action === "delete") {
        const deletion = this.service.runtime(id).deletion;
        if (deletion && deletion.state !== "deleted")
          this.service.setRuntime(id, {
            held: true,
            deletion: {
              ...deletion,
              state: "failed",
              error: "Deletion could not be confirmed. Retry delete.",
              changedAt: new Date().toISOString(),
            },
          });
      } else
        this.service.setRuntime(id, {
          stopState: "failed",
          stopError: "Some Sprite work could not be stopped. Retry pause.",
        });
      return ok({ failures: 1 });
    } finally {
      this.changing.delete(eventId);
    }
  }
  async change(
    actor: Identity,
    eventId: string,
    action: "pause-sprites" | "pause-event" | "unpause-event",
  ) {
    if (!this.service.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    if (this.changing.has(eventId))
      return fail("A pause operation is still in progress. Retry shortly.", 409);
    if (action === "unpause-event") return this.service.setExecution(actor, eventId, false);
    this.changing.add(eventId);
    try {
      // Commit event-wide gate BEFORE enumerating/stopping work, including future
      // reservations. A process crash keeps it blocked and the failure retryable.
      if (action === "pause-event") {
        const gate = this.service.setExecution(actor, eventId, true);
        if (!gate.ok) return gate;
      }
      const held = this.service.holdSprites(actor, eventId);
      if (!held.ok) return held;
      for (const workspace of held.value) this.disconnect(workspace.id);
      for (const workspace of held.value) {
        const entries = this.operations.get(workspace.spriteName ?? "");
        if (entries) for (const operation of entries) operation.controller.abort();
      }
      for (const workspace of held.value) {
        try {
          const entries = this.operations.get(workspace.spriteName ?? "");
          if (entries) await Promise.all([...entries].map((op) => op.done));
          await this.drain(workspace.id);
          await this.provider.stop(workspace.spriteName as string);
          this.service.setRuntime(workspace.id, {
            stopState: "stopped",
            stopError: null,
            stoppedAt: new Date().toISOString(),
          });
        } catch {
          this.service.setRuntime(workspace.id, {
            stopState: "failed",
            stopError: "Some Sprite work could not be stopped. Retry pause to finish.",
          });
        }
      }
      return ok({
        paused: this.service.execution(eventId).paused,
        failures: held.value.filter((w) => this.service.runtime(w.id).stopState === "failed")
          .length,
      });
    } finally {
      this.changing.delete(eventId);
    }
  }
  close() {
    clearInterval(this.timer);
    for (const entries of this.operations.values())
      for (const operation of entries) operation.controller.abort();
  }
}
