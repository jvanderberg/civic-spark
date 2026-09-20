# Civic Spark control plane on Fly

This package deploys signup, administration, static UI, authenticated APIs, SQLite and team Git on **one Fly Machine with one encrypted volume**. Participant programs, agents and terminals execute only in Sprites. The setup helper creates only the explicitly selected installation resources. Choose deployment inputs before running the cloud-mutating steps below.

The explicit demo has passed live Linux startup, idle volume restart, public demo sign-in and dedicated Sprite workspace checks; see the live record below. This is not production certification: sender delivery, token rotation, full backup/restore and resource lifecycle recovery remain unverified. Public previews now use each existing Sprite's native HTTPS URL and HTTP service. No preview ingress app, Machine, domain, origin pool, extra port or authentication gateway is required. Dedicated native-provider acceptance passed HTTP/assets/Vite HMR, Stop/Launch and warm-sleep subsequent access; cold restart remains unverified. Earlier private gateway evidence applies only to the retired design.

## Requirements and inputs

Use Node **22.23.2**, npm with the committed lockfile, Fly CLI **0.4.104** and Sprite CLI **2026-09-02 (6390abf)**. Fly's CLI runs only on the operator/CI host, not in the image. Sprite CLI in the image is downloaded from the committed release manifest and checked against its SHA-256. The Node image uses a multiarchitecture digest; Debian packages resolve from a fixed September 15, 2026 snapshot. Native dependencies build from source during `npm ci`. Python, Git and Sprite are trusted control-plane tools; this does not permit executing participant code on the Machine.

Choose app name, Fly organization, region, exact public HTTPS origin, Sprite organization, sender and limits. No account name is a product default. `org` and `spriteOrg` can differ; Fly's personal-organization selector is not necessarily the Sprite token's organization slug. Read the selectors from the authenticated CLIs; do not infer one from the other.

`proxyCidrs` specifies the immediate peers allowed to supply `Fly-Client-IP`. The example uses the Fly Machine proxy network; verify it in the selected deployment before inviting users. The generated app has a dedicated Fly network and listens on IPv4 `0.0.0.0`, not its IPv6 private-network address. Do not broaden trust to every address or add unrelated workloads to that network. `X-Forwarded-For`, host and proto do not establish identity or the canonical origin. TLS cookies derive from `BETTER_AUTH_URL`; application and WebSocket origins are exact. An untrusted peer's IP headers are ignored. On another provider use `CIVIC_SPARK_PROXY=none` or implement that provider's explicit peer boundary. No Git or Sprite operation depends on Fly private networking.

Production defaults to `email` authentication and requires complete Resend or SMTP settings. SMTP permits port 587 with required STARTTLS or 465 with immediate TLS. Verify the sender domain externally. Local prototype sign-in remains unavailable publicly: a public bind, production environment or hosted deployment rejects prototype mode at startup.

## Explicit hosted demo

For a fresh, intentionally unverified demonstration, set `authMode: "demo"` in setup JSON (`CIVIC_SPARK_AUTH_MODE=demo` at runtime). Omit `emailProvider`, `emailFrom` and email credentials; only `SPRITE_TOKEN` and `BETTER_AUTH_SECRET` are required. The UI warns that anyone entering the same email can access that demo account. Use demo data and disposable model credentials only. Demo users retain `emailVerified: false` with an explicit demo identity marker; they are never promoted or migrated to verified users.

For a site dedicated to one hackathon, set optional `siteEventId` in setup JSON to the existing event UUID. Setup emits `CIVIC_SPARK_SITE_EVENT_ID`; this runtime setting needs no frontend rebuild. Create the event in the appropriate auth-mode data store before enabling it. Startup rejects malformed IDs or an event missing from that store instead of choosing another event. The session response supplies the event name for sign-in, navigation and the document title; anonymous visitors only receive names of registration/live events. Draft/closed names remain limited to authorized event members. A configured event unavailable to a signed-in visitor shows an explicit not-open message.

The pinned portal shows only that event's projects, teams and workspaces, with no event switcher or create-event UI. An old workspace URL from another event cannot switch the portal. Event admins retain project/team management. This is installation navigation scope, not a replacement for API membership/role authorization; the domain and authenticated multi-event management APIs remain reusable. Omit the setting to retain the multi-event portal. Never copy an ID between isolated demo/prototype/production data stores or migrate identities to make it resolve.

