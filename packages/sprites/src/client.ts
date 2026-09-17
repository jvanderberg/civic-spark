import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import {
  type SpriteCreationFailure,
  spriteCreationMessages,
} from "../../domain/src/provisioning.ts";
import type { FileContent, Result } from "../../domain/src/types.ts";
import { fail, ok } from "../../domain/src/types.ts";
import {
  type TeamUpdate,
  teamStatusSchema,
  teamUpdateResultSchema,
} from "../../workspace/src/team-git.ts";
import {
  BLOB_BODY_LIMIT,
  blobSchema,
  changesSchema,
  type FileMutation,
  manifestSchema,
  TEXT_BODY_LIMIT,
} from "../../workspace/src/types.ts";
import { CommandBusy, CommandQueue } from "./command-queue.ts";
import { validateSpriteToken } from "./credentials.ts";
import { boundedProviderJson, classifyCreationFailure } from "./provisioning.ts";

const execute = promisify(execFile);
const spriteNamePattern = /^civic-spark-[a-z0-9-]{1,45}$/;
export type SpriteLease = { signal: AbortSignal; release(): void };
export type SpriteCreateResult = Result<string> & { creationFailure?: SpriteCreationFailure };
export class SpriteClient {
  private commands = new CommandQueue(
    z.coerce
      .number()
      .int()
      .min(1)
      .max(64)
      .parse(process.env.CIVIC_SPARK_MAX_COMMANDS ?? "16"),
  );
  private reads = new Map<string, Promise<Result<unknown>>>();
  private transfers = new CommandQueue(2);
  constructor(
    private org = process.env.CIVIC_SPARK_SPRITE_ORG,
    private acquire?: (name: string, passive?: boolean) => SpriteLease,
    private request: typeof fetch = fetch,
  ) {}
  /** Provider metadata only: no guessed hostname or browser-visible organization token. */
  async previewUrl(
    name: string,
    access: "public" | "publish" | "inspect" = "public",
    beforePublish?: () => Promise<void>,
  ): Promise<Result<{ url: string }>> {
    if (!spriteNamePattern.test(name)) return fail("Invalid workspace name");
    let lease: SpriteLease | undefined;
    let release: (() => void) | undefined;
    try {
      lease = this.lease(name);
      release = await this.commands.acquire(lease?.signal);
      const token = process.env.SPRITE_TOKEN;
      if (!token) throw Error();
      const base = new URL(process.env.CIVIC_SPARK_SPRITE_API_URL ?? "https://api.sprites.dev");
      if (
        base.protocol !== "https:" ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== "/"
      )
        throw Error();
      const endpoint = new URL(`/v1/sprites/${name}`, base);
      const call = async (method: "GET" | "PUT") => {
        const response = await this.request(endpoint, {
          method,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(method === "PUT"
            ? { body: JSON.stringify({ url_settings: { auth: "public" } }) }
            : {}),
          redirect: "error",
          signal: AbortSignal.any([AbortSignal.timeout(15000), ...(lease ? [lease.signal] : [])]),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error();
        }
        const body = await response.text();
        if (body.length > 65536) throw Error();
        return z
          .object({
            name: z.literal(name),
            url: z.url(),
            url_settings: z.object({ auth: z.enum(["public", "sprite"]) }),
          })
          .parse(JSON.parse(body));
      };
      let metadata = await call("GET");
      if (access === "publish" && metadata.url_settings.auth !== "public") {
        await beforePublish?.();
        lease?.signal.throwIfAborted();
        metadata = await call("PUT");
      }
      const url = new URL(metadata.url);
      if (
        (access !== "inspect" && metadata.url_settings.auth !== "public") ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !/^[a-z0-9-]+\.sprites\.app$/.test(url.hostname)
      )
        throw Error();
      return ok({ url: url.origin });
    } catch {
      return fail(
        "Public preview URL unavailable. Retry Launch after checking Sprite access.",
        502,
      );
    } finally {
      release?.();
      lease?.release();
    }
  }
  lease(name: string, passive = false): SpriteLease | undefined {
    return this.acquire?.(name, passive);
  }
  private args(args: string[]) {
    return this.org ? ["-o", this.org, ...args] : args;
  }
  async command(
    args: string[],
    timeout = 120000,
    input?: string,
    maxBuffer = 16 * 1024 * 1024,
  ): Promise<Result<Buffer>> {
    let lease: SpriteLease | undefined;
    let closed: Promise<void> | undefined;
    let releaseCommand: (() => void) | undefined;
    let releaseTransfer: (() => void) | undefined;
    try {
      const name = args.includes("-s")
        ? args[args.indexOf("-s") + 1]
        : args[0] === "create"
          ? args.at(-1)
          : undefined;
      if (name) lease = this.acquire?.(name);
      if (maxBuffer > 16 * 1024 * 1024)
        releaseTransfer = await this.transfers.acquire(lease?.signal);
      releaseCommand = await this.commands.acquire(lease?.signal);
      lease?.signal.throwIfAborted();
      const pending = execute("sprite", this.args(args), {
        timeout,
        maxBuffer,
        encoding: "buffer",
        signal: lease?.signal,
      });
      closed = new Promise((resolve) => pending.child.once("close", () => resolve()));
      pending.child.stdin?.end(input);
      const { stdout } = await pending;
      return ok(stdout);
    } catch (error) {
      if (error instanceof CommandBusy) return fail(error.message, 429);
      return fail(
        "Sprite command failed. Check your CLI login and connectivity; no account credentials were logged.",
        502,
      );
    } finally {
      await closed;
      lease?.release();
      releaseCommand?.();
      releaseTransfer?.();
    }
  }
  private provisioningEndpoint(name?: string) {
    const token = validateSpriteToken(process.env.SPRITE_TOKEN, this.org);
    const base = new URL(process.env.CIVIC_SPARK_SPRITE_API_URL ?? "https://api.sprites.dev");
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/"
    )
      throw new Error("Invalid provider origin");
    return { token, url: new URL(name ? `/v1/sprites/${name}` : "/v1/sprites", base) };
  }
  /** Metadata only; a missing or uncertain reservation never authorizes creation. */
  async inspectReservation(name: string): Promise<"present" | "missing" | "unknown"> {
    if (!spriteNamePattern.test(name)) return "unknown";
    let release: (() => void) | undefined;
    try {
      const { token, url } = this.provisioningEndpoint(name);
      release = await this.commands.acquire();
      const response = await this.request(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return "missing";
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return "unknown";
      }
      const result = z
        .object({ name: z.literal(name), organization: z.literal(this.org) })
        .safeParse(await boundedProviderJson(response));
      return result.success ? "present" : "unknown";
    } catch {
      return "unknown";
    } finally {
      release?.();
    }
  }
  async create(name: string): Promise<SpriteCreateResult> {
    if (!spriteNamePattern.test(name)) return fail("Invalid Civic Spark Sprite name.");
    const failure = (kind: SpriteCreationFailure): SpriteCreateResult => ({
      ok: false,
      status: 502,
      error: spriteCreationMessages[kind],
      creationFailure: kind,
    });
    // Retain local CLI-login support. Its free-form output cannot reliably carry
    // structured provider codes, so a failure remains unknown, never guessed.
    if (!process.env.SPRITE_TOKEN) {
      try {
        const result = await this.command(["create", "--skip-console", name]);
        return result.ok ? ok(name) : failure("unknown");
      } catch {
        return failure("unknown");
      }
    }
    let endpoint: ReturnType<SpriteClient["provisioningEndpoint"]>;
    try {
      validateSpriteToken(process.env.SPRITE_TOKEN, this.org);
    } catch {
      return failure("auth");
    }
    try {
      endpoint = this.provisioningEndpoint();
    } catch {
      return failure("unknown");
    }
    let lease: SpriteLease | undefined;
    let release: (() => void) | undefined;
    let dispatched = false;
    try {
      lease = this.lease(name);
      release = await this.commands.acquire(lease?.signal);
      lease?.signal.throwIfAborted();
      // One POST, no automatic retries or fallback mutation after an uncertain response.
      dispatched = true;
      const response = await this.request(endpoint.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(120000), ...(lease ? [lease.signal] : [])]),
      });
      const body = await boundedProviderJson(response);
      if (!response.ok) return failure(classifyCreationFailure(response.status, body));
      const created = z
        .object({ name: z.literal(name), organization: z.literal(this.org) })
        .safeParse(body);
      return [200, 201].includes(response.status) && created.success
        ? ok(name)
        : failure("unknown");
    } catch {
      return failure(dispatched && !lease?.signal.aborted ? "transient" : "unknown");
    } finally {
      release?.();
      lease?.release();
    }
  }
  async uploadBundle(name: string, bundle: string): Promise<Result<Buffer>> {
    if (!spriteNamePattern.test(name)) return fail("Invalid prototype Sprite name");
    return this.command([
      "-s",
      name,
      "exec",
      "--no-port-forward",
      "--file",
      `${bundle}:/tmp/civic-spark-seed.bundle`,
      "--",
      "bash",
      "-lc",
      readFileSync(new URL("./checkout.sh", import.meta.url), "utf8"),
    ]);
  }
  async exec(name: string, args: string[], uploads: string[] = []): Promise<Result<Buffer>> {
    if (!spriteNamePattern.test(name)) return fail("Invalid prototype Sprite name");
    return this.command([
      "-s",
      name,
      "exec",
      "--no-port-forward",
      ...uploads.flatMap((file) => ["--file", file]),
      "--",
      ...args,
    ]);
  }
  private fileOperation<T>(
    name: string,
    payload: { operation: string; [key: string]: unknown },
    schema: z.ZodType<T>,
    scriptName = "files.py",
    upload?: { local: string; remote: string },
  ): Promise<Result<T>> {
    if (!upload && ["list", "changes", "manifest", "status", "logs"].includes(payload.operation)) {
      const key = JSON.stringify([name, scriptName, payload]);
      const pending = this.reads.get(key);
      if (pending) return pending as Promise<Result<T>>;
      const request = this.performFileOperation(name, payload, schema, scriptName).finally(() =>
        this.reads.delete(key),
      );
      this.reads.set(key, request);
      return request;
    }
    return this.performFileOperation(name, payload, schema, scriptName, upload);
  }
  private async performFileOperation<T>(
    name: string,
    payload: { operation: string; [key: string]: unknown },
    schema: z.ZodType<T>,
    scriptName = "files.py",
    upload?: { local: string; remote: string },
  ): Promise<Result<T>> {
    if (!spriteNamePattern.test(name)) return fail("Invalid workspace name");
    const script = readFileSync(new URL(`./${scriptName}`, import.meta.url), "utf8");
    const transferringFile = ["read", "save", "mutate"].includes(payload.operation);
    const response = await this.command(
      [
        "-s",
        name,
        "exec",
        "--no-port-forward",
        ...(upload ? ["--file", `${upload.local}:${upload.remote}`] : []),
        "--",
        "python3",
        "-c",
        script,
      ],
      scriptName === "preview.py" && ["start", "restart"].includes(payload.operation)
        ? 360000
        : transferringFile
          ? 120000
          : 30000,
      JSON.stringify(payload),
      transferringFile
        ? scriptName === "files.py"
          ? TEXT_BODY_LIMIT
          : BLOB_BODY_LIMIT
        : 16 * 1024 * 1024,
    );
    if (!response.ok) return response;
    try {
      const parsed = z
        .discriminatedUnion("ok", [
          z.object({ ok: z.literal(true), value: schema }),
          z.object({ ok: z.literal(false), error: z.string(), status: z.number() }),
        ])
        .parse(JSON.parse(response.value.toString()));
      return parsed;
    } catch {
      return fail("The workspace returned an invalid file response", 502);
    }
  }
  teamStatus(name: string, remote: string) {
    return this.fileOperation(
      name,
      { operation: "status", remote },
      teamStatusSchema,
      "team_git.py",
    );
  }
  agentGit(
    name: string,
    payload: { operation: string; head?: string; remote?: string; confirmed?: boolean },
  ) {
    return this.fileOperation(
      name,
      payload,
      z.object({
        status: z.enum(["ready", "confirmation", "resolving"]).optional(),
        head: z.string().optional(),
        remote: z.string().optional(),
        backup: z.string().optional(),
        conflicts: z.array(z.string()).optional(),
        commit: z.string().optional(),
        title: z.string().optional(),
        ref: z.string().optional(),
        revision: z.string().optional(),
        bundle: z.string().optional(),
      }),
      "agent_git.py",
    );
  }
  preview(
    name: string,
    operation: "start" | "restart" | "stop" | "status" | "logs",
    config?: { port: number; command: string[] },
    previewHost?: string,
  ) {
    return this.fileOperation(
      name,
      {
        operation,
        ...config,
        previewHost,
        defaults: JSON.parse(
          readFileSync(new URL("../../agents/runtime/environment.json", import.meta.url), "utf8"),
        ),
      },
      z.object({
        port: z.number(),
        command: z.array(z.string()),
        running: z.boolean(),
        ready: z.boolean(),
        phase: z.enum(["installing", "starting", "ready", "stopped", "error"]).optional(),
        error: z.string().optional(),
        logs: z.string().optional(),
      }),
      "preview.py",
    );
  }
  importTeam(name: string, bundle: string, remote: string) {
    const destination = `/tmp/civic-spark-team-${randomUUID()}.bundle`;
    return this.fileOperation(
      name,
      { operation: "import", remote, bundle: destination },
      z.object({ imported: z.string() }),
      "team_git.py",
      { local: bundle, remote: destination },
    );
  }
  teamUpdate(name: string, input: TeamUpdate) {
    return this.fileOperation(
      name,
      { operation: "apply", ...input },
      teamUpdateResultSchema,
      "team_git.py",
    );
  }
  verifyTeamUpdate(name: string, head: string, remote: string) {
    return this.fileOperation(
      name,
      { operation: "verify", head, remote },
      teamUpdateResultSchema,
      "team_git.py",
    );
  }
  manifest(name: string) {
    return this.fileOperation(name, { operation: "manifest" }, manifestSchema, "workspace.py");
  }
  changes(name: string) {
    return this.fileOperation(name, { operation: "changes" }, changesSchema, "workspace.py");
  }
  share(name: string, title: string, revision: string) {
    return this.fileOperation(
      name,
      { operation: "share", title, revision },
      z.object({
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        ref: z.string().regex(/^refs\/civic-spark\/share\/[a-f0-9]{64}$/),
        revision: z.string(),
        bundle: z.string().max(14 * 1024 * 1024),
      }),
      "workspace.py",
    );
  }
  adoptExistingShare(name: string, commit: string, head: string) {
    return this.fileOperation(
      name,
      { operation: "adopt-share", commit, head },
      z.object({ commit: z.string(), alreadyCompleted: z.boolean() }),
      "workspace.py",
    );
  }
  acknowledgeShare(name: string, revision: string, commit: string) {
    return this.fileOperation(
      name,
      { operation: "shared", revision, commit },
      z.object({ updated: z.boolean() }),
      "workspace.py",
    );
  }
  readBlob(name: string, path: string) {
    return this.fileOperation(name, { operation: "read", path }, blobSchema, "workspace.py");
  }
  mutateBlob(name: string, input: FileMutation) {
    return this.fileOperation(
      name,
      { operation: "mutate", ...input },
      z.object({ revision: z.string().nullable() }),
      "workspace.py",
    );
  }
  files(name: string) {
    return this.fileOperation(name, { operation: "list" }, z.array(z.string()));
  }
  readFile(name: string, path: string) {
    return this.fileOperation(
      name,
      { operation: "read", path },
      z.object({ path: z.string(), content: z.string(), revision: z.string() }),
    );
  }
  saveFile(name: string, file: FileContent) {
    return this.fileOperation(
      name,
      { operation: "save", ...file },
      z.object({ path: z.string(), content: z.string(), revision: z.string() }),
    );
  }
}
