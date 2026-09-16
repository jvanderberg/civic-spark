import { z } from "zod";
import type { Identity } from "../../../packages/domain/src/access-types.ts";
import type { SpriteInventory } from "../../../packages/domain/src/lifecycle.ts";
import type { EventService } from "../../../packages/domain/src/service.ts";
import { fail, ok } from "../../../packages/domain/src/types.ts";
import type { SpriteLease } from "../../../packages/sprites/src/client.ts";
import {
  cpuLifetimeCeiling,
  type SpriteLifecycleProvider,
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
      if (service.runtime(w.id).stopState === "pending")
        service.setRuntime(w.id, {
          stopState: "failed",
          stopError: "Pause was interrupted by a server restart. Retry pause to finish.",
        });
    }
  }
  touch(id: string) {
    if (this.service.executionAllowed(id).ok)
      this.service.setRuntime(id, { lastUsedAt: new Date().toISOString() });
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
      const provider = await this.provider.inspect(row.spriteName);
      sprites.push({
        ...row,
        provider,
        working: this.working(row.workspaceId),
        cpuLifetimeCeilingUsd: cpuLifetimeCeiling(provider.createdAt),
      });
    }
    // Roles can be revoked while metadata requests are outstanding.
    if (!this.service.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    return ok({ event: this.service.execution(eventId), idleMinutes: this.idleMinutes, sprites });
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