Demo metadata is under the separate `demo/` data subtree, with a separate `civic-spark-demo` cookie namespace and Secure cookies on HTTPS. Email mode uses the original separate root and accepts verified identities only; prototype remains loopback-only with its own root/cookies. Changing mode does not import accounts or resources.

The public demo sign-in route limits requests before account/session writes using the normalized trusted client IP. `CIVIC_SPARK_AUTH_REQUESTS_PER_MINUTE` sets its budget (default 20). The fixed one-minute windows are process-local and reset on restart; the map holds at most 10,000 clients and rejects new clients when full. This is request throttling, not a lifetime account/storage quota. Plan management storage and transient command concurrency for the expected workload; there is no total Sprite allocation quota. See [capacity and recovery](capacity-resilience.md). The organization token can manage its organization's Sprites, not just this demo's resources.

## Public native previews

Launch prepares the existing project's supported npm dependencies inside its Sprite, preserves the configured command and port, and creates/updates the single `civic-spark-web-preview` provider service with that HTTP port. A private launcher clears inherited credentials and allows only the exact provider-reported hostname through Vite's host check. Launch then enables public URL authentication. No model key, agent harness, paid inference, source generation or Share is involved.

Open preview checks the signed-in owner, current session, event gate, Sprite identity and server readiness, then returns the provider-reported HTTPS URL. Status/Open do not change public authentication or install dependencies. Public URLs have no Civic Spark ticket/cookie and remain usable after management signout. Management restart does not remap their origin. App traffic and WebSockets go directly to the provider, not through management.

Public means anyone can visit the configured app. **Ordinary inactivity and explicit Stop/Pause differ.** At the unchanged five-minute participant inactivity threshold, management holds workspace APIs and detaches agent/terminal/integration bridges. It does not stop the public service. Subsequent status polls are denied before any Sprite exec, allowing native hibernation without intentionally breaking the URL. The provider documents quiet services as compatible with sleep; active public HTTP/WebSocket traffic may keep the Sprite awake and billable.

Admin Pause (individual, all Sprites or event) still drains and stops services/exec work, including the preview. Preview Stop also stops its current service and retains the definition. These actions do not revoke the public URL, but **a stopped service needs owner Launch again** (after unpausing the event/reopening the workspace). Root's dedicated smoke observed `failed`, no PID, exit 143 after Stop, zero matching processes, and anonymous HTTP 502 rather than auto-start. Status polling never restarts it. Launch reapplies the same definition and explicitly starts it if not already running. Public requests do not carry the portal's event/session gate; this is not a provider network lockdown.

Retained setup must remove `previewIngress`, `previewPoolSize`, `previewOriginTemplate` and obsolete `maxSprites`; there are no aliases. Remove old `CIVIC_SPARK_PREVIEW_ORIGIN_POOL`, `CIVIC_SPARK_PREVIEW_ORIGIN_TEMPLATE` and relay settings from generated runtime configuration. Retain old `preview-origins.json`, original provisioning receipt and secret backup as historical records; native routing neither reads nor reassigns old origins. Deleted ingress apps are never recreated. The retired `preview-provision` action is unavailable. Stage any secret cleanup explicitly through the deployment owner.

