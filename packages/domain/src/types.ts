import { z } from "zod";

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  revision: z.number().int().nonnegative().optional(),
});
export const scheduleSchema = z.object({
  id: z.string().optional(),
  time: z.string(),
  title: z.string(),
  description: z.string(),
});
export const templateSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  projects: z.array(projectSchema),
  schedule: z.array(scheduleSchema),
});
export const createEventSchema = z.object({
  name: z.string().trim().min(2).max(100),
  date: z.iso.date(),
  timezone: z.string().refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid timezone"),
  location: z.string().trim().min(2).max(160),
  capacity: z.number().int().min(1).max(500),
  budget: z.number().min(0).max(10000),
  templateId: z.enum(["blank", "diod"]),
});
// Stored legacy labels remain valid; new edits validate clock-style times separately.
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time (HH:mm)");
export const defaultProjectBriefGuidance =
  "Describe the problem and who it helps. Explain the outcome or demo you want to build, what is in scope, and how you will know it succeeded. Include useful data links, access requirements, and any constraints.";
const eventDetailsFields = {
  projectBriefGuidance: z.string().max(5000).default(defaultProjectBriefGuidance),
  description: z.string().max(10000).default(""),
  address: z.string().trim().max(300).default(""),
  startTime: z.union([z.literal(""), clockTime]).default(""),
  endTime: z.union([z.literal(""), clockTime]).default(""),
};
export const eventSettingsSchema = createEventSchema
  .omit({ templateId: true })
  .extend({
    projectBriefGuidance: eventDetailsFields.projectBriefGuidance.removeDefault(),
    description: eventDetailsFields.description.removeDefault(),
    address: eventDetailsFields.address.removeDefault(),
    startTime: eventDetailsFields.startTime.removeDefault(),
    endTime: eventDetailsFields.endTime.removeDefault(),
    expectedRevision: z.number().int().nonnegative(),
    schedule: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          time: z
            .string()
            .max(100)
            .refine((value) => value.trim().length > 0, "Enter a schedule time or label"),
          title: z.string().trim().min(1).max(200),
          description: z.string().max(5000),
        }),
      )
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.startTime && value.endTime && value.startTime >= value.endTime)
      ctx.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "End time must be after start time on the event date",
      });
    const ids = new Set<string>();
    let previous = "";
    for (const [index, row] of value.schedule.entries()) {
      if (ids.has(row.id))
        ctx.addIssue({
          code: "custom",
          path: ["schedule", index, "id"],
          message: "Schedule entries must have unique IDs",
        });
      ids.add(row.id);
      const time = row.time.trim();
      if (clockTime.safeParse(time).success) {
        if (previous > time)
          ctx.addIssue({
            code: "custom",
            path: ["schedule", index, "time"],
            message: "Put timed schedule entries in chronological order",
          });
        previous = time;
      }
    }
  });
export type EventSettingsInput = z.input<typeof eventSettingsSchema>;
export type EventSettings = z.infer<typeof eventSettingsSchema>;
export const eventSchema = createEventSchema.extend({
  ...eventDetailsFields,
  revision: z.number().int().nonnegative().default(0),
  id: z.string(),
  status: z.enum(["draft", "registration", "live", "closed"]),
  createdAt: z.string(),
  projects: z.array(projectSchema),
  schedule: z.array(scheduleSchema),
});
export const teamSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  number: z.number(),
  name: z.string(),
  projectId: z.string(),
  createdAt: z.string(),
  deletedAt: z.string().optional(),
});
export const spritePhaseSchema = z.enum(["bundling", "creating", "checkout", "verifying", "ready"]);
export type SpritePhase = z.infer<typeof spritePhaseSchema>;
export const participantSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  teamId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  spriteName: z.string().nullable(),
  spriteStatus: z.enum(["local", "provisioning", "ready", "error"]),
  spriteError: z.string().nullable(),
  spritePhase: spritePhaseSchema.nullable().optional(),
  spriteUpdatedAt: z.string().nullable().optional(),
});
export const contributionSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  teamId: z.string(),
  participantId: z.string(),
  title: z.string(),
  commit: z.string(),
  previewRevision: z.string().optional(),
  status: z.enum(["review", "accepted", "conflict"]),
  createdAt: z.string(),
  diff: z.string(),
});
export const activitySchema = z.object({
  id: z.string(),
  eventId: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
export const stateSchema = z.object({
  version: z.literal(1),
  events: z.array(eventSchema),
  teams: z.array(teamSchema),
  participants: z.array(participantSchema),
  contributions: z.array(contributionSchema),
  activity: z.array(activitySchema),
});
export type Event = z.infer<typeof eventSchema>;
export type EventInput = z.infer<typeof createEventSchema>;
export type Team = z.infer<typeof teamSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type Contribution = z.infer<typeof contributionSchema>;
export type State = z.infer<typeof stateSchema>;
export type Template = z.infer<typeof templateSchema>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status: number };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (error: string, status = 400): Result<never> => ({ ok: false, error, status });
export type FileContent = { path: string; content: string; revision: string };
export type Bootstrap = State & {
  templates: Template[];
  capabilities: { sprites: boolean; mode: "local-operator" };
};
