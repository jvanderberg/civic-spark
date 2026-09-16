# Next-session handoff

Checkpoint: September 16, 2026, America/Chicago. Rename, admin project briefs and the Fly deployment package are integrated. Hosted demo is live at https://civic-spark.fly.dev; see the live deployment record below.

## Local Markdown and single-event update

The `civic-spark-markdown-briefs` branch from `9719554` renders safe GFM in catalog/team cards, with scrollable long-brief disclosures, inert images and unchanged raw Markdown/`PROJECT.md`. A long-code regression exposed and fixed the team card's missing minimum-width constraint.

Optional `CIVIC_SPARK_SITE_EVENT_ID` (Fly setup `siteEventId`) pins the portal to an existing event in its current auth-mode store. `/api/session` supplies the permitted event title; the portal hides cross-event selection/creation and excludes unrelated workspaces, contributions and activity. Missing/invalid configuration fails rather than selecting another event. Root must configure the intended event and deploy; this branch does not push, deploy or modify live data.

Validation: `npm run check` passed 143 tests / 35 files, lint, both typechecks and build; `npm run test:mobile` (including the new site-context matrix) and `npm run test:browser` passed. Markdown fixtures cover GFM, unsafe HTML/URLs, no image fetching, touch/keyboard disclosure and internal code/table scrolling. The site matrix uses two underlying events, checks branding/admin controls and rejects an unrelated workspace URL while preserving valid workspace refresh. Local replay of all 15 imported briefs verified the 9,985-character transit brief in catalog/team views and unchanged canonical content, with no external requests. Screenshots at 360/390/desktop/short sizes in both themes were inspected; consoles were clean. Evidence is ignored under `artifacts/mobile`, `artifacts/site-event`, `artifacts/briefs` and `artifacts/`. No paid inference or live Sprite provisioning. Physical mobile keyboards/pickers remain unverified.

## Resume here

Current worktree: `/Users/joshv/.paseo/worktrees/2eoh2bv5/nasty-octopus`. All three Paseo implementation branches have been combined here. Dependencies and Playwright Chromium are installed; no `.env` or participant data was copied. The earlier machine used `~/git/civic-spark`, portal <http://127.0.0.1:4310> and API <http://127.0.0.1:4311/api/health>; its processes and compatibility symlink were not inspected or changed. Do not start the renamed server against existing participant data before the migration review below.

