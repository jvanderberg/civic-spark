# Next-session handoff

Checkpoint: September 16, 2026, America/Chicago. Local prototype; deployment remains unfinished.

## Resume here

Repository: `~/git/civic-spark` (`~/git/vibehack` remains a compatibility symlink for existing processes). Portal: <http://127.0.0.1:4310>; API: <http://127.0.0.1:4311/api/health>. Development servers were left running. If stopped, run `npm run dev`; do not start a second server against the same data directory.

Read [AGENTS.md](../AGENTS.md), [the implementation plan](../IMPLEMENTATION_PLAN.md), and [workspace contracts](workspaces.md). Wikimemory page: `vibehack`. Public source repository: [jvanderberg/civic-spark](https://github.com/jvanderberg/civic-spark). The platform is provisionally named Civic Spark; event names should remain the primary branding. Existing runtime/config identifiers are unchanged. No deployed Fly app.

## Current behavior

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

1. **Check the user's actual browser.** Confirm `web/index.html` has colors in the original incognito workspace after refresh. The matching lazy-grammar failure is reproduced and fixed; the exact user window has not been confirmed after the fix. Check OpenRouter refresh/reopen hides the saved-key input and resumes without pasting the key. Automated regressions pass for both issues.
2. **Finish the hosted preview design.** Local Open preview works through a separate-origin gateway and an authenticated Sprite tunnel on the Mac. It does not tunnel through the browser. Its loopback URLs will not work unchanged on Fly. The Sprite external HTTPS URL remains private and is not wired into this preview. Choose participant-private versus public demo exposure before implementing hosted HTTPS routing and restart recovery; retain private access until then.
3. **Rehearse remaining real flows.** Full Claude questions/cancellation/provider-failure testing, native Chrome/Edge folder pickers on macOS/Windows, and real email delivery. Native CLI resumed-session prompt refresh has not been verified to the same standard as browser Claude.
4. **Then deployment work.** Durable jobs/recovery, hosted Git transport and event-scoped access, trusted proxies, coordinated metadata backup/recovery, runtime cleanup and enforced budgets. [Portability](portability.md) requires configurable authenticated protocols, not reliance on Fly private networking. No deployment files have been implemented yet.

## Validation and useful commands

Latest full check: **124 tests / 29 files**, lint, application/runtime typechecks and production build passed. The expanded `npm run test:browser` passes confirmed cleanup, copying, repository browsing and whole-repository/single-file restore, plus existing participant/admin flows. Mobile, terminal, workspace and agent browser regressions pass. Light/dark/mobile screenshots were reviewed; console was clean. Browser tests use isolated fixtures and mocked Sprite transports, without paid inference. Build still emits large-chunk warnings. This batch includes admin management, file restore and mobile support; the user authorized committing and pushing it to continue in Paseo on m1mbp. Machine-local environment configuration and prototype data are not tracked by Git. [Prototype evidence](prototype-results.md) records earlier browser and dedicated-Sprite checks without treating historical counts as current.

```sh
npm run check
npm run test:mobile
npm run test:agent-browser
npm run test:editor-browser
# Reproduce resilience to a failed lazy HTML grammar request:
VIBEHACK_EDITOR_BLOCK_HTML=1 npm run test:editor-browser
# Same regression against the development server fixture:
VIBEHACK_EDITOR_DEV=1 VIBEHACK_EDITOR_BLOCK_HTML=1 npm run test:editor-browser
npm run test:workspace-browser
npm run test:environment-browser
```

Browser scripts use isolated fixtures. Run production browser checks after building, and avoid simultaneous rebuilds of their shared `dist/` directory. Ordinary checks make no paid model calls. Explicit cloud scripts use dedicated smoke resources; see [README](../README.md#verification). Do not use participant projects as disposable test fixtures.

## Preserve this state

- Ignored `.env`, `.data/`, `artifacts/`, dependencies and build output remain local. Do not delete participant state or include credentials/invitation links in source or memory.
- Original workspace: `e5669c85-a53b-4efe-b819-8be57c3b6d66`, Sprite `vibehack-e5669c85`; second workspace: `2f237fe1-28d0-4a4c-9d78-8a9b0d746bb4`, Sprite `vibehack-2f237fe1`. The tool-connected regular browser and the user's incognito browser are different sessions.
- Shared team Git is currently a bare repository under `.data/prototype/repos/`. Do not reset participant HEADs or repeat the historical Share repair.
- The original dashboard lives in `/home/sprite/project/web`. Managed preview uses Python's static server on port 5173 for that directory; an earlier unmanaged server on 8777 was intentionally preserved. New apps default to Vite 5173. Launch requests do not authorize rewriting existing apps.
- Preserve active turns when updating the runtime/server. Finish or wait for idle before restarting. Never leave the dev watcher paused.
- Keep the T3 license and source attribution under `apps/web/src/vendor/t3code/`; follow the copied UI rather than inventing chat interactions.
