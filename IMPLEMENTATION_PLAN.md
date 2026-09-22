## Admin console backups — local, pending integration

- [x] Live in-process capture (SQLite online backup, Git mirror clones, verified and sealed in the archive layout as plain checksummed files; sessions/auth secret excluded) from Admin → Backups without stopping the application.
- [x] Backup list, download as an ordinary ZIP of the real files, upload of such a ZIP with tree verification, delete; optional `CIVIC_SPARK_BACKUP_OPERATORS` allowlist on top of event admin access.
- [x] Restore of any same-mode backup with cross-installation warnings: staged recovered root, session revocation, preserved newer preview origins, Sprite reservation report, restart-and-swap with startup completion, retained replaced root, discard while pending.
- [x] Integration tests with a real demo-mode application and the browser Backups check at phone/desktop/short widths in both themes.
- [ ] Root integration, hosted restart-path acceptance on Fly and first live backup/restore rehearsal.
## Deterministic participant rehearsal — local

- [x] Add a per-person JSON Playwright runner for sign-in, exact project selection, dedicated team/workspace, hello file/Share, terminal ls, GLM MVP request, five-minute bounded completion loop, MVP Share and React ZIP inspection.
- [x] Keep keys in environment variables, reconcile shared history before retries, reject reused workspaces, and retain sanitized milestone/result evidence without executing participant code locally.
- [x] Full check passed with two workers: 662 tests, two opt-in skips, lint, both typechecks and build. Browser matrix passed at desktop/360/390/short sizes in both themes, including streamed completion text, a transient Share failure and a lost successful Share response; screenshots inspected.
- [x] Corrected single-person live acceptance passed in 7m18s: exact hello/MVP shared commits, first five-minute completion question, successful assistant sentinel and verified 20-entry React ZIP. Five HTTP502 and one HTTP409 console errors were retained; this is functional acceptance, not a clean-console or concurrency claim. Initial trial was interrupted and its dedicated OpenCode process stopped, retaining files/Git. See [scripted rehearsal](docs/scripted-participant-load.md).

## Administrative Sprite deletion reset — deployed `6c48d0f`

- [x] Trace row Delete through API/admin/generation checks, drains, provider deletion and owner recovery.
- [x] Require strict authenticated resource identity and confirmed exact absence; preserve retryable metadata on uncertain outcomes.
- [x] Retire old runtime identity/reservations/recovery/connection metadata after confirmation, reconcile interrupted local cleanup, and gate fresh-name shared-only preparation on explicit owner connect and event execution state.
- [x] Extend full-request/relay drains and stale-generation protections; retain accounts, memberships, catalog, shared Git, historical preview tombstones and unrelated workspaces.
- [x] Full check passed 647 tests/68 files (2 opt-in suites skipped), lint/types/build; complete mobile and lifecycle/provisioning/connection browser checks passed, with inspected screenshots and no unexpected console errors. Evidence: artifacts/sprite-delete-reset.
- [x] Follow-up guards Delete after all metadata awaits (including confirmed absence) and reset creation after queue admission; real adapter/queue regressions cover revoked admin/session/membership, newer generation, event pause and post-dispatch cleanup. Reset defaults verified through interrupted-cleanup restart.
- [x] Root integration/publication and deployment `6c48d0f`; final check 656 tests/68 files plus two opt-in skips, full mobile and connection suites, context158. Dedicated browser Delete → Connect passed with old provider404/new200, private README marker removed, same shared Git HEAD and cleared obsolete runtime metadata. Final dedicated replacement cleanup passed: both provider names404, obsolete metadata cleared, shared Git retained. No attendee workspace was modified.

## Absent project checkout repair — local, pending integration

- [x] Distinguish absent roots from empty/private/excluded projects and refuse symlink/file/unreadable roots in the trusted file adapter.
- [x] Guard shared checkout uploads after queue admission; publish atomically without replacing or nesting into a concurrent destination.
- [x] Add explicit owner wake/retry repair of falsely ready, genuinely absent checkouts on the same allocated Sprite; retain shared-only repair intent across restart without provider recreation permission. Preserve ordinary Resume with active work or uncertain listing.
- [x] Focused six-file152-test pass and both types; final HTTP/atomic-race coverage and complete check being finalized.
- [ ] Root integration and deployed same-resource checkout acceptance; no live mutation in this worktree.

