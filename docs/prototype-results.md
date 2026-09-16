# Prototype evidence

This is a chronological evidence log. Earlier counts and limitations describe their revision, not the current implementation. Start with [the current handoff](handoff.md) for status and remaining verification. Historical cloud resource names are omitted; existing resources and ignored evidence directories retain their original names. Current command examples use the new namespace and require a dedicated compatible fixture; this source rename did not rerun live checks or migrate resources.

## Sprite transport

A live test created a dedicated smoke Sprite using the existing authenticated CLI. Existing Sprites were not modified.

- Confirmed remote working directory `/home/sprite`.
- Seeded `/home/sprite/project` from a Git bundle generated on the Mac.
- Initial commit matched on both sides: `76b7ccc3b1320cd15f3b8f40582dba0835de2118`.
- Created a new file and commit inside the Sprite, downloaded a return bundle, verified and merged it on the Mac.
- Returned commit matched: `bef759a4101f5a029aa4b8ca67ea1310624099eb`.
- No model calls, no public Mac tunnel, no GitHub repository, no hosted Git endpoint.

The test Sprite was retained for inspection. Local bundles, repository, and machine-readable report are under its original resource-named directory within `.data/sprite-smoke/` and excluded from source control. Resource usage is not measured by this test; zero model calls does not mean zero Sprite infrastructure cost.

Reproduce with `npm run test:sprite -- --live`; each invocation creates another named Sprite.

## Local checks

`npm run check` covers Biome, strict TypeScript, behavioral/API tests, and the Vite production build. Tests use temporary local repositories and verify conflict preservation, stale writes, path restrictions, lifecycle validation, persistence, and ZIP generation.

`npm run test:browser` exercises the built interface against an isolated temporary database and captures desktop, workspace, and mobile screenshots. See the command output and ignored `artifacts/` for the latest run; cloud access is disabled in this browser test.

Verified in this implementation session: seven behavioral/API tests passed, production build and Biome passed, and the browser workflow passed with a clean console. Desktop, CSV workspace, and 390px mobile screenshots were inspected visually.

## Authenticated participant revision

The anonymous organizer UI is superseded by sign-in, project/team discovery, My teams, and an event-admin view. The browser test now uses separate admin/participant sessions backed by real signed cookies in disposable databases. It verifies multiple team membership, custom project briefs, owner-only files, contribution/ZIP, admin promotion, membership revocation, mobile layout, and logout. It does not fake Google/Apple redirects.

The same dedicated smoke Sprite was also used to verify the authenticated file API against its real filesystem: list/read/save/reread, other-account rejection, stale-write rejection, and hidden metadata rejection. The temporary README change was restored. No model calls or new Sprites were used for this file test.

## Email-link revision

Email links now replace Google/Apple signup and sign-in. The sender is configurable: standard SMTP, Resend HTTP, or disabled until configured. Account ownership and event/team permissions remain in the application.

Verified: 19 tests passed, Biome and strict TypeScript passed, and the production build passed. Tests cover hashed token storage, email verification, single use, expiry, logout, returning account identity, untrusted callback rejection, disabled/failed delivery, and SMTP encryption/provider failure handling. Origin and CSRF checks are explicitly enabled even in test mode.

The browser smoke test signed up separate organizer and participant accounts through real magic-link endpoints with an in-memory mailbox, then passed the event, multi-team, private-files, sharing/ZIP, admin, revocation, mobile, and logout workflow with a clean console. The sign-in and email-sent screenshots were inspected. No real emails were sent; live inbox delivery still needs provider configuration and rehearsal. No new Sprite or model calls were made for this revision.

## Workspace and prototype-login revision

Explicit local prototype mode now accepts an email without mailbox verification, uses that normalized email as the domain identity, and isolates its data/cookies from verified-email mode. The browser can exercise event creation, team membership and returning identity without a sender account.

New workspace views implement files, live diffs, agent adapters, a browser terminal, and local folder sync. All 45 automated tests, Biome, strict TypeScript, and the build passed. Both browser checks passed. The workspace check used real Chromium FileSystem handles and a substituted OS picker: initial copy, two-way updates, repeated automatic saves after creating a new file, conflict choice, deletion review, preserved unsaved browser edits, returning account/team, and mobile layout. Changes, conflict, and mobile screenshots were inspected. Native Windows/macOS picker testing remains outstanding.

