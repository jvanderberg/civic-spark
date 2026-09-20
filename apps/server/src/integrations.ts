import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Identity } from "../../../packages/domain/src/access-types.ts";
import type { EventService } from "../../../packages/domain/src/service.ts";
import type { Result } from "../../../packages/domain/src/types.ts";
import { gitAsync } from "../../../packages/git/src/async.ts";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";
import { type ChangeNotifier, silentNotifier } from "./events.ts";
import {
  type IntegrationRequest,
  type IntegrationResponse,
  IntegrationRunner,
  integrationRequestSchema,
} from "./relay/integration-runner.ts";

export type IntegrationEvents = {
  /** One validated request from the in-Sprite CLI. */
  request(request: IntegrationRequest): void;
  /** The relay process is gone (exit, spawn failure or relay worker loss); called once. */
  ended(): void;
};
/** One relay.py child as seen by the integration manager, wherever its process lives. */
export interface IntegrationHandle {
  readonly ended: boolean;
  /** Answer one request by id; dropped once the relay ended. */
  respond(id: string, response: IntegrationResponse): void;
  stop(): void;
}
export interface IntegrationBackend {
  start(id: string, sprite: string, events: IntegrationEvents): IntegrationHandle;
}
/** Spawns and reads relay.py in this process. */
export const localIntegrationBackend: IntegrationBackend = {
  start(_id, sprite, events) {
    const runner = new IntegrationRunner(sprite, events);
    return {
      get ended() {
        return runner.ended;
      },
      respond: (id, response) => runner.respond(id, response),
      stop: () => runner.stop(),
    };
  },
};
export type IntegrationOptions = {
  backend?: IntegrationBackend;
  /**
   * Whether an agent or terminal session currently exists for a workspace.
   * When given, the relay child runs only while one does (plus a grace
   * period) and `wake` starts it when a session begins; without it the child
   * runs from `ensure` until `stop`.
   */
  inUse?: (id: string) => boolean;
};
const pendingSchema = z.object({
  id: z.uuid(),
  owner: z.string(),
  head: z.string().regex(/^[a-f0-9]{40}$/),
  remote: z.string().regex(/^[a-f0-9]{40}$/),
  conflicts: z.array(z.string()),
  status: z.enum(["confirmation", "resolving", "declined"]),
  backup: z.string().optional(),
});
type Pending = z.infer<typeof pendingSchema>;
/**
 * One prepared workspace: who may use the relay and which Sprite and
 * generation it was prepared for. `handle` is the running child, if any.
 */
type Relay = {
  owner: Identity;
  sprite: string;
  generation: number;
  authorized: () => Promise<boolean>;
  handle?: IntegrationHandle;
  /** When the last agent or terminal session was seen gone, while a child runs. */
  idleSince?: number;
  timer: NodeJS.Timeout;
};
function unwrap<T>(value: Result<T>): T {
  if (!value.ok) throw new Error(value.error);
  return value.value;
}

