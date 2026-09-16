import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
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
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Identity } from "../../../packages/domain/src/access-types.ts";
import type { EventService } from "../../../packages/domain/src/service.ts";
import type { Result } from "../../../packages/domain/src/types.ts";
import { git } from "../../../packages/git/src/repository.ts";
import { SpriteClient } from "../../../packages/sprites/src/client.ts";
import { WorkspacePreviews } from "./preview.ts";

const requestSchema = z.object({
  id: z.uuid(),
  operation: z.enum([
    "git-publish",
    "git-status",
    "preview-start",
    "preview-restart",
    "preview-status",
    "preview-logs",
    "preview-stop",
  ]),
  port: z.number().int().min(1024).max(65535).optional(),
  command: z.array(z.string().min(1).max(4096)).min(1).max(40).optional(),
});
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
type Relay = {
  process: ChildProcessWithoutNullStreams;
  owner: Identity;
  authorized: () => Promise<boolean>;
  timer: NodeJS.Timeout;
};
function unwrap<T>(value: Result<T>): T {
  if (!value.ok) throw new Error(value.error);
  return value.value;
}

export class WorkspaceIntegrations {
  private relays = new Map<string, Relay>();
  private directory: string;
  readonly previews: WorkspacePreviews;
  constructor(
    private service: EventService,
    root: string,
    private busy: Set<string>,
    private portal: string,
    private client = new SpriteClient(),
  ) {
    this.directory = join(root, "agent-integrations");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.previews = new WorkspacePreviews(portal);
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
  }
  ensure(id: string, owner: Identity, sprite: string, authorized: () => Promise<boolean>) {
    const old = this.relays.get(id);
    if (old) {
      old.authorized = authorized;
      return;
    }
    const child = spawn(
      "sprite",
      [
        ...(process.env.CIVIC_SPARK_SPRITE_ORG ? ["-o", process.env.CIVIC_SPARK_SPRITE_ORG] : []),
        "-s",
        sprite,
        "exec",
        "-file",
        `${fileURLToPath(new URL("../../../packages/agents/runtime/relay.py", import.meta.url))}:/home/sprite/.civic-spark-agent/relay.py`,
        "python3",
        "/home/sprite/.civic-spark-agent/relay.py",
      ],
      { stdio: "pipe" },
    );
    const relay: Relay = {
      process: child,
      owner,
      authorized,
      timer: setInterval(() => {
        void relay
          .authorized()
          .then((ok) => {
            if (!ok) this.stop(id);
          })
          .catch(() => this.stop(id));
      }, 15000),
    };
    this.relays.set(id, relay);
    child.stderr.resume();
    let queued = Promise.resolve();
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.length > 65536) return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }
      const input = requestSchema.safeParse(raw);
      if (!input.success) return;
      queued = queued
        .then(async () => {
          const request = input.data;
          let response: object;
          try {
            if (!(await relay.authorized()))
              throw new Error("Workspace access ended. Sign in again.");
            unwrap(this.service.workspace(owner, id, true));
            if (request.operation === "git-publish")
              response = { ok: true, value: await this.publish(id, owner, relay.authorized) };
            else if (request.operation === "git-status")
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
                  request.operation.slice(8) as "start" | "restart" | "stop" | "status" | "logs",
                  request.port && request.command
                    ? { port: request.port, command: request.command }
                    : undefined,
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
          }
          if (!child.stdin.destroyed)
            child.stdin.write(`${JSON.stringify({ id: request.id, ...response })}\n`);
        })
        .catch(() => {
          /* One malformed request must not stop later requests. */
        });
    });
    const ended = () => {
      if (this.relays.get(id) === relay) {
        clearInterval(relay.timer);
        this.relays.delete(id);
      }
    };
    child.on("error", ended);
    child.on("close", ended);
  }
  async preview(
    id: string,
    owner: Identity,
    operation: "start" | "restart" | "stop" | "status" | "logs",
    config?: { port: number; command: string[] },
  ) {
    const workspace = unwrap(this.service.workspace(owner, id, true));
    if (workspace.spriteStatus !== "ready" || !workspace.spriteName)
      throw new Error("Web preview needs a running Sprite.");
    const result = unwrap(await this.client.preview(workspace.spriteName, operation, config));
    unwrap(this.service.workspace(owner, id, true));
    if (operation === "stop" || operation === "restart") this.previews.stop(id);
    return result;
  }
  async openPreview(id: string, owner: Identity, authorized: () => Promise<boolean>) {
    const workspace = unwrap(this.service.workspace(owner, id, true));
    if (!workspace.spriteName) throw new Error("Web preview needs a running Sprite.");
    if (!["127.0.0.1", "localhost"].includes(new URL(this.portal).hostname))
      throw new Error("Hosted preview is not configured for this installation.");
    const status = await this.preview(id, owner, "status");
    if (!status.ready)
      throw new Error("The web server is not ready. Launch it or inspect its logs.");
    return this.previews.open(id, workspace.spriteName, status.port, authorized);
  }
  private async fetched(id: string, owner: Identity) {
    const team = unwrap(this.service.teamReference(owner, id, true));
    if (team.workspace.spriteStatus !== "ready" || !team.workspace.spriteName)
      throw new Error("Agent publishing needs a running Sprite.");
    const sprite = team.workspace.spriteName;
    const temp = mkdtempSync(join(tmpdir(), "civic-spark-agent-fetch-"));
    try {
      const bundle = join(temp, "team.bundle");
      git(team.repo, ["bundle", "create", bundle, "main"]);
      if (statSync(bundle).size > 10 * 1024 * 1024)
        throw new Error("Compressed team update exceeds 10 MiB.");
      unwrap(await this.client.importTeam(sprite, bundle, team.remote));
      const fresh = unwrap(this.service.teamReference(owner, id, true));
      if (fresh.remote !== team.remote)
        throw new Error("Team changed during fetch. Retry publication.");
      return { sprite, remote: team.remote };
    } finally {
      rmSync(temp, { recursive: true, force: true });
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
      git(temp, ["init", "--bare", repo]);
      git(repo, ["bundle", "verify", bundle]);
      git(repo, ["fetch", bundle, `${exported.ref}:refs/heads/incoming`]);
      const commit = git(repo, ["rev-parse", "refs/heads/incoming"]).toString().trim();
      if (commit !== exported.commit || !(await authorized()))
        throw new Error("Git publication changed or access ended.");
      unwrap(
        this.service.publishSnapshot(owner, id, exported.title, exported.revision, repo, commit),
      );
      const acknowledged = await this.client.acknowledgeShare(sprite, exported.revision, commit);
      rmSync(this.path(id), { force: true });
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
        rmSync(this.path(id), { force: true });
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
      return {
        ...result,
        instructions:
          "Conflict resolution approved. Ask your agent to run civic-spark git status, resolve the pending rebase, run checks and publish.",
      };
    } finally {
      this.busy.delete(id);
    }
  }
  stop(id: string) {
    const relay = this.relays.get(id);
    if (relay) {
      clearInterval(relay.timer);
      relay.process.kill();
      this.relays.delete(id);
    }
    this.previews.stop(id);
  }
  close() {
    for (const id of this.relays.keys()) this.stop(id);
    this.previews.close();
  }
}
