import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { GitQueue, gitAsync } from "../../git/src/async.ts";
import { gitJob } from "../../git/src/jobs.ts";
import {
  git,
  initializeTeam,
  listFiles,
  readText,
  revision,
  safePath,
} from "../../git/src/repository.ts";
import { commitChanges } from "../../workspace/src/share.ts";
import { FILE_LIMIT, projectPath } from "../../workspace/src/types.ts";
import {
  type InitialCreation,
  initialCreationSchema,
  type SpriteProviderBinding,
} from "./provisioning.ts";
import {
  type Contribution,
  createEventSchema,
  type Event,
  type EventInput,
  type EventSettings,
  eventSchema,
  type FileContent,
  fail,
  ok,
  type Participant,
  type Result,
  type State,
  stateSchema,
  type Team,
  type Template,
  templateSchema,
} from "./types.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const templates: Template[] = ["blank", "diod"].map((name) =>
  templateSchema.parse(
    JSON.parse(readFileSync(join(projectRoot, "templates/events", `${name}.json`), "utf8")),
  ),
);
const initialState: State = {
  version: 1,
  events: [],
  teams: [],
  participants: [],
  contributions: [],
  activity: [],
};
const stamp = () => new Date().toISOString();

export class WorkspaceEngine {
  private publications = new GitQueue();
  private db: DatabaseSync;
  private state: State;
  private persistedState = "";
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, "state.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS publication_intents (workspace TEXT NOT NULL, commit_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(workspace, commit_id))",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS initial_sprite_creation (workspace TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
    const row = this.db.prepare("SELECT body FROM state WHERE id=1").get();
    this.state = row
      ? stateSchema.parse(JSON.parse(String(row.body)))
      : structuredClone(initialState);
    this.persistedState = JSON.stringify(this.state);
    // Add only neutral fields and stable row identity; preserve every existing label/value.
    for (const event of this.state.events) {
      for (const row of event.schedule) row.id ??= randomUUID();
    }
    if (row && JSON.stringify(this.state) !== String(row.body)) this.save();
  }
  close() {
    this.db.close();
  }
  snapshot(): State {
    return structuredClone(this.state);
  }
  private save() {
    const body = JSON.stringify(this.state);
    try {
      this.db
        .prepare(
          "INSERT INTO state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        )
        .run(body);
      this.persistedState = body;
    } catch (error) {
      // ENOSPC/SQLITE_FULL cannot leave an uncommitted role, binding or event
      // mutation visible in memory. Roll back to the last durable snapshot.
      this.state = JSON.parse(this.persistedState) as State;
      throw error;
    }
  }
  private record(eventId: string, message: string) {
    this.state.activity.unshift({ id: randomUUID(), eventId, message, createdAt: stamp() });
    this.save();
  }
  private boundary<T>(action: () => Result<T>): Result<T> {
    try {
      return action();
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Operation failed", 500);
    }
  }
  createEvent(input: EventInput): Result<Event> {
    const parsed = createEventSchema.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join(". "));
    const template = templates.find((t) => t.id === parsed.data.templateId);
    if (!template) return fail("Template not found", 404);
    const event = eventSchema.parse({
      ...parsed.data,
      id: randomUUID(),
      status: "draft",
      createdAt: stamp(),
      projects: structuredClone(template.projects),
      schedule: template.schedule.map((row) => ({ ...row, id: randomUUID() })),
    });
    this.state.events.push(event);
    this.record(event.id, "Event created. Ready to make it yours.");
    return ok(event);
  }
  updateEvent(eventId: string, input: EventSettings): Result<Event> {
    const event = this.state.events.find((e) => e.id === eventId);
    if (!event) return fail("Event not found", 404);
    if (event.revision !== input.expectedRevision)
      return fail(
        "This event changed. Your draft is kept. Load the latest version before saving again.",
        409,
      );
    // Explicit editable fields only. Status, identity, template and project history stay intact.
    const { expectedRevision, ...settings } = input;
    Object.assign(event, settings, { revision: expectedRevision + 1 });
    this.save();
    return ok(structuredClone(event));
  }
  addProject(eventId: string, name: string, brief: string): Result<string> {
    const event = this.state.events.find((e) => e.id === eventId);
    if (!event) return fail("Event not found", 404);
    const id = randomUUID();
    event.projects.push({ id, name, description: brief, tags: ["Community project"] });
    this.save();
    return ok(id);
  }
  updateProject(
    eventId: string,
    projectId: string,
    name: string,
    brief: string,
    expectedRevision: number,
  ) {
    const event = this.state.events.find((e) => e.id === eventId);
    const project = event?.projects.find((p) => p.id === projectId);
    if (!project) return fail("Project not found in this event", 404);
    if ((project.revision ?? 0) !== expectedRevision)
      return fail(
        "This project changed since you opened it. Your draft is kept. Load the latest version to review it before saving again.",
        409,
      );
    if (
      event?.projects.some((p) => p.id !== projectId && p.name.toLowerCase() === name.toLowerCase())
    )
      return fail("A project with this name already exists in this event", 409);
    project.name = name;
    project.description = brief;
    project.revision = expectedRevision + 1;
    this.save();
    return ok(structuredClone(project));
  }
  transition(id: string, status: Event["status"]): Result<Event> {
    const event = this.state.events.find((e) => e.id === id);
    if (!event) return fail("Event not found", 404);
    const next: Record<Event["status"], Event["status"] | null> = {
      draft: "registration",
      registration: "live",
      live: "closed",
      closed: null,
    };
    if (next[event.status] !== status) return fail("Follow the event stages in order.", 409);
    event.status = status;
    this.record(id, `Event moved to ${status}.`);
    return ok(event);
  }
  createTeam(eventId: string, name: string, projectId: string): Result<Team> {
    return this.boundary(() => {
      const event = this.state.events.find((e) => e.id === eventId);
      if (!event) return fail("Event not found", 404);
      if (event.status === "closed") return fail("This event has ended.", 409);
      if (!event.projects.some((p) => p.id === projectId))
        return fail("Choose a project from this event.");
      if (name.trim().length < 2 || name.length > 80)
        return fail("Use a team name between 2 and 80 characters.");
      const team = {
        id: randomUUID(),
        eventId,
        number: this.state.teams.filter((t) => t.eventId === eventId).length + 1,
        name: name.trim(),
        projectId,
        createdAt: stamp(),
      };
      const project = event.projects.find((p) => p.id === projectId);
      initializeTeam(
        this.root,
        team.id,
        join(projectRoot, "templates/projects/data-starter"),
        `# ${project?.name}\n\n${project?.description}\n`,
      );
      this.state.teams.push(team);
      this.record(eventId, `Team ${team.number} · ${team.name} is ready.`);
      return ok(team);
    });
  }
  deleteTeam(id: string) {
    const team = this.state.teams.find((t) => t.id === id && !t.deletedAt);
    if (!team) return fail("Team not found", 404);
    team.deletedAt = stamp();
    this.record(team.eventId, `Deleted team ${team.name}. Repository and private work retained.`);
    return ok({ deleted: true, workPreserved: true });
  }
  copyTeam(id: string, name: string): Result<Team> {
    return this.boundary(() => {
      const source = this.state.teams.find((t) => t.id === id && !t.deletedAt);
      if (!source) return fail("Team not found", 404);
      if (this.state.events.find((e) => e.id === source.eventId)?.status === "closed")
        return fail("This event has ended.", 409);
      if (name.trim().length < 2 || name.trim().length > 80)
        return fail("Use a team name between 2 and 80 characters.");
      const team: Team = {
        id: randomUUID(),
        eventId: source.eventId,
        projectId: source.projectId,
        number: this.state.teams.filter((t) => t.eventId === source.eventId).length + 1,
        name: name.trim(),
        createdAt: stamp(),
      };
      // Copy only shared main and its ancestry, never private checkouts or other refs.
      git(this.root, ["init", "--bare", "--initial-branch=main", this.repoPath(team.id)]);
      git(this.repoPath(team.id), [
        "fetch",
        "--no-tags",
        this.repoPath(id),
        "refs/heads/main:refs/heads/main",
      ]);
      const integration = join(this.root, "integration", team.id);
      git(this.root, ["clone", this.repoPath(team.id), integration]);
      this.state.teams.push(team);
      this.record(team.eventId, `Copied ${source.name} to ${team.name}.`);
      return ok(team);
    });
  }
  addParticipant(teamId: string, name: string, capacityChecked = false): Result<Participant> {
    return this.boundary(() => {
      const team = this.state.teams.find((t) => t.id === teamId);
      const event = this.state.events.find((e) => e.id === team?.eventId);
      if (!team || !event) return fail("Team not found", 404);
      if (event.status === "closed") return fail("This event has ended.", 409);
      if (
        !capacityChecked &&
        this.state.participants.filter((p) => p.eventId === event.id).length >= event.capacity
      )
        return fail("This event is at capacity.", 409);
      if (!name.trim() || name.length > 80) return fail("Enter a name of up to 80 characters.");
      const p: Participant = {
        id: randomUUID(),
        eventId: event.id,
        teamId,
        name: name.trim(),
        createdAt: stamp(),
        spriteName: null,
        spriteStatus: "local",
        spriteError: null,
      };
      mkdirSync(dirname(this.workspacePath(p.id)), { recursive: true });
      git(this.root, ["clone", this.repoPath(teamId), this.workspacePath(p.id)]);
      git(this.workspacePath(p.id), ["switch", "-c", `participant/${p.id}`]);
      git(this.workspacePath(p.id), ["update-ref", "refs/civic-spark/base", "HEAD"]);
      this.state.participants.push(p);
      this.record(event.id, `${p.name} joined ${team.name}.`);
      return ok(p);
    });
  }
  repoPath(teamId: string) {
    return join(this.root, "repos", `${teamId}.git`);
  }
  workspacePath(id: string) {
    return join(this.root, "workspaces", id);
  }
  private localParticipant(id: string): Result<Participant> {
    const p = this.state.participants.find((p) => p.id === id);
    if (!p) return fail("Participant not found", 404);
    if (p.spriteStatus !== "local")
      return fail(
        "This workspace is on a Sprite. Local edits are disabled to prevent two conflicting copies.",
        409,
      );
    if (this.state.events.find((e) => e.id === p.eventId)?.status === "closed")
      return fail("This event has ended. The workspace is read-only.", 409);
    return ok(p);
  }
  files(id: string): Result<string[]> {
    return this.boundary(() => {
      if (!this.state.participants.some((p) => p.id === id))
        return fail("Participant not found", 404);
      return ok(listFiles(this.workspacePath(id)));
    });
  }
  readFile(id: string, name: string): Result<FileContent> {
    return this.boundary(() => {
      if (!this.state.participants.some((p) => p.id === id))
        return fail("Participant not found", 404);
      const path = safePath(this.workspacePath(id), name);
      if (!path) return fail("File unavailable", 404);
      const content = readText(path);
      return ok({ path: name, content, revision: revision(content) });
    });
  }
  saveFile(id: string, name: string, content: string, previous: string): Result<FileContent> {
    return this.boundary(() => {
      const p = this.localParticipant(id);
      if (!p.ok) return p;
      const current = this.readFile(id, name);
      if (!current.ok) return current;
      if (current.value.revision !== previous)
        return fail(
          "This file changed since you opened it. Reload it before saving; your text has been kept in the editor.",
          409,
        );
      if (Buffer.byteLength(content) > FILE_LIMIT)
        return fail("File exceeds the 25 MiB editor limit.", 413);
      const path = safePath(this.workspacePath(id), name);
      if (!path) return fail("File unavailable", 404);
      writeFileSync(path, content);
      return ok({ path: name, content, revision: revision(content) });
    });
  }
  propose(id: string, title: string): Result<Contribution> {
    return this.boundary(() => {
      const p = this.localParticipant(id);
      if (!p.ok) return p;
      const dir = this.workspacePath(id);
      git(dir, ["add", "--all"]);
      if (git(dir, ["status", "--porcelain"]).toString().trim()) git(dir, ["commit", "-m", title]);
      const commit = git(dir, ["rev-parse", "HEAD"]).toString().trim();
      const main = git(this.repoPath(p.value.teamId), ["rev-parse", "main"]).toString().trim();
      git(dir, ["fetch", "origin", "main"]);
      const diff = git(dir, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        `${main}...${commit}`,
      ]).toString();
      if (!diff) return fail("There are no new changes to share.", 409);
      if (this.state.contributions.some((c) => c.teamId === p.value.teamId && c.commit === commit))
        return fail("These changes have already been shared.", 409);
      const contribution: Contribution = {
        id: randomUUID(),
        eventId: p.value.eventId,
        teamId: p.value.teamId,
        participantId: id,
        title: title.trim().slice(0, 160) || "Project update",
        commit,
        status: "review",
        createdAt: stamp(),
        diff,
      };
      git(dir, ["push", "origin", `${commit}:refs/heads/contribution/${contribution.id}`]);
      this.state.contributions.push(contribution);
      this.record(p.value.eventId, `${p.value.name} shared “${contribution.title}”.`);
      return ok(contribution);
    });
  }
  shareLocal(id: string, title: string, revision: string): Result<Contribution> {
    return this.boundary(() => {
      const p = this.localParticipant(id);
      if (!p.ok) return p;
      const prior = this.state.contributions.find(
        (c) => c.participantId === id && c.previewRevision === revision && c.status === "accepted",
      );
      if (prior) {
        git(this.workspacePath(id), ["update-ref", "refs/civic-spark/base", prior.commit]);
        return ok(prior);
      }
      const snapshot = commitChanges(this.workspacePath(id), title, revision);
      const result = this.publishSnapshot(
        id,
        title,
        revision,
        this.workspacePath(id),
        snapshot.commit,
      );
      if (result.ok)
        git(this.workspacePath(id), ["update-ref", "refs/civic-spark/base", snapshot.commit]);
      return result;
    });
  }
  // source is a trusted local checkout/quarantine repository, never a browser-provided URL.
  async publishPrepared(
    id: string,
    title: string,
    revision: string,
    source: string,
    commit: string,
    authorize: () => Promise<Result<unknown>>,
  ): Promise<Result<Contribution>> {
    const participant = this.state.participants.find((p) => p.id === id);
    if (!participant) return fail("Workspace not found", 404);
    const p = structuredClone(participant);
    return this.publications
      .run(p.teamId, async () => {
        try {
          const initial = await authorize();
          if (!initial.ok) return initial;
          const prior = this.state.contributions.find(
            (c) => c.participantId === id && c.commit === commit && c.status === "accepted",
          );
          if (prior) return ok(structuredClone(prior));
          const repo = this.repoPath(p.teamId);
          const row = this.db
            .prepare("SELECT body FROM publication_intents WHERE workspace=? AND commit_id=?")
            .get(id, commit);
          let intent: { main: string; contribution: Contribution };
          if (row) intent = JSON.parse(String(row.body)) as typeof intent;
          else {
            const contributionId = randomUUID();
            const prepared = await gitJob({
              operation: "prepare",
              source,
              repo,
              commit,
              ref: `refs/civic-spark/prepared/${contributionId}`,
            });
            const access = await authorize();
            if (!access.ok) return access;
            if (!prepared.main || !prepared.diff) throw new Error("Incomplete Git preparation");
            intent = {
              main: prepared.main,
              contribution: {
                id: contributionId,
                eventId: p.eventId,
                teamId: p.teamId,
                participantId: id,
                title,
                commit,
                previewRevision: revision,
                status: "accepted",
                createdAt: stamp(),
                diff: prepared.diff,
              },
            };
            // Durable intent precedes publication. Restart never resumes it automatically.
            this.db
              .prepare("INSERT INTO publication_intents(workspace,commit_id,body) VALUES(?,?,?)")
              .run(id, commit, JSON.stringify(intent));
          }
          const current = (await gitAsync(repo, ["rev-parse", "main"])).toString().trim();
          let alreadyPublished = current === commit;
          if (!alreadyPublished && current !== intent.main) {
            try {
              await gitAsync(repo, ["merge-base", "--is-ancestor", commit, current]);
              alreadyPublished = true;
            } catch {
              /* Diverged, never force or rewrite. */
            }
          }
          const access = await authorize(); // Immediately before the asynchronous compare-and-swap.
          if (!access.ok) return access;
          if (!alreadyPublished) {
            if (current !== intent.main)
              return fail(
                "Your local commit is saved, but the team repository changed. Get team updates before sharing again.",
                409,
              );
            try {
              await gitAsync(repo, ["update-ref", "refs/heads/main", commit, intent.main]);
            } catch {
              // A transport/process failure is uncertain, not permission to repeat a write.
              const observed = (await gitAsync(repo, ["rev-parse", "main"])).toString().trim();
              if (observed !== commit)
                return fail(
                  "Publication could not be confirmed. Your local commit is saved; retry Share to inspect the recorded outcome.",
                  503,
                );
            }
          }
          // The Git commit is durable even if metadata storage fails. Keep the intent
          // so an explicit retry can reconcile it without re-publishing or rewriting.
          const contribution = intent.contribution;
          this.state.contributions.push(contribution);
          this.record(p.eventId, `${p.name} shared “${contribution.title}”.`);
          this.db
            .prepare("DELETE FROM publication_intents WHERE workspace=? AND commit_id=?")
            .run(id, commit);
          await gitAsync(repo, [
            "update-ref",
            "-d",
            `refs/civic-spark/prepared/${contribution.id}`,
            commit,
          ]).catch(() => {});
          return ok(structuredClone(contribution));
        } catch (error) {
          return fail(
            error instanceof Error
              ? error.message
              : "Sharing could not complete; your local commit is preserved.",
            409,
          );
        }
      })
      .catch(() => fail("Git is busy. Retry shortly; your local commit is preserved.", 503));
  }

  publishSnapshot(
    id: string,
    title: string,
    revision: string,
    source: string,
    commit: string,
  ): Result<Contribution> {
    return this.boundary(() => {
      const p = this.state.participants.find((p) => p.id === id);
      if (!p) return fail("Workspace not found", 404);
      if (this.state.events.find((e) => e.id === p.eventId)?.status === "closed")
        return fail("This event has ended.", 409);
      const previous = this.state.contributions.find(
        (c) => c.participantId === id && c.commit === commit && c.status === "accepted",
      );
      if (previous) return ok(previous);
      const repo = this.repoPath(p.teamId);
      const main = git(repo, ["rev-parse", "main"]).toString().trim();
      git(source, ["fetch", repo, "main"]);
      const base = git(source, ["merge-base", main, commit]).toString().trim();
      if (base !== main)
        return fail(
          "Your local commit is saved, but the team repository has newer changes. Update your workspace from the team repository, resolve any conflicts, then Share again.",
          409,
        );

      const privateEntries = new Map<string, string>();
      for (const entry of git(source, ["ls-tree", "-rz", main]).toString().split("\0")) {
        const tab = entry.indexOf("\t");
        if (tab >= 0 && !projectPath(entry.slice(tab + 1)))
          privateEntries.set(entry.slice(tab + 1), entry.slice(0, tab));
      }
      const incoming = git(source, ["rev-list", "--max-count=501", commit, "--not", main])
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      if (incoming.length > 500)
        return fail("Contribution history exceeds 500 commits. Your files are preserved.", 409);
      for (const revision of incoming) {
        for (const entry of git(source, ["ls-tree", "-rz", revision]).toString().split("\0")) {
          const tab = entry.indexOf("\t");
          if (tab < 0) continue;
          const path = entry.slice(tab + 1);
          if (
            (!projectPath(path) && privateEntries.get(path) !== entry.slice(0, tab)) ||
            entry.startsWith("120000") ||
            entry.startsWith("160000")
          )
            return fail(
              "The contribution history includes excluded files or links. Your private workspace is preserved.",
              409,
            );
        }
      }

      for (const path of git(source, ["diff", "--name-only", "-z", base, commit])
        .toString()
        .split("\0")
        .filter(Boolean)) {
        if (!projectPath(path))
          return fail(
            "The committed history includes excluded files. Remove them from the contribution before sharing.",
            409,
          );
      }
      let diff = git(source, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
        `${main}...${commit}`,
      ]).toString();
      if (commit === main) return fail("There are no new changes to share.", 409);
      if (!diff) diff = "Commit history updated; no file content changes.";
      const existing = this.state.contributions.find(
        (c) => c.participantId === id && c.commit === commit,
      );
      const contribution: Contribution = {
        id: existing?.id ?? randomUUID(),
        eventId: p.eventId,
        teamId: p.teamId,
        participantId: id,
        title,
        commit,
        previewRevision: revision,
        status: "accepted",
        createdAt: stamp(),
        diff,
      };
      git(source, ["push", repo, `${commit}:refs/heads/contribution/${contribution.id}`]);
      git(repo, ["update-ref", "refs/heads/main", commit, main]);
      if (existing)
        this.state.contributions[this.state.contributions.indexOf(existing)] = contribution;
      else this.state.contributions.push(contribution);
      this.record(p.eventId, `${p.name} shared “${title}”.`);
      return ok(contribution);
    });
  }
  accept(id: string): Result<Contribution> {
    return this.boundary(() => {
      const c = this.state.contributions.find((c) => c.id === id);
      if (!c) return fail("Contribution not found", 404);
      if (this.state.events.find((e) => e.id === c.eventId)?.status === "closed")
        return fail("This event has ended.", 409);
      if (c.status === "accepted") return fail("Already accepted", 409);
      const dir = join(this.root, "integration", c.teamId);
      git(dir, ["fetch", "origin"]);
      git(dir, ["reset", "--hard", "origin/main"]);
      try {
        git(dir, ["merge", "--no-ff", "-m", c.title, c.commit]);
      } catch {
        git(dir, ["reset", "--hard", "origin/main"]);
        c.status = "conflict";
        this.save();
        return fail(
          "Sharing stopped because your changes overlap with the team version. The shared version is unchanged and your files are preserved. Resolve the overlap, then Share again.",
          409,
        );
      }
      git(dir, ["push", "origin", "main"]);
      c.status = "accepted";
      this.record(c.eventId, `Accepted “${c.title}” into the team version.`);
      return ok(c);
    });
  }
  sync(id: string): Result<string> {
    return this.boundary(() => {
      const p = this.localParticipant(id);
      if (!p.ok) return p;
      const dir = this.workspacePath(id);
      if (git(dir, ["status", "--porcelain"]).toString().trim())
        return fail("Share your saved changes before getting team updates.", 409);
      git(dir, ["fetch", "origin", "main"]);
      try {
        git(dir, ["merge", "--no-edit", "origin/main"]);
      } catch {
        git(dir, ["merge", "--abort"]);
        return fail("Your changes overlap with team updates. Your version is preserved.", 409);
      }
      git(dir, ["update-ref", "refs/civic-spark/base", "origin/main"]);
      return ok("Workspace updated to include the team version.");
    });
  }
  teamFile(id: string, path: string) {
    return git(this.repoPath(id), ["show", `main:${path}`]).toString();
  }
  exportTeam(id: string): Result<Buffer> {
    return this.boundary(() => {
      if (!this.state.teams.some((t) => t.id === id)) return fail("Team not found", 404);
      return ok(git(this.repoPath(id), ["archive", "--format=zip", "--prefix=project/", "main"]));
    });
  }
  initialCreation(id: string): InitialCreation | null {
    const row = this.db
      .prepare("SELECT body FROM initial_sprite_creation WHERE workspace=?")
      .get(id);
    return row ? initialCreationSchema.parse(JSON.parse(String(row.body))) : null;
  }
  reserveInitialCreation(id: string, name: string, binding: SpriteProviderBinding) {
    const p = this.state.participants.find((p) => p.id === id);
    if (!p || p.spriteName !== null || p.spriteStatus !== "local" || name !== `civic-spark-${id}`)
      throw new Error("Initial creation requires a never-reserved workspace.");
    const next = initialCreationSchema.parse({ name, ...binding, state: "creating" });
    const existing = this.initialCreation(id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(next))
      throw new Error("Initial creation provider binding changed.");
    this.db
      .prepare("INSERT OR IGNORE INTO initial_sprite_creation(workspace,body) VALUES(?,?)")
      .run(id, JSON.stringify(next));
  }
  setSprite(
    id: string,
    name: string,
    status: Participant["spriteStatus"],
    error: string | null,
    phase?: Participant["spritePhase"],
    creationFailure?: Participant["spriteCreationFailure"],
  ): Result<Participant> {
    const p = this.state.participants.find((p) => p.id === id);
    if (!p) return fail("Participant not found", 404);
    // An irreversible barrier precedes any checkout/private-work access. A crash
    // between this write and the phase write must deny recreation, never reopen it.
    if (status === "ready" || (phase && ["checkout", "verifying", "ready"].includes(phase))) {
      const initial = this.initialCreation(id);
      if (initial?.state === "creating")
        this.db
          .prepare("UPDATE initial_sprite_creation SET body=? WHERE workspace=?")
          .run(JSON.stringify({ ...initial, state: "sealed" }), id);
    }
    const nextFailure =
      status === "ready"
        ? null
        : creationFailure
          ? (p.spriteCreationFailure ?? creationFailure)
          : p.spriteCreationFailure;
    const nextPhase = phase ?? (status === "ready" ? "ready" : (p.spritePhase ?? null));
    // A repeated observation is not a new transition. Keep the last transition's
    // timestamp/activity and avoid rewriting the whole state for the same phase.
    if (
      p.spriteName === name &&
      p.spriteStatus === status &&
      p.spriteError === error &&
      p.spritePhase === nextPhase &&
      p.spriteCreationFailure === nextFailure
    )
      return ok(p);
    p.spriteName = name;
    p.spriteStatus = status;
    p.spriteError = error;
    // Phase updates and retries must not erase or rewrite the original cause.
    // Legacy records remain unknown; only a newly observed create failure sets it.
    p.spriteCreationFailure = nextFailure;
    p.spritePhase = nextPhase;
    p.spriteUpdatedAt = stamp();
    this.record(p.eventId, `${p.name} · Sprite ${status}.`);
    return ok(p);
  }
}