The existing dedicated smoke Sprite passed remote manifest/revision/diff checks, agent runner startup/reconnect, a real terminal command, and persistence of a shell variable across terminal reconnection. The temporary project file and tmux test session were removed. Pinned agent tools remained installed in the test Sprite. Zero model calls were made; actual Claude/OpenCode model-turn behavior is not claimed as verified.

## Full-screen workspace and runtime repair

Workspace now occupies the full viewport with compact toolbars, no modal backdrop, and no bottom sharing bar. Browser checks assert the header starts at (0,0), the viewport is filled, and model choices are exactly GLM and Opus 5. Both browser flows pass with clean consoles, including local sharing through its compact menu.

Runtime setup is a committed shell script with pinned dependencies and a separate lockfile. It explicitly installs both native CLI binaries, checks versions and SDK imports, and repairs missing executables. Verified a deliberately missing OpenCode executable repaired successfully in the dedicated test Sprite; the immediately repeated setup did not reinstall. The participant Sprite also passed both executable checks.

An explicitly authorized live GLM test used an API key through stdin only. GLM connected through the actual WebSocket/runner/OpenCode path, requested edit approval, and created a valid SVG chart. Reported turn cost: $0.0012392. The temporary chart and test session were removed. No credential is retained in source, documentation, or test artifacts. Claude model turns remain untested.

## T3 chat and shared terminal configuration

Copied and adapted T3 Code’s MIT-licensed composer surface, send/stop controls, activity row, detail component, and conversation markup. Preserved attribution and source commit. The agent UI renders Markdown, tables, and copyable code blocks; tool output collapses into compact rows; questions use a plain answer form. Removed decorative sparkle icons. Desktop and mobile conversation screenshots were inspected.

The deterministic `test:agent-browser` check uses the shipped UI and actual application sessions/files, with only the runtime transport mocked. It verifies readiness, streaming, formatted output, tool disclosures, questions, errors, keyboard send/stop, model switching, file links, and mobile bounds. This is UI verification, not a second live inference test.

Explicit user requirements now select bypass permissions for both coding harnesses. Web credentials/model defaults are shared with native terminal commands through owner-readable configuration outside the project. A separate authorization regression verifies that an event admin cannot open another participant’s agent or terminal, untrusted origins are rejected, and removed members lose execution access.

Final validation: 52 tests across 11 files pass with Biome, strict TypeScript, and production build. Both existing browser workflows and the new T3 agent browser workflow pass. Native CLI verification used disposable dummy credentials in the dedicated test Sprite and restored prior configuration: OpenCode resolved the GLM model and allow permissions; Claude reported API-key authentication from its saved configuration. This confirms loading/configuration, not a live Claude provider call. The user’s existing Sprite received the same scripted runtime/launcher update.

## Refresh and repeated-disconnect repair

Browser checks now verify direct page refresh and manual project reopen restore the selected model, Agent tab, conversation, and working-turn controls without repasting a key. They also cover single-connection tab switching, temporary-disconnect retries, retry exhaustion, and access-denied handling. Browser storage contains only nonsecret view preferences.

The new history module initially caused a real Sprite startup crash: Node strip-types cannot execute TypeScript constructor parameter properties. Replaced that syntax, added a native Node import regression test and an erasable-syntax TypeScript check. Actual participant Sprite startup then passed with runtimeReady, saved OpenRouter configuration, and no stderr errors. Five existing user messages and five assistant messages were recovered from native OpenCode history into the durable journal without inference.

History regression tests cover independent readiness state after transcript truncation, streaming aggregation, restart/interruption behavior, mode-0600 persistence, secret redaction, excluded configure payloads, damaged journals, and write failures. CLI wrappers forward shutdown signals, and runner shutdown flushes its journal and closes child services.

Final recovery validation: 58 tests across 12 files pass, with Biome, both TypeScript checks (including native-runtime erasable syntax), and the production build. The agent browser workflow passes refresh/reopen and bounded reconnect coverage. The dedicated live Sprite check passes manifest/CAS/diff, runner startup/reconnect with authoritative state snapshots, and terminal/tmux reconnection. No model calls were made for recovery validation.

