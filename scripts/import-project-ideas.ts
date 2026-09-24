import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

// Imports Day in Our Data project ideas: every starter brief (starter-projects/NN-*.md,
// except 00 "pitch your own") and each challenge in project-ideas.md that is not already a
// starter project. Relative links become GitHub links; data files link to raw downloads so
// agents in a workspace can fetch them.
export const defaultSource = "https://github.com/oak-park-cisc/Oak_Park_Day_in_our_Data";
export type ProjectIdea = { id: string; name: string; brief: string; tags: string[] };

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const briefLimit = 10000;
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function githubLinks(markdown: string, file: string, source: string, branch: string) {
  const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(source)?.[1];
  if (!repo) return markdown;
  return markdown.replace(/\]\(([^)\s]+)\)/g, (match, target: string) => {
    if (/^(?:[a-z]+:|#|\/\/)/i.test(target)) return match;
    const [path = "", fragment] = target.split("#");
    const resolved = posix.normalize(posix.join(posix.dirname(file), path));
    if (resolved.startsWith("..")) return match;
    const raw = /\.(csv|geojson|json|py|txt)$/i.test(resolved);
    const url = raw
      ? `https://raw.githubusercontent.com/${repo}/${branch}/${resolved}`
      : `https://github.com/${repo}/blob/${branch}/${resolved}${fragment ? `#${fragment}` : ""}`;
    return `](${url})`;
  });
}
function field(markdown: string, name: string) {
  return new RegExp(`\\*\\*${name}:\\*\\*\\s*([^\\n]+)`).exec(markdown)?.[1]?.trim();
}
function tagsFor(markdown: string, kind: string) {
  const tags = [kind];
  const difficulty = field(markdown, "Difficulty");
  const readiness = field(markdown, "Readiness");
  // Keep the label only: "Ready now, data cached in this repo" becomes "Ready now".
  for (const value of [difficulty, readiness])
    if (value) tags.push(value.split(/[,;(]/)[0]?.replace(/\.$/, "").trim() ?? "");
  return tags.filter((tag) => tag && tag.length <= 40);
}

export function readProjectIdeas(root: string, source = defaultSource, branch = "main") {
  const ideas: ProjectIdea[] = [];
  const starterDirectory = join(root, "starter-projects");
  for (const file of readdirSync(starterDirectory).sort()) {
    if (!/^\d{2}-.+\.md$/.test(file) || file.startsWith("00-")) continue;
    const text = readFileSync(join(starterDirectory, file), "utf8").trim();
    const name = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (!name) throw new Error(`${file} has no title`);
    ideas.push({
      id: slug(file.replace(/^\d{2}-|\.md$/g, "")),
      name,
      brief: githubLinks(text, `starter-projects/${file}`, source, branch),
      tags: tagsFor(text, "Starter project"),
    });
  }
  const guide = readFileSync(join(root, "project-ideas.md"), "utf8");
  const sections = guide.split(/^(?=#{2,3} )/m);
  for (const section of sections) {
    const title = /^### \d+\.\s+(.+)$/m.exec(section)?.[1]?.trim();
    // Challenges already turned into starter briefs were imported above.
    if (!title || /Now a starter project/.test(section)) continue;
    const body = section
      .replace(/^### .+\n/, "")
      .replace(/\n-{3,}\s*$/, "")
      .trim();
    const brief = githubLinks(`# ${title}\n\n${body}\n`, "project-ideas.md", source, branch);
    ideas.push({ id: slug(title), name: title, brief, tags: tagsFor(body, "Project idea") });
  }
  for (const idea of ideas) {
    if (idea.name.length > 100) throw new Error(`Project name too long: ${idea.name}`);
    if (idea.brief.length > briefLimit)
      throw new Error(`Brief over 10,000 characters: ${idea.name}`);
  }
  if (new Set(ideas.map((idea) => idea.name.toLowerCase())).size !== ideas.length)
    throw new Error("Duplicate project names in the source");
  return ideas;
}

function checkout(source: string) {
  if (existsSync(source)) return { root: resolve(source), cleanup: () => {} };
  const root = mkdtempSync(join(tmpdir(), "civic-spark-ideas-"));
  const clone = spawnSync("git", ["clone", "--quiet", "--depth", "1", source, root], {
    stdio: "inherit",
  });
  if (clone.status !== 0) throw new Error(`Could not clone ${source}`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Replace the DIOD event template's projects with the imported ideas. */
export function writeTemplate(
  ideas: ProjectIdea[],
  path = join(repositoryRoot, "templates/events/diod.json"),
) {
  const template = JSON.parse(readFileSync(path, "utf8"));
  template.projects = ideas.map(({ id, name, brief, tags }) => ({
    id,
    name,
    description: brief,
    tags,
  }));
  writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`);
}

export type SiteIO = {
  askCode: (email: string) => Promise<string>;
  log: (message: string) => void;
  request?: typeof fetch;
};
/**
 * Sign in to a site as an owner with an emailed code, then add each idea to the site's
 * event. Projects whose names already exist there are skipped, so reruns are safe.
 */
export async function importToSite(
  origin: string,
  email: string,
  ideas: ProjectIdea[],
  io: SiteIO,
) {
  const request = io.request ?? fetch;
  let cookie = "";
  const call = async (path: string, method = "GET", body?: object) => {
    const response = await request(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const set = response.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((value) => value.split(";")[0]).join("; ");
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok)
      throw new Error(
        data.error ?? data.message ?? `${method} ${path} failed (${response.status})`,
      );
    return data;
  };
  const anonymous = await call("/api/session");
  if (anonymous.authMode === "demo") {
    const sent = await call("/api/demo/sign-in", "POST", { email });
    if (!sent.codeSent) throw new Error(`${email} is not an owner of this site`);
  } else
    await call("/api/auth/sign-in/magic-link", "POST", {
      email,
      callbackURL: origin,
      errorCallbackURL: origin,
    });
  const code = (await io.askCode(email)).replace(/\D/g, "");
  await call("/api/auth/sign-in/email-otp", "POST", { email, otp: code });
  try {
    const session = await call("/api/session");
    const eventId: string | undefined = session.siteEvent?.id;
    if (!eventId) throw new Error("Create the site's event first, then import projects");
    const state = await call("/api/state");
    const event = state.events.find((candidate: { id: string }) => candidate.id === eventId);
    if (event?.role !== "admin") throw new Error(`${email} is not an admin of the site's event`);
    const existing = new Set(
      event.projects.map((project: { name: string }) => project.name.trim().toLowerCase()),
    );
    let added = 0;
    for (const idea of ideas) {
      if (existing.has(idea.name.toLowerCase())) {
        io.log(`Skipped (already there): ${idea.name}`);
        continue;
      }
      await call(`/api/events/${eventId}/projects`, "POST", { name: idea.name, brief: idea.brief });
      io.log(`Added: ${idea.name}`);
      added++;
    }
    return { added, skipped: ideas.length - added };
  } finally {
    await call("/api/auth/sign-out", "POST", {}).catch(() => {});
  }
}

function siteTarget(target: string) {
  if (/^https:\/\//.test(target)) return { origin: new URL(target).origin, owner: undefined };
  const setup = join(
    process.env.CIVIC_SPARK_STATE_DIR ?? join(homedir(), ".local/state/civic-spark/sites"),
    target,
    "setup.json",
  );
  if (!existsSync(setup))
    throw new Error(`No saved site named ${target}; pass its https:// address`);
  const saved = z
    .object({ origin: z.string(), owners: z.array(z.string()) })
    .parse(JSON.parse(readFileSync(setup, "utf8")));
  return { origin: saved.origin, owner: saved.owners[0] };
}

async function main() {
  const [mode, target, source = defaultSource] = process.argv.slice(2);
  const usage =
    "Usage: npm run site:import-projects -- template [source]\n       npm run site:import-projects -- <site-name|https://address> [source]";
  if (!mode) throw new Error(usage);
  const repo = mode === "template" ? (target ?? defaultSource) : source;
  const { root, cleanup } = checkout(repo);
  try {
    const ideas = readProjectIdeas(root, /^https:/.test(repo) ? repo : defaultSource);
    if (mode === "template") {
      writeTemplate(ideas);
      // Match the repository's JSON formatting so the regenerated file passes lint.
      spawnSync("npx", ["biome", "format", "--write", "templates/events/diod.json"], {
        cwd: repositoryRoot,
        stdio: "ignore",
      });
      console.log(`Wrote ${ideas.length} projects to templates/events/diod.json`);
      return;
    }
    const site = siteTarget(mode);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const email = site.owner ?? (await prompt.question("Owner email: ")).trim();
      console.log(`Importing ${ideas.length} projects into ${site.origin} as ${email}`);
      const result = await importToSite(site.origin, email, ideas, {
        askCode: (address) => prompt.question(`Sign-in code emailed to ${address}: `),
        log: (message) => console.log(message),
      });
      console.log(`Done: ${result.added} added, ${result.skipped} already there.`);
    } finally {
      prompt.close();
    }
  } finally {
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Import failed");
    process.exitCode = 1;
  });
