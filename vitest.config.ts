import { defineConfig } from "vitest/config";
// Tests run every Sprite child in-process unless a test enables relay workers itself.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    env: { CIVIC_SPARK_RELAY_WORKERS: "0" },
  },
});
