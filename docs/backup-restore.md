# Management backup and disaster recovery

Civic Spark disaster recovery covers **all management state and shared Git**, plus an encrypted operator recovery package. Sprites are intentionally ephemeral for this recovery policy. Unshared Sprite working trees, saved model keys, private provider conversations, process memory and terminal sessions are **not backed up**. Share often, with the participant's explicit approval for the current changes. Backup never publishes work. Normal pause/wake still preserves existing Sprites; this policy does not authorize deleting them.

`npm run backup -- create JOB.json` creates a versioned, authenticated encrypted directory artifact. `validate` decrypts into a private temporary root, verifies it, rehearses session invalidation and removes the temporary root. `restore` performs those checks and publishes an isolated, **startup-fenced** recovery directory. Neither restore command starts the application, executes backed-up source/configuration, contacts a provider, changes cloud resources, or overwrites an existing destination.

## Authoritative inventory

| Store | Recovery treatment |
| --- | --- |
| `auth.sqlite` and WAL/SHM | All users, account/auth associations, verification status, rate-limit rows and auth schema captured. Restore deletes active sessions and outstanding verification/login tokens; user/account IDs remain intact. |
| `access.sqlite` and WAL/SHM | Entire database, including users, event admin/member roles, active/inactive memberships, `event_execution` and `workspace_runtime` lifecycle tables and future tables. No JSON projection that loses unknown fields. |
| `state.sqlite` and WAL/SHM | Events, projects and exact Markdown descriptions, teams including deleted teams, workspace IDs, reserved Sprite names, provisioning phases/errors, contributions, activity and future state. |
| `repos/` | Complete bare repositories, all refs and tags, reachable and unreachable objects, reflogs, configuration. Validation checks objects and refs in a separately constructed inert Git directory; backed-up hooks, config, filters and source are never run. |
| `workspaces/`, `integration/` | Existing management-side checkouts and all files, including local unshared edits if present. This does not extend to Sprite files. Local Git clones may hard-link objects: archive stores independent copies of their bytes. |
| `agent-integrations/`, seed `*.bundle` | Retained owner conflict tickets and provisioning material. They remain fenced pending review; no queued action is replayed by the restore tool. |
| `preview-origins.json` | Permanent workspace-origin bindings, including removed workspaces. Must never be reassigned. Reconciliation must also recover bindings allocated **after** the chosen backup from the surviving gateway/volume or later backups. |
| Remaining persisted data tree | Every regular file and directory, unknown/future files, local `auth-secret`, writer-lock SQLite file, auth-mode subtrees and inert symlink metadata. Nothing is silently filtered. Sockets/devices, external Git alternates/worktrees and linked authoritative state fail validation. External symlink targets are not followed or included. |
| Operator package, outside data root | Retained setup configuration, installation/resource receipt, exact service secrets and preview relay secret, plus any additional operator files supplied in this private directory. Entire directory encrypted; never a browser/team export. |
| Sprite resources | Reserved names remain management state. Private files/keys/history and checkpoints are outside this DR scope. Restored accounts regain only shared work if a Sprite is lost; users must save a new model key. |
| Browser/device state | Unsaved browser drafts, local-folder content/permissions/baselines and browser storage are outside the management backup. |

The root is `CIVIC_SPARK_DATA_DIR`, **not just its `demo/` or `prototype/` child**. Those modes isolate stores and cookies; the backup captures the entire parent and requires the same active auth mode at restore. Demo/prototype accounts cannot be restored as verified-email production users.

## Consistency and coordination

The implementation uses the same SQLite exclusive writer lock as server startup. It refuses a running management writer and holds the lock across validation and copying all stores. Source inventory metadata is checked again before finalization. SQLite files and their journals are kept together. This is an offline coordinated recovery point, not live cross-store crash atomicity.

Before each hosted backup, the deployment owner must coordinate a maintenance window: block new ingress/writes, allow active Share/provisioning operations to complete, confirm no provider allocation request remains in flight, and stop the single management process. Do not abruptly stop participant turns or invoke lifecycle pause-all without coordination. Sprite-private turns need not be checkpointed for this policy, but they must not be allowed to publish or allocate through another management writer during the window. Out-of-band Git/volume/config writers must also be excluded. A hung/unknown allocation must be inspected by reserved name and recorded in the operator receipt before resuming operation. `coordinatedOffline: true` is the operator's assertion of these preconditions; the tool does not orchestrate a Fly stop or infer external consistency from a database lock.

