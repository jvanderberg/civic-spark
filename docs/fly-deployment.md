# Civic Spark control plane on Fly

This package deploys signup, administration, static UI, authenticated APIs, SQLite and team Git on **one Fly Machine with one encrypted volume**. Participant programs, agents and terminals execute only in Sprites. No app, volume, Machine, token or participant Sprite was created or changed during implementation. Choose and review deployment inputs before running the cloud-mutating steps below.

Local validation is not a production certification. Actual Linux image build/start, volume restart recovery, trusted proxy addresses, sender delivery, public sign-in, and dedicated test-Sprite lifecycle still require live checks. Hosted preview opening deliberately returns “Hosted preview is not configured for this installation”; it never returns a Mac/loopback URL or makes a Sprite public. Remote Launch/Stop/status still manage the server inside its Sprite. Full hosted preview isolation/routing is separate work.

## Requirements and inputs

Use Node **22.23.2**, npm with the committed lockfile, Fly CLI **0.4.104** and Sprite CLI **2026-09-02 (6390abf)**. Fly's CLI runs only on the operator/CI host, not in the image. Sprite CLI in the image is downloaded from the committed release manifest and checked against its SHA-256. The Node image uses a multiarchitecture digest; Debian packages resolve from a fixed September 15, 2026 snapshot. Native dependencies build from source during `npm ci`. Python, Git and Sprite are trusted control-plane tools; this does not permit executing participant code on the Machine.

Choose app name, Fly organization, region, exact public HTTPS origin, Sprite organization, sender and limits. No account name is a product default. `org` and `spriteOrg` can differ; Fly's personal-organization selector is not necessarily the Sprite token's organization slug. Read the selectors from the authenticated CLIs; do not infer one from the other.

`proxyCidrs` specifies the immediate peers allowed to supply `Fly-Client-IP`. The example uses the Fly Machine proxy network; verify it in the selected deployment before inviting users. The generated app has a dedicated Fly network and listens on IPv4 `0.0.0.0`, not its IPv6 private-network address. Do not broaden trust to every address or add unrelated workloads to that network. `X-Forwarded-For`, host and proto do not establish identity or the canonical origin. TLS cookies derive from `BETTER_AUTH_URL`; application and WebSocket origins are exact. An untrusted peer's IP headers are ignored. On another provider use `CIVIC_SPARK_PROXY=none` or implement that provider's explicit peer boundary. No Git or Sprite operation depends on Fly private networking.

Production requires `email` authentication and complete Resend or SMTP settings. SMTP permits port 587 with required STARTTLS or 465 with immediate TLS. Verify the sender domain externally. No public prototype sign-in is available: a public bind, production environment or hosted deployment rejects prototype mode at startup.

## Prepare locally

Run commands from the repository root. The helper also anchors Fly's working directory, build context and explicit Dockerfile argument to that root, independently of the generated TOML location. Its public config schema rejects unknown properties, so secrets cannot accidentally be added to configuration.

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

Save all managed credentials as a JSON object in a password manager or a mode-0600 file **outside the repository**. The required keys are `SPRITE_TOKEN`, `BETTER_AUTH_SECRET` (at least 32 random characters), and `RESEND_API_KEY`; for SMTP replace the Resend key with `SMTP_USER` and `SMTP_PASSWORD`. No real credentials belong in examples, shell history, command arguments or tickets. Keep the auth secret stable across repeat setup and Sprite token rotation.

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

The entrypoint requires `/data` to be an actual mount. It initializes `/data/civic-spark` as uid/gid 1000 and runs Node without root privileges. Existing imported files must already be owned by that user; it intentionally does not recursively rewrite recovery data ownership. A missing mount or unwritable data directory fails startup. The default-deny `.dockerignore` includes only source/build inputs and rejects nested `.env`, data, Git, artifacts and credential files. The two `credentials.ts` modules and `deployment-secrets.ts` are trusted **source**, explicitly included. The clean-context test runs TypeScript/Vite from only those staged inputs, attaching local dependencies afterward; it does not substitute for Linux/native/container execution.

## Durability, recovery and limits

Keep the **entire** `/data/civic-spark` tree together: `auth.sqlite`, `access.sqlite`, `state.sqlite` and WAL/SHM siblings, bare `repos/`, local `workspaces/`, `agent-integrations/` conflict tickets, provisioning seed bundles and the writer-lock database. Auth signing material comes from Fly secrets and must accompany disaster recovery. Provider session IDs, conversation journals, saved model keys and runtime configuration live privately in each person's persistent Sprite. Do not export those directories into shared Git. Restarting the management app does not stop participant turns or erase their sessions; reconnect reattaches the saved context.

Provisioning reserves a full-UUID Sprite name and persists each phase before the external action. Startup marks interrupted jobs as retryable errors through the event service, without automatically creating resources or running models. Owner retry probes the same name and uses the existing non-destructive checkout script. Unknown provider outcomes never allocate another name. Deleted/revoked workspaces retain resources for recovery and still count toward the configured allocation limit. `maxSprites` bounds recorded allocations and `maxProvisioning` bounds concurrent setup calls; neither is a dollar budget, orphan-resource detector or unattended-session cleanup system. No paid inference is used in checks.

Git sharing uses the existing authenticated owner-authorized bundle transport over the Sprite API; bare repositories are durable on the volume. There is no public unauthenticated Git endpoint or assumed `.internal` remote. Continuous hosted Smart HTTP/mTLS Git and its certificate/revocation review remain future work; standard configurable authenticated HTTPS remains the portability contract.

For a coordinated backup, pause writes, drain/stop the one Machine, and snapshot/copy the **whole volume** with auth secrets held separately in a secure manager; do not copy one active SQLite file without WAL or mix repository and metadata recovery points. Restore to a new volume/app first and validate users, roles, shared refs, private ownership, conflict tickets and named Sprite reattachment. Restore must not roll a shared repository back and force-push over newer history. Fly volume snapshots alone are not an independent off-provider backup. Cross-store crash atomicity, full disaster recovery, external backups and reconciliation of provider-side orphan resources are not claimed complete.

## Rotation and live acceptance

Rotation replaces the **entire managed credential set** in the envelope. Update the Sprite token in the private input while retaining the auth/email secrets, run `verify-sprites`, stage `secrets`, then `deploy` to activate. After health, sign-in, existing workspace reconnect and a dedicated disposable Sprite probe succeed, revoke the old token. If activation fails, restage the old complete set and redeploy while it remains valid. Intentional auth-secret rotation invalidates sessions. Delete temporary secret files according to operator policy after staging; preserve the authoritative copy securely. Fly organization members with deployment/exec privileges can access application secrets.

Before admitting participants, the deployment operator must verify:

- Exactly one Machine and volume, expected app/org/region, public TLS origin and secure cookie flags; HTTP redirects to HTTPS. Health is minimal and unauthenticated, reports 503 for unavailable storage, and does not expose users or secrets.
- Real sender delivery and single-use link signup, logout, return login; spoofed forwarded headers and unverified sessions do not authorize APIs. No prototype sign-in on the public origin. Another user and an event admin cannot attach to private workspaces, agent or terminal sockets.
- Fresh-volume ownership, Machine restart with saved sessions/Git/tickets, and interrupted provisioning retry against the same dedicated Sprite. API create/exec/tunnel connectivity uses the deployed token without a laptop. Never use participant Sprites as test resources.
- Token rotation and revocation, limited allocation/concurrency, explicit hosted preview failure, and documented backup/restore rehearsal. Live model inference requires separate authorization and is not part of this checklist.

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
