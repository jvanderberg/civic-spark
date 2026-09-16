import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { imageDataUrl } from "./images.ts";
import type { AgentInput } from "./protocol.ts";

type Prompt = Extract<AgentInput, { type: "prompt" }>;
export function claudePrompt(input: Prompt): string | AsyncIterable<SDKUserMessage> {
  if (!input.images?.length) return input.text;
  const images = input.images;
  return (async function* () {
    yield {
      type: "user" as const,
      parent_tool_use_id: null,
      message: {
        role: "user" as const,
        content: [
          ...images.map((image) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: image.mime, data: image.data },
          })),
          ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
        ],
      },
    };
  })();
}

export function openCodeParts(input: Prompt) {
  return [
    ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
    ...(input.images ?? []).map((image) => ({
      type: "file" as const,
      mime: image.mime,
      filename: image.name,
      url: imageDataUrl(image),
    })),
  ];
}

export function requireImageCapability(supported: boolean) {
  if (!supported) {
    const error = new Error("The configured model does not support image input.");
    error.name = "ImageCapabilityError";
    throw error;
  }
}
