import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import { gitAsync } from "../../git/src/async.ts";
import {
  type historyQuerySchema,
  repositoryFile,
  repositoryHistory,
  repositoryVersion,
  type restoreFileInputSchema,
  type restoreInputSchema,
  restoreRepository,
  restoreRepositoryFile,
} from "../../git/src/history.ts";
import { gitJob } from "../../git/src/jobs.ts";
import { git } from "../../git/src/repository.ts";
import { WorkspaceFiles } from "../../workspace/src/files.ts";
import {
  applyTeamUpdate,
  importTeamBundle,
  type TeamUpdate,
  teamStatus,
  verifyTeamUpdate,
} from "../../workspace/src/team-git.ts";
import type { FileMutation } from "../../workspace/src/types.ts";
import {
  type AccessState,
  accessStateSchema,
  type Identity,
  identitySchema,
  type PortalState,
  type ProjectInput,
  type ProjectUpdate,
  projectInputSchema,
  projectUpdateSchema,
  type TeamInput,
  teamInputSchema,
  type Workspace,
} from "./access-types.ts";
import { templates, WorkspaceEngine } from "./engine.ts";
import {
  executionSchema,
  HELD_MESSAGE,
  PAUSED_MESSAGE,
  runtimeSchema,
  type WorkspaceRuntime,
} from "./lifecycle.ts";
import type { SpriteProviderBinding } from "./provisioning.ts";
import {
  type Event,
  type EventInput,
  type EventSettingsInput,
  eventSettingsSchema,
  fail,
  ok,
  type Result,
} from "./types.ts";

export { templates } from "./engine.ts";

