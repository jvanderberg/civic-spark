import { z } from "zod";

export const executionSchema = z.object({
  paused: z.boolean().default(false),
  changedAt: z.string().nullable().default(null),
  generation: z.number().int().default(0),
});
export type EventExecution = z.infer<typeof executionSchema>;
export const runtimeSchema = z.object({
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
    // Allocation age is only a CPU ceiling, never a total bill or running time.
    cpuLifetimeCeilingUsd: number | null;
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
