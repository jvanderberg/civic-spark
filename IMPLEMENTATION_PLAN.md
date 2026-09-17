# Implementation plan

Current checkpoint, validation and next-session priorities: [handoff](docs/handoff.md).

## Persistent workspace connections

- [x] Keep Agent/Terminal connections independent of view visibility after lazy first activation; preserve bounded retries and explicit disconnect/access/lifecycle gates.
- [x] Check saved-key presence before preparing a fresh agent runtime; no-key workspaces request a key without opening an agent socket.
- [x] Guard deferred agent/terminal input against disconnect, lifecycle changes and revocation after asynchronous authorization.
- [x] Preserve the five-minute idle default; passive agent/terminal connections do not keep resources awake.
- [x] Complete local combined/mobile/specialized browser validation and bounded review; prepare local commit for root integration.
- [x] Root integration/deployment `82e3769`; live source/data/health checks and dedicated saved-key owner/anonymous check passed, no model calls.

## Agent screenshots

- [x] Add image paste/picker, removable thumbnails and native multimodal requests for the fixed Claude/GLM providers; bounded owner-only transcript/replay and explicit failure/draft retention. See [limits and local verification](docs/agent-images.md).
- [x] Integrate the coordinated 6 MiB transport and terminal 64 KiB guard; bounded independent review and combined local provider-wire checks pass.
- [x] Complete combined browser validation and deploy `49cdda9`; physical-device clipboard/picker and live vision remain separately unverified. No paid inference used.

## Current participant workflow requests

- [x] Add a main-menu Teams destination for existing event teams, moving discovery out of the bottom of Projects; retain My teams and separate Admin Teams.
- [x] Make fresh team checkout Launch prepare project dependencies and run the shared demo without a coding agent/model/key; visible preparation and retry, all execution inside owner Sprite, lifecycle gates preserved.
- [x] Add screenshot paste/file-picker attachments to the agent composer with actual multimodal provider delivery, validated bounded private history and mobile checks.
- [x] Deploy Teams (`5245524`); ten-case live GET-only navigation/list acceptance passed with existing data/resources preserved.
- [x] Complete, integrate and deploy preview preparation and image paste (`49cdda9`); dedicated temporary Sprite Vite install/reuse/cleanup passed, no participant code/resource mutation or paid models.

## Admin feedback integration — September 16, 2026

- [x] Replace Sprite cards with a compact list for dozens of resources, individual Pause/Delete, elapsed runtime and one Estimated cost currency amount using an internal best-guess assumption; no cost prose, ranges, formulas, disclosures or tooltips in the UI.
- [x] Put a single Admin parent in portal navigation with Sprites, Projects, Teams and People & roles directly beneath it; remove duplicated Overview/Admin overview entries and the prepended separate navigation.
- [x] Review, integrate and deploy these corrections with browser/provider-contract tests and live UI/individual-pause acceptance; no live deletion performed.

## Event Sprite lifecycle

Recovered user scope: a compact list for dozens of Sprites with individual Pause/Delete, elapsed runtime and one best-guess currency estimate assuming continuously running since start. No cost prose, ranges, formulas, tooltips or disclosures in the product. Assumptions remain only in operator docs/tests.

- [x] Authorized event allocation inventory with provider status and timestamp provenance
- [x] Compact one-row-per-Sprite list with elapsed runtime, one estimated cost and individual Pause/Delete confirmation; durable deletion/retry/generation gates and shared-only owner recreation retaining preview origins
- [x] Individual-control fullcheck (270 tests/48 files), complete mobile and relevant browser verification; 32-row screenshots inspected in both themes
- [x] Root integration/deployment of individual controls (`3cea3ec`), live eight-case UI acceptance and dedicated individual pause/reopen; no live deletion
- [x] Durable pause-all workspace holds and event-wide execution pause; cancellation/drain, retryable partial stops, restart gates and on-demand same-Sprite wake
- [x] Shared Git downloads remain available while paused; no private-source export or prototype fallback
- [x] Release inactive polling and retained terminal bridges after configurable inactivity; active browser model Tasks holds, preview use and recent terminal input/output protection
- [x] Explicit post-restore owner recovery from canonical shared Git after authenticated missing-resource reconciliation, preserving names/identities/preview origins
- [x] Isolated domain/API/provider/race/recovery tests and phone/desktop lifecycle browser coverage; see [mechanics and limits](docs/sprite-lifecycle.md)
- [x] Dedicated live provider exec-stop/pause-all/owner-wake and event-pause/shared-download/unpause acceptance; same Sprite retained, no participant-event pause or paid inference. VM sleep remains provider-controlled; see current handoff.
- [ ] Automatic Tasks instrumentation for arbitrary silent native-terminal/background jobs; those remain subject to provider idle detection

## Civic Spark namespace

