import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  type TeamInput,
  teamInputSchema,
  type Workspace,
} from "./access-types.ts";
import { templates, WorkspaceEngine } from "./engine.ts";
import { type Event, type EventInput, fail, ok, type Result } from "./types.ts";

export { templates } from "./engine.ts";

// Every user-facing operation requires the verified session actor. The Git engine
// is an internal storage implementation, never a route exposed to the browser.
export class EventService {
  private engine: WorkspaceEngine;
  private db: DatabaseSync;
  private state: AccessState;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.engine = new WorkspaceEngine(root);
    this.db = new DatabaseSync(join(root, "access.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS access_state(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)",
    );
    const row = this.db.prepare("SELECT body FROM access_state WHERE id=1").get();
    this.state = row
      ? accessStateSchema.parse(JSON.parse(String(row.body)))
      : { version: 1, users: [], eventMembers: [], memberships: [] };
  }
  close() {
    this.engine.close();
    this.db.close();
  }
  private save() {
    this.db
      .prepare(
        "INSERT INTO access_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(JSON.stringify(this.state));
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
    if (event.status === "closed" || (event.status === "draft" && !this.isAdmin(actor, eventId)))
      return fail("This event is not open for joining", 409);
    const active = new Set(
      this.state.memberships.filter((m) => m.eventId === eventId && m.active).map((m) => m.userId),
    );
    if (!active.has(actor.id) && active.size >= event.capacity)
      return fail("This event is at capacity", 409);
    return ok(event);
  }
  portal(actor: Identity, sprites: boolean): PortalState {
    this.remember(actor);
    const data = this.engine.snapshot();
    const events = data.events.filter((e) => this.canDiscover(actor, e));
    const eventIds = new Set(events.map((e) => e.id));
    const active = this.state.memberships.filter((m) => m.active && eventIds.has(m.eventId));
    const my = active.filter((m) => m.userId === actor.id);
    const teamIds = new Set(my.map((m) => m.teamId));
    return {
      user: actor,
      events: events.map((e) => ({
        ...e,
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
                name: actor.name,
                userId: actor.id,
                teamName: data.teams.find((t) => t.id === m.teamId)?.name ?? "Team",
              },
            ]
          : [];
      }),
      contributions: data.contributions.filter(
        (c) => teamIds.has(c.teamId) || this.isAdmin(actor, c.eventId),
      ),
      activity: data.activity.filter((a) => this.isAdmin(actor, a.eventId)),
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
  transition(actor: Identity, eventId: string, status: Event["status"]) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    return this.engine.transition(eventId, status);
  }
  addAdmin(actor: Identity, eventId: string, email: string) {
    if (!this.isAdmin(actor, eventId)) return fail("Event admin access required", 403);
    const user = this.state.users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
    if (!user)
      return fail("This person needs to sign in to VibeHack first, using this email address", 404);
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
  joinTeam(actor: Identity, teamId: string): Result<Workspace> {
    const team = this.engine.snapshot().teams.find((t) => t.id === teamId);
    if (!team) return fail("Team not found", 404);
    const allowed = this.canJoin(actor, team.eventId);
    if (!allowed.ok) return allowed;
    this.remember(actor);
    const existing = this.state.memberships.find(
      (m) => m.teamId === teamId && m.userId === actor.id,
    );
    if (existing) {
      existing.active = true;
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
  workspace(actor: Identity, id: string, write = false): Result<Workspace> {
    const m = this.state.memberships.find((m) => m.id === id && m.userId === actor.id && m.active);
    if (!m) return fail("Workspace not found", 404);
    const data = this.engine.snapshot();
    const p = data.participants.find((p) => p.id === id);
    if (!p) return fail("Workspace not found", 404);
    if (write && data.events.find((e) => e.id === m.eventId)?.status === "closed")
      return fail("This event has ended. The workspace is read-only.", 409);
    return ok({
      ...p,
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
    return this.engine.accept(id);
  }
  private canReadTeam(actor: Identity, id: string) {
    const team = this.engine.snapshot().teams.find((t) => t.id === id);
    return Boolean(
      team &&
        (this.isAdmin(actor, team.eventId) ||
          this.state.memberships.some((m) => m.teamId === id && m.userId === actor.id && m.active)),
    );
  }
  exportTeam(actor: Identity, id: string) {
    return this.canReadTeam(actor, id) ? this.engine.exportTeam(id) : fail("Team not found", 404);
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
  workspacePath(id: string) {
    return this.engine.workspacePath(id);
  }
  setSprite(
    id: string,
    name: string,
    status: Workspace["spriteStatus"],
    error: string | null,
    phase?: Workspace["spritePhase"],
  ) {
    return this.engine.setSprite(id, name, status, error, phase);
  }
}