## Anthropic identity-linked key repair

A supplied Anthropic key reproduced HTTP400 before inference: identity-linked keys require `anthropic-workspace-id`. Listing workspaces returned HTTP403, so this key could not discover its workspace. The connector previously discarded the provider's explanation and showed a generic failure.

Added validated optional workspace selection, fixed-model access validation, native saved headers shared by browser SDK and terminal CLI, and specific missing/invalid/inaccessible workspace errors. Rejected key replacements retain the working configuration. The new runtime was uploaded to the participant Sprite and the precise missing-workspace explanation verified against the provider. Eleven focused tests and the full 63-test suite passed, together with both TypeScript checks. No inference calls were made. A workspace ID or workspace-scoped replacement key is still required to rehearse a live Claude turn.

## File explorer revision

Replaced the flat file list with compact expandable folders, file-type icons and change markers. The explorer supports arrow-key navigation, collapse/restore, pointer and keyboard resizing, and saved width/collapse preferences. ResizeObserver ignores hidden-tab zero widths.

The main browser flow and extended workspace flow pass nested file opening, drag/keyboard resize, persistence across reload, unsaved-edit cancellation/preservation, and mobile overflow checks. Desktop and mobile explorer screenshots were inspected. File API permissions and editor save safeguards remain in force.

## Terminal viewport repair

The terminal used a viewport-minus-fixed-offset height that ignored actual header wrapping. Replaced it with a flex child that fills the remaining workspace height; xterm refits only when its host has positive dimensions. The independent terminal browser check verifies desktop, 480px-tall windows, mobile, internal scrollback and connection retention across tabs with mocked transport and real xterm rendering. Desktop/short-window and mobile screenshots were inspected. No provider calls.

## Final Share semantics and existing-work repair

The initial Share implementation published a separate snapshot and retained the participant's native HEAD/index. That behavior was rejected: Share must make a real local commit, with the entered description, and push that exact commit. The implementation now commits shown changes into the participant's active branch, then transports that same commit and fast-forwards shared main. No hidden merge, rewritten parallel history or review gate. Push failure retains the local commit; retry reuses it. Later edits remain dirty, excluded staged files remain staged, and excluded prior commit history blocks publication explicitly.

Ten focused tests and a dedicated live Sprite check verify commit-message preservation, identical native/transferred/remote commit IDs, clean native status after committing, later-edits preservation, stale previews, native index locking/CAS, retry behavior, divergence, access checks and guarded legacy adoption. The actual participant's earlier Share was repaired using its already-created `a1edc8760b9a88146242b8e55b317c66d9d5f9b8` commit (`Project update`): native main and shared main now both point to it, the existing contribution is recorded as accepted, the diff baseline was acknowledged, and native git status is clean. No newer changes were staged during that repair.

The API was briefly stopped while its service updated the accepted state, then restarted, avoiding an out-of-process write behind its in-memory cache. Health verification passed afterward.

## T3 fidelity, Monaco and system themes

The final chat port uses upstream composer/banner/button geometry, message-copy metadata, tool-result rows, Markdown styles and question controls. Custom suggestions, footer hints and turn-completion/cost rows were removed. Chat code fences now use the upstream Shiki WASM helper, streaming grammar-state logic and exact Pierre light/dark palettes. Source mapping and explicit adapter boundaries are in `apps/web/src/vendor/t3code/README.md`. Three real-engine highlighting tests and the agent browser flow pass, including stream updates, copy/wrap, theme switching, credentials retries and session restoration. Light/dark desktop/mobile screenshots were inspected.

The editor is pinned Monaco 0.56.0 with lazy local workers. Workspace browser checks verify syntax colors, live dark/light changes without losing dirty edits, Cmd/Ctrl+S revision-checked saving, externally changed-file preservation, CSV mode and responsive explorer layout. Portal and xterm also follow live system changes; terminal theme tests verify the same connection stays open. Main, workspace and terminal browser flows passed, and their light/dark screenshots were inspected.

## September 15 follow-up: provisioning, file limits and team updates