- [x] Rename tracked display copy, configuration, runtime/CLI paths, package metadata, cookies, storage keys, Git refs, fixtures, scripts and documentation consistently; no compatibility aliases
- [x] Document breaking installation migration and preserve historical evidence without claiming live resources were renamed; see [migration requirements](docs/rename-migration.md)
- [x] Complete renamed-source lint/type/unit/build (124 tests / 29 files) and isolated mobile, portal, workspace, agent, terminal, provisioning, updates, changes, file-toolbar, preview and editor browser validation; screenshots reviewed, no unexpected console errors
- [ ] Separately authorize, rehearse and perform existing-installation migration; no participant Sprites, data, credentials or services were changed by the source rename

## Authenticated event and participant foundation

- [x] Email-link signup/sign-in using Better Auth; verified database sessions
- [x] Configurable SMTP and Resend adapters; single-use, expiring, hashed login tokens
- [x] Creator becomes event admin; promote members or add known accounts by verified email; retain last admin
- [x] Server-enforced event roles and owner-only workspace access
- [x] Main portal Menu for phone/short viewports, retained desktop sidebar, and actionable Event admin entry; existing event roles unchanged
- [x] Signed-in discovery, existing teams, new teams, custom project briefs
- [x] Separate participant Teams destination with compact event-scoped project/member rows and existing join/open actions; Explore projects contains only projects, while My teams and Admin → Teams retain their scopes
- [x] Optional runtime-pinned single-event portal, event-first branding, scoped discovery/workspace navigation and validated Fly setup setting; multi-event domain retained
- [x] Admin console sections for Sprites, Projects, Teams and People/roles; team membership removal and shared repository downloads remain accessible
- [x] Revision-checked event-admin catalog editing by stable project ID, exact Markdown persistence, stale-draft recovery and no writes to existing team files/history
- [x] Event-admin project creation with validated Markdown briefs; existing description → PROJECT.md seeding, intact links, preserved app README and team edits
- [x] Safe Markdown rendering in catalog/team cards with bounded long-brief disclosure, internal code/table scrolling and light/dark phone/desktop browser regressions
- [x] Multiple team memberships per account; capacity counts people once
- [x] Admin membership removal with immediate API revocation and preserved files
- [x] Confirmed event-scoped person removal and team deletion with retained work; last-admin protection
- [x] Admin team copying from shared main/history/brief without copying members or private work
- [x] Per-team repository browser with paginated commits, bounded file previews/diffs and confirmed history-preserving restore
- [x] Confirmed per-file restore recovers deleted/overwritten data without reverting unrelated current files; retains history and private work
- [x] Own teams view and independent personal checkout for each team
- [x] First-open Sprite provisioning and real remote file browse/read/save
- [x] Visible setup phases, retained errors, retry, refresh startup and interrupted-job detection
- [x] Real local commit + exact-commit Share, conflict preservation and ZIP export
- [x] Narrow `.gitignore` file allowance across editor/Changes/sync and native-history Share, with TypeScript/Python parity and unchanged secret/link/history guards
- [x] Auth/session/domain tests and separate-browser participant/admin workflow
- [x] Live Sprite file API verification; remote temporary edit restored
- [ ] Configure email sender and verify actual inbox delivery on the deployed origin

## Required workspace experience

