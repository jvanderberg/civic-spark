import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
import {
  commandFailure,
  type DiagnosticRecord,
  diagnostic,
  diagnosticContext,
  helperDiagnosticSchema,
  operationLabels,
  spriteWorkspaceId,
} from "../../diagnostics/src/index.ts";
import {
  type SpriteCreationFailure,
  type SpriteProviderBinding,
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
import {
  logSpriteCreate,
  observeSpriteCreate,
  type SpriteCreateLogger,
} from "./create-diagnostics.ts";
import { validateSpriteToken } from "./credentials.ts";
import { HelperSession, HelperSessionLost, type HelperSessionOptions } from "./helper-session.ts";
import {
  certifiesSpriteResource,
  listWitnessesTarget,
  resourceAgreesWithWitness,
  type SpriteOrganizationList,
  spriteMembershipPath,
  spriteOrganizationListSchema,
  spriteResourceCandidateSchema,
} from "./metadata.ts";
import { boundedProviderJson, classifyCreationFailure } from "./provisioning.ts";

const execute = promisify(execFile);
const spriteNamePattern = /^civic-spark-[a-z0-9-]{1,45}$/;
const commandFailed =
  "Sprite command failed. Check your CLI login and connectivity; no account credentials were logged.";
/** Read-only helper operations a long-lived session may serve; everything else stays one-shot. */
const sessionReads = new Set([
  "files.py:list",
  "files.py:read",
  "workspace.py:manifest",
  "workspace.py:changes",
  "workspace.py:read",
  "preview.py:status",
  "preview.py:logs",
  "team_git.py:status",
]);
const helperSources = new Map<string, string>();
function helperSource(name: string) {
  let source = helperSources.get(name);
  if (source === undefined) {
    source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    helperSources.set(name, source);
  }
  return source;
}
export type SpriteLease = { signal: AbortSignal; release(): void };
export type HelperSessionSettings = Omit<HelperSessionOptions, "scripts"> & {
  retryMs: number;
  pingAfterMs: number;
};
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
  private org: string | undefined;
  private readonly usesConfiguredOrg: boolean;
  private sessions = new Map<string, HelperSession>();
  private sessionStarts = new Map<string, Promise<HelperSession | undefined>>();
  // A session starts only for a Sprite that has answered a real one-shot command
  // in this process, so unreachable Sprites never get a long-lived process.
  private sessionReachable = new Set<string>();
  private sessionRetryAt = new Map<string, number>();
  private readonly sessionOptions: HelperSessionSettings;
  constructor(
    org?: string,
    private acquire?: (name: string, passive?: boolean) => SpriteLease,
    private request: typeof fetch = fetch,
    private createLogger: SpriteCreateLogger = logSpriteCreate,
    sessionOptions: Partial<HelperSessionSettings> = {},
  ) {
    this.usesConfiguredOrg = org === undefined;
    this.org = org ?? process.env.CIVIC_SPARK_SPRITE_ORG;
    this.sessionOptions = {
      readyTimeoutMs: 30000,
      idleMs: 120000,
      maxLine: TEXT_BODY_LIMIT + 1024 * 1024,
      maxInFlight: 32,
      retryMs: 60000,
      pingAfterMs: 30000,
      ...sessionOptions,
    };
  }
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
    beforeDispatch?: () => Promise<void>,
  ): Promise<Result<Buffer>> {
    const started = performance.now();
    let dispatched: number | undefined;
    let failure: Partial<DiagnosticRecord> = {};
    const name = args.includes("-s")
      ? args[args.indexOf("-s") + 1]
      : args[0] === "create"
        ? args.at(-1)
        : undefined;
    let lease: SpriteLease | undefined;
    let closed: Promise<void> | undefined;
    let releaseCommand: (() => void) | undefined;
    let releaseTransfer: (() => void) | undefined;
    try {
      if (name) lease = this.acquire?.(name);
      if (maxBuffer > 16 * 1024 * 1024)
        releaseTransfer = await this.transfers.acquire(lease?.signal);
      releaseCommand = await this.commands.acquire(lease?.signal);
      await beforeDispatch?.();
      lease?.signal.throwIfAborted();
      dispatched = performance.now();
      const pending = execute("sprite", this.args(args), {
        timeout,
        maxBuffer,
        encoding: "buffer",
        signal: lease?.signal,
      });
      closed = new Promise((resolve) => pending.child.once("close", () => resolve()));
      pending.child.stdin?.end(input);
      const { stdout } = await pending;
      if (name && args[2] === "exec") this.sessionReachable.add(name);
      return ok(stdout);
    } catch (error) {
      failure =
        error instanceof CommandBusy
          ? { outcome: "queue_busy" }
          : commandFailure(
              error,
              dispatched === undefined ? 0 : performance.now() - dispatched,
              timeout,
              lease?.signal.aborted ?? false,
            );
      if (error instanceof CommandBusy) return fail(error.message, 429);
      return fail(commandFailed, 502);
    } finally {
      await closed;
      diagnostic({
        event: "sprite.command",
        transport: "process",
        workspaceId: spriteWorkspaceId(name),
        durationMs: Math.round(performance.now() - started),
        queueMs: Math.round((dispatched ?? performance.now()) - started),
        executionMs: dispatched === undefined ? 0 : Math.round(performance.now() - dispatched),
        timeoutMs: timeout,
        outcome: "ok",
        ...failure,
      });
      lease?.release();
      releaseCommand?.();
      releaseTransfer?.();
    }
  }
  private sessionsEnabled() {
    return process.env.CIVIC_SPARK_HELPER_SESSIONS !== "0";
  }
  /** Ends the Sprite's helper session, if any; in-flight reads fall back to one-shot commands. */
  closeSession(name: string) {
    this.sessions.get(name)?.end("ok");
    this.sessionReachable.delete(name);
    this.sessionRetryAt.delete(name);
  }
  /** Ends every helper session and waits briefly for their processes to close. */
  async close() {
    const open = [...this.sessions.values()];
    for (const name of [...this.sessions.keys()]) this.closeSession(name);
    await Promise.race([
      Promise.all(open.map((session) => session.closed)),
      new Promise((resolve) => setTimeout(resolve, 5000).unref()),
    ]);
  }
  private session(name: string, signal?: AbortSignal): Promise<HelperSession | undefined> {
    const existing = this.sessions.get(name);
    if (existing && !existing.ended)
      return existing.ready.then(
        async () => {
          if (Date.now() - existing.lastUsedAt < this.sessionOptions.pingAfterMs) return existing;
          try {
            await existing.ping(5000, signal);
            return existing;
          } catch (error) {
            if (!(error instanceof HelperSessionLost)) throw error;
            existing.end("timeout");
            return undefined;
          }
        },
        () => undefined,
      );
    const starting = this.sessionStarts.get(name);
    if (starting) return starting;
    if ((this.sessionRetryAt.get(name) ?? 0) > Date.now()) return Promise.resolve(undefined);
    const start = this.startSession(name).finally(() => this.sessionStarts.delete(name));
    this.sessionStarts.set(name, start);
    return start;
  }
  private async startSession(name: string): Promise<HelperSession | undefined> {
    let lease: SpriteLease | undefined;
    let releaseCommand: (() => void) | undefined;
    try {
      // Passive: an open session is not use, so idle release still disconnects it.
      lease = this.acquire?.(name, true);
      releaseCommand = await this.commands.acquire(lease?.signal);
    } catch {
      lease?.release();
      return undefined;
    }
    const startedAt = performance.now();
    const child = spawn(
      "sprite",
      this.args([
        "-s",
        name,
        "exec",
        "--no-port-forward",
        "--",
        "python3",
        "-c",
        helperSource("helper_session.py"),
      ]),
      { stdio: "pipe" },
    );
    const session = new HelperSession(child, {
      ...this.sessionOptions,
      scripts: Object.fromEntries(
        ["files.py", "workspace.py", "preview.py", "team_git.py"].map((script) => [
          script,
          helperSource(script),
        ]),
      ),
    });
    this.sessions.set(name, session);
    const abort = () => session.end("lease_aborted");
    lease?.signal.addEventListener("abort", abort, { once: true });
    void session.closed.then((end) => {
      lease?.signal.removeEventListener("abort", abort);
      if (this.sessions.get(name) === session) this.sessions.delete(name);
      if (end.outcome !== "ok")
        this.sessionRetryAt.set(name, Date.now() + this.sessionOptions.retryMs);
      const detail = commandFailure(
        { stderr: end.stderr, code: end.exitCode ?? undefined, signal: end.signal ?? undefined },
        0,
        0,
        false,
      );
      diagnostic({
        event: "sprite.session",
        phase: "end",
        workspaceId: spriteWorkspaceId(name),
        durationMs: Math.round(performance.now() - session.startedAt),
        stderrKind: detail.stderrKind,
        ...(detail.stderrHash ? { stderrHash: detail.stderrHash } : {}),
        ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode }),
        ...(detail.signal ? { signal: detail.signal } : {}),
        outcome: end.outcome,
      });
      lease?.release();
    });
    try {
      await session.ready;
    } catch {
      return undefined;
    } finally {
      releaseCommand();
    }
    diagnostic({
      event: "sprite.session",
      phase: "start",
      workspaceId: spriteWorkspaceId(name),
      durationMs: Math.round(performance.now() - startedAt),
      outcome: "ok",
    });
    return session;
  }
  /** Serves a read through the Sprite's helper session; undefined means use the one-shot path. */
  private sessionCommand(
    name: string,
    scriptName: string,
    payload: object,
    timeout: number,
    limit: number,
  ): Promise<Result<Buffer> | undefined> | undefined {
    if (!this.sessionsEnabled() || !this.sessionReachable.has(name)) return undefined;
    return this.sessionRequest(name, scriptName, payload, timeout, limit);
  }
  private async sessionRequest(
    name: string,
    scriptName: string,
    payload: object,
    timeout: number,
    limit: number,
  ): Promise<Result<Buffer> | undefined> {
    const started = performance.now();
    let dispatched: number | undefined;
    let failure: Partial<DiagnosticRecord> = {};
    let lease: SpriteLease | undefined;
    let result: Result<Buffer> | undefined;
    let attempted = false;
    try {
      lease = this.acquire?.(name);
      const session = await this.session(name, lease?.signal);
      if (!session) return undefined;
      attempted = true;
      lease?.signal.throwIfAborted();
      dispatched = performance.now();
      const reply = await session.request(scriptName, payload, timeout, limit, lease?.signal);
      if ("stdout" in reply) result = ok(Buffer.from(reply.stdout, "utf8"));
      else {
        failure = {
          outcome: reply.error === "unknown_script" ? "process_failed" : reply.error,
          ...(reply.exitCode === undefined ? {} : { exitCode: reply.exitCode }),
        };
        result = fail(commandFailed, 502);
      }
    } catch (error) {
      attempted = true;
      if (error instanceof HelperSessionLost) failure = { outcome: "session_lost" };
      else if (error instanceof CommandBusy) {
        failure = { outcome: "queue_busy" };
        result = fail(error.message, 429);
      } else {
        failure = { outcome: lease?.signal.aborted ? "lease_aborted" : "process_failed" };
        result = fail(commandFailed, 502);
      }
    } finally {
      if (attempted)
        diagnostic({
          event: "sprite.command",
          transport: "session",
          workspaceId: spriteWorkspaceId(name),
          durationMs: Math.round(performance.now() - started),
          queueMs: Math.round((dispatched ?? performance.now()) - started),
          executionMs: dispatched === undefined ? 0 : Math.round(performance.now() - dispatched),
          timeoutMs: timeout,
          outcome: "ok",
          ...failure,
        });
      lease?.release();
    }
    return result;
  }
  private provisioningEndpoint(name?: string) {
    if (this.usesConfiguredOrg && this.org !== process.env.CIVIC_SPARK_SPRITE_ORG)
      throw Error("Provider organization configuration changed");
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
  provisioningBinding(): SpriteProviderBinding | null {
    try {
      const { token, url } = this.provisioningEndpoint();
      return {
        org: this.org as string,
        apiOrigin: url.origin,
        // Bind the credential's provider account, allowing ordinary token rotation.
        // No credential or token-derived secret is persisted or sent to browsers.
        account: createHash("sha256")
          .update(token.split("/")[1] as string)
          .digest("hex"),
      };
    } catch {
      return null;
    }
  }
  /** Runs within an admitted command slot; never nests queue acquisition. */
  private async reservationMetadata(
    name: string,
    authenticateOrganization: boolean,
    signal?: AbortSignal,
  ) {
    const { token, url } = this.provisioningEndpoint(name);
    const environmentOrg = process.env.CIVIC_SPARK_SPRITE_ORG;
    const boundOrg = this.org as string;
    const checkBinding = () => {
      signal?.throwIfAborted();
      const current = this.provisioningEndpoint(name);
      if (
        current.token !== token ||
        current.url.href !== url.href ||
        this.org !== boundOrg ||
        process.env.CIVIC_SPARK_SPRITE_ORG !== environmentOrg
      )
        throw Error("Provider binding changed");
    };
    const get = async (target: URL) => {
      checkBinding();
      const response = await this.request(target, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      });
      checkBinding();
      return response;
    };
    let organization: SpriteOrganizationList | undefined;
    if (authenticateOrganization) {
      const response = await get(new URL("/v1/sprites?max_results=1", url));
      if (response.status !== 200) {
        await response.body?.cancel();
        return "unknown" as const;
      }
      const org = spriteOrganizationListSchema(this.org as string, name).safeParse(
        await boundedProviderJson(response),
      );
      if (!org.success) return "unknown" as const;
      checkBinding();
      organization = org.data;
    }
    const response = await get(url);
    if (response.status === 404) {
      await response.body?.cancel();
      checkBinding();
      return listWitnessesTarget(organization, name) ? ("unknown" as const) : ("missing" as const);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return "unknown" as const;
    }
    const result = spriteResourceCandidateSchema(name, boundOrg).safeParse(
      await boundedProviderJson(response),
    );
    checkBinding();
    if (!result.success || !resourceAgreesWithWitness(result.data, organization))
      return "unknown" as const;
    if (result.data.organization !== boundOrg) {
      if (!result.data.id) return "unknown" as const;
      const membership = await get(new URL(spriteMembershipPath(name), url));
      if (membership.status !== 200) {
        await membership.body?.cancel();
        return "unknown" as const;
      }
      const certified = certifiesSpriteResource(
        await boundedProviderJson(membership),
        result.data,
        boundOrg,
      );
      checkBinding();
      if (!certified) return "unknown" as const;
    }
    return "present" as const;
  }
  /** Metadata only; callers separately authorize any creation. */
  async inspectReservation(
    name: string,
    authenticateOrganization = false,
  ): Promise<"present" | "missing" | "unknown"> {
    if (!spriteNamePattern.test(name)) return "unknown";
    let release: (() => void) | undefined;
    try {
      release = await this.commands.acquire();
      return await this.reservationMetadata(name, authenticateOrganization);
    } catch {
      return "unknown";
    } finally {
      release?.();
    }
  }
  async create(
    name: string,
    beforeDispatch?: () => Promise<void>,
    requireMissing = false,
  ): Promise<SpriteCreateResult> {
    if (!spriteNamePattern.test(name)) return fail("Invalid Civic Spark Sprite name.");
    const environmentOrg = process.env.CIVIC_SPARK_SPRITE_ORG;
    let observedFailure: SpriteCreationFailure | null = null;
    const failure = (kind: SpriteCreationFailure): SpriteCreateResult => {
      observedFailure = kind;
      return {
        ok: false,
        status: 502,
        error: spriteCreationMessages[kind],
        creationFailure: kind,
      };
    };
    // Retain local CLI-login support. Its free-form output cannot reliably carry
    // structured provider codes, so a failure remains unknown, never guessed.
    if (!process.env.SPRITE_TOKEN) {
      try {
        // A guarded retry must never fall back to unaudited CLI authentication.
        if (beforeDispatch || requireMissing) return failure("unknown");
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
    let validatingIdentity = false;
    let diagnostic: ReturnType<typeof observeSpriteCreate> | undefined;
    let signal: AbortSignal | undefined;
    let onAbort: (() => void) | undefined;
    try {
      lease = this.lease(name);
      release = await this.commands.acquire(lease?.signal);
      lease?.signal.throwIfAborted();
      await beforeDispatch?.();
      if (requireMissing) {
        // Refresh absence after queue admission under the lifecycle lease. A
        // same-name race at POST must fail as conflict; never attach/seed it.
        if (
          !beforeDispatch ||
          (await this.reservationMetadata(name, true, lease?.signal)) !== "missing"
        )
          return failure("unknown");
        await beforeDispatch();
      }
      lease?.signal.throwIfAborted();
      // Revalidation may await session storage; never cross a provider/credential
      // change between admission and this actual dispatch.
      const current = this.provisioningEndpoint();
      if (
        current.token !== endpoint.token ||
        current.url.href !== endpoint.url.href ||
        process.env.CIVIC_SPARK_SPRITE_ORG !== environmentOrg
      )
        return failure("unknown");
      // One POST, no automatic retries or fallback mutation after an uncertain response.
      const timeout = AbortSignal.timeout(120000);
      signal = AbortSignal.any([timeout, ...(lease ? [lease.signal] : [])]);
      diagnostic = observeSpriteCreate(
        name,
        this.org as string,
        endpoint.token.split("/")[1] as string,
        requireMissing,
        this.createLogger,
      );
      onAbort = () =>
        diagnostic?.aborted(
          timeout.aborted && signal?.reason === timeout.reason
            ? "timeout"
            : lease?.signal.aborted && signal?.reason === lease.signal.reason
              ? "lease"
              : "other",
        );
      signal.addEventListener("abort", onAbort, { once: true });
      dispatched = true;
      const response = await this.request(endpoint.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
        redirect: "error",
        signal,
      });
      diagnostic.headers(response.status);
      const body = await boundedProviderJson(response);
      diagnostic.body(body);
      if (!response.ok) {
        diagnostic.validated(false);
        return failure(classifyCreationFailure(response.status, body));
      }
      // Preserve the existing uncertain-body outcome without accepting an aborted read.
      if (signal.aborted && body === null) {
        diagnostic.validated(false);
        return failure("unknown");
      }
      validatingIdentity = true;
      const boundOrg = this.org as string;
      const checkBinding = () => {
        signal?.throwIfAborted();
        const current = this.provisioningEndpoint();
        if (
          current.token !== endpoint.token ||
          current.url.href !== endpoint.url.href ||
          this.org !== boundOrg ||
          process.env.CIVIC_SPARK_SPRITE_ORG !== environmentOrg
        )
          throw Error("Provider binding changed");
      };
      checkBinding();
      const created = spriteResourceCandidateSchema(name, boundOrg).safeParse(body);
      let confirmed =
        (requireMissing ? response.status === 201 : [200, 201].includes(response.status)) &&
        created.success;
      if (confirmed && created.success && created.data.organization !== boundOrg) {
        confirmed = false;
        if (created.data.id) {
          const membershipSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
          const membership = await this.request(new URL(spriteMembershipPath(name), endpoint.url), {
            method: "GET",
            headers: { Authorization: `Bearer ${endpoint.token}` },
            redirect: "error",
            signal: membershipSignal,
          });
          membershipSignal.throwIfAborted();
          checkBinding();
          if (membership.status === 200) {
            confirmed = certifiesSpriteResource(
              await boundedProviderJson(membership),
              created.data,
              boundOrg,
            );
            membershipSignal.throwIfAborted();
            checkBinding();
          } else await membership.body?.cancel();
        }
      }
      checkBinding();
      diagnostic.validated(confirmed);
      return confirmed ? ok(name) : failure("unknown");
    } catch {
      return failure(
        !validatingIdentity && dispatched && !lease?.signal.aborted ? "transient" : "unknown",
      );
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      diagnostic?.finish(observedFailure);
      release?.();
      lease?.release();
    }
  }
  async uploadBundle(
    name: string,
    bundle: string,
    beforeDispatch?: () => Promise<void>,
  ): Promise<Result<Buffer>> {
    if (!spriteNamePattern.test(name)) return fail("Invalid prototype Sprite name");
    return this.command(
      [
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
      ],
      120000,
      undefined,
      16 * 1024 * 1024,
      beforeDispatch,
    );
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
    return diagnosticContext.run(
      { ...diagnosticContext.getStore(), operationId: randomUUID() },
      () => this.tracedFileOperation(name, payload, schema, scriptName, upload),
    );
  }
  private async tracedFileOperation<T>(
    name: string,
    payload: { operation: string; [key: string]: unknown },
    schema: z.ZodType<T>,
    scriptName: string,
    upload?: { local: string; remote: string },
  ): Promise<Result<T>> {
    if (!upload && ["list", "changes", "manifest", "status", "logs"].includes(payload.operation)) {
      const key = JSON.stringify([name, scriptName, payload]);
      const pending = this.reads.get(key);
      if (pending) {
        diagnostic({
          event: "sprite.coalesced",
          workspaceId: spriteWorkspaceId(name),
          ...operationLabels(scriptName, payload.operation),
        });
        return pending as Promise<Result<T>>;
      }
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
    const transferringFile = ["read", "save", "mutate"].includes(payload.operation);
    const timeout =
      scriptName === "preview.py" && ["start", "restart"].includes(payload.operation)
        ? 360000
        : transferringFile
          ? 120000
          : 30000;
    const limit = transferringFile
      ? scriptName === "files.py"
        ? TEXT_BODY_LIMIT
        : BLOB_BODY_LIMIT
      : 16 * 1024 * 1024;
    // Reads use the Sprite's helper session when one is healthy; writes, uploads
    // and any read the session could not answer take the one-shot command path.
    const served =
      !upload && sessionReads.has(`${scriptName}:${payload.operation}`)
        ? this.sessionCommand(name, scriptName, payload, timeout, limit)
        : undefined;
    const response =
      (served && (await served)) ||
      (await this.command(
        [
          "-s",
          name,
          "exec",
          "--no-port-forward",
          ...(upload ? ["--file", `${upload.local}:${upload.remote}`] : []),
          "--",
          "python3",
          "-c",
          readFileSync(new URL(`./${scriptName}`, import.meta.url), "utf8"),
        ],
        timeout,
        JSON.stringify(payload),
        limit,
      ));
    const details = {
      event: "sprite.operation" as const,
      workspaceId: spriteWorkspaceId(name),
      ...operationLabels(scriptName, payload.operation),
    };
    if (!response.ok) {
      diagnostic({ ...details, status: response.status, outcome: "process_failed" });
      return response;
    }
    try {
      const parsed = z
        .discriminatedUnion("ok", [
          z.object({ ok: z.literal(true), value: schema }),
          z.object({
            ok: z.literal(false),
            error: z.string(),
            status: z.number(),
            diagnostic: helperDiagnosticSchema.optional(),
          }),
        ])
        .parse(JSON.parse(response.value.toString()));
      diagnostic({
        ...details,
        status: parsed.ok ? 200 : parsed.status,
        outcome: parsed.ok ? "ok" : "helper_failed",
        ...(!parsed.ok ? { helper: parsed.diagnostic } : {}),
      });
      return parsed.ok ? parsed : fail(parsed.error, parsed.status);
    } catch {
      diagnostic({ ...details, status: 502, outcome: "invalid_response" });
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
