# Sprite deletion reset handoff

Branch: `civic-spark/sprite-delete-reset`.
Base: canonical local main `b106bb83b3e705b0ab288b8347701304e5afe645` at worktree start.
Commit: supplied in final response and local `commit.txt` after commit.
Root integration owner: Paseo `d393aafd-ebba-4b5e-85e2-da747446e067`.

## Behavior

Admin Delete now verifies provider organization/exact-resource identity, deletes a present Sprite, and requires fresh authenticated exact absence before retiring metadata. Auth/network/uncertain/surviving-resource outcomes preserve the original metadata behind a retryable gate. An already absent resource needs no DELETE. Old confirmations cannot delete a newer generation.

Full HTTP requests, command leases, relay operations and provisioning starts/jobs drain behind the durable gate; agent/terminal/integration bridges disconnect. Removed-session output and deferred relay callbacks cannot target new sessions. Team-status caches include the runtime generation.

Confirmed absence persists a cleanup receipt, then clears the old Sprite identity, provisioning status/errors/phases/timestamp/failure category, initial-create reservation, checkout-repair intent, runtime holds/stop/activity metadata, restore-recovery entry and integration conflict ticket. Native keys/provider-session history/process state disappear with the deleted Sprite. The receipt makes partial local cleanup retryable/restart-safe without a second provider deletion. The old inventory row disappears after cleanup.

A minimal fresh-name/provider reset intent and monotonic generation remain until owner preparation verifies readiness. The owner must explicitly choose Connect new Sprite with the current generation; stale ordinary wake/automatic preparation requests cannot recreate. Event pause still blocks connect. Preparation seeds only canonical shared main, excluding private local commits and files. Account, memberships, catalog, workspace ID, shared Git/history, historical retired preview-origin tombstones and unrelated workspaces are preserved. The fresh Sprite has a new name/native preview URL.

Exact lifecycle: `docs/sprite-lifecycle.md#metadata-lifecycle`. Missing-resource/restored-resource identity checks and same-Sprite absent-checkout repair remain strict and separate.

## Evidence

- `npm run check`: 647 tests passed across 68 files; 2 opt-in suites skipped. Lint, both TypeScript checks and production build passed. `check.log`.
- Focused deletion suite: 32 passed, including provider response/identity uncertainty, API scope/session/origin/generation, active drains, old callbacks, failure/retry, repeated delete, pause, restart/partial cleanup and shared-only replacement. `focused.log`.
- Actual local bridge cancellation/active-turn regressions: 7 passed. `active-turn.log`.
- `npm run test:lifecycle-browser`: passed all pause/row/reset matrices, including actual Git commit/bundle/clone and editor content. `lifecycle-browser.log`.
- `npm run test:provisioning-browser`: passed missing-resource/retry/reload contracts. `provisioning-browser.log`.
- `npm run test:connections-browser`: passed lazy/persistent agent and terminal state, reconnect/revocation/hold behavior; only expected in-flight signout rejections. `connections-browser.log`.
- `npm run test:mobile`: complete aggregate passed with exit 0, including new deletion/reset matrix and all existing portal/workspace/admin/project/provisioning matrices. `mobile.log`.
- Inspected actual screenshots: destructive confirmation, explicit connect and restored shared files at phone/desktop/short widths in both themes. Screenshots under `browser/` and `../sprite-rows/`; browser scripts assert clean consoles.

## Limits

No live provider calls/deletion, deployment, push, paid inference or participant data modifications. All resources/data are isolated fixtures. Live root runtime24de48f and the nine working participants were untouched. Root owns integration and live acceptance on a dedicated resource. Physical iOS/Android keyboard/device behavior is not established by Chromium viewport emulation.

The prototype remains single-writer and uses a durable receipt across stores, not a general multi-store transaction system. Persistent cleanup/storage failure keeps reconnect blocked and can fail startup closed until repaired. Historical backup recovery and publication bookkeeping remain preserved. Existing SQLite experimental and Vite chunk-size notices remain.

## Review follow-up: both dispatch races

Separate commit atop `1d1029a5ba7996b2be1d07933f5e162796402fe2`; cherry-pick only this follow-up after root's integrated `2870d90`. Exact SHA supplied in final response and local `followup-commit.txt`.

- Delete passes current admin/generation validation into the real adapter. The synchronous guard runs after all metadata preflight awaits, before accepting missing and immediately before DELETE HTTP dispatch. Failure retains original identity/reservation behind the deletion hold. Authorized dispatched DELETE still requires exact absence and completes cleanup after later admin revocation; current-generation protection remains.
- Reset recovery calls `create(revalidate)`, so actual command-queue admission checks owner session, membership, generation, event pause and provider binding before POST. Identity verification and confirmation remain unchanged.
- No reset-default bug found: explicit schema defaults replace the complete deletion object with null; explicit undefined clears optional projectRepair; reset is overwritten with fresh identity and later cleared on ready. The strengthened restart test seeds stale top-level reset, projectRepair, deletion reset/ownerRecovery/replacement flags and asserts exact persisted output. Documented in docs/sprite-lifecycle.md.
- PASS: 170 focused tests across five affected suites; both TypeScript checks; changed-source Biome; diff whitespace check. Injected-fetch/real-adapter tests cover delayed named GET and actual occupied create queue through owner Connect API. Seven new regression cases fail against previous production code and pass with the fix; already-missing/newer-generation protection passed before as well.
- Logs: `followup-focused.log`, `followup-regression-before.log`, `followup-typecheck.log`, `followup-lint.log`. No UI changes or broad/mobile rerun; root owns ongoing combined validation, independent reread and dedicated live acceptance. No live/cloud calls, deletion, deploy, push, paid inference, extra agents or participant modifications.