The backup process may create/open the writer-lock database and SQLite read coordination sidecars. It does not change domain state, stop services, run models or publish commits. Existing private files must not be read for discovery; the management archive is an explicitly privileged operator operation.

Do not copy a live volume into a temporary directory and bypass its writer lock: copying while the source runs defeats the consistency contract. A provider snapshot taken only after the same coordinated stop can be mounted on an isolated recovery host and then archived. Resume the original management process only after capture finishes and the deployment owner confirms the maintenance window is over.

## Prepare private recovery inputs

Run the checked-out, reviewed release with its npm lockfile (`npm ci`). Keep this source release/build image and Node/Git versions available independently; source code is not bundled in the data archive. Set `spriteOrg` to `null` only for installations with no Sprite reservations. The provider organization/API origin are part of the expected installation identity; reconciliation cannot switch them. The manifest records application `civic-spark`, package version `0.1.0`, archive version `1`, a required 40-character release SHA, installation ID, auth mode and origin. Supply the **deployed** release SHA at creation and the identical expected value at recovery; the operator must independently verify the executable release. The script does not guess a deployed SHA from an unrelated laptop checkout.

Use a private, nonsymlink parent directory on a sufficiently large volume. On macOS use the real path (`/private/tmp`, not the `/tmp` symlink). Restored directories are 0700 and files are 0600, retaining only the owner's executable bit. No group/world permissions, setuid bits, ownership changes or archive-provided ACLs are applied. Restore as the intended runtime uid (container uid 1000) or explicitly adjust ownership of the new recovery tree before deployment. Do not recursively chown live participant data.

```sh
umask 077
mkdir -p /private/recovery/keys /private/recovery/archives /private/recovery/operator /private/recovery/rehearsals
chmod 700 /private/recovery/keys /private/recovery/archives /private/recovery/operator /private/recovery/rehearsals
npm run backup -- keygen /private/recovery/keys/management.key
```

The key is exactly 32 random bytes, mode 0600. Store it separately from archives in the operator's secret manager with an independently tested recovery path. Losing it makes the archives unrecoverable. Never put keys or credential values in argv, source, logs, shell tracing or team exports. No unencrypted backup option exists. Each file uses AES-256-GCM with a fresh random nonce, authenticated path, and SHA-256 of plaintext in the encrypted manifest. The manifest is encrypted/authenticated too; numbered blob files reveal sizes/counts, not filenames. `FINALIZED` authenticates completeness via the encrypted manifest hash and its expected file set; cryptographic trust comes from the secret key, not the public hash.

Populate `/private/recovery/operator` from the authoritative secret manager and retained setup directory, without printing their contents:

- `setup.json`: exact origin/app/org/region/auth-mode/provider/email/proxy/resource-limit/preview configuration.
- `receipt.json`: original setup receipt, resource creation identities, Machine/volume IDs and all permanent preview app/origin assignments.
- `service-secrets.json`: **complete** original service-secret input (auth encryption/signing key, Sprite orchestration token, email credentials as applicable). Preserve the managed deployment envelope if it is the authoritative source too.
- `preview-relay-secret`: retained relay secret from the ignored setup directory, when previews are configured. It is needed in addition to the original service-secret input.
- An operator recovery note identifying secret-manager access, administration credential recovery, DNS/TLS ownership, image digest and any interrupted reservations. Fly administration credentials stay in the operator secret manager; do not install them in the control plane. Include a separate encrypted operator credential file only if the organization's recovery policy requires it.

The tool requires explicit configuration/receipt/secrets filenames and encrypts **all** files in that directory. It cannot prove that an operator supplied current, complete credentials; rehearse decrypting and validating them without printing values. Do not reuse signing material from another installation or silently migrate credentials. Plaintext input files and rehearsal roots require private storage and operator-controlled cleanup; unlinking is not secure erasure on SSD/snapshotted storage.

