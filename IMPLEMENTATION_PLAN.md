# Implementation plan

Current checkpoint, validation and next-session priorities: [handoff](docs/handoff.md).

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
- [x] Signed-in discovery, existing teams, new teams, custom project briefs
- [x] Event-admin project creation with validated Markdown briefs; existing description → PROJECT.md seeding, intact links, preserved app README and team edits
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
- [x] Agent Git publication relay, clean rebase and owner-confirmed conflict resolution
- [ ] Integration Sprite, configured checks and hosted/shared app preview
- [ ] Enforced model budgets and deployment resource limits
- [ ] GitHub publication, external backups, retention and recovery rehearsal
- [x] Locally validated Fly control-plane deployment package: single-writer volume, canonical HTTPS/auth guards, trusted proxy boundary, pinned build, staged secret setup and restart reconciliation
- [x] Build/run Linux container and first explicit hosted demo on Fly; real signup/event/project/team/Sprite/files/GLM/terminal, isolation and idle redeploy persistence verified
- [ ] Verify production email delivery, token rotation and complete dedicated Sprite lifecycle/recovery
- [ ] Complete hosted multi-user security review and external backup/restore rehearsal

## Preserved earlier proof

The initial anonymous organizer rehearsal has been superseded. Its data remains on disk but is not assigned to authenticated users. The original Git bundle round-trip proof and provider-portability/mTLS design remain valid.

Deployment setup, exact commands, constraints and validation gaps: [Fly deployment](docs/fly-deployment.md). Hosted preview opening remains explicitly unavailable; continuous hosted Git/mTLS, complete cross-store crash recovery and unattended-session/budget enforcement are not complete.