The actual second Bikes ’r Us workspace stalled before persisted provisioning while the old page misleadingly showed preparation. The original exception was not retained. The corrected workspace lifecycle started setup on the existing page and reached ready with no error. Setup now reports real phases, elapsed time, visible startup/poll errors and retry. Dedicated API and browser fixtures verify failed start, retained error, retry, deduplication, reload mid-setup, interrupted jobs and safe existing-checkout preservation. Dark/light/mobile screenshots were inspected.

File operations now allow 25 MiB per file across the browser, API and Sprite, retaining 50 MiB aggregate, 1 MiB diff-preview and 10 MiB compressed Git bundle limits. Boundary tests transfer an exact-limit file, reject one additional byte without overwriting, and synchronize a larger CSV in both directions.

Incoming team changes use ancestry-aware polling and a top-bar menu. Local Git/Python-adapter tests cover clean merges, untouched conflict previews, resumed agent merges and verification, stale/dirty guards, and recovery copies before replacing even conflicted work. Browser checks cover incoming indicators, Later without mutation, replacement confirmation and light/dark/mobile layout. A real React agent test verifies explicit one-time prompt handoff, draft preservation, no delayed surprise requests and replay-safe completion; no paid model calls were used.

Combined `npm run check` passed 90 tests across 21 files plus Biome, strict application/runtime TypeScript checks and production build. Main portal, workspace/folder-sync, terminal and Changes browser flows passed. Actual Claude inference and the native Windows folder-picker matrix remain unverified.

Final dedicated Sprite incoming-update rehearsal passed through real SpriteClient upload and response validation in an isolated temporary project: ancestry polling, clean divergent merge, unchanged conflict preview, durable agent-merge setup/verification, and backed-up replacement. The test did not call a model or modify user projects. The full browser handoff from Team updates through Workspace to the selected ready Claude adapter sent exactly one mocked request and verified the original Git hashes on completion. `scripts/team-updates-live-smoke.ts --sprite civic-spark-smoke-NAME` reproduces the explicit live transport check.

## Local-folder sync correction

The connected local folder initially had only PROJECT.md, README.md and sample.csv; its checkpoint contained the same three paths. Both Sprite checkouts and shared main already held all 12 yearly CSVs, so that earlier server-side verification did not establish local synchronization. `Sync now` incorrectly performed preview only. The local-folder container also used the same ineffective hidden-element selector that had previously clipped Changes, leaving long transfer lists/actions inaccessible.

Manual sync now transfers nonconflicting additions/edits directly, including an initial empty-folder copy; conflicts and deletions still require review. A bounded, keyboard-scrollable local panel keeps the Apply action above the file list. Transfer status reports completed/total files and current path. Downloads validate each blob's revision without a redundant full manifest scan for every file. Six focused folder-sync tests passed, including nested multi-CSV transfer, checkpointed interruption/resume, byte limits and stale edits.

The actual local folder subsequently converged: all 12 yearly CSVs matched the Sprite SHA-256 revisions and no sync differences remained. A guarded download-only recovery check found zero missing transfers by the time it ran; it did not overwrite local edits or upload files to the Sprite.

Follow-up browser verification passed: one-click initial sync and a later batch of 12 yearly CSV downloads (one larger than 1 MiB), nested Chromium-native file handles, long preview scrolling and visible Apply controls, two-way edits, explicit conflicts/deletions, and unsaved buffers. The OS picker is still substituted in automation; Windows native-picker behavior remains unverified. Actual local CSV checksums were separately verified.

Changes/main/team-update browser flows passed after the compact UI/toast revision. File-toolbar browser tests passed for six icons, keyboard upload, create/download/save/shortcut, dirty reload confirmation, delete confirmation/stale-revision rejection and outsider denial across desktop/mobile and both themes. Terminal browser checks passed automatic opening, existing connection reuse, refresh, bounded retries, explicit disconnect and denied access. Reconnect regression first reproduced the historical-error flash and then verified its removal while preserving live credential errors. No paid inference was used.

Final combined follow-up verification: `npm run check` passed 92 tests across 21 files, repository Biome, strict app/runtime TypeScript checks and production build. All associated browser checks described above passed against the current source. No deployment or Civic Spark repository commit was made.

## Agent environment, Git relay and personal web preview