Create a mode-0600 job JSON outside both source trees (all paths operator-configurable):

```json
{
  "dataRoot": "/data/civic-spark",
  "operatorRoot": "/private/recovery/operator",
  "destination": "/private/recovery/archives/backup-2026-09-16T180000Z-00000000-0000-4000-8000-000000000001",
  "keyFile": "/private/recovery/keys/management.key",
  "installation": {
    "id": "installation-id-from-retained-receipt",
    "authMode": "demo",
    "release": "0000000000000000000000000000000000000000",
    "origin": "https://event.example.test",
    "spriteOrg": "operator-selected-sprite-org",
    "spriteApiOrigin": "https://api.sprites.dev"
  },
  "coordinatedOffline": true,
  "operatorFiles": {"configuration":"setup.json","receipt":"receipt.json","secrets":"service-secrets.json"}
}
```

Replace the placeholder installation ID/release/origin with the recorded deployed values. No personal organization is assumed.

```sh
# Only after deployment-owner coordination and the one writer has stopped:
npm run backup -- create /private/recovery/backup-job.json
```

Artifacts appear at their final name only after file sync and atomic directory rename. Failed operations remove their temporary directory when possible; process/machine death may leave `.civic-spark-*-partial-*` directories. They are not valid backups and must never be renamed into final artifacts. A new run uses a new temporary directory and refuses to overwrite any existing destination. Inspect/remove abandoned partials manually on private storage after verifying no process is using them.

## Off-machine copies and retention

Copy the **whole encrypted artifact directory** to a separately administered host/storage destination. Standard SSH/SFTP/rsync over authenticated SSH is sufficient; configure host/key/destination using the operator's SSH config and verify host keys. No Fly private network or new storage vendor is required. Example, after setting operator-owned nonsecret paths:

```sh
# SSH alias 'backup-vault' is operator configuration with verified host key.
# Precreate a mode-0700 incoming directory on that host; keep the key elsewhere.
rsync -a --checksum --chmod=D700,F600 /private/recovery/archives/backup-ID/ backup-vault:/srv/civic-spark/incoming/backup-ID/
```

Run `validate` on the receiving host using the separately recovered key and an isolated private scratch root; then rename the incoming artifact to its final retained path on that same filesystem. Alternatively fetch the replica back into a different private root and validate there. Transfer success/size alone is not a recovery test. Provider volume snapshots (currently seven days in the Fly setup) are an additional convenience, **not** an independent off-provider backup. Choose a schedule and retention count appropriate to accepted shared-work loss; no daemon, maintenance stop, cloud storage charge or deletion schedule is silently installed by this feature.

Retention defaults to keeping everything. Explicit `npm run backup -- prune RETENTION.json` accepts `{directory, replicaDirectory, keep, keyFile, installation}`. Both directories must be private, real, separate trees; `keep` is at least 1; `installation` is the same expected tuple used for restore. Point `replicaDirectory` at an authenticated mounted off-machine replica or at independently retrieved replica artifacts. The tool cannot establish geographic/provider independence of a mount: that is operator configuration. It considers only conventional `backup-TIMESTAMP-UUID` finalized directories, newest filesystem modification time first. For every candidate it requires a byte-identical encrypted manifest in the replica and **fully validates both archives** before deleting any local candidate. Missing/corrupt replicas abort the entire prune. Unknown files and partials remain untouched; replicas are never deleted. Test transfer tools preserving mtime if retention must track original capture order. Daily/weekly/monthly selection can be handled by the existing scheduler using the same CLI. Never prune the last good independently recoverable copy or its key. Do not make archive directories world-readable to accommodate a transfer account.

## Validate and restore into a new root

Create a private restore job with the exact expected installation tuple from the independent receipt:

```json
{
  "archive": "/private/recovery/archives/backup-ID",
  "target": "/private/recovery/rehearsals/recovered-ID",
  "keyFile": "/private/recovery/keys/management.key",
  "installation": {
    "id":"installation-id-from-retained-receipt",
    "authMode":"demo",
    "release":"0000000000000000000000000000000000000000",
    "origin":"https://event.example.test",
    "spriteOrg":"operator-selected-sprite-org",
    "spriteApiOrigin":"https://api.sprites.dev"
  }
}
```

