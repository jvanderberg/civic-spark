import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { includedInContext } from "../scripts/deployment-context-check.ts";

it("matches Docker directory re-inclusion and explicit descendant exclusions", () => {
  const oldRules = ["**", "!scripts/", "!scripts/prepare-pty.ts"];
  expect(includedInContext("scripts/browser-smoke.ts", oldRules)).toBe(true);
  const rules = readFileSync(".dockerignore", "utf8").split("\n");
  expect(includedInContext("scripts/browser-smoke.ts", rules)).toBe(false);
  expect(includedInContext("scripts/prepare-pty.ts", rules)).toBe(true);
  expect(includedInContext("scripts/backup.ts", rules)).toBe(true);
  expect(includedInContext("deploy/fly/local-token.json", rules)).toBe(false);
  expect(includedInContext("deploy/fly/Dockerfile", rules)).toBe(true);
  expect(includedInContext("deploy/fly/preview-ingress.Dockerfile", rules)).toBe(true);
  expect(includedInContext("apps/server/.data/private-token", rules)).toBe(false);
  expect(includedInContext("packages/agents/src/credentials.ts", rules)).toBe(true);
});
