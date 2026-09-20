import { expect, it } from "vitest";
import { integrationRequestSchema } from "../apps/server/src/relay/integration-runner.ts";

it("accepts the agent's fetch request alongside status and publish", () => {
  for (const operation of ["git-status", "git-publish", "git-fetch"])
    expect(
      integrationRequestSchema.parse({ id: "2b7c1f7e-0d5f-4c9e-9a1e-7c3a1f9d2b10", operation })
        .operation,
    ).toBe(operation);
  expect(
    integrationRequestSchema.safeParse({
      id: "2b7c1f7e-0d5f-4c9e-9a1e-7c3a1f9d2b10",
      operation: "git-pull",
    }).success,
  ).toBe(false);
});