The standard Sprite organization credential (`SPRITE_TOKEN`) supplies authenticated provider metadata/update requests; it never reaches the browser or app environment. Other runtime providers must supply their own stable per-workspace public HTTPS endpoint and HTTP service adapter. [Sprite services](https://docs.sprites.dev/concepts/services/), [Sprite URLs](https://docs.sprites.dev/working-with-sprites/).

Local `npm run test:hosted-preview-browser` covers direct TLS, real Vite assets/HMR and Launch/Open at 360/390/desktop/short widths in both themes with provider doubles. It does not certify cold wake or physical devices. Root separately verified loopback-bound anonymous native HTTPS200, same-name service update, Stop producing no process/HTTP502, and explicit service start restoring HTTPS200 on one dedicated Sprite. Live dedicated Vite assets/WebSocket HMR and subsequent HTTP200 after observed warm suspension passed on runtime400c345; full cold restart remains unverified. Owner Stop/Launch recovery, same Sprite/URL, no browser cookies and no new Fly resources passed. The temporary fixture was removed and prior test configuration restored. See docs/handoff.md for exact evidence and scope.

## Prepare locally

Run commands from the repository root. The helper anchors Fly's working directory and build context to that root. Its generated Dockerfile path is relative to the nested TOML directory, matching Fly's actual config resolution; the explicit CLI argument alone does not override that behavior. Its public config schema rejects unknown properties, so secrets cannot accidentally be added to configuration.

```sh
npm ci --prefer-offline --no-audit --no-fund
mkdir -p .data/fly
cp deploy/fly/setup.example.json .data/fly/setup.json
# Edit .data/fly/setup.json with the coordinated deployment inputs.
export CIVIC_SPARK_SETUP="$PWD/.data/fly/setup.json"
npx tsx scripts/fly-setup.ts plan "$CIVIC_SPARK_SETUP"
npm run check
npm run test:deploy-context
```

For SMTP set `emailProvider` to `smtp` and add `smtpHost` and `smtpPort` (465 or 587) in the public JSON. `emailFrom` is the verified sending address, optionally with a display name. A custom origin also requires its DNS and Fly certificate before sign-in; the default `app.fly.dev` certificate is managed by Fly.

The generated `.data/fly/<app>/fly.toml` and ownership receipt are private operator state, excluded from Git and the image. Preserve the receipt when moving operator hosts. A preexisting app without its receipt is refused. If creation succeeded but the operator crashed before the receipt was written, inspect the app/org/network/volumes/Machines manually, then recover a receipt containing only its verified `app`, `org`, and `region`. Do not blindly adopt an existing app. The helper refuses extra Machines, unexpected volume names/regions/sizes, and changed organization/receipt inputs. Volume extension, recovery and region migration are separate coordinated operations.

## Authenticate explicitly

```sh
# Interactive authentication (only needed if the sessions are absent/expired):
npx tsx scripts/fly-setup.ts auth "$CIVIC_SPARK_SETUP"
# Or reuse locally authenticated CLIs; read-only identity/list checks:
npx tsx scripts/fly-setup.ts auth "$CIVIC_SPARK_SETUP" --ambient
```

CI may supply its Fly app/org provisioning token through Fly's supported environment, never an argv flag. App creation/volume provisioning require suitable operator scope; an app-scoped deploy token is preferable for subsequent deployment. Neither the operator's Fly token nor its local CLI configuration is copied into the image or installed as an application secret. Ambient CLI authentication is convenient locally; it is not the deployed service credential.

Create a dedicated **Sprites token** in the selected organization using the Sprites account/token interface. Its documented CLI format is `org-slug/org-id/token-id/token-value`; the helper checks that contract and selected slug. That syntactic check does not prove authorization. The separate `verify-sprites` action performs an authenticated, read-only API list probe and discards all names/metadata. A Sprites organization token can manage that organization's Sprites; do not claim it is event-scoped or limited to a name prefix. Use a dedicated organization if unrelated resources require isolation. It is not a general Fly admin token.

Save all managed credentials as a JSON object in a password manager or a mode-0600 file **outside the repository**. The required keys are `SPRITE_TOKEN`, `BETTER_AUTH_SECRET` (at least 32 random characters), and `RESEND_API_KEY`; for SMTP replace the Resend key with `SMTP_USER` and `SMTP_PASSWORD`. In explicit demo mode omit the email credentials. No real credentials belong in examples, shell history, command arguments or tickets. Keep the auth secret stable across repeat setup and Sprite token rotation.

```sh
# Set this to an existing private JSON file outside this checkout; values are not argv.
export CIVIC_SPARK_SECRETS_FILE=/private/tmp/civic-spark-secrets.json
chmod 600 "$CIVIC_SPARK_SECRETS_FILE"
npx tsx scripts/fly-setup.ts verify-sprites "$CIVIC_SPARK_SETUP" < "$CIVIC_SPARK_SECRETS_FILE"
```

Do not use `set -x`, Fly `--debug`, process-environment dumps or request-body logging around credentials. The helper suppresses provider/CLI output and validates the allowed secret names. Fly's importer does not JSON-unescape quoted strings; the helper therefore sends **one base64 JSON envelope**, `CIVIC_SPARK_SECRETS_B64`, to `fly secrets import --stage` via stdin. Base64 is encoding, not encryption: protection comes from Fly's encrypted secret storage and access control. Startup validates every name/type before any environment mutation, decodes the envelope into the service's credential variables and removes the envelope from its environment. Malformed envelopes fail with fixed diagnostics. The pinned Sprite CLI reads `SPRITE_TOKEN` from the environment with a fresh container home; no `auth setup --token` argument, laptop keychain or persistent credentials file is needed. No secret enters participant project files or browser responses.

## Cloud actions — run after reviewing deployment inputs

```sh
# Creates/reuses only the named app and exactly one matching volume; does not deploy.
npx tsx scripts/fly-setup.ts provision "$CIVIC_SPARK_SETUP"
# Validates receipt, remote org and resources; stages secrets without updating Machines.
npx tsx scripts/fly-setup.ts secrets "$CIVIC_SPARK_SETUP" < "$CIVIC_SPARK_SECRETS_FILE"
# Validates again; builds with explicit repository context and creates/updates one Machine.
npx tsx scripts/fly-setup.ts deploy "$CIVIC_SPARK_SETUP"
```

Provisioning and repeated deployment reuse matching resources. There is no automatic deletion, scale-out, volume replacement or forced Git push. `--ha=false` and immediate deployment avoid a second writer; the SQLite exclusive writer lock additionally prevents two control-plane processes opening the same data root. Scheduled volume snapshots retain seven days. The Machine stays running so connected integrations are not idled unexpectedly. Deployments briefly interrupt the single Machine; this is not high availability. Graceful shutdown waits up to 25 seconds for provisioning, then permits restart reconciliation.

For Docker locally, use the repository root as context:

```sh
docker build -f deploy/fly/Dockerfile -t civic-spark-control-plane .
```

The entrypoint requires `/data` to be an actual mount. It initializes `/data/civic-spark` as uid/gid 1000, gives that user ownership of the volume root itself (non-recursively, so admin-console backups, staged restores and replaced data roots can be created beside the data directory) and runs Node without root privileges. Existing imported files must already be owned by that user; it intentionally does not recursively rewrite recovery data ownership. A missing mount or unwritable data directory fails startup. The default-deny `.dockerignore` includes only source/build inputs and rejects nested `.env`, data, Git, artifacts and credential files. The two `credentials.ts` modules and `deployment-secrets.ts` are trusted **source**, explicitly included. The clean-context test runs TypeScript/Vite from only those staged inputs, attaching local dependencies afterward; it does not substitute for Linux/native/container execution.

## Operator CLI identity

The entrypoint precreates `/home/node/.sprites` as uid/gid 1000 with mode 0700 before dropping privileges. Sprite initializes local CLI state even when authentication comes from `SPRITE_TOKEN`. It does not recursively change ownership of existing files.

Run **all operator Sprite probes as the app user**, with `HOME=/home/node`, including read-only list/status/exec checks. A root Machine console inherits the container's node HOME: running Sprite directly there can create root-owned CLI state and block subsequent app provisioning. Use `setpriv --reuid=node --regid=node --init-groups` before the probe process; when loading the secret envelope, decode it inside that process without printing values. Never put a token in argv.

If provisioning fails, inspect sanitized CLI diagnostics and the reserved Sprite's API existence before retrying. Check ownership of the CLI directory and its children separately. Repair only confirmed CLI-state ownership; never recursively chown participant data, clear credentials, replace the workspace, or allocate a different name to hide the failure. Use the existing workspace's preparation retry after repair.

September 16 live recovery: a root-run operator probe created an empty root-owned `.sprites` directory. The app's create command then failed before its API request with a local config permission error. Correcting only that empty directory and retrying the original reservation completed actual fresh Sprite creation, checkout and file-access verification without a management restart or participant file replacement. The CLI flag, token and provider quota were not the cause.

## Durability, recovery and limits

Keep the **entire** `/data/civic-spark` tree together: `auth.sqlite`, `access.sqlite`, `state.sqlite` and WAL/SHM siblings, bare `repos/`, local `workspaces/`, `agent-integrations/` conflict tickets, provisioning seed bundles and the writer-lock database. Auth signing material comes from Fly secrets and must accompany disaster recovery. Provider session IDs, conversation journals, saved model keys and runtime configuration live privately in each person's persistent Sprite. Do not export those directories into shared Git. Restarting the management app does not stop participant turns or erase their sessions; reconnect reattaches the saved context.

Provisioning reserves a full-UUID Sprite name and persists each phase before the external action. Startup marks interrupted jobs as retryable errors through the event service, without automatically creating resources or running models. Owner retry probes the same name and uses the existing non-destructive checkout script. Unknown provider outcomes never allocate another name. Deleted/revoked workspaces retain resources for recovery. There is no total allocation cap. `maxProvisioning` bounds concurrent setup calls; busy responses do not consume an allocation quota, and the participant app retries them automatically with backoff while showing that it is waiting for a slot. Agent preparation on a just-woken Sprite is retried up to three times server-side before it reports failure, and the app retries a failed preparation quietly once more before showing an error. `CIVIC_SPARK_MAX_COMMANDS` bounds transient Sprite CLI operations (default 16); large file operations have two transfer slots and matching concurrent polling reads coalesce. These are backpressure controls, not a dollar budget, orphan-resource detector or account/workspace quota. No paid inference is used in checks.

Git sharing uses the existing authenticated owner-authorized bundle transport over the Sprite API; bare repositories are durable on the volume. There is no public unauthenticated Git endpoint or assumed `.internal` remote. Continuous hosted Smart HTTP/mTLS Git and its certificate/revocation review remain future work; standard configurable authenticated HTTPS remains the portability contract.

Use the [scriptable encrypted backup/restore runbook](backup-restore.md) for the **entire management data tree**, all shared Git refs/objects and a separately supplied encrypted operator recovery package. Coordinate writes/provisioning and the one management writer before capture; the CLI refuses its active writer lock. Restore to a new root/volume first, revoke sessions, validate identities/Git/origins, then explicitly reconcile provider metadata and permanent preview bindings before startup. Sprite private edits/keys/history/processes are intentionally disposable in this DR scope; normal reconnect still preserves surviving Sprites. Missing resources require the matching explicit owner-reopen lifecycle recovery integration; never reset IDs or force-push newer shared history. Fly snapshots alone are not independent off-provider backups. First live/off-machine rehearsal, cutover, cross-store crash atomicity and orphan reconciliation remain operator work.

The existing image also has an explicit `CIVIC_SPARK_MAINTENANCE=backup` entrypoint mode for a coordinated offline capture on the same Machine/volume. It runs only sleep as uid 1000; HTTP/application startup stays off until an explicit `off` update. Follow the [maintenance capture, off-machine validation and rehearsal commands](fly-backup-maintenance.md); no live operation is implied by installing this capability.

## Rotation and live acceptance

Rotation replaces the **entire managed credential set** in the envelope. Update the Sprite token in the private input while retaining the auth/email secrets, run `verify-sprites`, stage `secrets`, then `deploy` to activate. After health, sign-in, existing workspace reconnect and a dedicated disposable Sprite probe succeed, revoke the old token. If activation fails, restage the old complete set and redeploy while it remains valid. Intentional auth-secret rotation invalidates sessions. Delete temporary secret files according to operator policy after staging; preserve the authoritative copy securely. Fly organization members with deployment/exec privileges can access application secrets.

Before admitting participants, the deployment operator must verify:

- Exactly one Machine and volume, expected app/org/region, public TLS origin and secure cookie flags; HTTP redirects to HTTPS. Health is minimal and unauthenticated, reports 503 for unavailable storage, and does not expose users or secrets.
- Real sender delivery and single-use link signup, logout, return login; spoofed forwarded headers and unverified sessions do not authorize APIs. No prototype sign-in on the public origin. Another user and an event admin cannot attach to private workspaces, agent or terminal sockets.
- Fresh-volume ownership, Machine restart with saved sessions/Git/tickets, and interrupted provisioning retry against the same dedicated Sprite. API create/exec/tunnel connectivity uses the deployed token without a laptop. Never use participant Sprites as test resources.
- Token rotation and revocation, bounded operation concurrency, configured private preview opening, unauthorized-origin/session rejection, and documented backup/restore rehearsal. Live model inference requires separate authorization and is not part of this checklist.

## Official sources checked September 16, 2026

- [Fly volumes and their durability constraints](https://fly.io/docs/volumes/overview/), [volume creation](https://fly.io/docs/flyctl/volumes-create/), [secrets import via stdin and staging](https://fly.io/docs/flyctl/secrets-import/).
- [Fly deployment options](https://fly.io/docs/flyctl/deploy/), [app configuration and health checks](https://fly.io/docs/reference/configuration/), [proxy request headers](https://fly.io/docs/networking/request-headers/), [IPv4 services versus direct private IPv6 services](https://fly.io/docs/networking/app-services/).
- [Sprites CLI authentication and token scope/storage](https://docs.sprites.dev/cli/authentication/), [CLI environment variables](https://docs.sprites.dev/cli/commands/), [official pinned CLI release manifest](https://sprites-binaries.t3.storage.dev/client/2026-09-02/manifest.json).
- [Exact Fly 0.4.104 secret parser source](https://github.com/superfly/flyctl/blob/815f54c023706c8735fa0c4c89a980feb719a8ad/internal/command/secrets/parser.go). Its actual Go parser was run offline against synthetic credentials containing dollar signs, backslashes, quotes, whitespace, hashes and equals signs; the envelope round-trip preserved all bytes.

## Local validation record

September 16, 2026, isolated deployment worktree:

- `npm run check`: 133 tests in 30 files, Biome, application/runtime TypeScript and production Vite build passed. Build retains the existing large-chunk warning.
- `npm run test:deploy-context`: TypeScript/Vite passed from 121 packaged files, including all credential-handling source modules and runtime assets. Dependencies were attached only after context staging.
- Generated configuration passed `fly config validate`. Installed Fly 0.4.104's exact Go secret parser passed the synthetic special-character envelope round-trip; no cloud secret import was used for this test.
- `npm run test:browser`, `npm run test:mobile`, `npm run test:provisioning-browser`, and `npm run test:environment-browser` passed, with clean browser consoles and mocked Sprite transports. Desktop, 360px/390px phones and short/landscape viewports passed. Light/dark screenshots were inspected for signup, event creation, provisioning progress, chat and preview controls. Physical device keyboard/picker support is unverified.
- No Docker binary was available, so Linux image compilation, native-module execution, actual mount ownership/startup and live cloud checks are outstanding. No paid inference, app/volume/Machine creation, participant Sprite modification or Git publication occurred.

## Live demo deployment record

September 16, 2026: fresh https://civic-spark.fly.dev deployment passed real remote Linux build, native dependency loading, mounted-volume ownership/startup and repeated helper deployment on one Machine. Public demo signup, event/project/team creation, real Sprite checkout/files, browser agent setup and one authorized GLM file-edit turn passed. Browser refresh/reopen and idle redeploy retained identity, workspace, provider session, conversation and saved-key presence. Terminal commands/reconnect and different-identity isolation passed. Test provider credentials were removed afterward and key-bearing runtime/provider processes stopped. See [live handoff](handoff.md#first-live-hosted-demo--september-16-2026) for resource identifiers and limitations.

The real build exposed Docker directory-negation semantics that the earlier custom staging approximation missed. Explicit descendant exclusions now restrict `scripts/` and `deploy/`; the staging check uses pinned `@balena/dockerignore` and tests the former directory re-inclusion failure. The provider CLI contract is checked with argument-shape tests and actual Sprite operations; execution disables implicit local port forwarding.

## Capacity configuration

See [the measured capacity review and exact retained-setup edits](capacity-resilience.md). `volumeGb` is the initial/minimum size (10 GB by default); `provision` can explicitly extend the same retained volume, never shrink or replace it. `volumeAutoExtend` defaults to `{ "enabled": false }`; opting in requires threshold percent, increment GB and ceiling GB. These generate Fly's native mount auto-extension fields, requiring no administration token in the runtime. `managementCpus` and `managementMemoryMb` make the single writer's size repeatable. The setup receipt pins the volume identity and observed high-water size, preserves unrelated receipt fields, accepts bounded auto-growth, and rejects replacement/shrink/unexpected growth. Lowering a minimum never shrinks the disk. Provision/extension must complete before deployment when the existing volume is smaller than the requested minimum.

The old `maxSprites` setup property is removed with no compatibility alias. Explicit event membership capacity remains organizer configuration. Public native previews allocate no management origin slots; retained historical ledgers never block Launch/Open. See the native-preview retained-configuration steps above.

Management CPU class is explicit: `managementCpuKind` accepts `shared` (default) or `performance`. Select `performance` when dedicated CPU is required; retain this setting in the installation setup JSON so later deployments preserve it. CPU count and memory remain `managementCpus` and `managementMemoryMb`.

For a bounded diagnostic rehearsal, set `"diagnostics": true` in the retained public setup JSON and redeploy through the same helper. This enables `CIVIC_SPARK_DIAGNOSTICS=1` structured request/Sprite timing and failure logs; see [scripted participant rehearsal](scripted-participant-load.md). It defaults off and does not log provider credentials, request bodies, project content or raw CLI output. Preserve the original app, volume and receipt.
