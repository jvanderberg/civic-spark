import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventService } from "../packages/domain/src/service.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";

const name = process.argv[process.argv.indexOf("--sprite") + 1];
if (!name || !/^civic-spark-smoke-[a-z0-9-]+$/.test(name))
  throw new Error("Supply an existing dedicated --sprite civic-spark-smoke-NAME");
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const root = mkdtempSync(join(tmpdir(), "civic-spark-share-live-"));
const remote = `/tmp/civic-spark-share-smoke-${randomUUID()}`;
const service = new EventService(root);
const client = new SpriteClient();
try {
  const actor = {
    id: "smoke",
    name: "Smoke",
    email: "smoke@example.test",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(actor, {
      name: "Share smoke",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 10,
      budget: 0,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    service.createTeam(actor, { eventId: event.id, name: "Share test", projectId: "data-starter" }),
  );
  const local = service.workspacePath(team.workspace.id);
  const outbound = join(root, "seed.bundle");
  git(local, ["bundle", "create", outbound, "--all"]);
  unwrap(
    await client.command([
      "-s",
      name,
      "exec",
      "-file",
      `${outbound}:${remote}.bundle`,
      "python3",
      "-c",
      "import pathlib,subprocess,sys; p=sys.argv[1]; subprocess.run(['git','clone',p+'.bundle',p],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); subprocess.run(['git','-C',p,'update-ref','refs/civic-spark/base','HEAD'],check=True); pathlib.Path(p,'large.csv').write_text('year,count\\n'+('2017,3\\n'*160000)); pathlib.Path(p,'note.txt').write_text('First update\\n')",
      remote,
    ]),
  );
  const script = readFileSync(
    new URL("../packages/sprites/src/workspace.py", import.meta.url),
    "utf8",
  ).replace(
    "ROOT = pathlib.Path('/home/sprite/project')",
    `ROOT = pathlib.Path(${JSON.stringify(remote)})`,
  );
  const run = async (payload: object) =>
    JSON.parse(
      unwrap(
        await client.command(
          ["-s", name, "exec", "python3", "-c", script],
          30000,
          JSON.stringify(payload),
        ),
      ).toString(),
    );
  const preview = await run({ operation: "changes" });
  assert.equal(preview.ok, true);
  assert.equal(preview.value.files.length, 2);
  assert.match(
    preview.value.files.find((f: { path: string }) => f.path === "large.csv").diff,
    /Large file/,
  );
  const shared = await run({
    operation: "share",
    revision: preview.value.revision,
    title: "Live transfer",
  });
  assert.equal(shared.ok, true);
  const nativeHead = unwrap(await client.exec(name, ["git", "-C", remote, "rev-parse", "HEAD"]))
    .toString()
    .trim();
  assert.equal(nativeHead, shared.value.commit);
  assert.equal(
    unwrap(await client.exec(name, ["git", "-C", remote, "status", "--porcelain"])).toString(),
    "",
  );
  // An edit made after commit but before push remains an ordinary uncommitted edit.
  unwrap(
    await client.exec(name, [
      "python3",
      "-c",
      "import pathlib,sys; pathlib.Path(sys.argv[1],'note.txt').write_text('Newer working edit\\n')",
      remote,
    ]),
  );

  const incoming = join(root, "incoming.bundle");
  writeFileSync(incoming, Buffer.from(shared.value.bundle, "base64"));
  const quarantine = join(root, "incoming.git");
  git(root, ["init", "--bare", quarantine]);
  git(quarantine, ["bundle", "verify", incoming]);
  git(quarantine, ["fetch", incoming, `${shared.value.ref}:refs/heads/incoming`]);
  const contribution = unwrap(
    service.publishSnapshot(
      actor,
      team.workspace.id,
      "Live transfer",
      preview.value.revision,
      quarantine,
      shared.value.commit,
    ),
  );
  assert.equal(contribution.status, "accepted");
  assert.equal(
    git(join(root, "repos", `${team.team.id}.git`), ["rev-parse", "main"])
      .toString()
      .trim(),
    nativeHead,
  );
  assert.match(
    unwrap(await client.exec(name, ["git", "-C", remote, "status", "--porcelain"])).toString(),
    / M note.txt/,
  );

  const repo = join(root, "repos", `${team.team.id}.git`);
  assert.equal(git(repo, ["show", "main:note.txt"]).toString(), "First update\n");
  assert.equal(
    git(repo, ["show", "main:large.csv"]).length,
    "year,count\n".length + "2017,3\n".length * 160000,
  );
  console.log(
    "PASS: live Sprite local commit/message/clean status → exact same commit pushed to team main; edits made after commit remain dirty. No models or participant project changes.",
  );
} finally {
  await client.exec(name, [
    "python3",
    "-c",
    "import shutil,pathlib,sys; shutil.rmtree(sys.argv[1],ignore_errors=True); pathlib.Path(sys.argv[1]+'.bundle').unlink(missing_ok=True)",
    remote,
  ]);
  service.close();
  rmSync(root, { recursive: true, force: true });
}
