import { z } from "zod";
export const agentModels = {
  opencode: {
    label: "GLM",
    model: "openrouter/z-ai/glm-5.3-flash",
    credential: "OpenRouter API key",
  },
  claude: { label: "Opus 5", model: "claude-opus-5", credential: "Anthropic API key" },
} as const;

// Never expose SDK request objects, headers, or provider response bodies.
export function agentFailure(error: unknown): string {
  const value = error as {
    message?: string;
    status?: number;
    statusCode?: number;
    name?: string;
    data?: { statusCode?: number; message?: string };
    cause?: { code?: string };
  } | null;
  if (value?.name === "CredentialConfigurationError")
    return "Could not save the agent settings in this Sprite. Check home-directory permissions and JSON configuration, then reconnect.";
  const status = value?.status ?? value?.statusCode ?? value?.data?.statusCode;
  const message = `${value?.name ?? ""} ${value?.message ?? ""} ${value?.data?.message ?? ""}`;
  if (/workspace/i.test(message)) {
    if (status === 404 || /not found|not.*access|forbidden/i.test(message))
      return "This API key cannot access that Anthropic workspace. Check the workspace ID and the key’s permissions.";
    if (/valid workspace|invalid.*workspace/i.test(message))
      return "Enter a valid Anthropic workspace ID from Claude Console → Settings → Workspaces (it starts with wrkspc_).";
    if (/required|must include|not scoped|specify|send.*id/i.test(message))
      return "This Anthropic key requires a workspace ID. Add the ID from Claude Console → Settings → Workspaces, or use a workspace-scoped API key.";
  }
  if (status === 403)
    return "This API key does not have permission for the requested workspace or model. Check its provider access.";
  if (status === 401 || /API key|authentication|unauthorized/i.test(message))
    return "The API key was rejected. Check the selected model’s key and reconnect.";
  if (status === 402 || /credits|balance|payment/i.test(message))
    return "This account has insufficient credits. Add credits or use another API key.";
  if (status === 429 || /rate.limit/i.test(message))
    return "The provider is rate limiting requests. Wait a moment, then retry.";
  if (/postinstall|ENOENT|server exited|server to start/i.test(message))
    return "The agent runtime could not start. Reconnect to run the installation checks and repair it.";
  if (status === 404 || /model.*(not found|unavailable)|ModelNotFound/i.test(message))
    return "The selected model is unavailable to this account. Check provider access and retry.";
  if (/timeout|timed out/i.test(message) || value?.cause?.code === "ETIMEDOUT")
    return "The provider connection timed out. Check network access from the Sprite and retry.";
  if (
    /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(`${message} ${value?.cause?.code ?? ""}`)
  )
    return "The Sprite could not reach the provider. Check its network connection and retry.";
  if (/abort/i.test(message)) return "Stopped. You can send another request.";
  return "The provider request failed. Retry, or reconnect to check the runtime and API key.";
}
export function credentialFailure(error: unknown): boolean {
  return /API key was rejected|does not have permission|insufficient credits|Anthropic workspace|workspace ID|key requires a workspace/.test(
    agentFailure(error),
  );
}
export const agentInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("configure"),
    provider: z.enum(["claude", "opencode"]),
    key: z.string().trim().min(1).max(1000),
    workspaceId: z
      .string()
      .trim()
      .regex(/^wrkspc_[A-Za-z0-9]+$/)
      .max(128)
      .optional(),
  }),
  z.object({
    type: z.literal("prompt"),
    provider: z.enum(["claude", "opencode"]),
    text: z.string().trim().min(1).max(20000),
    model: z.string().max(160).optional(),
  }),
  z.object({
    type: z.literal("approval"),
    id: z.string(),
    allow: z.boolean(),
    answer: z.string().max(10000).optional(),
  }),
  z.object({ type: z.literal("reconnect"), provider: z.enum(["claude", "opencode"]) }),
  z.object({ type: z.literal("stop") }),
]);
export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentEvent = {
  type:
    | "state"
    | "ready"
    | "configured"
    | "user"
    | "text"
    | "tool"
    | "approval"
    | "resolved"
    | "status"
    | "done"
    | "error";
  id: string;
  text: string;
  details?: string;
  cost?: number;
  runtimeReady?: boolean;
  working?: boolean;
  // Runtime turn clock, retained across browser reconnects; absent for old runners.
  workingStartedAt?: string;
  configuredProviders?: ("claude" | "opencode")[];
  // Presence only, never credential values. Saving and runtime readiness differ.
  savedProviders?: ("claude" | "opencode")[];
  failedProviders?: ("claude" | "opencode")[];
  provider?: "claude" | "opencode";
  credentialFailure?: boolean;
  // Wire-only provenance: saved transcript events are not new runtime failures.
  replayed?: boolean;
  // A server snapshot explicitly restores an unresolved current error. Undefined
  // means this is a runner snapshot that does not own the server's error state.
  currentError?: string | null;
};
