import { agentModels } from "./protocol.ts";

export async function verifyProviderKey(
  provider: keyof typeof agentModels,
  key: string,
  workspaceId?: string,
  request: typeof fetch = fetch,
): Promise<{ workspaceId?: string }> {
  const response = await request(
    provider === "opencode"
      ? "https://openrouter.ai/api/v1/auth/key"
      : `https://api.anthropic.com/v1/models/${agentModels.claude.model}`,
    {
      headers:
        provider === "opencode"
          ? { Authorization: `Bearer ${key}` }
          : {
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              ...(workspaceId ? { "anthropic-workspace-id": workspaceId } : {}),
            },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    // Keep provider diagnostics internal; the UI receives only agentFailure's fixed messages.
    const body = (await response.json().catch(() => undefined)) as
      | { error?: { message?: string } }
      | undefined;
    throw { status: response.status, message: body?.error?.message };
  }
  const resolved = response.headers.get("anthropic-workspace-id");
  return { workspaceId: provider === "claude" ? (resolved ?? workspaceId) : undefined };
}
