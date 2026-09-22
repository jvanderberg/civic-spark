import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const completionText = "WE'RE ALL GOOD";
export const scenarioSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }, "Use an HTTPS origin, or HTTP on loopback"),
  authMode: z.enum(["demo", "prototype"]),
  eventName: z.string().trim().min(1),
  projectName: z.string().trim().min(1),
  participant: z.strictObject({ name: z.string().trim().min(2).max(80), email: z.email() }),
  teamName: z.string().trim().min(2).max(80),
  /** Which saved harness the scenario connects: GLM through OpenRouter or Claude. */
  agent: z.enum(["opencode", "claude"]).default("opencode"),
  credentialEnv: z
    .string()
    .regex(/^CIVIC_SPARK_[A-Z0-9_]+$/)
    .default("CIVIC_SPARK_LOAD_GLM_KEY"),
  prompt: z
    .string()
    .trim()
    .min(10)
    .max(18000)
    .default(
      "Read PROJECT.md and the existing repository, then build a small working React and TypeScript MVP that answers this project's civic question with real data. Use the data sources listed in the brief: fetch them from inside this workspace with curl or a short script, keep only what the MVP needs (filter to Oak Park and cap each file at about 2 MB), and store the extracts as static JSON or CSV under public/data with a SOURCES.md that records each URL, the retrieval date and the filters applied. Do not invent records. If a source is unreachable, say so in the README and use the smallest clearly labelled placeholder that keeps the app working. If the brief lists no data, choose one real public dataset about Oak Park, Illinois and cite it the same way. Choose one useful core interaction and a clear mobile-ready screen. Include a README explaining the scope, the data and how to run it. Preserve hello.txt containing exactly 42. Keep this first MVP small enough to finish promptly. If you make a local commit, use exactly MVP as its message. Do not publish; I will use Share.",
    ),
  timing: z
    .strictObject({
      actionMs: z.number().int().min(1000).max(120000).default(30000),
      provisioningMs: z.number().int().min(1000).max(1800000).default(600000),
      agentTurnMs: z.number().int().min(1000).max(3600000).default(1200000),
      completionWaitMs: z.number().int().min(1).max(1800000).default(300000),
      completionChecks: z.number().int().min(1).max(12).default(6),
      pollMs: z.number().int().min(10).max(30000).default(2000),
      retryMs: z.number().int().min(10).max(60000).default(3000),
      retries: z.number().int().min(0).max(5).default(3),
      thinkMs: z.number().int().min(0).max(60000).default(1000),
    })
    .prefault({}),
  browser: z
    .strictObject({
      headed: z.boolean().default(false),
      width: z.number().int().min(360).max(2560).default(1440),
      height: z.number().int().min(360).max(1600).default(900),
      theme: z.enum(["light", "dark"]).default("light"),
    })
    .prefault({}),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export function redact(value: string, key = "") {
  return (key ? value.replaceAll(key, "[REDACTED]") : value).replace(
    /sk-[A-Za-z0-9_-]+/g,
    "[REDACTED]",
  );
}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// Retry only operations whose callers reconcile state first, or read-only operations.
export async function retry<T>(
  operation: () => Promise<T>,
  retries: number,
  delayMs: number,
  onRetry: (attempt: number) => void = () => {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof FatalScenarioError || attempt >= retries) throw error;
      onRetry(attempt + 1);
      await sleep(Math.min(delayMs * 2 ** attempt, 60000));
    }
  }
}
export class FatalScenarioError extends Error {}