```sh
npm run backup -- validate /private/recovery/restore-job.json
npm run backup -- restore /private/recovery/restore-job.json
```

The target must not exist, even as an empty directory or dangling symlink. It receives `data/`, `operator/`, decrypted `manifest.json`, and `RESTORE-REPORT.json`, all operator-private. Validation compares identities and ownership associations, full Git ref/HEAD inventories and object integrity, and preview binding uniqueness. Every file has authenticated encryption and a verified hash. Restore invalidates sessions and outstanding login links in every captured auth subtree. Authenticated users must sign in again. Lifecycle pause/hold rows and resource names are preserved, and interrupted provisioning is never replayed by this tool. The encrypted original remains unchanged so another rehearsal is repeatable.

`data/.civic-spark-recovery.json` prevents startup via `validateDeployment` before application/service/runtime constructors. **Do not remove it for a rehearsal.** Rehearsals need no Sprite token or network access. Unknown SQLite/Git content is inspected as data: Git validation only copies objects/refs/HEAD into a clean temporary directory with isolated configuration. Backed-up source, hooks, aliases, filters, commands and package installers are not invoked.

## Activation is a separate reviewed recovery operation

`resume` is an explicit operator reconciliation command, separate from restore; it clears the startup fence only after validation. It performs authenticated provider metadata GET requests and records recovery permissions, with no cloud creation, checkpoint restore, force push, or live overwrite. A feature request or successful rehearsal does not authorize production cutover. The deployment owner must explicitly approve the recovered installation after reviewing:

1. The original writer is fenced/stopped. Never run two management installations with the same reserved cloud resources, Git histories, or origins. Compare shared repository heads with the newest surviving state; preserve newer published commits instead of force-pushing an older snapshot over them.
2. Every reserved Sprite name is inspected in the original organization using provider metadata only. Authentication/network/timeouts/5xx are unknown outcomes, **not missing resources**. Surviving resources retain the same IDs/names and owner associations. Account for reservations made after the selected recovery point from provider inventory and later receipts; never allocate a replacement ID to hide uncertainty.
3. Every preview origin retains its original workspace binding, including allocations after this backup. Merge the surviving permanent binding ledger into the recovered one without changing any existing mapping or recycling deleted workspaces. If the later ledger cannot be recovered, retire those uncertain origins permanently and provision a new origin pool by an explicitly approved deployment step. Never guess which old origin is safe to reuse.
4. Provider service definitions or still-running relays/turns cannot publish/replay commands on reconnect. Restore does not stop them: coordinate participants and inspect/drain them before activation. Review retained `resolving` integration tickets and pending lifecycle stops; do not treat a prior approval as permission for new publication/model work.
5. Review local management checkout Git configuration for paths pointing to the old root; adjust only local repository origins to the recovered shared repositories before using a relocated root. Backed-up Git configuration/hooks were stored but never executed by validation. Review untrusted configuration before allowing normal Git operations. Hosted deploy should retain its original `/data/civic-spark` runtime path.
6. Validate operator setup/receipt/secrets, expected release/mode, runtime uid, proxy boundary, origin/DNS/TLS and private preview routing. Preserve original auth encryption material for stored accounts; sessions are already revoked. Restore to a **new volume/app first**; do not run provisioning against a live app to turn a rehearsal into a deployment.

After those reviews and **separate approval for this recovered installation**, write a private reconciliation job. Copy `installation` exactly from the restore job, set `backupId` from the restore report, and supply the complete permanent origin ledger (including later allocations):

```json
{
  "target":"/private/recovery/rehearsals/recovered-ID",
  "backupId":"00000000-0000-4000-8000-000000000001",
  "installation": {
    "id":"installation-id-from-retained-receipt", "authMode":"demo",
    "release":"0000000000000000000000000000000000000000",
    "origin":"https://event.example.test",
    "spriteOrg":"operator-selected-sprite-org", "spriteApiOrigin":"https://api.sprites.dev"
  },
  "spriteOrg":"operator-selected-sprite-org", "spriteApiOrigin":"https://api.sprites.dev",
  "previewBindings": {},
  "sourceWriterFenced":true, "sharedGitReviewed":true, "previewLedgerComplete":true,
  "providerActivityReviewed":true, "operatorCredentialsReviewed":true
}
```

