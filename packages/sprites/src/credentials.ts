// Pinned CLI contract: sprite auth setup --help (2026-09-02), also documented at
// https://docs.sprites.dev/cli/authentication/. Never include input in an error.
export function validateSpriteToken(token: string | undefined, org: string | undefined) {
  const parts = token?.split("/");
  if (
    !org ||
    !parts ||
    parts.length !== 4 ||
    parts[0] !== org ||
    parts.some((part) => !part || /\s/.test(part))
  )
    throw new Error(
      "SPRITE_TOKEN must use the documented org-slug/org-id/token-id/token-value format for the selected Sprite organization",
    );
  return token as string;
}
