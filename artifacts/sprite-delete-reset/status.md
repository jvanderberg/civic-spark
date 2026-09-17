# Completed: Sprite deletion reset

Branch: civic-spark/sprite-delete-reset. Started from canonical local main b106bb83b3e705b0ab288b8347701304e5afe645. Local commit SHA is supplied in the final response and commit.txt.

Implemented authenticated resource verification and confirmed provider absence before metadata retirement; full request/command/relay/provisioning drains; new runtime identity; restart-safe scoped cleanup; explicit generation-bound owner Connect new Sprite from shared main; event pause enforcement; stale callback/session/cache protection. Accounts, memberships, projects, workspace IDs, shared Git, historical preview tombstones and unrelated workspaces remain. Exact metadata lifecycle is documented in docs/sprite-lifecycle.md.

Final evidence:

- npm run check: PASS; 647 tests, 68 files, 2 opt-in suites skipped; lint, both typechecks and production build. check.log.
- Focused deletion tests: 32 PASS. focused.log.
- Active local bridge/turn cancellation regressions: 7 PASS. active-turn.log.
- npm run test:mobile: entire aggregate PASS, exit 0. mobile.log.
- npm run test:lifecycle-browser: PASS, including real shared Git commit/bundle/clone/editor flow after Delete and explicit reconnect. lifecycle-browser.log.
- npm run test:provisioning-browser: PASS. provisioning-browser.log.
- npm run test:connections-browser: PASS; only expected in-flight signout rejections. connections-browser.log.
- Actual destructive-confirmation, reconnect and shared-file screenshots inspected at 360/390 phones, desktop and short viewports in light/dark. No unexpected console errors. browser/ and ../sprite-rows/.

Validation setup/fixes: installed committed root/runtime lockfile dependencies in this isolated checkout; updated stale-generation expectation; fixed a browser fixture teardown to await pending route callbacks. Final mobile run used a fixed production build, with no overlapping rebuild.

No live provider/cloud calls, deletion, deployment, push, paid models, participant data modifications or additional agents. Root runtime24de48f and active participants untouched. Root owns integration/live acceptance on a dedicated test resource. Physical iOS/Android device behavior remains unverified. See handoff.md for implementation details and prototype durability limits.

## Narrow follow-up: dispatch authorization races

Both reviewer P2 fixes implemented atop 1d1029a; separate local follow-up commit (SHA supplied in final response and followup-commit.txt). Delete takes a synchronous admin/current-generation guard, called after complete metadata preflight before accepting absence and immediately at DELETE dispatch. Authorized dispatched deletion still confirms absence and cleans up after later admin revocation; newer generations remain protected. Reset recovery now passes the existing revalidate callback into queued creation.

New injected-fetch/real-adapter regressions cover named GET delayed across admin revocation/new generation for present and missing resources, revocation after authorized DELETE, and real owner Connect queued across database session removal, membership removal, generation change and event pause. Initial focused suite: 41/41 PASS. Running these tests against previous production code reproduced seven failures; the missing/newer-generation case was already protected. Changes restored afterward. Exact persisted reset defaults are verified by a strengthened interrupted-cleanup/restart test with every optional intent seeded.

Both TypeScript checks and changed-source Biome PASS. Related five-file focused run PASS: 170 tests (sprite-controls, sprite-provisioning, missing-workspace-recovery, initial-provisioning-retry, lifecycle-races). Logs: followup-focused.log, followup-regression-before.log, followup-typecheck.log, followup-lint.log. No broad check/browser duplication while root validation runs. No UI changes, live/provider calls, cloud/deploy/push, paid models or participant mutations.

## Runtime-view browser follow-up (root owns application keys)

Added scripts/runtime-identity-browser-smoke.ts and included it in verifySpriteReset, so the existing lifecycle/mobile aggregate runs it. The shipped-UI fixture seeds private Agent transcript and terminal output, keeps an unsaved editor draft, and tests same-Sprite transport reconnect followed by replacement without reload. Both observed deleted/local → fast explicit Connect and skipped old-ready → fresh-ready polling paths are covered. Fresh identity shows the new-key prompt with no new Agent socket or retired transcript; Terminal has only fresh output; Workspace/editor node and draft survive. Same identity retains Agent/Terminal nodes and composer/editor drafts.

PASS: all eight light/dark × 360/390/desktop/short browser cases; inspected actual screenshots; clean consoles. Both typechecks, fixture Biome and local production build pass. Logs: ui-runtime-browser.log, ui-typecheck.log, ui-build.log. Screenshots: runtime-identity/. Existing specialized connection check PASS (ui-connections-browser.log), including text/image/model/session retention and hold/revocation cleanup; only expected in-flight sign-out 401s.

Application patch is LOCAL BUILD ONLY and excluded from the fixture commit: root owns the distinct agent:/terminal: prefixed Sprite identity keys in Workspace.tsx. No Workspace/editor key changes. Root owns final combined npm run check then mobile; neither duplicated here. No live/provider calls, deployment, push, paid inference or participant mutations. Physical-device keyboard behavior remains unverified.
