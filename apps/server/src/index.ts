import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { completePendingRestore } from "./backups.ts";
import {
  acquireWriter,
  assertApplicationMode,
  deploymentSettings,
  storageReady,
  validateDeployment,
} from "./deployment.ts";
import { loadDeploymentSecrets } from "./deployment-secrets.ts";

// Check before reading local configuration, decoding the secret envelope, or importing app code.
assertApplicationMode();
if (existsSync(".env")) process.loadEnvFile(".env");
// Local configuration may itself enable maintenance.
assertApplicationMode();
process.umask(0o077);
loadDeploymentSecrets();
const settings = deploymentSettings();
const root = resolve(process.env.CIVIC_SPARK_DATA_DIR ?? ".data");
validateDeployment(
  root,
  process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:4310",
  process.env.CIVIC_SPARK_AUTH_MODE ?? "email",
);
// A restore staged by the admin console is applied before any store is opened.
try {
  completePendingRestore(root);
} catch (error) {
  console.error(
    `Civic Spark cannot apply the staged restore: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exit(1);
}
const release = acquireWriter(root);
try {
  storageReady(root);
  const { createApp } = await import("./app.ts");
  let stopping = false;
  const stop = (afterClose: () => void) => {
    if (stopping) return;
    stopping = true;
    // Forced shutdown releases the writer lock; durable provisioning phases recover on boot.
    setTimeout(() => process.exit(1), 25000).unref();
    void app.close().then(() => {
      release();
      afterClose();
    });
  };
  const { app } = await createApp(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () =>
      stop(() => {
        // Apply the swap now so the data is restored even if nothing restarts this process.
        try {
          completePendingRestore(root);
        } catch (error) {
          console.error(
            `Civic Spark restore swap failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
        console.log("Civic Spark is exiting to complete a restore; start it again to resume.");
        process.exit(settings.hosted ? 3 : 0);
      }),
  );
  await app.listen({ port: settings.port, host: settings.host });
  console.log(`Civic Spark control plane listening on port ${settings.port}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => stop(() => process.exit(0)));
} catch {
  release();
  console.error(
    "Civic Spark startup failed. Check deployment configuration, volume permissions and required secrets.",
  );
  process.exitCode = 1;
}
