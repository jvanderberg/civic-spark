import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../apps/server/src/app.ts";
import type { LoginEmail } from "../apps/server/src/email.ts";
import { importToSite, readProjectIdeas } from "../scripts/import-project-ideas.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const source = "https://github.com/example-org/ideas";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-ideas-"));
  roots.push(root);
  mkdirSync(join(root, "starter-projects"));
  writeFileSync(
    join(root, "starter-projects", "00-pitch-your-own.md"),
    "# Pitch your own\n\nCard.",
  );
  writeFileSync(
    join(root, "starter-projects", "01-is-my-assessment-fair.md"),
    "# Is my assessment fair?\n\n**Civic question:** Are similar homes assessed alike?\n\n**Data:** [values](../data/values.csv), [catalog](../data/open-data-catalog.md#assessor), [portal](https://example.org/data)\n\n**Difficulty:** Beginner.\n\n**Readiness:** Ready now, data cached in this repo.\n",
  );
  writeFileSync(
    join(root, "project-ideas.md"),
    [
      "# Ideas",
      "## Featured Challenges",
      "### 1. Assessment Check",
      "**Now a starter project:** [brief 01](starter-projects/01-is-my-assessment-fair.md).",
      "---",
      "### 2. Capital Projects Near Me",
      "**Civic question:** What is being built near me?",
      "**Difficulty:** Intermediate",
      "---",
      "## Suggested Challenge-Card Template",
      "### Project title",
      "**Civic question:**",
      "",
    ].join("\n\n"),
  );
  return root;
}

it("imports starter briefs and non-duplicate challenges with GitHub links", () => {
  const ideas = readProjectIdeas(fixture(), source);
  expect(ideas.map((idea) => idea.name)).toEqual([
    "Is my assessment fair?",
    "Capital Projects Near Me",
  ]);
  const [starter, idea] = ideas;
  expect(starter?.tags).toEqual(["Starter project", "Beginner", "Ready now"]);
  expect(starter?.brief).toContain(
    "(https://raw.githubusercontent.com/example-org/ideas/main/data/values.csv)",
  );
  expect(starter?.brief).toContain(
    "(https://github.com/example-org/ideas/blob/main/data/open-data-catalog.md#assessor)",
  );
  expect(starter?.brief).toContain("(https://example.org/data)");
  expect(idea?.brief.startsWith("# Capital Projects Near Me\n\n**Civic question:**")).toBe(true);
  expect(idea?.brief).not.toContain("---");
  expect(idea?.tags).toEqual(["Project idea", "Intermediate"]);
});

it("adds ideas to a site's event as an owner signed in by code, skipping existing names", async () => {
  const root = mkdtempSync(join(tmpdir(), "civic-spark-import-site-"));
  roots.push(root);
  const outbox: LoginEmail[] = [];
  // The address is only known after listening; the server's origin must match it.
  const probe = await createApp(join(root, "probe"), false);
  await probe.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (probe.app.server.address() as AddressInfo).port;
  await probe.app.close();
  const origin = `http://127.0.0.1:${port}`;
  const previous = process.env.CIVIC_SPARK_OWNERS;
  process.env.CIVIC_SPARK_OWNERS = "owner@example.test";
  const { app } = await createApp(join(root, "site"), false, origin, {
    configured: true,
    async send(message) {
      outbox.push(message);
    },
  });
  try {
    await app.listen({ host: "127.0.0.1", port });
    const code = async (email: string) => {
      const message = outbox.findLast((entry) => entry.email === email);
      if (!message) throw new Error("Missing code");
      return message.code;
    };
    const ideas = readProjectIdeas(fixture(), source);
    const io = { askCode: code, log: () => {} };
    await expect(importToSite(origin, "owner@example.test", ideas, io)).rejects.toThrow(
      "Create the site's event first",
    );
    // The owner signs in with an emailed code and creates the site's one event.
    const post = (path: string, body: object, cookie = "") =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(body),
      });
    await post("/api/auth/sign-in/magic-link", {
      email: "owner@example.test",
      callbackURL: origin,
    });
    const signedIn = await post("/api/auth/sign-in/email-otp", {
      email: "owner@example.test",
      otp: await code("owner@example.test"),
    });
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const created = await post(
      "/api/events",
      {
        name: "Day in Our Data",
        date: "2026-10-03",
        timezone: "America/Chicago",
        location: "Library",
        capacity: 40,
        budget: 20,
        templateId: "blank",
      },
      cookie,
    );
    expect(created.status).toBe(200);
    expect(await importToSite(origin, "owner@example.test", ideas, io)).toEqual({
      added: 2,
      skipped: 0,
    });
    expect(await importToSite(origin, "owner@example.test", ideas, io)).toEqual({
      added: 0,
      skipped: 2,
    });
    await expect(importToSite(origin, "someone@example.test", ideas, io)).rejects.toThrow();
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.CIVIC_SPARK_OWNERS;
    else process.env.CIVIC_SPARK_OWNERS = previous;
  }
});
