import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliConfiguration } from "../packages/agents/src/cli-config.ts";
import {
  claudeEnvironment,
  claudeWorkspaceId,
  saveCredential,
} from "../packages/agents/src/credentials.ts";
import { agentFailure, agentInputSchema } from "../packages/agents/src/protocol.ts";
import { verifyProviderKey } from "../packages/agents/src/provider.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("Anthropic workspace authentication", () => {
  it("validates a scoped key without requiring a workspace ID", async () => {
    const request = vi.fn<typeof fetch>();
    request.mockResolvedValue(
      new Response(JSON.stringify({ id: "claude-opus-5" }), {
        headers: { "anthropic-workspace-id": "wrkspc_Default123" },
      }),
    );
    expect(await verifyProviderKey("claude", "fixture-key", undefined, request)).toEqual({
      workspaceId: "wrkspc_Default123",
    });
    expect(request.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/models/claude-opus-5");
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty("anthropic-workspace-id");
  });
  it("sends an explicit workspace and never sends it to OpenRouter", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    await verifyProviderKey("claude", "fixture-key", "wrkspc_Example123", request);
    expect(request.mock.calls[0]?.[1]?.headers).toHaveProperty(
      "anthropic-workspace-id",
      "wrkspc_Example123",
    );
    await verifyProviderKey("opencode", "router-fixture", "wrkspc_Example123", request);
    expect(request.mock.calls[1]?.[1]?.headers).not.toHaveProperty("anthropic-workspace-id");
  });
  it("classifies the real organization-key error instead of hiding it behind a generic provider failure", async () => {
    const secret = "never-expose-this-fixture";
    const request = vi.fn<typeof fetch>();
    request.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: `This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. ${secret}`,
          },
        }),
        { status: 400 },
      ),
    );
    try {
      await verifyProviderKey("claude", secret, undefined, request);
      throw Error("Expected provider failure");
    } catch (error) {
      expect(agentFailure(error)).toContain("requires a workspace ID");
      expect(agentFailure(error)).not.toContain(secret);
    }
    expect(agentFailure({ status: 404, message: "Workspace wrkspc_unknown not found." })).toContain(
      "cannot access",
    );
    expect(
      agentFailure({
        status: 400,
        message: "anthropic-workspace-id header must be a valid workspace ID.",
      }),
    ).toContain("valid Anthropic workspace ID");
    expect(agentFailure({ name: "TimeoutError", message: secret })).toContain("timed out");
    expect(agentFailure({ message: "fetch failed", cause: { code: "ENOTFOUND" } })).toContain(
      "could not reach",
    );
  });
  it("persists a shared SDK and CLI workspace header while preserving other headers and env settings", () => {
    const root = mkdtempSync(join(tmpdir(), "vibehack-provider-"));
    roots.push(root);
    mkdirSync(join(root, ".claude"));
    const file = join(root, ".claude/settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        env: {
          KEEP: "yes",
          ANTHROPIC_CUSTOM_HEADERS: "x-custom: keep\nanthropic-workspace-id: wrkspc_old",
        },
      }),
    );
    saveCredential(root, "claude", "fixture-key", "wrkspc_New123");
    const env = claudeEnvironment(root, {}, "fixture-key");
    expect(claudeWorkspaceId(root)).toBe("wrkspc_New123");
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-custom: keep\nanthropic-workspace-id: wrkspc_New123",
    );
    expect(cliConfiguration(root, "claude", [], {}).env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      env.ANTHROPIC_CUSTOM_HEADERS,
    );
    expect(JSON.parse(readFileSync(file, "utf8")).env.KEEP).toBe("yes");
    saveCredential(root, "claude", "new-scoped-fixture", null);
    expect(claudeWorkspaceId(root)).toBeUndefined();
    expect(claudeEnvironment(root, {}).ANTHROPIC_CUSTOM_HEADERS).toBe("x-custom: keep");
    expect(() =>
      saveCredential(root, "claude", "replacement", "wrkspc_x\nx-api-key: injected"),
    ).toThrow();
    expect(claudeEnvironment(root, {}).ANTHROPIC_API_KEY).toBe("new-scoped-fixture");
  });
  it("validates optional workspace IDs and blocks header injection", () => {
    expect(
      agentInputSchema.safeParse({
        type: "configure",
        provider: "claude",
        key: "fixture-key",
        workspaceId: "wrkspc_Example123",
      }).success,
    ).toBe(true);
    expect(
      agentInputSchema.safeParse({
        type: "configure",
        provider: "claude",
        key: "fixture-key",
        workspaceId: "wrkspc_x\nx-api-key:bad",
      }).success,
    ).toBe(false);
  });
});