export type ObservedAgentEvent = {
  type: string;
  id: string;
  text: string;
  outcome?: string;
  replayed?: boolean;
};
export const observedEventLimit = 10000;
// Streamed text arrives as one event per delta, so a long turn can produce
// thousands of events. Coalesce deltas of the same message and, when trimming,
// never drop the current turn: positions are not stable, so callers must locate
// turns by their user echo every time instead of caching an index.
export function observeAgentEvent(
  events: ObservedAgentEvent[],
  event: ObservedAgentEvent,
  limit = observedEventLimit,
) {
  const last = events.at(-1);
  if (
    event.type === "text" &&
    last?.type === "text" &&
    last.id === event.id &&
    !last.replayed &&
    !event.replayed
  ) {
    events[events.length - 1] = { ...last, text: last.text + event.text };
    return;
  }
  events.push(event);
  if (events.length > limit) {
    const turnStart = events.findLastIndex((entry) => entry.type === "user" && !entry.replayed);
    events.splice(0, Math.min(events.length - limit, Math.max(0, turnStart)));
  }
}
// The turn started by the latest fresh echo of this question, up to its fresh
// end-of-turn event. Recomputed on every call so buffer trimming cannot hide it.
export function turnEvents(events: ObservedAgentEvent[], question: string) {
  const start = events.findLastIndex(
    (event) => event.type === "user" && event.text === question && !event.replayed,
  );
  if (start < 0) return undefined;
  const turn = events.slice(start + 1);
  const done = turn.findIndex((event) => event.type === "done" && !event.replayed);
  return { turn: done < 0 ? turn : turn.slice(0, done), done: done < 0 ? undefined : turn[done] };
}
// Only a fresh, successful response AFTER this question can satisfy completion.
// User echoes, tool output, old replayed replies and failed turns cannot pass.
export function completedReply(events: ObservedAgentEvent[], question: string) {
  const found = turnEvents(events, question);
  if (found?.done?.outcome !== "success" || !found) return false;
  if (found.turn.some((event) => event.type === "user" && !event.replayed)) return false;
  const messages = new Map<string, string>();
  for (const event of found.turn) {
    if (event.type === "text" && !event.replayed)
      messages.set(event.id, (messages.get(event.id) ?? "") + event.text);
  }
  return [...messages.values()].some((text) =>
    text.split(/\r?\n/).some((line) => line.trim() === completionText),
  );
}

const packageSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

export function verifyReactZip(filename: string) {
  const path = resolve(filename);
  if (statSync(path).size > 50 * 1024 * 1024)
    throw new Error("ZIP exceeds 50 MiB validation limit");
  const unzip = (args: string[], maxBuffer = 2 * 1024 * 1024) =>
    execFileSync("unzip", args, {
      encoding: "utf8",
      maxBuffer,
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const entries = unzip(["-Z1", path]).trim().split("\n");
  if (
    entries.length > 10000 ||
    new Set(entries).size !== entries.length ||
    entries.some(
      (name) =>
        name.startsWith("/") ||
        name.includes("\\") ||
        name.split("/").includes("..") ||
        [...name].some((character) => character.charCodeAt(0) < 32) ||
        /[*?[\]]/.test(name),
    )
  )
    throw new Error("ZIP has unsafe, duplicate, or excessive entries");
  const read = (entry: string) => unzip(["-p", path, entry]);
  const hello = entries.find((entry) => entry === "hello.txt" || entry.endsWith("/hello.txt"));
  if (!hello || read(hello) !== "42")
    throw new Error("ZIP must preserve hello.txt containing exactly 42");
  for (const manifest of entries.filter(
    (entry) => /(^|\/)package\.json$/.test(entry) && !entry.includes("node_modules/"),
  )) {
    const parsed = packageSchema.safeParse(JSON.parse(read(manifest)));
    if (!parsed.success) continue;
    const pkg = parsed.data;
    const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
    if (!dependencies.react || !dependencies["react-dom"] || !pkg.scripts?.build) continue;
    const root = manifest.slice(0, -"package.json".length);
    const sources = entries.filter(
      (entry) =>
        entry.startsWith(root) &&
        /\.(tsx|jsx|js|ts)$/.test(entry) &&
        !entry.includes("node_modules/"),
    );
    const source = sources.find((entry) =>
      /(?:from\s*|import\s*|require\s*\()\s*["']react(?:-dom)?(?:\/[^"']*)?["']/.test(read(entry)),
    );
    if (source && entries.includes(`${root}index.html`)) {
      // Evidence that the app carries data, recorded rather than required: a
      // source that is down on the day must not fail the run by itself.
      const dataRoot = `${root}public/data/`;
      const dataFiles = entries.filter(
        (entry) =>
          entry.startsWith(dataRoot) && !entry.endsWith("/") && !/SOURCES\.md$/i.test(entry),
      );
      const sourcesNote = entries.some(
        (entry) =>
          /^public\/data\/SOURCES\.md$/i.test(entry.slice(root.length)) && entry.startsWith(root),
      );
      return {
        manifest,
        source,
        entries: entries.length,
        hello,
        data: { files: dataFiles.length, sources: sourcesNote },
      };
    }
  }
  throw new Error(
    "ZIP lacks a React app: require react/react-dom, build script, index.html and React source imports",
  );
}