export class WorkspaceIntegrations {
  /** Authorization, generation and idle re-check period per prepared workspace. */
  static checkIntervalMs = 15000;
  /** How long a relay child outlives the last agent or terminal session (checked per interval). */
  static idleGraceMs = 30000;
  private relays = new Map<string, Relay>();
  private directory: string;
  private backend: IntegrationBackend;
  constructor(
    private service: EventService,
    root: string,
    private busy: Set<string>,
    private client = new SpriteClient(),
    private notify: ChangeNotifier = silentNotifier,
    private options: IntegrationOptions = {},
  ) {
    this.directory = join(root, "agent-integrations");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.backend = options.backend ?? localIntegrationBackend;
  }
  private path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid workspace");
    return join(this.directory, `${id}.json`);
  }
  pending(id: string, owner: Identity) {
    unwrap(this.service.workspace(owner, id, true));
    const path = this.path(id);
    if (!existsSync(path)) return null;
    const saved = pendingSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (saved.owner !== owner.id) throw new Error("Workspace access ended");
    const { owner: _owner, ...value } = saved;
    return value;
  }
  private save(id: string, pending: Pending) {
    writeFileSync(this.path(id), JSON.stringify(pending), { mode: 0o600 });
    this.notify.changed(id, "agent-git");
  }
  private clear(id: string) {
    rmSync(this.path(id), { force: true });
    this.notify.changed(id, "agent-git");
  }
  /**
   * Register a prepared workspace so the in-Sprite `civic-spark` CLI can reach
   * the host. Without `inUse`, the relay child starts now and runs until
   * `stop`; with it, the child starts when an agent or terminal session exists
   * (`wake`) and ends a grace period after the last one is gone. A changed
   * Sprite or generation replaces the registration.
   */
  ensure(id: string, owner: Identity, sprite: string, authorized: () => Promise<boolean>) {
    const access = this.service.executionAllowed(id);
    if (!access.ok) throw new Error(access.error);
    const generation = this.service.runtime(id).generation;
    let relay = this.relays.get(id);
    if (relay && (relay.sprite !== sprite || relay.generation !== generation)) {
      this.stop(id);
      relay = undefined;
    }
    if (relay) relay.authorized = authorized;
    else {
      relay = {
        owner,
        sprite,
        generation,
        authorized,
        timer: setInterval(() => this.check(id), WorkspaceIntegrations.checkIntervalMs),
      };
      this.relays.set(id, relay);
    }
    if (!this.options.inUse || this.options.inUse(id)) this.start(id, relay);
  }
  /** An agent or terminal session began: start the relay child of a prepared workspace. */
  wake(id: string) {
    const relay = this.relays.get(id);
    if (!relay || (relay.handle && !relay.handle.ended)) return;
    if (
      this.service.runtime(id).generation !== relay.generation ||
      !this.service.executionAllowed(id).ok
    ) {
      this.stop(id);
      return;
    }
    this.start(id, relay);
  }
  /** A relay child is running for the workspace. */
  active(id: string) {
    const handle = this.relays.get(id)?.handle;
    return Boolean(handle && !handle.ended);
  }
  private start(id: string, relay: Relay) {
    if (relay.handle && !relay.handle.ended) return;
    relay.idleSince = undefined;
    const lease = this.client.lease(relay.sprite, true);
    let handle: IntegrationHandle | undefined;
    let ended = false;
    const abort = () => handle?.stop();
    let queued = Promise.resolve();
    try {
      handle = this.backend.start(id, relay.sprite, {
        request: (request) => {
          const current = handle;
          if (!current) return;
          queued = queued
            .then(() => this.answer(id, relay, current, request))
            .catch(() => {
              /* One failed request must not stop later requests. */
            });
        },
        ended: () => {
          ended = true;
          lease?.signal.removeEventListener("abort", abort);
          lease?.release();
          if (handle && relay.handle === handle) relay.handle = undefined;
        },
      });
    } catch {
      lease?.release();
      return;
    }
    if (ended) {
      lease?.release();
      return;
    }
    relay.handle = handle;
    lease?.signal.addEventListener("abort", abort, { once: true });
  }
  private async answer(
    id: string,
    relay: Relay,
    handle: IntegrationHandle,
    request: IntegrationRequest,
  ) {
    const { owner, sprite } = relay;
    let response: IntegrationResponse;
    let operation: ReturnType<SpriteClient["lease"]>;
    try {
      // Re-validate on the main side: the worker already filtered lines, but
      // authorization and ticket state are decided only here.
      const input = integrationRequestSchema.parse(request);
      if (
        !(await relay.authorized()) ||
        this.relays.get(id) !== relay ||
        relay.handle !== handle ||
        this.service.runtime(id).generation !== relay.generation
      )
        throw new Error("Workspace access ended. Sign in again.");
      operation = this.client.lease(sprite);
      unwrap(this.service.workspace(owner, id, true));
      if (input.operation === "git-publish")
        response = { ok: true, value: await this.publish(id, owner, relay.authorized) };
      else if (input.operation === "git-fetch")
        response = { ok: true, value: await this.fetch(id, owner, relay.authorized) };
      else if (input.operation === "git-status")
        response = {
          ok: true,
          value: {
            pending: this.pending(id, owner),
            instructions:
              "If conflict resolution is pending, the participant must approve in the workspace top bar. Once resolving is approved, resolve conflicts, git add the resolved paths, and GIT_EDITOR=true git rebase --continue. Summarize the resolved result and ask for explicit publication confirmation before civic-spark git publish. Conflict approval alone does not authorize publication.",
          },
        };
      else
        response = {
          ok: true,
          value: await this.preview(
            id,
            owner,
            input.operation.slice(8) as "start" | "restart" | "stop" | "status" | "logs",
            input.port && input.command ? { port: input.port, command: input.command } : undefined,
            relay.authorized,
          ),
        };
    } catch (error) {
      response = {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Integration failed; your saved work is preserved.",
      };
    } finally {
      operation?.release();
    }
    handle.respond(request.id, response);
  }
  // Every interval: lost authorization or a changed generation ends the
  // registration; with `inUse`, a child whose sessions are all gone ends after
  // the grace period while the registration stays for the next `wake`.
  private check(id: string) {
    const relay = this.relays.get(id);
    if (!relay) return;
    if (this.service.runtime(id).generation !== relay.generation) {
      this.stop(id);
      return;
    }
    void relay
      .authorized()
      .then((ok) => {
        if (!ok && this.relays.get(id) === relay) this.stop(id);
      })
      .catch(() => {
        if (this.relays.get(id) === relay) this.stop(id);
      });
    if (!this.options.inUse || !relay.handle || relay.handle.ended) return;
    if (this.options.inUse(id)) relay.idleSince = undefined;
    else {
      relay.idleSince ??= Date.now();
      if (Date.now() - relay.idleSince >= WorkspaceIntegrations.idleGraceMs) {
        relay.handle.stop();
        relay.handle = undefined;
      }
    }
  }
  async preview(
    id: string,
    owner: Identity,
    operation: "start" | "restart" | "stop" | "status" | "logs",
    config?: { port: number; command: string[] },
    authorized: () => Promise<boolean> = async () => true,
  ) {
    unwrap(this.service.executionAllowed(id));
    const workspace = unwrap(this.service.workspace(owner, id, true));
    if (workspace.spriteStatus !== "ready" || !workspace.spriteName)
      throw new Error("Web preview needs a running Sprite.");
    const sprite = workspace.spriteName;
    const generation = this.service.runtime(id).generation;
    const validate = async () => {
      if (!(await authorized())) throw new Error("Workspace access ended.");
      const current = unwrap(this.service.workspace(owner, id, true));
      unwrap(this.service.executionAllowed(id));
      if (
        current.spriteName !== sprite ||
        current.spriteStatus !== "ready" ||
        this.service.runtime(id).generation !== generation
      )
        throw new Error("Workspace changed. Retry the preview action.");
    };
    await validate();
    let cancellation: Promise<unknown> | undefined;
    let checking = false;
    let monitoring = true;
    const launching = ["start", "restart"].includes(operation);
    // Browser and agent CLI launches both pass here, so every tab learns that a
    // launch began and, later, how it ended.
    if (launching || operation === "stop") this.notify.changed(id, "preview");
    const cancel = () => {
      if (!monitoring) return;
      cancellation ??= this.client.preview(sprite, "stop").catch(() => undefined);
    };
    // Only an explicit, in-flight launch owns this check. Polling never starts work.
    const monitor = launching
      ? setInterval(() => {
          if (checking || cancellation) return;
          checking = true;
          void validate()
            .catch(cancel)
            .finally(() => {
              checking = false;
            });
        }, 250)
      : undefined;
    try {
      const previewHost = launching
        ? new URL(unwrap(await this.client.previewUrl(sprite, "inspect")).url).hostname
        : undefined;
      await validate();
      const result = unwrap(await this.client.preview(sprite, operation, config, previewHost));
      await validate();
      if (launching && result.ready)
        unwrap(await this.client.previewUrl(sprite, "publish", validate));
      await validate();
      return result;
    } catch (error) {
      // A failed URL update is retryable with the same prepared service. Lost access drains it.
      if (launching) {
        try {
          await validate();
        } catch {
          cancel();
        }
      }
      throw error;
    } finally {
      monitoring = false;
      clearInterval(monitor);
      await cancellation;
      if (launching || operation === "stop") this.notify.changed(id, "preview");
    }
  }
  async openPreview(id: string, owner: Identity, authorized: () => Promise<boolean>) {
    unwrap(this.service.executionAllowed(id));
    const workspace = unwrap(this.service.workspace(owner, id, true));
    if (!workspace.spriteName) throw new Error("Web preview needs a running Sprite.");
    const sprite = workspace.spriteName;
    const generation = this.service.runtime(id).generation;
    const validate = async () => {
      if (!(await authorized())) throw new Error("Workspace access ended.");
      const current = unwrap(this.service.workspace(owner, id, true));
      unwrap(this.service.executionAllowed(id));
      if (current.spriteName !== sprite || this.service.runtime(id).generation !== generation)
        throw new Error("Workspace changed. Retry Open preview.");
    };
    await validate();
    const status = await this.preview(id, owner, "status", undefined, authorized);
    if (!status.ready)
      throw new Error("The web server is not ready. Launch it or inspect its logs.");
    await validate();
    const result = unwrap(await this.client.previewUrl(sprite));
    await validate();
    return result;
  }

  private async fetched(id: string, owner: Identity) {
    const team = unwrap(await this.service.teamReferenceAsync(owner, id, true));
    if (team.workspace.spriteStatus !== "ready" || !team.workspace.spriteName)
      throw new Error("Agent publishing needs a running Sprite.");
    const sprite = team.workspace.spriteName;
    const temp = mkdtempSync(join(tmpdir(), "civic-spark-agent-fetch-"));
    try {
      const bundle = join(temp, "team.bundle");
      await gitAsync(team.repo, ["bundle", "create", bundle, "main"]);
      if (statSync(bundle).size > 10 * 1024 * 1024)
        throw new Error("Compressed team update exceeds 10 MiB.");
      unwrap(await this.client.importTeam(sprite, bundle, team.remote));
      const fresh = unwrap(await this.service.teamReferenceAsync(owner, id, true));
      if (fresh.remote !== team.remote)
        throw new Error("Team changed during fetch. Retry publication.");
      return { sprite, remote: team.remote };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  // Import the team's current branch into the Sprite without touching the
  // checkout, so the agent can review teammates' published work on request.
  async fetch(id: string, owner: Identity, authorized: () => Promise<boolean>) {
    if (this.busy.has(id))
      throw new Error("A Git operation is already running. Retry when it finishes.");
    this.busy.add(id);
    try {
      if (!(await authorized())) throw new Error("Workspace access ended.");
      const { remote } = await this.fetched(id, owner);
      return {
        status: "fetched",
        remote,
        ref: "refs/civic-spark/team-incoming",
        instructions:
          "The team branch is now at refs/civic-spark/team-incoming; your files are unchanged. Review it with git log HEAD..refs/civic-spark/team-incoming and git diff HEAD...refs/civic-spark/team-incoming. Merge it locally only when the participant asks. Publishing still needs explicit confirmation and civic-spark git publish.",
      };
    } finally {
      this.busy.delete(id);
    }
  }
  async publish(id: string, owner: Identity, authorized: () => Promise<boolean>) {
    if (this.busy.has(id))
      throw new Error("A Git operation is already running. Retry when it finishes.");
    this.busy.add(id);
    let temp: string | undefined;
    try {
      if (!(await authorized())) throw new Error("Workspace access ended.");
      const saved = this.pending(id, owner);
      if (saved?.status === "confirmation")
        return {
          status: "confirmation",
          request: saved,
          instructions:
            "Paused before changing your checkout. The participant must approve conflict resolution in the Civic Spark top bar. Do not start the rebase or resolve conflicts before approval. After approval, use civic-spark git status and continue.",
        };
      if (saved?.status === "declined")
        throw new Error(
          "The participant declined conflict resolution. Discuss next steps; do not rebase or publish automatically.",
        );
      const { sprite, remote } = await this.fetched(id, owner);
      const inspected = unwrap(await this.client.agentGit(sprite, { operation: "head" }));
      if (!inspected.head) throw new Error("Missing native Git head");
      const result = unwrap(
        await this.client.agentGit(sprite, { operation: "rebase", head: inspected.head, remote }),
      );
      if (result.status === "confirmation") {
        const pending: Pending = {
          id: randomUUID(),
          owner: owner.id,
          head: inspected.head,
          remote,
          conflicts: result.conflicts ?? [],
          status: "confirmation",
        };
        this.save(id, pending);
        return {
          status: "confirmation",
          request: { ...pending, owner: undefined },
          instructions:
            "Conflicts need the participant's confirmation in the workspace top bar. The original checkout is unchanged. After approval, use civic-spark git status, then resolve and continue the rebase. Summarize the resolved changes and ask for explicit publication confirmation before publishing again.",
        };
      }
      if (!result.head) throw new Error("Missing rebased Git head");
      if (!(await authorized()))
        throw new Error("Workspace access ended. Local commit remains saved.");
      const exported = unwrap(
        await this.client.agentGit(sprite, { operation: "export", head: result.head }),
      );
      if (
        !exported.bundle ||
        !exported.ref ||
        !exported.commit ||
        !exported.revision ||
        !exported.title
      )
        throw new Error("Invalid Git export");
      temp = mkdtempSync(join(tmpdir(), "civic-spark-agent-push-"));
      const bundle = join(temp, "contribution.bundle");
      const data = Buffer.from(exported.bundle, "base64");
      if (
        data.length > 10 * 1024 * 1024 ||
        data.toString("base64") !== exported.bundle ||
        !/^refs\/civic-spark\/share\/[a-f0-9]{64}$/.test(exported.ref)
      )
        throw new Error("Invalid Git bundle");
      writeFileSync(bundle, data, { mode: 0o600 });
      const repo = join(temp, "repository.git");
      await gitAsync(temp, ["init", "--bare", repo]);
      await gitAsync(repo, ["bundle", "verify", bundle]);
      await gitAsync(repo, ["fetch", bundle, `${exported.ref}:refs/heads/incoming`]);
      const commit = (await gitAsync(repo, ["rev-parse", "refs/heads/incoming"])).toString().trim();
      if (commit !== exported.commit || !(await authorized()))
        throw new Error("Git publication changed or access ended.");
      unwrap(
        await this.service.publishSnapshotAsync(
          owner,
          id,
          exported.title,
          exported.revision,
          repo,
          commit,
          authorized,
        ),
      );
      const acknowledged = await this.client.acknowledgeShare(sprite, exported.revision, commit);
      this.clear(id);
      this.notify.changed(id, "files");
      this.notify.shared(id);
      return {
        status: "published",
        commit,
        notice: acknowledged.ok
          ? undefined
          : "Published; the Changes baseline will refresh on reconnect.",
      };
    } finally {
      this.busy.delete(id);
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
  }
  async confirm(id: string, owner: Identity, ticket: string, allow: boolean) {
    const pending = this.pending(id, owner);
    if (!pending || pending.id !== ticket || pending.status !== "confirmation")
      throw new Error("This conflict request is no longer pending.");
    if (!allow) {
      this.save(id, { ...pending, owner: owner.id, status: "declined" });
      return { status: "declined" };
    }
    if (this.busy.has(id)) throw new Error("A Git operation is already running.");
    this.busy.add(id);
    try {
      const { sprite, remote } = await this.fetched(id, owner);
      if (remote !== pending.remote) {
        this.clear(id);
        throw new Error(
          "Team changes advanced. Ask the agent to publish again for a fresh conflict preview.",
        );
      }
      const result = unwrap(
        await this.client.agentGit(sprite, {
          operation: "rebase",
          head: pending.head,
          remote,
          confirmed: true,
        }),
      );
      this.save(id, { ...pending, owner: owner.id, status: "resolving", backup: result.backup });
      this.notify.changed(id, "files");
      return {
        ...result,
        instructions:
          "Conflict resolution approved. Ask your agent to run civic-spark git status, resolve the pending rebase, run checks and publish.",
      };
    } finally {
      this.busy.delete(id);
    }
  }
  /** Lifecycle disconnect, hold or shutdown: end the child and forget the registration. */
  stop(id: string) {
    const relay = this.relays.get(id);
    if (relay) {
      clearInterval(relay.timer);
      relay.handle?.stop();
      relay.handle = undefined;
      this.relays.delete(id);
    }
  }
  close() {
    for (const id of this.relays.keys()) this.stop(id);
  }
}
