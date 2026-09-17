import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../apps/server/src/app.ts";
import { AgentReplay } from "../packages/agents/src/history.ts";
import { ok, type Result } from "../packages/domain/src/types.ts";
import { SpriteClient } from "../packages/sprites/src/client.ts";
import { WorkspaceFiles } from "../packages/workspace/src/files.ts";
import { testIdentity } from "../tests/auth-fixture.ts";

// Only synthetic local accounts and files. No provider command can run here.
SpriteClient.prototype.command = async () => {
  throw new Error("Provider calls forbidden in load fixture");
};
const mockDelay = async <T>(value: T) => {
  await delay(25);
  return ok(value);
};
SpriteClient.prototype.files = () => mockDelay(["README.md", "PROJECT.md"]);
SpriteClient.prototype.changes = () => mockDelay({ base: "a".repeat(40), files: [] });
SpriteClient.prototype.manifest = () => mockDelay({ files: {}, skipped: [] });
SpriteClient.prototype.teamStatus = (_name, remote) =>
  mockDelay({
    head: remote,
    remote,
    incoming: false,
    outgoing: false,
    dirty: false,
    merging: false,
    conflicts: [],
  });
SpriteClient.prototype.preview = () =>
  mockDelay({ command: ["npm", "run", "dev"], port: 5173, running: false, ready: false });
const unwrap = <T>(result: Result<T>) => {
  assert(result.ok, result.ok ? "" : result.error);
  return result.value;
};
const duration = Number(process.env.CIVIC_SPARK_LOAD_SECONDS ?? 30);
assert(Number.isFinite(duration) && duration >= 5 && duration <= 300);
const root = mkdtempSync(join(tmpdir(), "civic-spark-load-"));
const output = resolve(process.argv[2] ?? "artifacts/capacity/load.json");
const instance = await createApp(root, true, "http://127.0.0.1:4310", undefined, "email");
const { app, service, authentication } = instance;
const diskBytes = (path: string): number =>
  readdirSync(path, { withFileTypes: true }).reduce(
    (sum, entry) =>
      sum +
      (entry.isDirectory()
        ? diskBytes(join(path, entry.name))
        : statSync(join(path, entry.name)).size),
    0,
  );
const summarize = (values: number[]) => {
  values.sort((a, b) => a - b);
  return {
    count: values.length,
    p50: values[Math.floor(values.length * 0.5)] ?? 0,
    p95: values[Math.floor(values.length * 0.95)] ?? 0,
    p99: values[Math.floor(values.length * 0.99)] ?? 0,
    max: values.at(-1) ?? 0,
  };
};
const report: Record<string, unknown> = {
  participants: 60,
  teams: 12,
  seconds: duration,
  node: process.version,
  platform: process.platform,
  provider: "25ms in-process response fixtures; no cloud/CLI/paid calls",
};
try {
  const people = await Promise.all(
    Array.from({ length: 60 }, (_, i) => testIdentity(authentication, `Capacity Person ${i}`)),
  );
  const owner = people[0]?.actor;
  assert(owner);
  const event = unwrap(
    service.createEvent(owner, {
      name: "Capacity fixture",
      date: "2026-10-03",
      timezone: "America/Chicago",
      location: "Local only",
      capacity: 60,
      budget: 0,
      templateId: "blank",
    }),
  );
  unwrap(service.transition(owner, event.id, "registration"));
  const teams = Array.from(
    { length: 12 },
    (_, i) =>
      unwrap(
        service.createTeam(owner, {
          eventId: event.id,
          name: `Fixture team ${i}`,
          projectId: "data-starter",
        }),
      ).team,
  );
  const participants = people.map((person, i) => {
    assert(person.actor);
    const workspace = unwrap(
      service.joinTeam(person.actor, teams[Math.floor(i / 5)]?.id as string),
    );
    unwrap(service.setSprite(workspace.id, `civic-spark-${workspace.id}`, "ready", null, "ready"));
    return { ...person, actor: person.actor, workspace };
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const latencies: Record<string, number[]> = {};
  const statuses: Record<string, number> = {};
  const request = async (person: (typeof participants)[number], route: string, body?: unknown) => {
    const started = performance.now();
    const response = await fetch(`${base}${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: person.cookie,
        origin: "http://127.0.0.1:4310",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120000),
    });
    await response.arrayBuffer();
    const kind = route.split("/").at(-1) as string;
    latencies[kind] ??= [];
    latencies[kind].push(performance.now() - started);
    statuses[String(response.status)] = (statuses[String(response.status)] ?? 0) + 1;
  };
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let peakRss = process.memoryUsage().rss;
  const memory = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 50);
  const cpu = process.cpuUsage();
  const started = performance.now();
  await Promise.all(
    participants.map(async (person, i) => {
      await delay(i * 15);
      let tick = 0;
      while (performance.now() - started < duration * 1000) {
        await Promise.all([
          ...(tick % 3 === 0 ? [request(person, "/api/state")] : []),
          ...["files", "changes", "team-status", "sprite", "preview"].map((route) =>
            request(person, `/api/workspaces/${person.workspace.id}/${route}`),
          ),
        ]);
        tick++;
        await delay(5000);
      }
    }),
  );
  report.polling = {
    elapsedMs: performance.now() - started,
    latencyMs: Object.fromEntries(
      Object.entries(latencies).map(([key, value]) => [key, summarize(value)]),
    ),
    statuses: { ...statuses },
    eventLoopMs: {
      p95: lag.percentile(95) / 1e6,
      p99: lag.percentile(99) / 1e6,
      max: lag.max / 1e6,
    },
    peakRssBytes: peakRss,
    cpu: process.cpuUsage(cpu),
    diskBytes: diskBytes(root),
  };
  lag.reset();
  // Explicit synthetic Share requests: real Git commits and expected same-team contention.
  const shares = participants.map((person, i) => {
    unwrap(
      service.setSprite(person.workspace.id, `civic-spark-${person.workspace.id}`, "local", null),
    );
    writeFileSync(
      join(service.workspacePath(person.workspace.id), `fixture-${i}.txt`),
      `Synthetic contribution ${i}\n`,
    );
    return {
      person,
      revision: new WorkspaceFiles(service.workspacePath(person.workspace.id)).snapshot().revision,
    };
  });
  for (const key of Object.keys(latencies)) delete latencies[key];
  for (const key of Object.keys(statuses)) delete statuses[key];
  await delay(20);
  lag.reset();
  const shareStarted = performance.now();
  await Promise.all(
    shares.map(({ person, revision }) =>
      request(person, `/api/workspaces/${person.workspace.id}/share`, {
        title: "Synthetic load contribution",
        revision,
      }),
    ),
  );
  await delay(20);
  report.share = {
    elapsedMs: performance.now() - shareStarted,
    latencyMs: summarize(latencies.share ?? []),
    statuses: { ...statuses },
    eventLoopMaxMs: lag.max / 1e6,
    diskBytes: diskBytes(root),
  };
  // Real replay processing, 60 active conversations with frequent deltas.
  const replays = Array.from({ length: 60 }, () => new AgentReplay());
  const replayStart = performance.now();
  for (let turn = 0; turn < 100; turn++)
    for (const replay of replays)
      replay.accept({ type: "text", id: `turn-${turn}`, text: "x".repeat(10000) });
  report.replay = {
    elapsedMs: performance.now() - replayStart,
    retainedBytes: replays.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r.events)), 0),
    rssBytes: process.memoryUsage().rss,
  };
  clearInterval(memory);
  lag.disable();
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