// Every user-facing operation requires the verified session actor. The Git engine
// is an internal storage implementation, never a route exposed to the browser.
export class EventService {
  private engine: WorkspaceEngine;
  private db: DatabaseSync;
  private state: AccessState;
  private persistedState = "";
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.engine = new WorkspaceEngine(root);
    this.db = new DatabaseSync(join(root, "access.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS access_state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS event_execution(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS workspace_runtime(id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
    const row = this.db.prepare("SELECT body FROM access_state WHERE id=1").get();
    this.state = row
      ? accessStateSchema.parse(JSON.parse(String(row.body)))
      : { version: 1, users: [], eventMembers: [], memberships: [] };
    this.persistedState = JSON.stringify(this.state);
  }
  checkHealth() {
    this.db.prepare("SELECT 1").get();
  }
  // Internal recovery source, after owner authorization and the execution gate.
  // Only canonical shared main is eligible; never seed from a restored private checkout.
  sharedWorkspaceRepository(id: string) {
    const workspace = this.engine.snapshot().participants.find((w) => w.id === id);
    if (!workspace) throw new Error("Workspace not found");
    return this.engine.repoPath(workspace.teamId);
  }
  // Internal operator state; never returned by an API or used to authorize a user.
  provisioningRecords() {
    return this.engine.snapshot().participants;
  }
  execution(eventId: string) {
    const row = this.db.prepare("SELECT body FROM event_execution WHERE id=?").get(eventId);
    return executionSchema.parse(row ? JSON.parse(String(row.body)) : {});
  }
  runtime(id: string) {
    const row = this.db.prepare("SELECT body FROM workspace_runtime WHERE id=?").get(id);
    return runtimeSchema.parse(row ? JSON.parse(String(row.body)) : {});
  }
  setRuntime(id: string, change: Partial<WorkspaceRuntime>) {
    const next = runtimeSchema.parse({ ...this.runtime(id), ...change });
    this.db
      .prepare(
        "INSERT INTO workspace_runtime(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(id, JSON.stringify(next));
    return next;
  }
  setExecution(actor: Identity, eventId: string, paused: boolean) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    const previous = this.execution(eventId);
    const next = {
      paused,
      changedAt: new Date().toISOString(),
      generation: previous.generation + 1,
    };
    this.db
      .prepare(
        "INSERT INTO event_execution(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(eventId, JSON.stringify(next));
    return ok(next);
  }
  executionAllowed(id: string) {
    const workspace = this.provisioningRecords().find((w) => w.id === id);
    if (!workspace) return fail("Workspace not found", 404);
    if (this.execution(workspace.eventId).paused) return fail(PAUSED_MESSAGE, 423);
    const runtime = this.runtime(id);
    if (runtime.deletion && runtime.deletion.state !== "deleted")
      return fail("Sprite deletion needs to finish. Ask an event admin to retry.", 423);
    if (runtime.held) return fail(HELD_MESSAGE, 423);
    return ok(workspace);
  }
  spriteInventory(actor: Identity, eventId: string) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    const data = this.engine.snapshot();
    return ok(
      data.participants
        .filter((w) => w.eventId === eventId && w.spriteName)
        .map((w) => {
          const m = this.state.memberships.find((m) => m.id === w.id);
          const team = data.teams.find((t) => t.id === w.teamId);
          return {
            workspaceId: w.id,
            spriteName: w.spriteName as string,
            owner: this.state.users.find((u) => u.id === m?.userId)?.name ?? "Former member",
            team: team?.name ?? "Retained team",
            membershipActive: Boolean(m?.active && !team?.deletedAt),
            provisioningStatus: w.spriteStatus,
            provisioningUpdatedAt: w.spriteUpdatedAt ?? null,
            runtime: this.runtime(w.id),
          };
        }),
    );
  }
  holdSprite(
    actor: Identity,
    eventId: string,
    id: string,
    generation: number,
    deletion?: { org: string; apiOrigin: string },
  ) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    const workspace = this.provisioningRecords().find(
      (w) => w.id === id && w.eventId === eventId && w.spriteName,
    );
    if (!workspace) return fail("Sprite not found", 404);
    const runtime = this.runtime(id);
    if (runtime.generation !== generation)
      return fail("This Sprite changed. Refresh status before trying again.", 409);
    if (
      deletion &&
      runtime.deletion &&
      (runtime.deletion.org !== deletion.org || runtime.deletion.apiOrigin !== deletion.apiOrigin)
    )
      return fail(
        "Deletion provider changed. Restore the original provider configuration before retrying.",
        409,
      );
    if (
      !deletion &&
      runtime.deletion &&
      !(runtime.deletion.state === "deleted" && runtime.deletion.replacementReserved)
    )
      return fail("This Sprite is deleted or awaiting deletion. Refresh status.", 409);
    if (deletion && runtime.deletion?.state === "deleted" && !runtime.deletion.replacementReserved)
      return fail("This Sprite is already deleted.", 409);
    this.setRuntime(id, {
      held: true,
      reason: "admin",
      generation: generation + 1,
      stopState: deletion ? null : "pending",
      stopError: null,
      ...(deletion
        ? {
            deletion: {
              ...deletion,
              state: "pending",
              replacementReserved: false,
              error: null,
              changedAt: new Date().toISOString(),
            },
          }
        : {}),
    });
    return ok(workspace);
  }
  holdSprites(actor: Identity, eventId: string) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    const workspaces = this.provisioningRecords().filter(
      (w) =>
        w.eventId === eventId &&
        w.spriteName &&
        (!this.runtime(w.id).deletion ||
          (this.runtime(w.id).deletion?.state === "deleted" &&
            this.runtime(w.id).deletion?.replacementReserved)),
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const w of workspaces)
        this.setRuntime(w.id, {
          held: true,
          generation: this.runtime(w.id).generation + 1,
          reason: "admin",
          stopState: "pending",
          stopError: null,
        });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return ok(workspaces);
  }
  wakeWorkspace(actor: Identity, id: string) {
    const workspace = this.workspace(actor, id, true, true);
    if (!workspace.ok) return workspace;
    const runtime = this.runtime(id);
    if (runtime.deletion && runtime.deletion.state !== "deleted")
      return fail("Sprite deletion needs to finish. Ask an event admin to retry.", 423);
    if (runtime.stopState === "pending")
      return fail("Sprite pause is still in progress. Retry shortly.", 423);
    this.setRuntime(id, {
      held: false,
      reason: null,
      generation: runtime.generation + (runtime.held ? 1 : 0),
      lastUsedAt: new Date().toISOString(),
    });
    return workspace;
  }
  close() {
    this.engine.close();
    this.db.close();
  }
  private save() {
    const body = JSON.stringify(this.state);
    try {
      this.db
        .prepare(
          "INSERT INTO access_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        )
        .run(body);
      this.persistedState = body;
    } catch (error) {
      // ENOSPC/SQLITE_FULL cannot leave an uncommitted role, binding or event
      // mutation visible in memory. Roll back to the last durable snapshot.
      this.state = JSON.parse(this.persistedState) as AccessState;
      throw error;
    }
  }
  private remember(actor: Identity) {
    const user = identitySchema.parse(actor);
    const index = this.state.users.findIndex((u) => u.id === user.id);
    if (index < 0) {
      this.state.users.push(user);
      this.save();
    } else if (JSON.stringify(this.state.users[index]) !== JSON.stringify(user)) {
      this.state.users[index] = user;
      this.save();
    }
  }
  isAdmin(actor: Identity, eventId: string) {
    return this.state.eventMembers.some(
      (m) => m.eventId === eventId && m.userId === actor.id && m.role === "admin",
    );
  }
  private canDiscover(actor: Identity, event: Event) {
    return (
      this.state.eventMembers.some((m) => m.eventId === event.id) &&
      (event.status === "registration" ||
        event.status === "live" ||
        this.state.eventMembers.some((m) => m.eventId === event.id && m.userId === actor.id))
    );
  }
  private canJoin(actor: Identity, eventId: string): Result<Event> {
    const event = this.engine.snapshot().events.find((e) => e.id === eventId);
    if (!event || !this.canDiscover(actor, event)) return fail("Event not found", 404);
    if (this.execution(eventId).paused) return fail(PAUSED_MESSAGE, 423);
    if (event.status === "closed" || (event.status === "draft" && !this.isAdmin(actor, eventId)))
      return fail("This event is not open for joining", 409);
    const active = new Set(
      this.state.memberships.filter((m) => m.eventId === eventId && m.active).map((m) => m.userId),
    );
    if (!active.has(actor.id) && active.size >= event.capacity)
      return fail("This event is at capacity", 409);
    return ok(event);
  }
  // Public installation context exposes only a discoverable title, never event data.
  siteEvent(eventId: string, actor: Identity | null) {
    const event = this.engine.snapshot().events.find((e) => e.id === eventId);
    if (!event || !this.state.eventMembers.some((m) => m.eventId === eventId))
      return fail("The configured site event was not found. Check CIVIC_SPARK_SITE_EVENT_ID.", 503);
    const publicEvent = event.status === "registration" || event.status === "live";
    return ok({
      id: event.id,
      name: publicEvent || (actor && this.canDiscover(actor, event)) ? event.name : null,
    });
  }
  portal(actor: Identity, sprites: boolean, siteEventId?: string): PortalState {
    this.remember(actor);
    const data = this.engine.snapshot();
    data.teams = data.teams.filter((t) => !t.deletedAt);
    const visibleTeamIds = new Set(data.teams.map((t) => t.id));
    const events = data.events.filter(
      (e) => (!siteEventId || e.id === siteEventId) && this.canDiscover(actor, e),
    );
    const eventIds = new Set(events.map((e) => e.id));
    const active = this.state.memberships.filter(
      (m) => m.active && eventIds.has(m.eventId) && visibleTeamIds.has(m.teamId),
    );
    const my = active.filter((m) => m.userId === actor.id);
    const teamIds = new Set(my.map((m) => m.teamId));
    return {
      user: actor,
      events: events.map((e) => ({
        ...e,
        execution: this.execution(e.id),
        role:
          this.state.eventMembers.find((m) => m.eventId === e.id && m.userId === actor.id)?.role ??
          "visitor",
      })),
      teams: data.teams
        .filter((t) => eventIds.has(t.eventId))
        .map((t) => ({
          ...t,
          memberNames: active
            .filter((m) => m.teamId === t.id)
            .map((m) => this.state.users.find((u) => u.id === m.userId)?.name ?? "Member"),
          memberCount: active.filter((m) => m.teamId === t.id).length,
          joined: teamIds.has(t.id),
          projectName:
            events.find((e) => e.id === t.eventId)?.projects.find((p) => p.id === t.projectId)
              ?.name ?? "Project",
          projectBrief:
            events.find((e) => e.id === t.eventId)?.projects.find((p) => p.id === t.projectId)
              ?.description ?? "",
        })),
      members: this.state.eventMembers
        .filter(
          (m) =>
            eventIds.has(m.eventId) && (m.userId === actor.id || this.isAdmin(actor, m.eventId)),
        )
        .map((m) => {
          const user = this.state.users.find((u) => u.id === m.userId);
          return {
            ...m,
            name: user?.name ?? "Member",
            email: user?.email,
            teamIds: active
              .filter((a) => a.eventId === m.eventId && a.userId === m.userId)
              .map((a) => a.teamId),
          };
        }),
      myWorkspaces: my.flatMap((m) => {
        const p = data.participants.find((p) => p.id === m.id);
        return p
          ? [
              {
                ...p,
                runtime: this.runtime(p.id),
                name: actor.name,
                userId: actor.id,
                teamName: data.teams.find((t) => t.id === m.teamId)?.name ?? "Team",
              },
            ]
          : [];
      }),
      contributions: data.contributions.filter(
        (c) =>
          eventIds.has(c.eventId) &&
          visibleTeamIds.has(c.teamId) &&
          (teamIds.has(c.teamId) || this.isAdmin(actor, c.eventId)),
      ),
      activity: data.activity.filter(
        (a) => eventIds.has(a.eventId) && this.isAdmin(actor, a.eventId),
      ),
      templates,
      capabilities: { sprites },
    };
  }
  createEvent(actor: Identity, input: EventInput) {
    this.remember(actor);
    const created = this.engine.createEvent(input);
    if (!created.ok) return created;
    this.state.eventMembers.push({ eventId: created.value.id, userId: actor.id, role: "admin" });
    this.save();
    return created;
  }
  updateEvent(actor: Identity, eventId: string, input: EventSettingsInput) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    const parsed = eventSettingsSchema.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(". "));
    const event = this.engine.snapshot().events.find((e) => e.id === eventId);
    if (!event) return fail("Event not found", 404);
    // Legacy freeform labels are editable. Reject newly introduced malformed clock labels.
    for (const row of parsed.data.schedule) {
      const time = row.time.trim();
      if (
        /^\d{1,2}:/.test(time) &&
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) &&
        !event.schedule.some((old) => old.id === row.id && old.time === row.time)
      )
        return fail("Use a 24-hour schedule time (HH:mm) or a descriptive label");
    }
    const active = new Set(
      this.state.memberships.filter((m) => m.eventId === eventId && m.active).map((m) => m.userId),
    );
    if (parsed.data.capacity < active.size && parsed.data.capacity < event.capacity)
      return fail(`Capacity cannot be reduced below the ${active.size} current participants`, 409);
    return this.engine.updateEvent(eventId, parsed.data);
  }
  transition(actor: Identity, eventId: string, status: Event["status"]) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    return this.engine.transition(eventId, status);
  }
  addAdmin(actor: Identity, eventId: string, email: string) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    const user = this.state.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user)
      return fail(
        "This person needs to sign in to Civic Spark first, using this email address",
        404,
      );
    const existing = this.state.eventMembers.find(
      (m) => m.eventId === eventId && m.userId === user.id,
    );
    if (existing) existing.role = "admin";
    else this.state.eventMembers.push({ eventId, userId: user.id, role: "admin" });
    this.save();
    return ok({ userId: user.id, role: "admin" as const });
  }
  setRole(actor: Identity, eventId: string, userId: string, role: "admin" | "member") {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    const member = this.state.eventMembers.find(
      (m) => m.eventId === eventId && m.userId === userId,
    );
    if (!member) return fail("This person must join the event first", 404);
    if (
      member.role === "admin" &&
      role === "member" &&
      this.state.eventMembers.filter((m) => m.eventId === eventId && m.role === "admin").length ===
        1
    )
      return fail("An event must retain at least one admin", 409);
    member.role = role;
    this.save();
    return ok(member);
  }
  createTeam(actor: Identity, input: TeamInput) {
    const parsed = teamInputSchema.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(". "));
    const allowed = this.canJoin(actor, input.eventId);
    if (!allowed.ok) return allowed;
    this.remember(actor);
    let projectId = input.projectId;
    if (input.customProject) {
      const project = this.engine.addProject(
        input.eventId,
        input.customProject.name,
        input.customProject.brief,
      );
      if (!project.ok) return project;
      projectId = project.value;
    }
    if (!projectId) return fail("Choose a project");
    const team = this.engine.createTeam(input.eventId, input.name, projectId);
    if (!team.ok) return team;
    const joined = this.joinTeam(actor, team.value.id);
    if (!joined.ok) return joined;
    return ok({ team: team.value, workspace: joined.value });
  }
  createProject(actor: Identity, eventId: string, input: ProjectInput) {
    const event = this.engine.snapshot().events.find((event) => event.id === eventId);
    if (!event || !this.canDiscover(actor, event)) return fail("Event not found", 404);
    if (event.status === "draft" && !this.isAdmin(actor, eventId))
      return fail("Event admin access required", 403);
    const parsed = projectInputSchema.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(". "));
    if (event.status === "closed")
      return fail("This event has ended. Projects are read-only.", 409);
    if (event.projects.some((p) => p.name.toLowerCase() === parsed.data.name.toLowerCase()))
      return fail("A project with this name already exists in this event", 409);
    const created = this.engine.addProject(eventId, parsed.data.name, parsed.data.brief);
    return created.ok ? ok({ id: created.value }) : created;
  }
  updateProject(actor: Identity, eventId: string, projectId: string, input: ProjectUpdate) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    const parsed = projectUpdateSchema.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(". "));
    const event = this.engine.snapshot().events.find((e) => e.id === eventId);
    if (!event) return fail("Event not found", 404);
    if (event.status === "closed")
      return fail("This event has ended. Projects are read-only.", 409);
    return this.engine.updateProject(
      eventId,
      projectId,
      parsed.data.name,
      parsed.data.brief,
      parsed.data.expectedRevision,
    );
  }
  joinTeam(actor: Identity, teamId: string): Result<Workspace> {
    const team = this.engine.snapshot().teams.find((t) => t.id === teamId && !t.deletedAt);
    if (!team) return fail("Team not found", 404);
    const allowed = this.canJoin(actor, team.eventId);
    if (!allowed.ok) return allowed;
    this.remember(actor);
    const existing = this.state.memberships.find(
      (m) => m.teamId === teamId && m.userId === actor.id,
    );
    if (existing) {
      existing.active = true;
      if (!this.state.eventMembers.some((m) => m.eventId === team.eventId && m.userId === actor.id))
        this.state.eventMembers.push({ eventId: team.eventId, userId: actor.id, role: "member" });
      this.save();
      return this.workspace(actor, existing.id);
    }
    const created = this.engine.addParticipant(teamId, actor.name, true);
    if (!created.ok) return created;
    this.state.memberships.push({
      id: created.value.id,
      eventId: team.eventId,
      teamId,
      userId: actor.id,
      active: true,
      joinedAt: new Date().toISOString(),
    });
    if (!this.state.eventMembers.some((m) => m.eventId === team.eventId && m.userId === actor.id))
      this.state.eventMembers.push({ eventId: team.eventId, userId: actor.id, role: "member" });
    this.save();
    return this.workspace(actor, created.value.id);
  }
  removeMember(actor: Identity, teamId: string, userId: string) {
    const m = this.state.memberships.find(
      (m) => m.teamId === teamId && m.userId === userId && m.active,
    );
    if (!m) return fail("Membership not found", 404);
    if (!this.isAdmin(actor, m.eventId)) return fail("Event admin access required", 403);
    m.active = false;
    this.save();
    return ok({ removed: true, workPreserved: true });
  }
  workspace(actor: Identity, id: string, write = false, waking = false): Result<Workspace> {
    const m = this.state.memberships.find((m) => m.id === id && m.userId === actor.id && m.active);
    if (!m) return fail("Workspace not found", 404);
    const data = this.engine.snapshot();
    if (!data.teams.some((t) => t.id === m.teamId && !t.deletedAt))
      return fail("Workspace not found", 404);
    const p = data.participants.find((p) => p.id === id);
    if (!p) return fail("Workspace not found", 404);
    if (write && this.execution(m.eventId).paused) return fail(PAUSED_MESSAGE, 423);
    if (write && !waking && this.runtime(id).held) return fail(HELD_MESSAGE, 423);
    if (write && data.events.find((e) => e.id === m.eventId)?.status === "closed")
      return fail("This event has ended. The workspace is read-only.", 409);
    return ok({
      ...p,
      runtime: this.runtime(p.id),
      userId: actor.id,
      name: actor.name,
      teamName: data.teams.find((t) => t.id === m.teamId)?.name ?? "Team",
    });
  }
  files(actor: Identity, id: string) {
    const p = this.workspace(actor, id);
    return p.ok ? this.engine.files(id) : p;
  }
  readFile(actor: Identity, id: string, path: string) {
    const p = this.workspace(actor, id);
    return p.ok ? this.engine.readFile(id, path) : p;
  }
  saveFile(actor: Identity, id: string, path: string, content: string, revision: string) {
    const p = this.workspace(actor, id, true);
    return p.ok ? this.engine.saveFile(id, path, content, revision) : p;
  }
  propose(actor: Identity, id: string, title: string) {
    const p = this.workspace(actor, id, true);
    return p.ok ? this.engine.propose(id, title) : p;
  }
  teamReference(actor: Identity, id: string, write = false) {
    const p = this.workspace(actor, id, write);
    if (!p.ok) return p;
    try {
      const repo = this.engine.repoPath(p.value.teamId);
      return ok({
        workspace: p.value,
        repo,
        remote: git(repo, ["rev-parse", "main"]).toString().trim(),
      });
    } catch {
      return fail("The team repository is unavailable.", 503);
    }
  }
  async teamReferenceAsync(actor: Identity, id: string, write = false) {
    const p = this.workspace(actor, id, write);
    if (!p.ok) return p;
    try {
      const repo = this.engine.repoPath(p.value.teamId);
      const remote = (await gitAsync(repo, ["rev-parse", "main"])).toString().trim();
      const fresh = this.workspace(actor, id, write);
      return fresh.ok ? ok({ workspace: fresh.value, repo, remote }) : fresh;
    } catch {
      return fail("The team repository is unavailable.", 503);
    }
  }
  localTeamStatus(actor: Identity, id: string, remote: string) {
    const p = this.workspace(actor, id);
    if (!p.ok) return p;
    if (p.value.spriteStatus !== "local") return fail("Use the Sprite Git adapter", 409);
    try {
      return ok(teamStatus(this.workspacePath(id), remote));
    } catch {
      return fail("The workspace Git status is unavailable.", 409);
    }
  }
  localTeamUpdate(actor: Identity, id: string, input: TeamUpdate, bundle: string) {
    const p = this.teamReference(actor, id, true);
    if (!p.ok) return p;
    if (p.value.workspace.spriteStatus !== "local") return fail("Use the Sprite Git adapter", 409);
    if (p.value.remote !== input.remote)
      return fail("The team repository changed since the preview. Check for updates again.", 409);
    try {
      importTeamBundle(this.workspacePath(id), bundle, input.remote);
      return ok(applyTeamUpdate(this.workspacePath(id), input));
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "The team update failed. Your work is preserved.",
        409,
      );
    }
  }
  verifyLocalTeamUpdate(actor: Identity, id: string, head: string, remote: string) {
    const p = this.workspace(actor, id, true);
    if (!p.ok) return p;
    if (p.value.spriteStatus !== "local") return fail("Use the Sprite Git adapter", 409);
    try {
      return ok(verifyTeamUpdate(this.workspacePath(id), head, remote));
    } catch (error) {
      return fail(error instanceof Error ? error.message : "The merge is not complete yet.", 409);
    }
  }
  shareLocal(actor: Identity, id: string, title: string, revision: string) {
    const p = this.workspace(actor, id, true);
    return p.ok ? this.engine.shareLocal(id, title, revision) : p;
  }
  async shareLocalAsync(
    actor: Identity,
    id: string,
    title: string,
    revision: string,
    authorized: () => Promise<boolean> = async () => true,
  ) {
    const access = this.workspace(actor, id, true);
    if (!access.ok) return access;
    if (access.value.spriteStatus !== "local") return fail("Use the Sprite Git adapter", 409);
    try {
      const source = this.workspacePath(id);
      const prepared = await gitJob({ operation: "commit", root: source, title, revision });
      if (!prepared.commit) throw new Error("Incomplete local Git commit");
      const result = await this.publishSnapshotAsync(
        actor,
        id,
        title,
        revision,
        source,
        prepared.commit,
        authorized,
      );
      if (result.ok)
        await gitAsync(source, ["update-ref", "refs/civic-spark/base", prepared.commit]);
      return result;
    } catch {
      return fail("Sharing could not complete. Your local commit is preserved; retry Share.", 503);
    }
  }
  publishSnapshotAsync(
    actor: Identity,
    id: string,
    title: string,
    revision: string,
    source: string,
    commit: string,
    authorized: () => Promise<boolean> = async () => true,
  ) {
    return this.engine.publishPrepared(id, title, revision, source, commit, async () => {
      if (!(await authorized()))
        return fail("Sign in again before sharing. Your local commit is preserved.", 401);
      return this.workspace(actor, id, true);
    });
  }
  publishSnapshot(
    actor: Identity,
    id: string,
    title: string,
    revision: string,
    source: string,
    commit: string,
  ) {
    const p = this.workspace(actor, id, true);
    return p.ok ? this.engine.publishSnapshot(id, title, revision, source, commit) : p;
  }
  sync(actor: Identity, id: string) {
    const p = this.workspace(actor, id, true);
    return p.ok ? this.engine.sync(id) : p;
  }
  accept(actor: Identity, id: string) {
    const c = this.engine.snapshot().contributions.find((c) => c.id === id);
    if (!c || !this.canReadTeam(actor, c.teamId)) return fail("Contribution not found", 404);
    if (this.execution(c.eventId).paused) return fail(PAUSED_MESSAGE, 423);
    return this.engine.accept(id);
  }
  private canReadTeam(actor: Identity, id: string) {
    const team = this.engine.snapshot().teams.find((t) => t.id === id && !t.deletedAt);
    return Boolean(
      team &&
        (this.isAdmin(actor, team.eventId) ||
          this.state.memberships.some((m) => m.teamId === id && m.userId === actor.id && m.active)),
    );
  }
  exportTeam(actor: Identity, id: string) {
    return this.canReadTeam(actor, id) ? this.engine.exportTeam(id) : fail("Team not found", 404);
  }
  removeEventMember(actor: Identity, eventId: string, userId: string) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    const member = this.state.eventMembers.find(
      (m) => m.eventId === eventId && m.userId === userId,
    );
    if (!member) return fail("Event member not found", 404);
    if (
      member.role === "admin" &&
      this.state.eventMembers.filter((m) => m.eventId === eventId && m.role === "admin").length ===
        1
    )
      return fail("An event must retain at least one admin", 409);
    this.state.eventMembers = this.state.eventMembers.filter((m) => m !== member);
    for (const m of this.state.memberships)
      if (m.eventId === eventId && m.userId === userId) m.active = false;
    this.save();
    return ok({ removed: true, workPreserved: true });
  }
  private adminTeam(actor: Identity, id: string) {
    const team = this.engine.snapshot().teams.find((t) => t.id === id && !t.deletedAt);
    if (!team) return fail("Team not found", 404);
    if (!this.isAdmin(actor, team.eventId)) return fail("Event admin access required", 403);
    return ok(team);
  }
  deleteTeam(actor: Identity, id: string) {
    const team = this.adminTeam(actor, id);
    if (!team.ok) return team;
    const deleted = this.engine.deleteTeam(id);
    if (!deleted.ok) return deleted;
    for (const m of this.state.memberships) if (m.teamId === id) m.active = false;
    this.save();
    return deleted;
  }
  copyTeam(actor: Identity, id: string, name: string) {
    const team = this.adminTeam(actor, id);
    return team.ok ? this.engine.copyTeam(id, name) : team;
  }
  repositoryHistory(actor: Identity, id: string, input: z.input<typeof historyQuerySchema>) {
    if (!this.canReadTeam(actor, id)) return fail("Team not found", 404);
    try {
      return ok(repositoryHistory(this.engine.repoPath(id), input));
    } catch {
      return fail("Repository history is unavailable. Refresh and try again.", 409);
    }
  }
  repositoryVersion(actor: Identity, id: string, commit: string) {
    if (!this.canReadTeam(actor, id)) return fail("Team not found", 404);
    try {
      return ok(repositoryVersion(this.engine.repoPath(id), commit));
    } catch {
      return fail("Shared commit not found or too large to browse.", 404);
    }
  }
  repositoryFile(actor: Identity, id: string, commit: string, path: string) {
    if (!this.canReadTeam(actor, id)) return fail("Team not found", 404);
    try {
      return ok(repositoryFile(this.engine.repoPath(id), commit, path));
    } catch {
      return fail("File preview unavailable. It may be excluded or too large.", 404);
    }
  }
  restoreRepository(actor: Identity, id: string, input: z.input<typeof restoreInputSchema>) {
    const team = this.adminTeam(actor, id);
    if (!team.ok) return team;
    try {
      return ok(restoreRepository(this.engine.repoPath(id), input, actor));
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "Restore failed. Refresh and try again.",
        409,
      );
    }
  }
  restoreRepositoryFile(
    actor: Identity,
    id: string,
    input: z.input<typeof restoreFileInputSchema>,
  ) {
    const team = this.adminTeam(actor, id);
    if (!team.ok) return team;
    try {
      return ok(restoreRepositoryFile(this.engine.repoPath(id), input, actor));
    } catch (error) {
      return fail(
        error instanceof Error ? error.message : "File restore failed. Refresh and try again.",
        409,
      );
    }
  }
  workspaceFiles(
    actor: Identity,
    id: string,
    operation: "manifest" | "read" | "mutate" | "changes",
    input?: string | FileMutation,
  ) {
    const p = this.workspace(actor, id, operation === "mutate");
    if (!p.ok) return p;
    if (p.value.spriteStatus !== "local") return fail("Use the Sprite file adapter", 409);
    try {
      const files = new WorkspaceFiles(this.workspacePath(id));
      if (operation === "manifest") return ok(files.manifest());
      if (operation === "changes") return ok(files.changes());
      if (operation === "read" && typeof input === "string") return ok(files.read(input));
      if (operation === "mutate" && input && typeof input !== "string")
        return ok(files.mutate(input));
      return fail("Invalid file operation");
    } catch (e) {
      return fail(e instanceof Error ? e.message : "File operation failed", 409);
    }
  }
  // Internal provisioning methods; callers must authorize with workspace() first.
  initialCreation(id: string) {
    return this.engine.initialCreation(id);
  }
  reserveInitialCreation(id: string, name: string, binding: SpriteProviderBinding) {
    return this.engine.reserveInitialCreation(id, name, binding);
  }
  workspacePath(id: string) {
    return this.engine.workspacePath(id);
  }
  setSprite(
    id: string,
    name: string,
    status: Workspace["spriteStatus"],
    error: string | null,
    phase?: Workspace["spritePhase"],
    creationFailure?: Workspace["spriteCreationFailure"],
  ) {
    return this.engine.setSprite(id, name, status, error, phase, creationFailure);
  }
}
