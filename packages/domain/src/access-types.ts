import { z } from "zod";
import type { Contribution, Event, Participant, Team, Template } from "./types.ts";

export const verifiedIdentitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.email(),
  emailVerified: z.literal(true),
});
// Demo identity is explicitly unverified and never accepted by production auth.
export const demoIdentitySchema = verifiedIdentitySchema.extend({
  emailVerified: z.literal(false),
  authMode: z.literal("demo"),
});
export const identitySchema = z.union([verifiedIdentitySchema, demoIdentitySchema]);
export type Identity = z.infer<typeof identitySchema>;
export const eventMemberSchema = z.object({
  eventId: z.string(),
  userId: z.string(),
  role: z.enum(["admin", "member"]),
});
export const membershipSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  teamId: z.string(),
  userId: z.string(),
  active: z.boolean(),
  joinedAt: z.string(),
});
export const accessStateSchema = z.object({
  version: z.literal(1),
  users: z.array(identitySchema),
  eventMembers: z.array(eventMemberSchema),
  memberships: z.array(membershipSchema),
});
export type AccessState = z.infer<typeof accessStateSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type Workspace = Participant & {
  preparationAction?: "retry" | "recover-missing";
  userId: string;
  teamName: string;
  runtime?: import("./lifecycle.ts").WorkspaceRuntime;
};
// Portal lists carry project summaries only; the Markdown brief is fetched on
// demand per project so polling the portal never re-sends every brief.
export type ProjectSummary = Omit<Event["projects"][number], "description">;
export type EventView = Omit<Event, "projects"> & {
  projects: ProjectSummary[];
  execution?: import("./lifecycle.ts").EventExecution;
  role: "admin" | "member" | "visitor";
};
export type MemberView = {
  userId: string;
  eventId: string;
  name: string;
  email?: string;
  role: "admin" | "member";
  teamIds: string[];
};
export type TeamView = Team & {
  memberNames: string[];
  memberCount: number;
  joined: boolean;
  projectName: string;
};
export type SessionView = {
  user: Identity | null;
  emailSignIn: boolean;
  authMode: "email" | "prototype" | "demo";
  siteEvent: { id: string; name: string | null } | null;
  canCreateEvents: boolean;
};
export type PortalState = {
  user: Identity;
  events: EventView[];
  teams: TeamView[];
  members: MemberView[];
  myWorkspaces: Workspace[];
  contributions: Contribution[];
  templates: Template[];
  activity: { id: string; eventId: string; message: string; createdAt: string }[];
  capabilities: { sprites: boolean };
};
// Preserve Markdown whitespace and URLs exactly; trim only for validation.
export const projectInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
  brief: z
    .string()
    .max(10000, "Keep the project brief under 10,001 characters")
    .refine((value) => value.trim().length >= 20, "Write a project brief of at least 20 characters")
    .refine((value) => !value.includes("\0"), "Project briefs cannot contain null characters"),
});
export const projectUpdateSchema = projectInputSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
});
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;
export type ProjectInput = z.infer<typeof projectInputSchema>;
export const teamInputSchema = z
  .object({
    eventId: z.string(),
    name: z.string().trim().min(2).max(80),
    projectId: z.string().optional(),
    customProject: z
      .object({
        name: z.string().trim().min(2).max(100),
        brief: z.string().trim().min(20).max(10000),
      })
      .optional(),
  })
  .refine(
    (v) => Boolean(v.projectId) !== Boolean(v.customProject),
    "Choose a listed project or provide a custom brief",
  );
export type TeamInput = z.infer<typeof teamInputSchema>;
