import { describe, expect, it } from "vitest";
import {
  agentFailure,
  agentInputSchema,
  agentModels,
  credentialFailure,
} from "../packages/agents/src/protocol.ts";

describe("agent connection failures", () => {
  it("distinguishes credential failures from transient provider and runtime failures", () => {
    for (const status of [401, 402, 403]) expect(credentialFailure({ status })).toBe(true);
    for (const status of [429, 500, 502, 503]) expect(credentialFailure({ status })).toBe(false);
    expect(credentialFailure({ message: "fetch failed" })).toBe(false);
    expect(credentialFailure({ message: "server exited" })).toBe(false);
    expect(agentInputSchema.parse({ type: "reconnect", provider: "opencode" })).toEqual({
      type: "reconnect",
      provider: "opencode",
    });
    expect(agentInputSchema.safeParse({ type: "reconnect", provider: "other" }).success).toBe(
      false,
    );
  });
  it("returns actionable messages without leaking provider payloads", () => {
    const secret = "private-test-credential";
    expect(agentFailure({ status: 401, message: secret })).toContain("API key was rejected");
    expect(agentFailure({ status: 402, message: secret })).toContain("insufficient credits");
    expect(agentFailure({ data: { statusCode: 429, message: secret } })).toContain("rate limiting");
    expect(agentFailure({ message: `Server exited: postinstall ${secret}` })).toContain(
      "installation checks",
    );
    expect(agentFailure({ message: secret })).not.toContain(secret);
    expect(agentFailure(null)).toContain("Retry");
  });
  it("allows only supported backends and uses fixed model presets", () => {
    expect(
      agentInputSchema.safeParse({ type: "prompt", provider: "arbitrary", text: "test" }).success,
    ).toBe(false);
    expect(
      agentInputSchema.parse({ type: "prompt", provider: "opencode", text: "test" }).type,
    ).toBe("prompt");
    expect(agentModels.opencode.model).toBe("openrouter/z-ai/glm-5.3-flash");
    expect(agentModels.claude.model).toBe("claude-opus-5");
  });
});