The example empty ledger is valid only if no origins were ever assigned. Existing bindings cannot be removed or changed; the merged ledger must have distinct origin hostnames. `resume` cannot establish whether a later binding ledger is missing, whether another installation was stopped, or whether provider turns were drained: those explicit operator attestations require independent review. They are not inferred from elapsed time or backup success.

```sh
# Load SPRITE_TOKEN or CIVIC_SPARK_SECRETS_B64 privately from the original secret manager.
# Never place credentials in command arguments, logs or the reconciliation JSON.
npm run backup -- resume /private/recovery/reconcile-job.json
```

The script verifies the token's selected organization and the authenticated provider organization response. Each reservation receives a metadata GET: only exact 404 establishes missing; matching 200 means present; 401/403/429/5xx, redirects, malformed identity and network failures retain the fence. No participant files, bodies, keys or processes are read. The provider binding must match the encrypted backup's installation tuple. See [provider metadata API](https://sprites.dev/api/sprites).

The outer marker is version 1: `{version:1, backupId, installationId, authMode, release, status:"pending-reconciliation", createdAt}`. Its presence fails closed regardless of contents. `resume` writes the durable mode-root `.civic-spark-recovery-resources.json`, merged origins and private `RECONCILIATION.json` before clearing that fence. A crash before removal remains fenced and can be retried. The original archive and source are untouched.

The recovery-resource marker is version 1: `{version, backupId, provider:"sprites", org, apiOrigin, entries:[{workspaceId, spriteName, status:"confirmed-missing", observedAt, httpStatus:404}]}`. It grants only a fresh existence check on **explicit owner reopen**, not automatic startup or a model turn. Lifecycle integration must recheck the same name in the same organization immediately before creation; create only on fresh positive missing evidence; keep workspace/user/team IDs and permanent preview origin; seed only canonical shared Git; and retain the marker through failure until ready. Existing resources resume without overwrite. Durable event pause remains authoritative throughout every provisioning phase. Normal retry has no missing-resource recreation fallback. Users must supply a new model key if an ephemeral Sprite was lost.

The helper and resume path are tested here; owner-reopen provisioning is a separate lifecycle integration and must pass its mocked absent/existing/transient-provider tests before a deployment uses missing-resource recovery. Do not deploy only the helper and claim end-to-end owner recovery is complete. No live recreation or deletion is needed for those tests.

## Current cloud dependencies and limitations

The current hosted installation depends on its single persistent management volume/Machine, Fly app/origin/TLS and permanent preview ingress app/Machine pool, Sprite organization and surviving named resources, auth secret, preview relay secret and (email mode) sender credentials/delivery. The off-machine management archive plus independent secrets/source recovery removes dependence on a **volume snapshot alone**. It does not restore provider accounts, DNS ownership, deleted Sprite-private work, process memory, or automatically replace cloud infrastructure. Missing-resource owner recovery requires the matching lifecycle integration described above. The portable boundary remains standard authenticated protocols and configurable deployment/provider identities.

Provider checkpoint/export research is no longer required for the accepted scope. [Sprites' checkpoint documentation](https://docs.sprites.dev/concepts/checkpoints/) describes filesystem rather than memory recovery, and destructive restore semantics; no checkpoint calls are made by this feature. User-defined provider services may restart on provider wake, so the startup fence cannot replace external reconciliation.

## Verification

`npm run test:backup` uses private temporary roots, actual Better Auth databases, actual domain events/projects/teams/memberships, real local Git commits/refs and synthetic secrets. It checks email/demo/prototype round trips, lifecycle table/unknown-file preservation, restart fencing, session invalidation, dry-run cleanup, repeated restore, writer contention, wrong key/mode/release/installation, corruption and incomplete artifacts, existing-target protection, path/link attacks and inert Git configuration. The explicit resume tests use mocked provider metadata, preserve newer origin reservations and verify failures retain the fence. `npm run check` includes these tests. No live data, participant files, provider calls, model inference, deployment or publication is needed.
