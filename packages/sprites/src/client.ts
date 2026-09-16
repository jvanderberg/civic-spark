import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { z } from "zod";
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

const execute = promisify(execFile);
const spriteNamePattern = /^civic-spark-[a-z0-9-]{1,45}$/;
export type SpriteLease = { signal: AbortSignal; release(): void };
export class SpriteClient {
  constructor(
    private org = process.env.CIVIC_SPARK_SPRITE_ORG,
    private acquire?: (name: string, passive?: boolean) => SpriteLease,
  ) {}
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
    try {
      const name = args.includes("-s")
        ? args[args.indexOf("-s") + 1]
        : args[0] === "create"
          ? args.at(-1)
          : undefined;
      if (name) lease = this.acquire?.(name);
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
    } catch {
      return fail(
        "Sprite command failed. Check your CLI login and connectivity; no account credentials were logged.",
        502,
      );
    } finally {
      await closed;
      lease?.release();
    }
  }
  async create(name: string): Promise<Result<string>> {
    if (!spriteNamePattern.test(name)) return fail("Invalid Civic Spark Sprite name.");
    const result = await this.command(["create", "--skip-console", name]);
    return result.ok ? ok(name) : result;
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
  private async fileOperation<T>(
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
  ) {
    return this.fileOperation(
      name,
      {
        operation,
        ...config,
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
