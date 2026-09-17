import { z } from "zod";

const listedSpriteSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  org_slug: z.string().min(1).optional(),
  organization: z.string().min(1).optional(),
});

/** Use only after successful authentication with the configured org-bound token. */
export function spriteOrganizationListSchema(org: string, targetName?: string) {
  const claimsMatch = (sprite: z.infer<typeof listedSpriteSchema>) =>
    (sprite.org_slug === undefined || sprite.org_slug === org) &&
    (sprite.organization === undefined || sprite.organization === org);
  return z
    .object({
      error: z.never().optional(),
      name: z.literal(org).optional(),
      sprites: z.array(listedSpriteSchema).nullable(),
      has_more: z.boolean().optional(),
      next_continuation_token: z.string().nullable().optional(),
    })
    .refine((list) => {
      // Organization authentication cannot override conflicting ownership of
      // this reservation, even if a subsequent named GET would return404.
      const targets = list.sprites?.filter((sprite) => sprite.name === targetName) ?? [];
      if (
        targets.length > 1 ||
        targets.some(
          (sprite) =>
            (sprite.org_slug !== undefined && sprite.org_slug !== org) ||
            (sprite.organization !== undefined && sprite.organization !== org && !sprite.id),
        )
      )
        return false;
      // Current API: top-level name identifies the authenticated organization.
      // Unrelated rows cannot establish ownership of the reserved resource.
      // The official JS SDK also accepts null as an empty list.
      if (list.name === org) return true;
      // Older rc48 lists omit top-level name. Keep their claim checks, and do
      // not accept an unidentifiable null/missing collection as authentication.
      return list.sprites?.every(claimsMatch) ?? false;
    });
}

/** Named GET/create claims must match; List authentication cannot override them. */
export function spriteResourceSchema(name: string, org: string) {
  return z.object({
    error: z.never().optional(),
    name: z.literal(name),
    organization: z.literal(org),
    org_slug: z.literal(org).optional(),
  });
}

export type SpriteOrganizationList = z.infer<ReturnType<typeof spriteOrganizationListSchema>>;
export function spriteResourceCandidateSchema(name: string, org: string) {
  return spriteResourceSchema(name, org).extend({
    id: z.string().min(1).optional(),
    organization: z.string().min(1),
  });
}
type SpriteResource = z.infer<ReturnType<typeof spriteResourceCandidateSchema>>;
export function listWitnessesTarget(list: SpriteOrganizationList | undefined, name: string) {
  return list?.sprites?.some((sprite) => sprite.name === name) ?? false;
}
/** Carry forward any earlier exact-target witness, including on the direct-slug path. */
export function resourceAgreesWithWitness(resource: SpriteResource, list?: SpriteOrganizationList) {
  const targets = list?.sprites?.filter((sprite) => sprite.name === resource.name) ?? [];
  if (!targets.length) return true;
  return (
    targets.length === 1 &&
    !!resource.id &&
    targets[0]?.id === resource.id &&
    targets[0]?.organization === resource.organization
  );
}
export function spriteMembershipPath(name: string) {
  return `/v1/sprites?prefix=${encodeURIComponent(name)}&max_results=2`;
}
/** A complete org-scoped membership certificate, never an organization alias. */
export function certifiesSpriteResource(body: unknown, resource: SpriteResource, org: string) {
  const result = spriteOrganizationListSchema(org, resource.name).safeParse(body);
  if (!result.success || !resource.id) return false;
  const list = result.data;
  return (
    list.name === org &&
    list.has_more === false &&
    (list.next_continuation_token == null || list.next_continuation_token === "") &&
    list.sprites !== null &&
    list.sprites.length <= 2 &&
    list.sprites.filter((sprite) => sprite.name === resource.name).length === 1 &&
    resourceAgreesWithWitness(resource, list)
  );
}
