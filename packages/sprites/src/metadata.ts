import { z } from "zod";

const listedSpriteSchema = z.object({
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
      name: z.literal(org).optional(),
      sprites: z.array(listedSpriteSchema).nullable(),
    })
    .refine((list) => {
      // Organization authentication cannot override conflicting ownership of
      // this reservation, even if a subsequent named GET would return404.
      if (list.sprites?.some((sprite) => sprite.name === targetName && !claimsMatch(sprite)))
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
    name: z.literal(name),
    organization: z.literal(org),
    org_slug: z.literal(org).optional(),
  });
}
