import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { z } from "zod";
import { runParticipant } from "./participant-load.ts";
import { redact, scenarioSchema } from "./participant-scenario.ts";

async function main() {
  const [filename, mode] = process.argv.slice(2);
  if (!filename || !["--validate", "--live"].includes(mode ?? ""))
    throw new Error(
      "Usage: npm run test:participant-cohort -- roster.json --validate|--live (1-50 people)",
    );
  const roster = z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .parse(JSON.parse(readFileSync(filename, "utf8")));
  const scenarios = roster.map((file) =>
    scenarioSchema.parse(JSON.parse(readFileSync(resolve(dirname(filename), file), "utf8"))),
  );
  for (const values of [
    scenarios.map((s) => s.id),
    scenarios.map((s) => s.participant.email.toLowerCase()),
    scenarios.map((s) => s.teamName),
  ])
    if (new Set(values).size !== scenarios.length)
      throw new Error("Each person needs a unique ID, email and team name");
  if (mode === "--validate") {
    console.log(`Validated ${scenarios.length} concurrent scenarios`);
    return;
  }
  for (const scenario of scenarios) {
    if (scenario.timing.completionWaitMs < 300000)
      throw new Error("Live completion checks must wait five minutes");
    if (!process.env[scenario.credentialEnv]?.trim())
      throw new Error(`Set ${scenario.credentialEnv} in the environment`);
  }
  const output = resolve(
    "artifacts",
    "participant-load",
    `cohort-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
  );
  mkdirSync(output, { recursive: true, mode: 0o700 });
  console.log(`Cohort evidence: ${output}`);
  // One isolated browser context per person (separate cookies, storage and
  // sockets), sharing a browser process per ten people so fifty fit in memory.
  // All start together; provisioning still respects the application's limit.
  const browsers = await Promise.all(
    Array.from({ length: Math.ceil(scenarios.length / 10) }, () =>
      chromium.launch({ headless: !scenarios.some((s) => s.browser.headed) }),
    ),
  );
  // Spread arrivals like a real room filling up; this also keeps sign-ins under
  // the per-address demo throttle when many people share one test machine.
  const staggerMs = z.coerce
    .number()
    .int()
    .min(0)
    .max(60000)
    .parse(process.env.CIVIC_SPARK_LOAD_STAGGER_MS ?? "0");
  const results = await Promise.all(
    scenarios.map(async (scenario, index) => {
      await new Promise((resolve) => setTimeout(resolve, staggerMs * index));
      const directory = join(output, scenario.id);
      mkdirSync(directory, { mode: 0o700 });
      const key = process.env[scenario.credentialEnv]?.trim() as string;
      const browser = browsers[Math.floor(index / 10)];
      if (!browser) throw new Error("Browser allocation failed");
      let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
      try {
        context = await browser.newContext({
          acceptDownloads: true,
          viewport: { width: scenario.browser.width, height: scenario.browser.height },
          colorScheme: scenario.browser.theme,
          hasTouch: scenario.browser.width <= 390,
        });
        const result = await runParticipant(scenario, key, directory, await context.newPage());
        return {
          scenario: scenario.id,
          passed: true,
          traceId: result.traceId,
          elapsedMs: result.elapsedMs,
        };
      } catch (error) {
        return {
          scenario: scenario.id,
          passed: false,
          error: redact(error instanceof Error ? error.message : String(error), key),
        };
      } finally {
        await context?.close();
      }
    }),
  );
  await Promise.all(browsers.map((browser) => browser.close()));
  writeFileSync(join(output, "cohort.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(
    error instanceof z.ZodError
      ? "Invalid roster/scenario configuration"
      : redact(error instanceof Error ? error.message : String(error)),
  );
  process.exitCode = 1;
});
