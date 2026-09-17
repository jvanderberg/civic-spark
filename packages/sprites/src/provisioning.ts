import { z } from "zod";
import type { SpriteCreationFailure } from "../../domain/src/provisioning.ts";

// Official provider SDK contract, checked 2026-09-17:
// https://github.com/superfly/sprites-go/blob/main/errors.go
// Both quota and rate failures can use HTTP429. Do not infer a quota from counts,
// HTTP429 alone, message substrings, undocumented codes, or CLI stderr.
const providerError = z.object({ error: z.string() });
export function classifyCreationFailure(status: number, body: unknown): SpriteCreationFailure {
  if (status === 401 || status === 403) return "auth";
  const parsed = providerError.safeParse(body);
  const code = parsed.success ? parsed.data.error : undefined;
  if (status >= 400 && status < 500) {
    if (code === "concurrent_sprite_limit_exceeded") return "capacity";
    if (code === "sprite_creation_rate_limited") return "rate";
  }
  // Unknown structured codes may describe other limits; preserve uncertainty.
  if (status === 429 && !code) return "rate";
  if (status === 408 || (status >= 500 && status <= 599)) return "transient";
  return "unknown";
}

export async function boundedProviderJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65536) return null;
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