## Latest deployed checkpoint

- Native public Sprite previews and reviewed capacity/resilience changes are live at runtime `400c345`; all fifteen old/rejected ingress apps removed. No replacement ingress resources.
- Original management Machine now 2 performance CPUs/4 GB RAM (upgraded during the 40-person live exercise after health timeouts and 54% CPU steal); original volume 10 GB with explicit 80%/+5 GB/50 GB auto-growth. Local 60-person load evidence is not cloud certification.
- Live dedicated Vite HTTP/assets/HMR, owner Stop/Launch, anonymous public access, same native origin, and warm-sleep subsequent HTTP200 verified; fixture cleaned. Cold restart, physical devices and first live backup remain unverified. See current docs/handoff.md checkpoint.

# Implementation plan

## Previously ready workspace missing on Resume — local, pending integration

- [x] Inspect authenticated metadata before releasing a ready workspace's idle hold; durable exact404 status offers existing owner-confirmed shared-only recovery without automatic creation.
- [x] Preserve unknown/present resources and pending work; revalidate session, access, provider binding and event/runtime generations after inspection.
- [x] HTTP/race tests, full check (563 passing tests) and dedicated provisioning browser verification, including phone/desktop/short viewports in both themes.
- [ ] Full mobile aggregate is finishing its unchanged portal cases; root owns integration/deployment and live p09 acceptance.

## Vite 5 native preview compatibility — local, pending root integration

- [x] Read-only p26 diagnosis: managed wrapper/process have the exact additional-host variable, but installed Vite5.4.21 ignores it; Vite8-only fixtures missed the failure.
- [x] Add a private config adapter for plain root npm Vite5 launch scripts, retaining project config/plugins/reloads and exact-host restrictions without participant edits or upgrades.
- [x] Check readiness using the saved native Host; public-host403 is an error. Polling never repairs/restarts the server.
- [x] Complete full check (487 tests), final pinned Vite5 regression, full mobile and both specialized preview browser checks; inspect host-error screenshots in both themes at phone/desktop/short widths.
- [ ] Root integration/review and authorized live Restart acceptance; no live mutations or deployment by this workstream.

## Management disk writes — local, pending root integration

- [x] Audit polling/request persistence, health probes, the writer lock, activity timestamps and synchronous Git; retain correctness/durability and existing policy/provider behavior.
- [x] Skip exact no-op access/runtime/provisioning writes; preserve transition history, initial-creation sealing, changed timestamps/generations and failure rollback.
- [x] Move HTTP health filesystem probing off the event loop and coalesce only concurrent probes, retaining fresh headroom/real-write/failure checks. Startup/writer admission unchanged.
- [x] Focused regression/type verification: 83 tests across six files; real SQLite write counts, forty overlapping health requests, changed-write durability and failure/recovery coverage.
- [x] Full check passed with VITEST_MAX_WORKERS=2: 416 tests, lint, both typechecks and build. The default-worker attempt had three existing Git-test timeouts; affected files passed all25 tests in isolation without timeout changes.
- [ ] Root integration and deployed latency acceptance; dedicated CPU setup remains root-owned. No UI/provider/policy or live changes in this workstream.

## Provisioning diagnostics — local, pending root integration

- [x] Preserve a sanitized original creation-failure category across retry phases and restarts; legacy failures remain unknown and successful preparation clears the category.
- [x] Classify documented provider concurrent-limit and creation-rate codes separately; distinguish access/service/unknown outcomes without relaying provider diagnostics or guessing from stderr.
- [x] Retain reserved identity and fail closed on absent/unknown resources; show an honest admin-investigation message after confirmed absence.
- [x] Complete local check (381 tests), full mobile and dedicated provisioning browser verification; inspect both-theme phone/desktop/short screenshots and console errors.
- [x] Add a separate prospective explicit-owner initial-creation retry with durable provider binding, irreversible checkout barrier, exact-name404, late authorization/generation/lease checks and existing-project preservation. Legacy phase/activity cannot establish eligibility; document existing separately authorized operator recovery.
- [x] Complete follow-up local verification: full check (410 tests), full mobile, independent provisioning browser, both-theme phone/desktop/short screenshots and clean unexpected console. The original diagnostics commit remains separate; no live recovery or deployment.
- [ ] Root integration/review and dedicated deployed acceptance; no live repair, replacement, deployment or provider-capacity conclusion from this workstream.

