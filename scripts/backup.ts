import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeploymentSecrets } from "../apps/server/src/deployment-secrets.ts";
import { absentDestination, writePrivate } from "../packages/backup/src/archive.ts";
import {
  createBackup,
  createSchema,
  pruneBackups,
  restoreBackup,
  restoreSchema,
  retentionSchema,
} from "../packages/backup/src/backup.ts";
import { resumeRestore, resumeSchema } from "../packages/backup/src/recovery.ts";

export async function main(args: string[]) {
  const [command, path] = args;
  if (
    !path ||
    args.length !== 2 ||
    !["keygen", "create", "validate", "restore", "resume", "prune"].includes(command ?? "")
  )
    throw new Error(
      "Usage: npm run backup -- keygen KEY_FILE | create JOB.json | validate RESTORE.json | restore RESTORE.json | resume RECONCILE.json | prune RETENTION.json",
    );
  if (command === "keygen") {
    absentDestination(resolve(path));
    writePrivate(resolve(path), randomBytes(32));
    return { keyCreated: true };
  }
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (command === "prune") return pruneBackups(retentionSchema.parse(config));
  if (command === "resume") {
    loadDeploymentSecrets();
    return resumeRestore(resumeSchema.parse(config));
  }
  if (command === "create") {
    const result = await createBackup(createSchema.parse(config));
    // Never print filenames, identities, reservations, origins, secrets or provider output.
    return {
      backupId: result.backupId,
      finalized: true,
      spritePrivateState: result.spritePrivateState,
    };
  }
  return restoreBackup(restoreSchema.parse(config), command === "validate");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  main(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      // Zod issues and filesystem/provider errors can contain private source values.
      console.error(
        "Backup/recovery failed. Inspect the destination and recovery fence before startup. Check private configuration, offline writer lock, key, artifact integrity and target permissions; see docs/backup-restore.md.",
      );
      process.exitCode = 1;
    });
}
