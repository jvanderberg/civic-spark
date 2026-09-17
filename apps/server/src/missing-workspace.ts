import type { Identity, Workspace } from "../../../packages/domain/src/access-types.ts";
import type { EventService } from "../../../packages/domain/src/service.ts";
import { fail, ok, type Result } from "../../../packages/domain/src/types.ts";
import type { SpriteClient } from "../../../packages/sprites/src/client.ts";

/** Owner Resume may discover absence, but never grants replacement permission. */
export async function inspectIdleWorkspaceForWake(
  service: EventService,
  client: SpriteClient,
  owner: Identity,
  workspace: Workspace,
  authorize: () => Promise<Result<Workspace>>,
  busy: () => boolean,
): Promise<Result<{ missing: boolean }>> {
  const before = service.runtime(workspace.id);
  if (
    workspace.spriteStatus !== "ready" ||
    !workspace.spriteName ||
    !before.held ||
    before.reason !== "idle" ||
    before.deletion
  )
    return ok({ missing: false });
  const eventGeneration = service.execution(workspace.eventId).generation;
  const binding = client.provisioningBinding();
  if (!binding)
    return fail("Workspace status could not be authenticated. Nothing was rebuilt.", 409);
  const validate = async () => {
    const current = await authorize();
    if (!current.ok) return current;
    const runtime = service.runtime(workspace.id);
    if (
      current.value.spriteName !== workspace.spriteName ||
      current.value.spriteStatus !== "ready" ||
      runtime.generation !== before.generation ||
      !runtime.held ||
      runtime.reason !== "idle" ||
      runtime.deletion ||
      runtime.stopState === "pending" ||
      service.execution(workspace.eventId).generation !== eventGeneration ||
      process.env.CIVIC_SPARK_SPRITE_ORG !== binding.org ||
      JSON.stringify(client.provisioningBinding()) !== JSON.stringify(binding) ||
      busy()
    )
      return fail("Workspace state or active work changed. Refresh before resuming.", 409);
    return current;
  };
  const initial = await validate();
  if (!initial.ok) return initial;
  const existence = await client.inspectReservation(workspace.spriteName, true);
  const observedAt = new Date().toISOString();
  const current = await validate();
  if (!current.ok) return current;
  if (existence === "unknown")
    return fail(
      "The provider could not confirm this workspace’s status. Nothing was rebuilt.",
      409,
    );
  if (existence === "present") return ok({ missing: false });
  const recorded = service.recordMissingWorkspace(owner, workspace.id, {
    ...binding,
    name: workspace.spriteName,
    generation: before.generation,
    eventGeneration,
    observedAt,
    httpStatus: 404,
  });
  return recorded.ok ? ok({ missing: true }) : recorded;
}