Read [AGENTS.md](../AGENTS.md), [the implementation plan](../IMPLEMENTATION_PLAN.md), [workspace contracts](workspaces.md), and [breaking rename migration](rename-migration.md). Public source repository: [jvanderberg/civic-spark](https://github.com/jvanderberg/civic-spark). The platform is Civic Spark; event names remain the primary branding. Runtime/configuration identifiers now use the new namespace. External memory pages were not renamed. The fresh Fly demo is separate from all earlier participant installations.

## Current behavior

- Admin overview can create named projects with Markdown briefs/data links through event-admin-authorized domain/API writes. The existing event project `description` seeds canonical `PROJECT.md` for new teams; app README files and existing team/private edits stay intact. Catalog creation does not propagate updates to existing checkouts. See [project brief semantics](product.md#project-briefs).
- Agent context explicitly references the canonical file as untrusted project data. Browser turns refresh it; native launchers regenerate private guidance and preserve resume arguments. Native Claude uses `--system-prompt-snapshot off`, verified alongside the browser SDK at a local fake API with unchanged session IDs and no paid inference. Native OpenCode live resumed inference is still unverified.
- Admin cleanup and repository management: confirmed event-member removal and team deletion; copy shared project/history into a new empty team; browse each team's shared main commits/files/diffs and restore an earlier tree with a new descendant commit. Deleted team resources remain on disk/in Sprites for operator recovery. No global account deletion or in-app undelete. See [product contracts](product.md#admin-cleanup-and-repositories).
- Single-file restore creates a new shared commit changing only the selected file, preserving other current files and private work. Confirmation copy states the action and consequence concisely; keep conversational examples out of interface text.
- Mobile work completed in the requested separate agent stream: phone file drawer, touch controls, safe areas, short-viewport scrolling, dialogs and workspace state preservation. Codex's AGENTS.md and Claude's CLAUDE.md require mobile verification; participant harness guidance also includes mobile requirements. Physical iOS/Android keyboard and native-picker behavior still require device rehearsal.
- Email-identity prototype login, event/admin/team flows and private per-person workspaces are implemented. Production email-link authentication has SMTP/Resend adapters but still needs actual delivery testing.
- The [Fly package](fly-deployment.md) provides a pinned container, single Machine/volume setup, explicit or ambient CLI authentication, secure service credential staging, production HTTPS/email guards and a trusted proxy boundary. Setup is repeatable and does not hardcode an owner organization. The first explicit hosted demo is deployed; see the live record below.
- Sprite provisioning persists phases, uses full-UUID resource names, marks interrupted jobs for owner retry and enforces allocation/concurrency limits. Execution jobs remain process-local; cross-store crash atomicity and full resource lifecycle recovery are still incomplete.
- Full-screen workspace: resizable/collapsible explorer, six file-action icons, Monaco editor, themed diffs, T3-derived agent chat, persistent auto-connecting terminal and local-folder sync.
- Share takes a commit message, makes a real local commit and pushes that exact commit to shared team main. Failed pushes retain the commit. Incoming updates are polled; conflict actions preserve recovery paths. No automatic paid agent work from polling.
- One Sync now action transfers files. Conflicts/deletions require explicit choices. Limits: 25 MiB/file, 50 MiB/scan, 5,000 files; Git bundle 10 MiB and diff source 1 MiB. The actual local folder's 12 yearly CSVs were verified against Sprite hashes.
- Claude/OpenCode use deterministic pinned setup, fixed Opus 5/GLM choices and bypass permissions inside the Sprite. Saved keys remain private there and are shared with native terminal tools. Refresh restores session/context and current turn timing; saved-key fields stay hidden until missing or provider failure.
- Agent guidance favors React/TypeScript/Vite/Tailwind/Biome, static client-loaded data, simple mobile-ready interfaces and Leaflet/OpenStreetMap, unless the user asks otherwise. Browser Claude receives updated system guidance on resumed turns through `snapshot: false`.
- Agents may prepare local commits, but must ask at useful milestones and obtain explicit approval before publishing the current changes. Conflict-resolution approval does not authorize publication. This is prompt/handoff policy; there is no independent server approval gate for every publish command. Manual Share is explicit approval.

## Next steps

1. **Prepare verified-email production separately from the live demo.** The fresh demo below verifies Linux startup, idle redeploy persistence and dedicated Sprite/agent/terminal flows. Real email delivery, token rotation, full volume restore/resource lifecycle and production security review remain outstanding. Follow [Fly deployment](fly-deployment.md); never migrate demo identities into verified accounts.
2. **Migrate existing installations before reconnecting them.** The complete namespace change is breaking and has no old aliases or automatic migration. Follow [migration requirements](rename-migration.md); source publication does not migrate participant data, Sprite names, saved keys, sessions, Git refs or local-folder baselines. Never treat prototype identities as verified hosted users.
3. **Finish hosted previews.** Local Open preview uses a separate-origin gateway and authenticated Sprite tunnel. Hosted Open preview is explicitly disabled; choose participant-private versus public demo exposure before implementing isolated HTTPS routing and restart recovery. Existing Sprite URLs remain private.
4. **Rehearse remaining real flows.** Confirm HTML highlighting and saved-OpenRouter reconnect in the original user browser after migration. Rehearse live Claude questions/cancellation/provider failures, native OpenCode resumed context, Chrome/Edge native folder access and physical iOS/Android keyboard/pickers. Browser/native Claude prompt refresh passes the fake-API resume check without resetting session IDs.
5. **Complete operational recovery.** Hosted Smart HTTP/mTLS Git, integration workspaces/checks, cross-store recovery, external backups/restore, orphan cleanup and enforced spending budgets remain separate work. [Portability](portability.md) requires configurable authenticated protocols without dependence on Fly private networking.

## Validation and useful commands

Combined integration: `npm run check` passed **135 tests / 31 files**, lint, both typechecks and production build. Mobile and all ten specialized browser suites passed, along with the browser/native Claude fake-API prompt check and clean deployment-context build (122 packaged inputs). The workspace suite initially hit a keyboard activation timing race under parallel load and passed in isolation; its readiness wait now explicitly accounts for the preceding file read, and the updated suite passed. The individual branches also passed their checks before integration. The merge preserves canonical runtime names, native Claude snapshot refresh, the existing PROJECT.md handoff and full-UUID provisioning names. Final tracked-file/path scan found no prior-name references.

The rename exercised all ten browser suites and blocked lazy-HTML grammar loading in production and development. Project checks cover event-admin authorization, Markdown/data-link preservation, team brief inheritance and event-scoped drafts. Fly checks cover production auth/origin/proxy boundaries, secure cookies, private WebSocket access, restart reconciliation, allocation limits, idempotent setup and secret round-tripping. A clean allowlisted build context compiles without developer data or secrets. Generated Fly TOML validates; the pinned Fly secret parser was exercised offline with synthetic punctuation-containing credentials.

Screenshots at 360px/390px, desktop, short and landscape viewports were inspected in both themes; completed browser checks reported no unexpected console errors. The deliberately blocked production grammar test has one expected loader error. Physical device checks, native OpenCode resumed inference, Linux container execution and live hosted acceptance remain unverified. Build chunk and experimental SQLite notices remain.

This session used isolated fixtures and no paid inference. Existing participant resources, credentials and services were not changed. Evidence remains in ignored `artifacts/` and temporary check logs. The initial dependency timeout was resolved by `npm ci --prefer-offline --no-audit --no-fund`; shared Playwright Chromium/headless shell v1243 was installed. Historical live evidence is in [prototype results](prototype-results.md), not proof of post-rename compatibility.

```sh
npm run check
npm run test:mobile
npm run test:deploy-context
npm run test:browser
npm run test:agent-browser
npm run test:editor-browser
# Reproduce resilience to a failed lazy HTML grammar request:
CIVIC_SPARK_EDITOR_BLOCK_HTML=1 npm run test:editor-browser
# Same regression against the development server fixture:
CIVIC_SPARK_EDITOR_DEV=1 CIVIC_SPARK_EDITOR_BLOCK_HTML=1 npm run test:editor-browser
npm run test:workspace-browser
npm run test:environment-browser
# Browser/native Claude resume against a local fake API; no paid inference:
npx tsx scripts/agent-prompt-smoke.ts
```

Browser scripts use isolated fixtures. Run production browser checks after building, and avoid simultaneous rebuilds of their shared `dist/` directory. Ordinary checks make no paid model calls. Explicit cloud scripts use dedicated smoke resources; see [README](../README.md#verification). Do not use participant projects as disposable test fixtures.

## Preserve this state

- Ignored `.env`, `.data/`, `artifacts/`, dependencies and build output remain local. Do not delete participant state or include credentials/invitation links in source or memory.
- Original workspace: `e5669c85-a53b-4efe-b819-8be57c3b6d66`; second workspace: `2f237fe1-28d0-4a4c-9d78-8a9b0d746bb4`. Their existing Sprite names remain in private installation metadata; those resources have not been renamed or migrated. The tool-connected regular browser and the user's incognito browser are different sessions.
- Shared team Git is currently a bare repository under `.data/prototype/repos/`. Do not reset participant HEADs or repeat the historical Share repair.
- The original dashboard lives in `/home/sprite/project/web`. Managed preview uses Python's static server on port 5173 for that directory; an earlier unmanaged server on 8777 was intentionally preserved. New apps default to Vite 5173. Launch requests do not authorize rewriting existing apps.
- Preserve active turns when updating the runtime/server. Finish or wait for idle before restarting. Never leave the dev watcher paused.
- Keep the T3 license and source attribution under `apps/web/src/vendor/t3code/`; follow the copied UI rather than inventing chat interactions.

## First live hosted demo — September 16, 2026

URL: https://civic-spark.fly.dev. Explicit hosted demo mode retains unverified email signup and warns that anyone entering the same email can access that demo account. Verified-email production remains the default; local prototype remains loopback-only. No existing participant data was migrated. Demo metadata/cookies are isolated. Sign-in writes have a bounded per-client, process-local limiter (default 20/minute).

One `ord` Machine (`d8d962e3b65118`) and one 1 GiB volume (`vol_vp26nn5023pkey24`) serve this installation. Operator-only setup JSON/receipt remain under ignored `.data/fly/`; `maxSprites=8`, `maxProvisioning=2`. The live proxy peer was observed as `172.16.10.2`, configured as a /32 for this installation; recheck when networking changes. Organizations and origins remain operator configuration, never product defaults. The service uses the existing authenticated Sprite organization token, not a general Fly admin token; its scope remains organization-wide.

Actual remote builds discovered and fixed nested Fly config Dockerfile resolution and Docker directory re-inclusion. The clean-context check now uses a pinned Docker-compatible matcher with regression coverage. All production Sprite exec paths use the pinned CLI's `--file`/`--tty`, explicit command delimiter and `--no-port-forward`. Creation uses `--skip-console`. Repeating the setup helper reused the app, Machine and volume.

Live browser acceptance created a dedicated demo event, Markdown project, team and personal Sprite (`civic-spark-48616e04-41af-4b72-b45d-07cdae830b70`). The browser attached to real files. One explicitly authorized GLM turn wrote `hosted-smoke.txt` and responded (reported cost $0.000196038). Refresh/reopen and idle redeploy preserved the same account, team, workspace, Sprite, file, conversation, saved-key presence and native provider session ID. The terminal ran a command and reattached to the same shell. A different demo identity joined the same team but could not access the first user's private files, agent preparation or agent/terminal sockets. That second membership has a separate unprovisioned workspace.

The disposable OpenRouter entry was removed from native saved credentials after saved-key reconnect verification; key-bearing runner/provider processes were terminated and the management app redeployed. The parent confirmed deletion of the local source key after cleanup. A fresh browser shows an empty credential prompt with preserved conversation; no Sprite process retains an OpenRouter key environment variable. App-wide Sprite orchestration credentials remain installed.

Validation: `npm run check` passed 140 tests / 34 files, both typechecks, Biome and production build. Prototype and demo mobile checks, portal, agent, provisioning, terminal, workspace and clean-context suites passed. The terminal mock check had one timing failure under concurrent load and passed isolated. Real public signup/agent screenshots were inspected in light/dark at 360/390, desktop and short viewport sizes; post-redeploy browser console was clean. Initial preparation produced one transient 409 before runtime setup; subsequent preview/status APIs returned 200. Open preview intentionally returns 409 with the hosted-preview limitation.

Still unverified/out of scope: actual email delivery, physical iOS/Android keyboards/pickers, hosted preview routing, token rotation, external backups/full disaster recovery, continuous hosted Git/mTLS, lifecycle cleanup and enforced spending budgets. The demo's unverified identity model is intentional, not production authentication certification. Live evidence is in ignored `artifacts/live/`.
