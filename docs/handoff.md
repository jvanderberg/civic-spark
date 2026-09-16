# Next-session handoff

Checkpoint: September 16, 2026, America/Chicago. Local prototype; deployment remains unfinished.

## Resume here

Current worktree: `/Users/joshv/.paseo/worktrees/2eoh2bv5/nasty-octopus`. The rename started from a clean Git status. This worktree initially had neither dependencies nor `.env`. The earlier machine used `~/git/civic-spark`, portal <http://127.0.0.1:4310> and API <http://127.0.0.1:4311/api/health>; its processes and compatibility symlink were not inspected or changed. Do not start the renamed server against existing participant data before the migration review below.

Read [AGENTS.md](../AGENTS.md), [the implementation plan](../IMPLEMENTATION_PLAN.md), [workspace contracts](workspaces.md), and [breaking rename migration](rename-migration.md). Public source repository: [jvanderberg/civic-spark](https://github.com/jvanderberg/civic-spark). The platform is Civic Spark; event names remain the primary branding. Runtime/configuration identifiers now use the new namespace. External memory pages were not renamed. No deployed Fly app.

## Current behavior

- Admin overview can create named projects with Markdown briefs/data links through event-admin-authorized domain/API writes. The existing event project `description` seeds canonical `PROJECT.md` for new teams; app README files and existing team/private edits stay intact. Catalog creation does not propagate updates to existing checkouts. See [project brief semantics](product.md#project-briefs).
- Agent context explicitly references the canonical file as untrusted project data. Browser turns refresh it; native launchers regenerate private guidance and preserve resume arguments. Native Claude uses `--system-prompt-snapshot off`, verified alongside the browser SDK at a local fake API with unchanged session IDs and no paid inference. Native OpenCode live resumed inference is still unverified.
- Admin cleanup and repository management: confirmed event-member removal and team deletion; copy shared project/history into a new empty team; browse each team's shared main commits/files/diffs and restore an earlier tree with a new descendant commit. Deleted team resources remain on disk/in Sprites for operator recovery. No global account deletion or in-app undelete. See [product contracts](product.md#admin-cleanup-and-repositories).
- Single-file restore creates a new shared commit changing only the selected file, preserving other current files and private work. Confirmation copy states the action and consequence concisely; keep conversational examples out of interface text.
- Mobile work completed in the requested separate agent stream: phone file drawer, touch controls, safe areas, short-viewport scrolling, dialogs and workspace state preservation. Codex's AGENTS.md and Claude's CLAUDE.md require mobile verification; participant harness guidance also includes mobile requirements. Physical iOS/Android keyboard and native-picker behavior still require device rehearsal.
- Email-identity prototype login, event/admin/team flows and private per-person workspaces are implemented. Production email-link authentication has SMTP/Resend adapters but still needs actual delivery testing.
- Sprite provisioning shows phases, elapsed time, errors and retry. Jobs remain process-local.
- Full-screen workspace: resizable/collapsible explorer, six file-action icons, Monaco editor, themed diffs, T3-derived agent chat, persistent auto-connecting terminal and local-folder sync.
- Share takes a commit message, makes a real local commit and pushes that exact commit to shared team main. Failed pushes retain the commit. Incoming updates are polled; conflict actions preserve recovery paths. No automatic paid agent work from polling.
- One Sync now action transfers files. Conflicts/deletions require explicit choices. Limits: 25 MiB/file, 50 MiB/scan, 5,000 files; Git bundle 10 MiB and diff source 1 MiB. The actual local folder's 12 yearly CSVs were verified against Sprite hashes.
- Claude/OpenCode use deterministic pinned setup, fixed Opus 5/GLM choices and bypass permissions inside the Sprite. Saved keys remain private there and are shared with native terminal tools. Refresh restores session/context and current turn timing; saved-key fields stay hidden until missing or provider failure.
- Agent guidance favors React/TypeScript/Vite/Tailwind/Biome, static client-loaded data, simple mobile-ready interfaces and Leaflet/OpenStreetMap, unless the user asks otherwise. Browser Claude receives updated system guidance on resumed turns through `snapshot: false`.
- Agents may prepare local commits, but must ask at useful milestones and obtain explicit approval before publishing the current changes. Conflict-resolution approval does not authorize publication. This is prompt/handoff policy; there is no independent server approval gate for every publish command. Manual Share is explicit approval.

## Start tomorrow with

1. **Integrate the namespace change before reconnecting existing installations.** The parent coordinates the separately developed project setup and Fly changes and owns publication. Reconcile any new configuration/runtime references with `CIVIC_SPARK_*`, `civic-spark` and `civic_spark`, then rerun the combined checks and tracked-content/filename scan. Follow [migration requirements](rename-migration.md); the source rename did not migrate live resources.
2. **Check the user's actual browser after migration.** Confirm `web/index.html` has colors in the original incognito workspace after refresh. The matching lazy-grammar failure is reproduced and fixed; the exact user window has not been confirmed after the fix. Check OpenRouter refresh/reopen hides the saved-key input and resumes without pasting the key. Automated regressions pass for both issues.
3. **Finish the hosted preview design.** Local Open preview works through a separate-origin gateway and an authenticated Sprite tunnel on the Mac. It does not tunnel through the browser. Its loopback URLs will not work unchanged on Fly. The Sprite external HTTPS URL remains private and is not wired into this preview. Choose participant-private versus public demo exposure before implementing hosted HTTPS routing and restart recovery; retain private access until then.
4. **Rehearse remaining real flows.** Full Claude questions/cancellation/provider-failure testing, native Chrome/Edge folder pickers on macOS/Windows, and real email delivery. Browser and native Claude prompt refresh pass the local fake-API resume check; native OpenCode live resumed-session context still needs rehearsal.
5. **Then deployment work.** Durable jobs/recovery, hosted Git transport and event-scoped access, trusted proxies, coordinated metadata backup/recovery, runtime cleanup and enforced budgets. [Portability](portability.md) requires configurable authenticated protocols, not reliance on Fly private networking. No deployment files have been implemented in the rename scope; a separate Fly implementation awaits parent integration.

## Validation and useful commands

Project setup validation (September 16): `npm run check` passed **126 tests / 30 files**, lint, both typechecks and build. Mobile, portal, agent and terminal browser checks passed; project form screenshots at 360px, 390px, desktop and 360×430 were reviewed in both themes with clean consoles. Domain/API tests cover authorization, unchanged Markdown links and team brief inheritance; browser tests cover event-scoped draft isolation. `scripts/agent-prompt-smoke.ts` verifies browser/native Claude resumes against a local fake API without paid inference. Native OpenCode live resumed inference remains unverified. The combined rename/project integration also passed the full check, mobile, portal and fake-API prompt checks; Fly integration remains pending.

Rename validation (September 16): `npm run check` passed **124 tests / 29 files**, Biome, both application/runtime TypeScript checks and the production build. `npm run test:mobile` and all ten specialized browser scripts passed: portal, workspace/folder sync, agent, terminal, provisioning, team updates, changes, file toolbar, environment and editor. Editor checks passed with `CIVIC_SPARK_EDITOR_BLOCK_HTML=1` in production and with `CIVIC_SPARK_EDITOR_DEV=1` in development (41 file types, both themes). The production forced-failure check produced its one expected blocked-loader error; no unexpected console/page errors were reported. Actual desktop, 360px/390px phone, 360×430 and landscape screenshots were reviewed in both themes, including the renamed error copy and reachable retry/close controls. Physical iOS/Android keyboards and native pickers remain unverified.

Focused regressions verify Civic Spark email copy, prototype cookie namespace, new Sprite names, persisted mobile workspace-tab selection after reload and branded API-error recovery. The file-toolbar check contained an earlier stale 28px phone-height assertion; it now verifies the existing 44px phone targets at both 360px and 390px, while retaining the desktop check. No product layout change was needed.

All 178 previously tracked files and their filenames were scanned case-insensitively, including separated name variants: zero earlier-name references remain. None of the tracked filenames needed renaming. The new migration document was scanned too. Python adapters parse and shell scripts pass `bash -n`; package/lock names agree, and dependency resolutions are unchanged. Evidence remains in ignored `artifacts/` and `/tmp/civic-spark-rename-*.log`. Existing large-chunk build and experimental SQLite notices remain.

Local setup: the initial unrestricted `npm ci` failed with registry `read ETIMEDOUT`; `npm ci --prefer-offline --no-audit --no-fund` then installed all 431 dependencies successfully. Playwright Chromium/headless shell v1243 was missing and was installed; the subsequent full check passed. This worktree still has no `.env`; isolated checks supply their own configuration, so no local secrets or participant data were copied. No live Sprite tests or paid model calls were run, and no live resources or services were changed. The rename is committed locally for parent integration and has not been pushed by this task.

Earlier pre-rename checkpoint: **124 tests / 29 files**, lint, application/runtime typechecks and production build passed. The expanded `npm run test:browser` passes confirmed cleanup, copying, repository browsing and whole-repository/single-file restore, plus existing participant/admin flows. Mobile, terminal, workspace and agent browser regressions pass. Light/dark/mobile screenshots were reviewed; console was clean. Browser tests use isolated fixtures and mocked Sprite transports, without paid inference. Build still emits large-chunk warnings. That earlier batch covered admin management, file restore and mobile support. The rename is being committed locally for parent integration; the parent owns publication of the combined verified work. Machine-local environment configuration and prototype data are not tracked by Git. [Prototype evidence](prototype-results.md) records earlier browser and dedicated-Sprite checks without treating historical counts as current.

```sh
npm run check
npm run test:mobile
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
