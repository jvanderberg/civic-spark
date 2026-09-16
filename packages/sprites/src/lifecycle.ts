import { readFileSync } from "node:fs";
import { z } from "zod";
import type { SpriteObservation } from "../../domain/src/lifecycle.ts";
// Official rates retrieved 2026-09-16: https://fly.io/sprites/#pricing.
// CPU is cumulative cpu.stat usage, not elapsed allocation time. Memory and
// storage usage are not exposed by Get Sprite. Never invent a total bill.
import { SPRITE_PRICING } from "../../domain/src/lifecycle.ts";
import { SpriteClient } from "./client.ts";
export interface SpriteLifecycleProvider {
  inspect(name: string): Promise<SpriteObservation>;
  stop(name: string): Promise<void>;
}
const nameSchema = z.string().regex(/^civic-spark-[a-z0-9-]{1,45}$/);
const dateSchema = z.iso.datetime({ offset: true }).nullish();
const observationSchema = z.object({
  status: z.enum([
    "running",
    "warm",
    "cold",
    "suspended",
    "stopped",
    "sleeping",
    "creating",
    "starting",
    "stopping",
    "error",
  ]),
  created_at: dateSchema,
  updated_at: dateSchema,
});
const sessionsSchema = z.array(
  z.object({
    id: z.union([z.number().int().nonnegative(), z.string().regex(/^[a-zA-Z0-9-]+$/)]),
  }),
);
// Public reference examples use an array; the deployed API also returns this
// envelope. Parse every ID before issuing any kills, regardless of is_active.
const execListSchema = z.union([
  sessionsSchema,
  z
    .object({ count: z.number().int().nonnegative(), sessions: sessionsSchema })
    .transform((value) => value.sessions),
]);
export function sleeping(status: string) {
  return ["warm", "cold", "suspended", "stopped", "sleeping"].includes(status);
}
export class SpriteLifecycle implements SpriteLifecycleProvider {
  constructor(
    private token = process.env.SPRITE_TOKEN,
    private baseURL = process.env.CIVIC_SPARK_SPRITE_API_URL ?? "https://api.sprites.dev",
    private request: typeof fetch = fetch,
    private stopManaged = async (name: string) => {
      // Deliberate maintenance-only bypass after durable gate and bridge drain.
      // Never used for ordinary workspace commands or provider metadata reads.
      const result = await new SpriteClient().exec(name, [
        "python3",
        "-c",
        readFileSync(new URL("./pause.py", import.meta.url), "utf8"),
      ]);
      if (!result.ok) throw new Error("Managed Sprite work could not be stopped.");
    },
  ) {
    const url = new URL(baseURL);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error("Sprite API must use an HTTPS origin (loopback HTTP is allowed for tests).");
  }
  private async api(name: string, suffix = "", method = "GET") {
    nameSchema.parse(name);
    if (!this.token) throw new Error("Sprite lifecycle credentials are not configured.");
    const response = await this.request(
      `${this.baseURL.replace(/\/$/, "")}/v1/sprites/${encodeURIComponent(name)}${suffix}`,
      {
        method,
        headers: { Authorization: `Bearer ${this.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    // Provider diagnostics can contain command lines or credentials. Never relay them.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Sprite lifecycle request failed (${response.status}). Retry after checking provider access.`,
      );
    }
    const body = await response.text();
    if (body.length > 2 * 1024 * 1024)
      throw new Error("Sprite lifecycle response exceeds the limit.");
    if (method === "POST") {
      // HTTP 200 only starts the progress stream. Error events and a truncated
      // stream must remain retryable failures; never expose their private text.
      try {
        let values: unknown[];
        try {
          const value: unknown = JSON.parse(body);
          values = Array.isArray(value) ? value : [value];
        } catch {
          values = body
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        }
        const events = z.array(z.object({ type: z.string() })).parse(values);
        if (events.some((event) => event.type === "error") || events.at(-1)?.type !== "complete")
          throw new Error("Incomplete stop");
        return null;
      } catch {
        throw new Error("Sprite stop did not complete. Retry after checking provider access.");
      }
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error("Sprite lifecycle returned an invalid response.");
    }
  }

  async inspect(name: string): Promise<SpriteObservation> {
    const observedAt = new Date().toISOString();
    try {
      // Management metadata only: no exec, filesystem, URL fetch, or session listing.
      const info = observationSchema.parse(await this.api(name));
      return {
        status: info.status,
        createdAt: info.created_at ?? null,
        updatedAt: info.updated_at ?? null,
        observedAt,
        error: null,
      };
    } catch {
      return {
        status: "unknown",
        createdAt: null,
        updatedAt: null,
        observedAt,
        error: "Provider status unavailable. Check lifecycle credentials and connectivity.",
      };
    }
  }
  async stop(name: string) {
    const info = await this.inspect(name);
    if (info.error) throw new Error(info.error);
    if (sleeping(info.status)) return;
    // Sprites has no documented manual VM-suspend endpoint. Stop supported work,
    // then let provider idle detection suspend the VM. Keep definitions and disk.
    const services = z
      .array(z.object({ name: z.string().min(1).max(200) }))
      .parse(await this.api(name, "/services"));
    const failures: unknown[] = [];
    try {
      await this.stopManaged(name);
    } catch (error) {
      failures.push(error);
    }
    for (const service of services) {
      try {
        await this.api(name, `/services/${encodeURIComponent(service.name)}/stop`, "POST");
      } catch (error) {
        failures.push(error);
      }
    }
    const sessions = execListSchema.parse(await this.api(name, "/exec"));
    for (const session of sessions) {
      try {
        await this.api(name, `/exec/${encodeURIComponent(session.id)}/kill`, "POST");
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new Error("Some Sprite work could not be stopped. Retry pause to finish.");
  }
}

export function cpuLifetimeCeiling(createdAt: string | null, now = Date.now()) {
  if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) > now)
    return null;
  return ((now - Date.parse(createdAt)) / 3600000) * 8 * SPRITE_PRICING.cpuHour;
}