Current checkpoint, validation and next-session priorities: [handoff](docs/handoff.md).

## Capacity and resilience for 60 concurrent participants

- [ ] Remove arbitrary Sprite allocation blockers while retaining safe bounded concurrency and owner/pause isolation; address preview-origin capacity without origin reuse.
- [ ] Expose initial disk sizing and optional bounded auto-expansion in repeatable setup.
- [x] Measured fifty-person load on the deployed demo (September 20, 2026 UTC): 17/50 passed; the management host's single event loop saturated on native I/O at ~25 concurrent people (235 KB uncompressed `/api/state` per 5 s poll per person, 12 Sprite CLI spawns/s of helper polling, 300–400 agent text deltas/s). See [scripted rehearsal](docs/scripted-participant-load.md).
- [x] Portal state carries project summaries only (briefs served per project on demand), API GET bodies get weak ETags with 304 and Brotli/gzip over 1 KB, built assets are precompressed with immutable hashed bundles, the client sends conditional GETs and polls the portal every 15 s only while visible.
- [x] Agent text deltas are merged per message for 50 ms before replay and fan-out and activity touches are throttled; file polling slows to 20 s when the agent is idle and stops while hidden; preview status polls every 30 s when nothing is changing.
- [x] Diagnostics add response bytes per request and a ten-second `loop` record with event-loop delay p50/p99/max, CPU share, handle, child and socket counts.
- [x] Serve read-only helper polls through one long-lived, passive `sprite exec` helper session per Sprite (JSON lines, correlated ids, bounded replies, idle shutdown, lifecycle teardown, one-shot fallback) with `sprite.command`/`sprite.session` diagnostics; writes and uploads stay one-shot. Fake-spawn and dispatcher tests only; no live Sprite run yet.
- [x] Fifty-person re-run on the deployed fixes with one vCPU passed 47/50 (baseline 17/50 on two vCPUs): all workspaces ready, helper sessions served 96 % of Sprite commands, first byte 0.75 s early and 7–11 s at peak instead of 34 s, one HTTP error. See [scripted rehearsal](docs/scripted-participant-load.md).
- [x] Idle terminals cost nothing: tmux runs with its status line off so an idle shell emits no output, and the browser detaches the terminal socket five seconds after the tab is hidden and reattaches to the same tmux session when shown. Loop telemetry now reports per-interval counts of agent lines and frames, terminal chunks, bytes and frames, helper-session requests, process spawns, HTTP requests and bytes.
- [x] Relay the Sprite CLI children (agent runners, terminal PTYs, helper sessions, one-shot commands) into a fixed pool of forked relay worker processes assigned by workspace hash, with batched per-tick frames over the IPC channel, main-process fan-out/auth/leases unchanged, worker crash → reconnect close codes plus lease release plus restart, `relay`/`relay.worker` diagnostics, and `CIVIC_SPARK_RELAY_WORKERS=0` (setup `relayWorkers`) as the in-process fallback. Real-worker, fake-child and pool tests only; see [relay worker processes](docs/capacity-resilience.md#relay-worker-processes).
- [x] Push instead of poll for per-workspace status: one `/api/workspaces/:id/events` socket per open tab (agent/terminal-style auth, hold/generation teardown, `events` ws and loop diagnostics) carries scope-only change frames from Share, team updates, conflict tickets, preview launches/stops, saves and agent tool/turn events, with a bounded 30 s host check for team head and running previews only while subscribed; the browser refreshes only the affected scope, on reconnect/visibility and on slow safety timers. Local unit/route tests and browser smokes only; the fifty-person re-run is still to do.
- [x] Read-only service lookups use a zero-copy view of the domain state instead of cloning it; a live CPU profile at fifty participants showed 79.5 % of main-loop time in `structuredClone` from those lookups.
- [x] Move the per-workspace agent integration relay (`sprite exec … relay.py`, 49 long-lived main-process children in the fifty-person run) into the same relay workers as that workspace's other children: the worker validates and forwards CLI requests and writes replies, the main process keeps authorization, conflict tickets, host Git work and preview actions. The child now runs only while an agent runner or terminal session exists (started on attach, stopped about 30–45 s after the last session ends, restarted on the next attach without re-preparation; lifecycle disconnect, generation change and lost authorization end it) and `relay` telemetry counts `integrations`. Real-worker, fake-child and in-process tests only; no live Sprite run. See [relay worker processes](docs/capacity-resilience.md#relay-worker-processes).
- [x] Fourth fifty-person run on the deployed zero-copy state reads and worker-owned relays: 48/50, median 7m39s, main loop 17 % median / 35 % peak on one vCPU, first byte 0.25 s at peak, no load failures; both failures were stale-preview Share conflicts. See [scripted rehearsal](docs/scripted-participant-load.md).
- [x] Retry Share once with a refreshed preview when only the preview fingerprint changed (client and runner). Changes follows Git ignore rules on both adapters, so build output such as `tsconfig.tsbuildinfo` is never listed, never moves the fingerprint and is never staged. Typed-confirmation **Replace team repository** escape hatch with a dated `refs/civic-spark/replaced/*` backup and activity record.
- [x] Load-test tooling tracked under `scripts/participant-load/` (roster generator, capacity, collector, analysis, telemetry, cleanup) with a runbook; all run reports archived under `docs/participant-load-runs/`.
- [ ] Cap the `changes` payload; keep provisioning's Git bundling off the main loop.
- [ ] Exercise crash/restart and disk-full failure/recovery using isolated fixtures; report measured limits and remaining live acceptance.

## Editable event configuration — live

- [x] Add event-admin-authorized, revision-checked settings updates, neutral legacy migration, stable schedule row IDs and persisted plain-text project guidance.
- [x] Add nested Admin → Event details with reusable metadata/capacity/budget forms, schedule add/edit/remove/reorder, preserved drafts and explicit stale recovery; retain status and workspace controls.
- [x] Cover unauthorized/cross-event/invalid/stale writes, restart, legacy labels, pinned title privacy and unchanged roles/teams/projects/private files/history in isolated regression tests.
- [x] Complete full check/mobile/admin/portal browser matrices, screenshot inspection and bounded root source review; integration remains root-owned.
- [x] Integrated with participant creation and deployed `15c32b4`; live read-only forms/source/state verification passed.

## Participant project creation

- [x] Allow authenticated discovery-eligible registration/live visitors and members to create catalog projects before joining a team; retain draft privacy, closed read-only behavior and admin-only editing.
- [x] Add Projects creation and a single-dialog New project handoff preserving team drafts, with plain-text event guidance and canonical description → PROJECT.md briefs.
- [x] Complete local participant/domain/API/mobile/portal/admin verification and bounded root review, including delayed success across event changes and poll-before-response deduplication; no cloud or paid tests.
- [x] Combined check299/55, full mobile/portal/admin/context149 passed; published/deployed `15c32b4`, live eight-case read-only acceptance passed.

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
- [x] Release inactive polling and retained terminal bridges after configurable inactivity; active browser model Tasks holds and recent terminal input protection (output never delays release); native preview traffic uses provider activity tracking
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
- [x] Fifth fifty-person run on release v40: 41/50, median 8m55s, host 32 % peak, no platform errors; all eight Share failures were the hidden-file rule. See [scripted rehearsal](docs/scripted-participant-load.md).
- [x] Sixth fifty-person run (v43, real-data prompt): 32/50, every passing app with real data and sources, host 51 % peak; failures were the five-minute idle hold during long turns and a file-list race. Fixed: attended idle limit (`CIVIC_SPARK_WORKSPACE_ATTENDED_IDLE_MINUTES`, default 30) while a tab is visible; open-sequence guard and awaited refresh for new files.
- [x] Conflict-resolution hand-offs no longer assume the Agent tab: ticket approval is consent only with an explicit Send to Agent tab, and team updates gain Resolve in terminal, which shows the merge prompt with a copy button; terminal agents read the approved ticket through `civic-spark git status`.
- [x] MVP prompt and agent preamble ask for real data: fetch the brief's cited sources from the workspace, trim into `public/data` with a `SOURCES.md`, never invent records, label placeholders only when a source is down. The runner records data evidence per archive and the analysis summarizes it; earlier cohorts produced sample-data-only apps.
- [x] Hidden paths are project data unless private: the "no dotfiles except `.gitignore`" rule became a denylist of environment files, credentials, keys, agent state, the sync marker and caches, in TypeScript and both Python helpers. The fifth fifty-person run showed Vite-scaffolded `.oxlintrc.json` blocking Share for six of fifty. Refusals now name the excluded paths.
- [x] Agent chat composer defects: attachments clear with the text the moment a message is handed over and return only if the send fails; Stop is acknowledged by the server before the runner settles, shows a stopping control, drops the stopped turn's later output from transcript and replay, and wakes the OpenCode reconciler so the native abort is issued immediately while the Sprite activity hold is still kept until the turn settles; a message sent during a turn waits with the runner, survives a reload, can be taken back and is delivered once; a spent provider balance is reported as a billing failure that keeps the saved key connected and the composer usable.
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
- [x] Configured Sprite web server Launch/Restart, actual readiness and logs; native public preview replaces the original private local gateway
- [x] Explicit owner Launch prepares root npm project dependencies independently of coding harness/key/model, with locked installs, durable reuse, cancellation and progress; isolated Vite/API/browser fixtures (no live participant validation)
- [x] Agent Git publication relay, clean rebase and owner-confirmed conflict resolution
- [x] Historical private hosted gateway validated; superseded by public native service/URL below. Retained old origin assignments stay tombstones.
- [x] Retire the rejected Fly ingress-pool path; native public Sprite URLs replace it without additional apps/Machines or recycled historical origins.
- [ ] Verify deployed Open preview with a dedicated Sprite; preserve participant app/process/session state
- [ ] Integration Sprite, configured checks and shared app preview
- [ ] Enforced model budgets and deployment resource limits
- [x] Versioned encrypted whole-management/shared-Git/operator backup, exclusive offline writer coordination, isolated restore validation/session revocation and startup fence; see [backup/restore](docs/backup-restore.md)
- [x] Admin console unencrypted live backup/download/upload/restore of the running installation with restart-and-swap; see [admin console backups](docs/backup-restore.md#admin-console-backups)
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

Deployment setup, exact commands, constraints and validation gaps: [Fly deployment](docs/fly-deployment.md). Native public previews require provider service/URL acceptance; continuous hosted Git/mTLS, complete cross-store crash recovery and unattended-session/budget enforcement are not complete.

## Capacity and recovery for 60 concurrent participants (local work)

- [x] Remove the hidden total Sprite-allocation admission cap; preserve organizer participant capacity, planned budget metadata, lifecycle gates and the five-minute idle policy.
- [x] Measure isolated 60-person polling/Share/replay baseline and target; run actual agent/terminal/private preview HTTP+WS bridges with provider transport doubles. See [evidence and limits](docs/capacity-resilience.md).
- [x] Move costly Share preparation/validation off Node's request thread, add repository ordering and bounded worker/CLI/transfer pressure, optimize replay byte accounting, and persist/reconcile publication intents without automatic Share or history rewrite.
- [x] Exercise revocation/pause/session loss, stale refs, failed metadata persistence, before/after-CAS restart, worker cancellation, OS writer-lock release and storage/body-pressure failures in isolated fixtures.
- [x] Expose initial disk size, explicit native auto-extension threshold/increment/ceiling, repeatable same-volume growth/receipt drift checks and retained historical preview origin records.
- [x] Complete local mobile, Share, team-update, provisioning and workspace browser verification with screenshots and clean consoles; provider transports use isolated fixtures.
- [ ] Root integration review and dedicated deployment acceptance; no capacity changes deployed by this workstream.
- [ ] Root-coordinated dedicated provider/resource rehearsal: actual 60-workspace CLI/process/network limits, maximum file-transfer bursts, live volume expansion and crash recovery. Local mocks do not certify live 60-person capacity.
- [ ] Follow up synchronous admin/team Git and whole-state JSON persistence, full-history bundle growth/seed duplication, orphan/stale-lock reclamation and general cross-store recovery; no speculative full storage rewrite in this change.


### Public native previews (replaces ingress pools and port-gateway proposal)

- [x] Use the existing Sprite HTTP service/public HTTPS URL; preserve launch command, dependency preparation, stable identity and management owner/session/event gates.
- [x] Retire ingress provisioning and required origin configuration; preserve old origin ledgers as tombstones.
- [x] Keep five-minute idle connection release without service Stop; explicit admin Pause still stops the public service and requires owner Launch recovery.
- [x] Complete local provider-contract, dependency, TLS Vite/HMR and mobile/browser validation: check 342 tests/58 files plus opt-in stream skip, full mobile/environment/direct-TLS browser, inspected screenshots and clean consoles; exact local commit supplied in handoff.
- [ ] Root-owned dedicated provider acceptance: metadata/public URL and running anonymous HTTPS verified; same-name service update verified; explicit Stop produced failed/143, no process and later HTTP502. Loopback binding and explicit start recovery to anonymous HTTPS200 verified. Quiet native hibernation/wake, live Vite HMR and stable management restart remain separate acceptance.

## OpenCode long-turn transport — local fix, pending root integration

- [x] Replace the inference-length synchronous prompt with a single bounded async submission; use pinned native message IDs and correlate the current user message, final assistant and fresh idle status before releasing Working/Tasks.
- [x] Reconcile missing/stalled SSE and uncertain ACKs without resubmitting inference; Stop drains delayed acceptance through a subsequent native abort and idle check. Distinguish provider failures from local runtime transport loss.
- [x] Complete final local runner/browser/context checks and the opt-in Node 24.18.0 / OpenCode 1.18.31 loopback turn beyond 300 seconds, including Tasks renewal; see [evidence and limits](docs/opencode-turns.md).
- [x] Correct independent-review findings: recover durable current-answer text without duplicate streaming/replay, and validate message/status evidence before terminal hold release; actual-runner regressions added.
- [x] End a turn whose native run stops at a tool step (dismissed question) once idle with no pending tool part, and keep Stop converging when each abort republishes idle events; deployed stuck-turn diagnosis in artifacts/participant-load/backend-20260920b, tracker and actual-runner regressions plus interrupted-journal restart coverage added.
- [ ] Reviewer reread, root integration and separately authorized deployment/live acceptance. No participant resources or paid inference used by this workstream.

## Corrective owner recovery for missing legacy reservations

- [x] Add explicit owner-confirmed recovery from canonical shared team Git using validated durable lifecycle state; preserve identity/name, never backfill initial-create evidence or call provider DELETE.
- [x] Require fresh authenticated exact404, current owner/session/event/lifecycle/provider binding and queue-dispatch revalidation; preserve any present or uncertain resource without upload.
- [x] Expose Rebuild from shared work with private-state-loss confirmation; cancel, reload, status and ordinary wake never recreate.
- [x] Validate local HTTP/provider races and phone/desktop/short viewport confirmation/cancel/reload: full check, 71 focused tests (38 recovery cases), provisioning browser and complete mobile matrix passed.
- [ ] Root review/integration/deployment and physical-device acceptance. No live recovery mutations authorized in this worktree.

## Concurrent scripted participant diagnostics

- [x] Add a bounded five-person JSON cohort runner with independent browsers, per-person evidence and browser/backend request correlation.
- [x] Add opt-in structured request/Sprite diagnostics, safe command failure classification and private helper exception metadata; preserve operation results and omit keys/content/raw command output.
- [x] Deployed diagnostics to the existing demo Machine/volume and ran five dedicated people on different projects (September 20, 2026 UTC). Four passed end to end with zero browser HTTP errors; one failed its completion loop through a scripted-observer defect while the platform completed the turn and then paused the idle workspace as designed. Correlated one 429 (own provisioning cap), four 423 (idle hold) and one transient 502 (`sprite exec` 30 s CLI timeout during agent prepare on a just-resumed Sprite; retry succeeded). No 409 reproduced. See [scripted rehearsal](docs/scripted-participant-load.md).
- [x] Participant runner locates turns by their fresh user echo, coalesces streamed text, persists observed agent events and fails fast when the workspace is held or the agent connection ends; cohort launcher accepts up to fifteen people.
- [x] Provisioning concurrency raised to 5 in the operator setup; the app retries busy preparation and busy resume automatically with a waiting status instead of an error and Retry button.
- [x] Diagnostics now record agent/terminal WebSocket close codes and durations, agent runner exits, idle releases and preparation attempts; agent preparation retries up to three times server-side with backoff and once more quietly in the app.
- [x] Fifteen-person concurrent deployed acceptance passed 15/15 (September 20, 2026 UTC) with provisioning limit 5: fourteen busy responses retried transparently, no 502/409/423, Sprite command queue p95 8 ms. See [scripted rehearsal](docs/scripted-participant-load.md).
