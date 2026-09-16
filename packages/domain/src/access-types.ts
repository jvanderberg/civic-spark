import { z } from "zod";
import type { Contribution, Event, Participant, Team, Template } from "./types.ts";

export const identitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.email(),
  emailVerified: z.literal(true),
});
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
export type Workspace = Participant & { userId: string; teamName: string };
export type EventView = Event & { role: "admin" | "member" | "visitor" };
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
  projectBrief: string;
};
export type SessionView = {
  user: Identity | null;
  emailSignIn: boolean;
  authMode: "email" | "prototype";
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
