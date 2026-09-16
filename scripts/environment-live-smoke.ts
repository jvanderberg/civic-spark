import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSessions } from "../apps/server/src/agents.ts";
import { WorkspaceIntegrations } from "../apps/server/src/integrations.ts";
import { EventService } from "../packages/domain/src/service.ts";
import type { Result } from "../packages/domain/src/types.ts";
import { git } from "../packages/git/src/repository.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";

const sprite = process.argv[process.argv.indexOf("--sprite") + 1];
if (!sprite || !/^civic-spark-smoke-[a-z0-9-]+$/.test(sprite))
  throw new Error("Use an existing dedicated --sprite civic-spark-smoke-NAME");
const name = sprite;
const root = mkdtempSync(join(tmpdir(), "civic-spark-environment-live-"));
const remote = `/tmp/civic-spark-environment-${randomUUID()}`;
const runtime = `${remote}-runtime`;
const session = `civic-spark-preview-${randomUUID().slice(0, 8)}`;
const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
class FixtureSprite extends SpriteClient {
  private async fixture(script: string, payload: object, upload?: string) {
    const source = readFileSync(
      new URL(`../packages/sprites/src/${script}`, import.meta.url),
      "utf8",
    )
      .replaceAll("/home/sprite/project", remote)
      .replaceAll("/home/sprite/.civic-spark-agent", runtime)
      .replace("SESSION = 'civic-spark-web-preview'", `SESSION = '${session}'`);
    const destination = `/tmp/civic-spark-team-${randomUUID()}.bundle`;
    const response = unwrap(
      await this.command(
        [
          "-s",
          name,
          "exec",
          ...(upload ? ["--file", `${upload}:${destination}`] : []),
          "--",
          "python3",
          "-c",
          source,
        ],
        90000,
        JSON.stringify({ ...payload, ...(upload ? { bundle: destination } : {}) }),
      ),
    );
    return JSON.parse(response.toString());
  }
  override agentGit(
    _name: string,
    payload: Parameters<SpriteClient["agentGit"]>[1],
  ): ReturnType<SpriteClient["agentGit"]> {
    return this.fixture("agent_git.py", payload);
  }
  override importTeam(
    _name: string,
    bundle: string,
    remote: string,
  ): ReturnType<SpriteClient["importTeam"]> {
    return this.fixture("team_git.py", { operation: "import", remote }, bundle);
  }
  override acknowledgeShare(
    _name: string,
    revision: string,
    commit: string,
  ): ReturnType<SpriteClient["acknowledgeShare"]> {
    return this.fixture("workspace.py", { operation: "shared", revision, commit });
  }
  override preview(
    _name: string,
    operation: Parameters<SpriteClient["preview"]>[1],
    config?: Parameters<SpriteClient["preview"]>[2],
  ): ReturnType<SpriteClient["preview"]> {
    return this.fixture("preview.py", { operation, ...config });
  }
}
const client = new FixtureSprite();
const service = new EventService(root);
const integrations = new WorkspaceIntegrations(
  service,
  root,
  new Set(),
  "http://127.0.0.1:4310",
  client,
);
try {
  assert(await new AgentSessions().prepare(name));
  const actor = {
    id: "environment-smoke",
    name: "Environment smoke",
    email: "env@example.test",
    emailVerified: true as const,
  };
  const event = unwrap(
    service.createEvent(actor, {
      name: "Environment smoke",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Test",
      capacity: 4,
      budget: 0,
      templateId: "blank",
    }),
  );
  const team = unwrap(
    service.createTeam(actor, {
      eventId: event.id,
      name: "Environment test",
      projectId: "data-starter",
    }),
  );
  const id = team.workspace.id;
  service.setSprite(id, name, "ready", null);
  const local = service.workspacePath(id);
  const repo = join(root, "repos", `${team.team.id}.git`);
  const seed = join(root, "seed.bundle");
  git(local, ["bundle", "create", seed, "--all"]);
  unwrap(
    await client.command([
      "-s",
      name,
      "exec",
      "--file",
      `${seed}:${remote}.bundle`,
      "--",
      "python3",
      "-c",
      "import pathlib,subprocess,json,sys; p,r=sys.argv[1:]; subprocess.run(['git','clone',p+'.bundle',p],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); pathlib.Path(r).mkdir(); pathlib.Path(r,'environment.json').write_text(json.dumps({'port': 15173, 'command':['npx','vite','--host','127.0.0.1','--port','15173','--strictPort']})); pathlib.Path(p,'index.html').write_text('<h1>Civic Spark live preview</h1><script type=\"module\" src=\"/app.js\"></script>'); pathlib.Path(p,'app.js').write_text('console.log(\"asset loaded\")'); pathlib.Path(p,'package.json').write_text(json.dumps({'type':'module','devDependencies':{'vite':'8.3.0'}}))",
      remote,
      runtime,
    ]),
  );
  unwrap(
    await client.exec(name, [
      "bash",
      "-lc",
      `cd '${remote}' && npm install --ignore-scripts --no-audit --no-fund && git -c core.hooksPath=/dev/null add index.html app.js package.json package-lock.json && git -c user.name=Smoke -c user.email=smoke@example.test -c core.hooksPath=/dev/null commit -m 'Create static Vite preview'`,
    ]),
  );
  // Advance the team independently; publication must rebase only the unpublished app commit.
  git(local, ["switch", "main"]);
  writeFileSync(join(local, "team.txt"), "Team contribution\n");
  git(local, ["add", "team.txt"]);
  git(local, ["commit", "-m", "Team contribution"]);
  git(local, ["push", "origin", "main"]);
  const teamHead = git(repo, ["rev-parse", "main"]).toString().trim();
  integrations.ensure(id, actor, name, async () => service.workspace(actor, id, true).ok);
  const published = JSON.parse(
    unwrap(
      await client.exec(name, [
        "/home/sprite/.civic-spark-agent/bin/civic-spark",
        "git",
        "publish",
      ]),
    ).toString(),
  );
  assert(published.ok, published.error);
  assert.equal(published.value.status, "published");
  const native = unwrap(await client.exec(name, ["git", "-C", remote, "rev-parse", "HEAD"]))
    .toString()
    .trim();
  assert.equal(native, git(repo, ["rev-parse", "main"]).toString().trim());
  git(repo, ["merge-base", "--is-ancestor", teamHead, "main"]);
  console.log(
    "PASS native CLI relay: fetch → clean rebase → exact native commit published; team history preserved.",
  );
  // Real divergent edit: publication must wait for a separate owner confirmation.
  unwrap(
    await client.exec(name, [
      "bash",
      "-lc",
      `cd '${remote}' && printf 'Participant story\\n' > team.txt && git -c core.hooksPath=/dev/null add team.txt && git -c user.name=Smoke -c user.email=smoke@example.test -c core.hooksPath=/dev/null commit -m 'Participant story'`,
    ]),
  );
  const conflictHead = unwrap(await client.exec(name, ["git", "-C", remote, "rev-parse", "HEAD"]))
    .toString()
    .trim();
  git(local, ["fetch", repo, "main"]);
  git(local, ["merge", "--ff-only", "FETCH_HEAD"]);
  writeFileSync(join(local, "team.txt"), "Other teammate story\n");
  git(local, ["add", "team.txt"]);
  git(local, ["commit", "-m", "Other story"]);
  git(local, ["push", "origin", "main"]);
  const paused = JSON.parse(
    unwrap(
      await client.exec(name, [
        "/home/sprite/.civic-spark-agent/bin/civic-spark",
        "git",
        "publish",
      ]),
    ).toString(),
  );
  assert(paused.ok);
  assert.equal(paused.value.status, "confirmation");
  assert.equal(
    unwrap(await client.exec(name, ["git", "-C", remote, "rev-parse", "HEAD"]))
      .toString()
      .trim(),
    conflictHead,
  );
  const ticket = integrations.pending(id, actor);
  assert(ticket);
  const confirmed = await integrations.confirm(id, actor, ticket.id, true);
  assert.equal(confirmed.status, "resolving");
  unwrap(
    await client.exec(name, [
      "bash",
      "-lc",
      `cd '${remote}' && printf 'Participant and teammate reconciled\\n' > team.txt && git -c core.hooksPath=/dev/null add team.txt && GIT_EDITOR=true git -c user.name=Smoke -c user.email=smoke@example.test -c core.hooksPath=/dev/null rebase --continue`,
    ]),
  );
  const resumed = JSON.parse(
    unwrap(
      await client.exec(name, [
        "/home/sprite/.civic-spark-agent/bin/civic-spark",
        "git",
        "publish",
      ]),
    ).toString(),
  );
  assert(resumed.ok, resumed.error);
  assert.equal(resumed.value.status, "published");
  assert.equal(integrations.pending(id, actor), null);
  console.log(
    "PASS live conflict gate: original HEAD unchanged until owner confirmation, then recoverable rebase/resolution and same-history publication.",
  );
  const launch = await integrations.preview(id, actor, "start");
  assert.equal(launch.ready, true);
  assert.equal(launch.port, 15173);
  const again = await integrations.preview(id, actor, "start");
  assert.equal(again.ready, true);
  const opened = await integrations.openPreview(
    id,
    actor,
    async () => service.workspace(actor, id, true).ok,
  );
  const auth = await fetch(opened.url, { redirect: "manual" });
  assert.equal(auth.status, 303);
  const cookie = auth.headers.get("set-cookie")?.split(";")[0] ?? "";
  const origin = new URL(opened.url).origin;
  const html = await fetch(origin, { headers: { cookie } });
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Civic Spark live preview/);
  const asset = await fetch(`${origin}/app.js`, { headers: { cookie } });
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /asset loaded/);
  const restart = await integrations.preview(id, actor, "restart");
  assert.equal(restart.ready, true);
  assert.equal((await integrations.preview(id, actor, "stop")).running, false);
  console.log(
    "PASS live Vite lifecycle: launch/readiness, idempotent launch, private preview HTML/assets, restart, stop. No model calls; only isolated fixture paths changed.",
  );
} finally {
  integrations.close();
  await client.exec(name, [
    "python3",
    "-c",
    "import pathlib,shutil,subprocess,sys; p,r,s=sys.argv[1:]; subprocess.run(['tmux','kill-session','-t',s],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); shutil.rmtree(p,ignore_errors=True); shutil.rmtree(r,ignore_errors=True); pathlib.Path(p+'.bundle').unlink(missing_ok=True)",
    remote,
    runtime,
    session,
  ]);
  service.close();
  rmSync(root, { recursive: true, force: true });
}
