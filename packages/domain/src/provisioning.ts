import { z } from "zod";

export const spriteCreationFailureSchema = z.enum([
  "capacity",
  "rate",
  "auth",
  "transient",
  "unknown",
]);
export type SpriteCreationFailure = z.infer<typeof spriteCreationFailureSchema>;

export const initialCreationSchema = z.object({
  name: z.string(),
  org: z.string().min(1),
  apiOrigin: z.url(),
  account: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["creating", "sealed"]),
});
export type InitialCreation = z.infer<typeof initialCreationSchema>;
export type SpriteProviderBinding = Pick<InitialCreation, "org" | "apiOrigin" | "account">;

// Only these application-owned messages may represent a provider creation failure.
// Never persist or render provider messages, command output or credential values.
export const spriteCreationMessages: Record<SpriteCreationFailure, string> = {
  capacity:
    "The Sprite provider's workspace limit was reached. Ask an event admin to review the provider's capacity limit before trying again.",
  rate: "The Sprite provider is limiting workspace requests. Wait before trying again; ask an event admin if this continues.",
  auth: "Workspace creation could not authenticate with the Sprite provider. Ask an event admin to check the installation's provider access.",
  transient:
    "The Sprite provider could not confirm workspace creation because of a connection or service failure. Ask an event admin to check the reserved workspace.",
  unknown:
    "Workspace creation could not be confirmed. Ask an event admin to investigate the reserved workspace.",
};

export function withCreationFailure(
  cause: SpriteCreationFailure | null | undefined,
  current: string,
) {
  const original = cause ? spriteCreationMessages[cause] : null;
  return original && original !== current ? `${original} ${current}` : current;
}

export const legacyMissingWorkspaceMessage =
  "Workspace preparation did not complete, and the reserved Sprite is absent. Ask an event admin to investigate; retrying will not create a replacement.";
export const missingWorkspaceMessage =
  "The reserved workspace is missing. Rebuild from shared work can restore your team’s shared Git work. Unshared files, commits and workspace history are unavailable.";
