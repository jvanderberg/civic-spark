# Coordinated backup on the existing Fly Machine

This is a reviewed **operator procedure**, not authorization to perform a live restart. Root/deployment owner schedules the window, checks participant activity and provisioning, and approves the exact app, Machine, volume and images. No cloud action is run by adding this feature. The [management recovery runbook](backup-restore.md) defines the authoritative scope and artifact format.

## Mechanism

The existing `deploy/fly/Dockerfile` image now supports `CIVIC_SPARK_MAINTENANCE=backup`. Its entrypoint requires the real `/data` mount and the existing, non-symlink `/data/civic-spark` directory, then runs **only `/usr/bin/sleep infinity` as node (uid 1000)**. It does not import the application, open databases, acquire the writer lock, initialize missing data, decode secrets, run a model, start HTTP or execute participant code. Unknown or explicitly empty mode values fail closed. Direct application startup also rejects maintenance mode, so an accidental `npm start` cannot bypass the entrypoint choice. `off` (the default) uses normal startup. There is no timeout or automatic return to serving; repeated maintenance restarts remain in maintenance.

Use the **same existing Machine and volume**, with an immutable reviewed image digest containing this entrypoint and `scripts/backup.ts`. A command override alone does not bypass the hardcoded entrypoint. No second writer, replacement volume, separate deployment app or snapshot clone is needed. The Machine remains running, so authenticated operator exec and SFTP work while the application is offline. Health checks are expected to fail during maintenance; they must not be interpreted as permission to redeploy/restart into normal mode.

