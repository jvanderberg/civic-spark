import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app.ts";
import {
  acquireWriter,
  deploymentSettings,
  storageReady,
  validateDeployment,
} from "./deployment.ts";
import { loadDeploymentSecrets } from "./deployment-secrets.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
process.umask(0o077);
loadDeploymentSecrets();
const settings = deploymentSettings();
const root = resolve(process.env.CIVIC_SPARK_DATA_DIR ?? ".data");
validateDeployment(
  root,
  process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:4310",
  process.env.CIVIC_SPARK_AUTH_MODE ?? "email",
);
const release = acquireWriter(root);
try {
  storageReady(root);
  const { app } = await createApp(root);
  await app.listen({ port: settings.port, host: settings.host });
  console.log(`Civic Spark control plane listening on port ${settings.port}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      // Forced shutdown releases the writer lock; durable provisioning phases recover on boot.
      setTimeout(() => process.exit(1), 25000).unref();
      void app.close().then(() => {
        release();
        process.exit(0);
      });
    });
} catch {
  release();
  console.error(
    "Civic Spark startup failed. Check deployment configuration, volume permissions and required secrets.",
  );
  process.exitCode = 1;
}