See [workspace modes and acceptance requirements](docs/product.md#required-workspace-modes). Prototype implementation status is below; remaining live verification is listed separately.

- [x] Integrated browser agent sessions with pluggable Claude/OpenCode backends in participant Sprites
- [x] Owner-authorized browser terminal for advanced users, with session reconnection after refresh
- [x] Changes-in-flight view covering browser, local editor, terminal, and agent edits; preserve unsaved editor buffers
- [x] Connect a local folder with explicit browser read/write permission and safe initial reconciliation
- [x] Two-way project-file sync between the local folder and personal Sprite; keep team sharing explicit
- [x] Sync baseline tracking, conflict resolution, deletion tracking, interrupted-transfer recovery, and default exclusions
- [x] Sync status, Sync now, disconnect, permission recovery, and tab-resume reconciliation
- [ ] Verify Chrome/Edge on macOS/Windows; provide browser editing and upload/download fallback for unsupported browsers

- [x] Local email-identity prototype mode with isolated cookies/data and loopback-only access
- [x] Explicit hosted demo opt-in with unverified identities, isolated cookies/data, shared-email warning and bounded sign-in throttling; verified-email production remains the default
- [x] Full-screen compact workspace with fixed Opus 5/GLM choices and runtime/key readiness
- [x] Hierarchical file explorer with collapsible, resizable sidebar and saved layout preferences
- [x] System-following light/dark themes and syntax-highlighted Monaco editing
- [x] Shared Codex/Claude contributor instructions require mobile support and touch/keyboard/browser verification; participant harness guidance carries the same mobile expectations
- [x] Phone-width and short-viewport interaction regression coverage across participant, admin and workspace flows (`npm run test:mobile`), plus xterm/chat/desktop-preference regressions
- [x] Workspace visual-viewport height/pan tracking, compact mobile controls and panel-bounded composer; keyboard resize/scroll/rotation/zoom regressions retain drafts and sessions
- [ ] Rehearse physical iOS/Android keyboard, rotation and native file-picker behavior; viewport emulation alone does not establish device support
- [x] Full Monaco filename/extension detection and production-browser token/color checks across major file types, embedded HTML/CSS/JS, file switching, themes, and preserved drafts
- [x] Copy/adapt T3 Code chat UI and verify realistic conversation/controls in the browser
- [x] T3 active-turn elapsed header, animated Thinking/tool activity, reduced-motion behavior and restored turn clock; isolated production-browser lifecycle checks
- [x] Share model credentials with native terminal harnesses and verify bypass mode
- [x] Locked, deterministic Sprite tool setup with executable verification and incomplete-install repair
- [x] Live GLM request, approval, and SVG file creation through OpenCode
- [ ] Rehearse Claude turns, agent questions, cancellation, and provider failures with live credentials
- [x] Restore workspace/model/chat and running-turn state on browser refresh/reopen
- [x] Retain saved-key presence across reconnect, hide already-saved inputs, and retry saved provider credentials without browser secret recovery
- [x] Bounded durable conversation history with native provider context recovery
- [ ] Production resource limits and unattended-session cleanup for the agent bridge

A native helper for syncing while the browser is closed is a possible later extension, not required for the initial browser implementation.

## Remaining event platform work

- [x] Unified Share with a required description, authenticated bundle publishing and direct shared-team update
- [x] Poll incoming team commits; pull through authenticated bundles with agent conflict-resolution handoff and recoverable replacement
- [ ] Continuous hosted Git transport
- [ ] Mutual-TLS Smart HTTP Git endpoint, event CA, per-Sprite certificates, team/ref authorization
- [ ] Durable jobs, retries, crash reconciliation, coordinated metadata recovery, resource limits
- [ ] Event invitations/registration restrictions where required; account email changes
- [x] Shared PROJECT.md/environment preamble in browser and native harnesses
- [x] Browser Claude refreshed system guidance on resumed sessions, verified at the outgoing API boundary
- [x] Canonical PROJECT.md reference and untrusted-data guidance in both browser/native harnesses; native Claude snapshot refresh verified across resume with a local API double
- [ ] Rehearse native OpenCode resumed inference with project context on a dedicated Sprite; no paid inference in normal tests
- [x] Agent guidance requires current-batch publication confirmation; conflict approval remains separate
- [x] Configured Sprite web server Launch/Restart, actual readiness, logs and private local preview
- [x] Explicit owner Launch prepares root npm project dependencies independently of coding harness/key/model, with locked installs, durable reuse, cancellation and progress; isolated Vite/API/browser fixtures (no live participant validation)
- [x] Agent Git publication relay, clean rebase and owner-confirmed conflict resolution
- [x] Private hosted preview routing: isolated HTTPS origins, one-time owner handshakes, session revocation, HTTP/assets/WebSocket HMR and durable never-reused origin-pool assignments; local TLS/relay/browser validation
- [ ] Provision automatic Fly ingress pool and verify deployed acceptance; preserve one origin per workspace across restart/removal
- [ ] Verify deployed Open preview with a dedicated Sprite; preserve participant app/process/session state
- [ ] Integration Sprite, configured checks and shared app preview
- [ ] Enforced model budgets and deployment resource limits
- [x] Versioned encrypted whole-management/shared-Git/operator backup, exclusive offline writer coordination, isolated restore validation/session revocation and startup fence; see [backup/restore](docs/backup-restore.md)
- [x] Explicit recovery reconciliation CLI with provider/org binding, metadata-only present/404 checks and preserved permanent preview-origin ledger; no automatic cloud mutation or model turns
- [ ] Integrate/test explicit owner-reopen recovery of confirmed-missing ephemeral Sprites from canonical shared Git with lifecycle gates
- [ ] First coordinated live/off-machine backup and disaster-recovery rehearsal, deployment-owner review and cutover
- [ ] GitHub publication and scheduled off-machine backup/retention operations
- [x] Locally validated Fly control-plane deployment package: single-writer volume, canonical HTTPS/auth guards, trusted proxy boundary, pinned build, staged secret setup and restart reconciliation
- [x] Build/run Linux container and first explicit hosted demo on Fly; real signup/event/project/team/Sprite/files/GLM/terminal, isolation and idle redeploy persistence verified
- [ ] Verify production email delivery, token rotation and complete dedicated Sprite lifecycle/recovery
- [ ] Complete hosted multi-user security review and external backup/restore rehearsal

## Preserved earlier proof

The initial anonymous organizer rehearsal has been superseded. Its data remains on disk but is not assigned to authenticated users. The original Git bundle round-trip proof and provider-portability/mTLS design remain valid.

Deployment setup, exact commands, constraints and validation gaps: [Fly deployment](docs/fly-deployment.md). Hosted previews require isolated HTTPS origin configuration and still await live acceptance; continuous hosted Git/mTLS, complete cross-store crash recovery and unattended-session/budget enforcement are not complete.