Machine update, SSH and SFTP flags below were checked against the installed reviewed Fly CLI 0.4.104 and [Machine update documentation](https://fly.io/docs/flyctl/machine-update/), [SSH console documentation](https://fly.io/docs/flyctl/ssh-console/). Local shell tests use command doubles; actual Linux uid/mount/SSH behavior still requires root's authorized live acceptance.

## Preflight

- Record the original Machine configuration, exact serving image digest and server source SHA privately. Confirm the single Machine ID and unchanged `/data` volume ID against the retained provisioning receipt. Do not dump environment or secret values to a terminal/log.
- Keep the encryption key in a separate secret-manager/private-key location; never place it in the archive directory or transfer it with the off-machine artifact. Do not enable shell tracing or Fly debug/verbose output. Raw Machine configuration belongs only in mode-0600 operator files, never capture transcripts.
- Root may use its existing build pipeline to build/push the reviewed maintenance-capable image **without starting it**. Record that image digest separately from the original serving image. The backup's `installation.release` is the source SHA that last served/wrote this state; record the maintenance tooling SHA/image separately in the operator recovery note.
- Coordinate ingress closure, active Share/provisioning completion and any ambiguous reserved resource. Do not stop participant turns unannounced. Ensure no other deployment automation can update this Machine during maintenance. Keep administration credentials only on the operator host.
- Prepare the private operator package and independent encryption key as described in the recovery runbook. Verify available space on `/data` for an encrypted copy plus existing state; the format is not compressed. The archive destination is a **sibling** of the source tree, never inside it.

Set the following nonsecret variables from the reviewed receipt/image records; no personal app, org, Machine or image is a default:

```sh
: "${CIVIC_SPARK_APP:?set the reviewed app}"
: "${CIVIC_SPARK_MACHINE:?set the existing single Machine ID}"
: "${CIVIC_SPARK_MAINTENANCE_IMAGE:?set the reviewed image digest}"
: "${CIVIC_SPARK_ORIGINAL_IMAGE:?set the original serving image digest}"
```

## Enter the approved maintenance window

After explicit root approval and the preflight is complete:

```sh
fly machine update "$CIVIC_SPARK_MACHINE" --app "$CIVIC_SPARK_APP" \
  --image "$CIVIC_SPARK_MAINTENANCE_IMAGE" \
  --env CIVIC_SPARK_MAINTENANCE=backup --skip-health-checks --yes
```

This restarts that Machine, so prior server shutdown must already be coordinated. `--skip-health-checks` allows the intentional absence of an HTTP listener; it does not skip backup integrity or the exclusive writer check. Verify the same Machine is running, same volume attached, the maintenance log message appears, and public application health fails. Do not run `fly deploy` concurrently. If the update fails, inspect the actual Machine image/mode before acting; do not blindly assume either normal or maintenance operation.

Create input staging on tmpfs and an encrypted-output directory on the volume. These are operator-owned task directories, outside the management source tree. Existing input staging makes this command fail, so stale keys/jobs are not overwritten silently:

```sh
fly ssh console --app "$CIVIC_SPARK_APP" --machine "$CIVIC_SPARK_MACHINE" -C \
  'sh -c "umask 077; mkdir /dev/shm/civic-spark-backup-input && chown node:node /dev/shm/civic-spark-backup-input && install -d -m 0700 -o node -g node /dev/shm/civic-spark-backup-input/operator /data/civic-spark-backups"'
```

Use the retained authoritative operator files; do not recover participant keys or read private Sprite bodies. Upload credentials as files over authenticated SFTP, never as command arguments or shell literals:

```sh
fly ssh sftp put --app "$CIVIC_SPARK_APP" --machine "$CIVIC_SPARK_MACHINE" --user node --mode 0600 \
  /private/recovery/keys/management.key /dev/shm/civic-spark-backup-input/management.key
fly ssh sftp put --app "$CIVIC_SPARK_APP" --machine "$CIVIC_SPARK_MACHINE" --user node --mode 0600 \
  /private/recovery/operator/setup.json /dev/shm/civic-spark-backup-input/operator/setup.json
fly ssh sftp put --app "$CIVIC_SPARK_APP" --machine "$CIVIC_SPARK_MACHINE" --user node --mode 0600 \
  /private/recovery/operator/receipt.json /dev/shm/civic-spark-backup-input/operator/receipt.json
fly ssh sftp put --app "$CIVIC_SPARK_APP" --machine "$CIVIC_SPARK_MACHINE" --user node --mode 0600 \
  /private/recovery/operator/service-secrets.json /dev/shm/civic-spark-backup-input/operator/service-secrets.json
# Required when the installation has a retained preview relay secret:
fly ssh sftp put --app "$CIVIC_SPARK_APP" --machine "$CIVIC_SPARK_MACHINE" --user node --mode 0600 \
  /private/recovery/operator/preview-relay-secret /dev/shm/civic-spark-backup-input/operator/preview-relay-secret
```

Upload any additional files in the reviewed recovery package the same way. Do not omit email/provider/auth secret material because it was already available in the original Machine's environment: recovery needs an independent retained source. Do not copy an entire laptop working directory into this package.

Prepare `/private/recovery/maintenance-job.json` using the exact installation tuple from the main runbook, and these Machine paths:

```json
{
  "dataRoot":"/data/civic-spark",
  "operatorRoot":"/dev/shm/civic-spark-backup-input/operator",
  "destination":"/data/civic-spark-backups/backup-TIMESTAMP-UUID",
  "keyFile":"/dev/shm/civic-spark-backup-input/management.key",
  "installation": {
    "id":"installation-id-from-retained-receipt", "authMode":"demo",
    "release":"0000000000000000000000000000000000000000",
    "origin":"https://event.example.test",
    "spriteOrg":"operator-selected-sprite-org", "spriteApiOrigin":"https://api.sprites.dev"
  },
  "coordinatedOffline":true,
  "operatorFiles":{"configuration":"setup.json","receipt":"receipt.json","secrets":"service-secrets.json"}
}
```

Replace all placeholders; use a new timestamp/UUID on every capture. Upload and run as the application user:

```sh
fly ssh sftp put --app "$CIVIC_SPARK_APP" --machine "$CIVIC_SPARK_MACHINE" --user node --mode 0600 \
  /private/recovery/maintenance-job.json /dev/shm/civic-spark-backup-input/job.json
fly ssh console --app "$CIVIC_SPARK_APP" --machine "$CIVIC_SPARK_MACHINE" -C \
  'sh -c "cd /app && exec setpriv --reuid=node --regid=node --init-groups node --import tsx scripts/backup.ts create /dev/shm/civic-spark-backup-input/job.json"'
```

Creation acquires the original data root's exclusive writer lock; any unexpected application writer causes failure. This is the final machine-enforced exclusion in addition to the coordinated maintenance state. Only a backup ID and completion flags are printed. Failure leaves maintenance active and does not overwrite an existing archive. Inspect configuration and storage privately; do not bypass the lock.

## Retrieve, validate off-machine, and rehearse

On the independent operator/backup host, use private storage and the exact artifact name from the job:

```sh
umask 077
fly ssh sftp get --app "$CIVIC_SPARK_APP" --machine "$CIVIC_SPARK_MACHINE" --user node --recursive \
  /data/civic-spark-backups/backup-TIMESTAMP-UUID /private/recovery/archives/backup-TIMESTAMP-UUID
chmod 700 /private/recovery/archives/backup-TIMESTAMP-UUID
npm run backup -- validate /private/recovery/off-machine-restore-job.json
npm run backup -- restore /private/recovery/off-machine-restore-job.json
```

`off-machine-restore-job.json` uses that local archive, the independently stored local key, the identical installation tuple, and a **new absent** local target beneath `/private/recovery/rehearsals/`. The main runbook supplies its schema. Review its private `RESTORE-REPORT.json` and Git/auth/ownership/origin validation, and verify the startup fence exists. **Do not run `resume` or start the restored app for this rehearsal**: it shares real reservations/origins. The first backup is not accepted until this retrieved copy validates and the isolated restore completes. Retain the encrypted original until off-machine retention is established. The volume copy alone is not disaster recovery.

## Exit maintenance deliberately

Once root has accepted the off-machine validation and rehearsal, remove only this task's tmpfs inputs. Keep the independent key and operator source package in their approved secure stores:

```sh
fly ssh console --app "$CIVIC_SPARK_APP" --machine "$CIVIC_SPARK_MACHINE" -C \
  'setpriv --reuid=node --regid=node --init-groups rm -rf /dev/shm/civic-spark-backup-input'
fly machine update "$CIVIC_SPARK_MACHINE" --app "$CIVIC_SPARK_APP" \
  --image "$CIVIC_SPARK_ORIGINAL_IMAGE" --env CIVIC_SPARK_MAINTENANCE=off --yes
```

Returning to the original image avoids bundling an unrelated application release with backup acceptance. Root can separately deploy a newer reviewed release afterward. Verify public health, original Machine/volume identity, sign-in, and owner workspace reattachment without a model turn. Sessions on the original live data were **not** revoked by backup; only the isolated restore revokes sessions. Update the private operator maintenance record with archive ID, image pair, timestamps, off-machine validation and rehearsal result.

If retrieval/rehearsal fails, preserve the original data and finalized archive. Root can explicitly return the original Machine to serving after deciding how to close the maintenance window; that decision must not be reported as a successful backup. There is no automatic rollback, cloud deletion, volume replacement, forced Git push or model invocation in this procedure.

Local validation (September 16, 2026): shell syntax check, `npm run check` (196 tests / 40 files, lint, both typechecks and build) and clean deployment-context build (133 inputs) passed. Entry tests cover ordinary startup, maintenance restarts without data writes or app startup, absent data refusal, unknown/empty mode rejection, direct app-start fencing and operator lock access. This is shell/source validation; first Linux Machine, uid/mount and SSH/SFTP acceptance remains an explicitly authorized root operation.
