import { z } from "zod";

export const executionSchema = z.object({
  paused: z.boolean().default(false),
  changedAt: z.string().nullable().default(null),
  generation: z.number().int().default(0),
});
export type EventExecution = z.infer<typeof executionSchema>;
export const runtimeSchema = z.object({
  generation: z.number().int().nonnegative().default(0),
  deletion: z
    .object({
      state: z.enum(["pending", "failed", "deleted"]),
      changedAt: z.iso.datetime(),
      replacementReserved: z.boolean().default(false),
      error: z.string().nullable(),
      org: z.string().min(1),
      apiOrigin: z.url(),
    })
    .nullable()
    .default(null),
  held: z.boolean().default(false),
  reason: z.enum(["admin", "idle"]).nullable().default(null),
  lastUsedAt: z.string().nullable().default(null),
  stopState: z.enum(["pending", "stopped", "failed"]).nullable().default(null),
  stopError: z.string().nullable().default(null),
  stoppedAt: z.string().nullable().default(null),
});
export type WorkspaceRuntime = z.infer<typeof runtimeSchema>;
export const PAUSED_MESSAGE =
  "This hackathon is paused. Shared team source is still available to download.";
export const HELD_MESSAGE = "This Sprite is paused. Reload your workspace to resume.";
export const lifecycleActionSchema = z
  .object({
    action: z.enum(["pause-sprites", "pause-event", "unpause-event"]),
  })
  .strict();

export const spriteActionSchema = z
  .object({
    action: z.enum(["pause", "delete"]),
    generation: z.number().int().nonnegative(),
  })
  .strict();

export type SpriteObservation = {
  status: string;
  observedAt: string;
  createdAt: string | null;
  updatedAt: string | null;
  error: string | null;
};
export type SpriteInventory = {
  event: EventExecution;
  idleMinutes: number;
  sprites: {
    workspaceId: string;
    spriteName: string;
    owner: string;
    team: string;
    membershipActive: boolean;
    provisioningStatus: string;
    provisioningUpdatedAt: string | null;
    runtime: WorkspaceRuntime;
    provider: SpriteObservation;
    working: boolean;
    estimatedUsd: number | null;
    assumedRuntimeHours: number | null;
  }[];
};

export const SPRITE_PRICING = {
  asOf: "2026-09-16",
  source: "https://fly.io/sprites/#pricing",
  currency: "USD",
  cpuHour: 0.07,
  memoryGbHour: 0.04375,
  hotStorageGbHour: 0.000683,
  coldStorageGbHour: 0.000027,
} as const;