The shared browser/native context now includes the current project brief, saved launch command/port, React/TS/Vite/Tailwind/Biome guidance, static client-side data preparation, compact mobile UI guidance, real integration commands and explicit confirmation before publication conflict resolution. Runtime guidance is outside project exports. Native executable version checks bypass session/context flags; a real setup probe had failed while initializing Claude with the prompt-file flags. The deterministic version probe and its regression now pass.

Verification:

- Context/native launch tests and actual Git fixtures cover fresh project data, preserved credentials, clean rebase of unpublished commits, untouched checkout/index before conflict approval, recovery refs, dirty/stale guards and export of exact native HEAD.
- Access tests deny other team members, unsigned/cross-origin callers and forged approval tickets. Tickets survive control-plane re-instantiation. Private preview tests cover capability isolation, stripped credentials, static assets, WebSockets and revocation.
- A dedicated smoke Sprite ran the actual CLI request relay against disposable `/tmp` projects. Publication fetched an independently advanced shared main, rebased local work and published the exact native commit. A divergent edit stopped unchanged until separate owner confirmation, then completed a recoverable rebase and publication. No model calls.
- The same isolated Sprite ran Vite 8.3.0: actual HTTP readiness, repeated launch, private HTML/JS requests, restart and stop all passed. Lifecycle tests do not mutate participant projects.
- Chromium exercised Launch/Restart/Stop, the actual separate-origin capability redirect, dark/light/mobile controls and explicit conflict approval with agent handoff. Screenshots were reviewed. Browser testing caught and fixed the initial SameSite=Strict redirect failure; authenticated top-level navigation now uses Lax while cross-origin API requests remain blocked.
- The actual existing Oak Park static dashboard was opened through the owner-authorized workspace button in an isolated browser session. It rendered 17,098 reported crashes, 702 mapped walking/biking crashes and the complete charts/tables without page errors. It uses the configured static directory, not an invented root npm script. Its existing unrelated server was preserved.
- The actual idle Claude runtime was reattached with the upgraded context reader and saved credentials; readiness succeeded and provider-session IDs remained unchanged. No paid inference occurred.

The native Sprite HTTPS URL still exists with Sprite authentication; this verification uses the private local gateway/tunnel, not that external URL. Hosted/public/shared preview exposure remains a separate explicit configuration choice.


## End-of-session checkpoint — September 15, 2026 (America/Chicago)

- Latest combined `npm run check`: **115 tests across 28 files**, Biome, both application/runtime TypeScript checks and production build passed. Vite reports large-chunk warnings; the build succeeds. Cleanup afterward changes documentation and ignore rules only.
- Browser Claude now sets `systemPrompt.snapshot: false` so resumed sessions receive changed guidance. The real installed native CLI against a local fake API verified the outgoing system field on the same resumed session; no paid inference. Browser and native prompt guidance favors React/TypeScript/Vite/Tailwind/Biome, static client-loaded data, simple mobile UI and Leaflet/OpenStreetMap.
- Publication guidance now asks at useful milestones and requires explicit approval for the current changes. Conflict-resolution approval is separate from publication approval. This is guidance, not a newly added server gate on every publication command. Both actual Sprites received the corrected preamble while idle.
- Common editor language detection passed 41 file types in both themes. A failed lazy HTML grammar request reproduced all-gray tokens persisting across file switches. Direct registration of HTML/CSS/JS/TS tokenizers fixes the forced-failure case in development and production. The original incognito request failure was not observed, and user confirmation in that exact window remains pending.
- T3 active-turn UI now uses the upstream elapsed-time row and animated thinking/tool activity, with durable turn timing across reconnects. Browser checks cover actual animation, reduced motion, both themes and completion/stop/error cleanup; screenshots inspected. Upstream attribution is retained.
- Saved-key presence is separate from provider readiness. Refresh/reconnect does not discard it, healthy saved keys hide the password input, and provider failures allow replacement or retry of the Sprite-stored key. Fake-SDK subprocess and production browser checks cover reload, provider switching, failed verification, terminal key changes and keyless retry without leaking credentials. Actual original Sprite key presence was checked, without changing credentials.
- Dev server remains available on 4310, API health passes on 4311, and its watcher is running. Local participant data, project files, sessions, credentials and ignored evidence are preserved. No deployment or remote push was performed during this cleanup.
