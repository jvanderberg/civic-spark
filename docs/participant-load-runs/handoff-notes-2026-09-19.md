> Archived verbatim from the ignored working log `.data/handoff-concurrent-load.md` on 2026-09-20. Session numbers, process IDs and `artifacts/` paths refer to the machine and sessions that ran the tests. Repeatable instructions live in `scripts/participant-load/README.md`.

# Handoff: five concurrent scripted participants + backend diagnostics

User paused Astra to hand this work to personal Fable 5.1. Continue in this same worktree:
`/Users/joshv/.paseo/worktrees/2eoh2bv5/sweet-chipmunk`.

## Objective and authorization

Run five deterministic browser participants concurrently against https://civic-spark.fly.dev, on different projects, with backend diagnostics to reproduce and diagnose the earlier HTTP502/409 errors. Each JSON-driven person signs in, creates hello.txt exactly `42`, Shares `hello`, verifies terminal `ls`, configures GLM, asks for a React MVP, waits at least five minutes, asks for `WE'RE ALL GOOD`, checks a fresh successful assistant reply, Shares `MVP`, downloads the team ZIP and verifies React source structure. User explicitly authorized live paid Sprite/GLM tests and necessary instrumentation. Do not start unrelated paid tests or publish source Git. Read root AGENTS.md; do not run exported participant code on the host. No delegation requested. No secrets in source/logs/artifacts.

## Immediate state at handoff

**The five live runs have NOT started.** All code/tests/preflight finished. Deployment launched and is still running as of the last poll; do not launch a second deployment or kill this one just to switch models.

- Unified exec session **23782**: `npx tsx scripts/fly-setup.ts deploy .data/fly/setup.json > artifacts/participant-load/backend-20260919/deploy.log 2>&1`
- Unified exec session **19403**: `python3 artifacts/participant-load/backend-20260919/collect.py`
- Deployment helper buffers Fly output and prints only its safe completion/error; empty deploy.log while building is normal. Timeout up to 15 minutes.
- Collector writes only structured diagnostic JSON to `artifacts/participant-load/backend-20260919/backend.jsonl`; **zero records at handoff**, so log capture has not yet been verified. It filters Fly JSON envelope `message` or `Message`; inspect envelope shape if needed, without exposing secrets/raw provider output.
- Use write_stdin to poll those sessions if available; otherwise inspect existing processes/log files and `fly status`, avoiding duplicate starts. Collector may be left running until the experiment is finished, then terminate only its own process.

## Deployment and event preflight

Existing app civic-spark, org personal, region ord, original Machine **d8d962e3b65118**, original volume **vol_vp26nn5023pkey24**. Preserve these. One writer, performance 2 CPU / 4096 MB; max provisioning 2 retained. Earlier runtime a37a603 (terminal idle fix), source HEAD86955ac only docs after it. No source commit or push made in this task.

Retained operator setup/receipt copied from sibling clever-puma into ignored `.data/fly/setup.json` and `.data/fly/civic-spark/receipt.json`. Only added `diagnostics:true` to setup. Committed helper now supports this optional boolean, emitting CIVIC_SPARK_DIAGNOSTICS=1, default off. Deploy via this helper, which checks the original resource identity. Never provision replacement resources or print the secrets envelope.

Before deploying, read-only DB aggregate showed all **52 existing workspace runtime records held** (no unheld workspaces). Event `Day in Our Data`, ID **b8892f83-8375-492d-a37f-6221c312424f**, had **46 unique active people**. Its capacity was increased **50 -> 51**, preserving all other settings with expectedRevision2 via authenticated EventService API. This makes exactly five slots. User was informed. No other people/workspaces altered. Existing admin demo account used for that authorized setup change: jvanderberg@gmail.com; demo sign-in accepts name/email, not a password.

Backend deployed source fingerprints saved in `artifacts/participant-load/backend-20260919/source-hashes.json`. After deployment confirm health/request-ID header, logs, source hashes if needed, and same Machine/volume before paid run.

## Ready-to-run cohort

Ignored roster: `artifacts/participant-load/cohort-inputs/roster.json`, five relative person JSONs, validated already.

IDs: concurrent-20260919-p01 through p05; emails corresponding @example.test; team names `Concurrent test 20260919 01` through05.
Projects:
1. Your first project
2. Where does my tax dollar go?
3. Can I park here right now?
4. Which bus stops need help?
5. How resilient is our urban forest?

Each prompt asks to read the project brief and produce a small appropriate React/TypeScript MVP with one core interaction and labelled static sample data, preserve hello.txt, any local commit message exactly MVP, and no agent publication. Desktop1440x900, alternating light/dark. Each has a separate browser. Keep the app's ordinary provisioning concurrency2; this still starts all five scripts together and should overlap the agent work.

```
npm run test:participant-cohort -- artifacts/participant-load/cohort-inputs/roster.json --validate
npm run test:participant-cohort -- artifacts/participant-load/cohort-inputs/roster.json --live
```

Live requires env **CIVIC_SPARK_LOAD_GLM_KEY**. User supplied the OpenRouter key in the conversation's original task. It was deliberately NOT written to any file. Recover from conversation context and inject into process environment without printing, shell-history storage, command-line arguments or committed artifacts. The deployment and collector do not need it. Do not request the key again if it is available in context.

Run creates `artifacts/participant-load/cohort-<timestamp>/` with per-person steps.jsonl, requests.jsonl, result.json, screenshots, project.zip, and overall cohort.json. Wait for all five, inspect screenshots, correlate HTTP errors to backend requestId/traceId/operationId. Report successes/failures, timings, per-route error counts, retry recovery and evidence-backed causes. A passing ZIP test certifies source structure, not a successful build/product correctness.

A failure closes the browser but intentionally does not stop a running paid agent. Inspect/reconcile unfinished dedicated test turns; do not kill unrelated participants. Do not blindly rerun these identities: runner rejects existing workspaces to avoid duplicate paid work. Preserve files/commits/resources for diagnosis. User asked reproduction/diagnosis, not speculative fixes.

## Implemented, uncommitted work

Earlier single-run work and current instrumentation are all uncommitted, no unrelated dirty changes at task start.

- scripts/participant-scenario.ts: strict JSON schema, timing limits, bounded retry, fresh streamed completion sentinel with done(success), secret redaction, safe ZIP inspection.
- scripts/participant-load.ts: actual Playwright UI sequence; Share retry reconciles shared HEAD to avoid duplicate commits. Now records random trace UUID and per-request timestamp/step/method/API pathname without query/status/server request-ID, including APIRequestContext GETs. No bodies/cookies/provider headers/traces/HAR saved.
- scripts/participant-load-cohort.ts: new one-to-five roster launcher, validates unique identity/team/ID, launches independent browsers concurrently, waits for all outcomes, aggregate JSON.
- apps/server/src/diagnostics.ts, installed early in app.ts: server-generated UUID response header, UUID-only optional test trace, async context isolation, registered route template/status/duration/workspace ID logs.
- packages/diagnostics/src/index.ts: opt-in schema-allowlisted JSON logging and AsyncLocalStorage. Classifies CLI queue_busy, lease_aborted, timeout, buffer_limit, spawn_missing, process_failed; stderr category/hash only, exit code/signal, no raw CLI arguments/input/output/error message.
- packages/sprites/src/client.ts: command queue/execution timings, per-helper operation IDs/status/outcome, coalesced-read markers. Coalesced commands are attributed to their initiating request, other requests may share the result.
- workspace.py and team_git.py trusted helpers: errors include exception class/line/errno/exitCode for backend only. Client strips helper diagnostic before returning API errors. Error behavior/status preserved.
- scripts/fly-setup.ts optional diagnostics config.
- package scripts test:participant, test:participant-browser, test:participant-cohort.
- tests/backend-diagnostics.test.ts, tests/participant-scenario.test.ts, scripts/participant-load-browser-smoke.ts; generic examples and docs.
- docs/scripted-participant-load.md documents both runners, safe logs, previous acceptance. docs/fly-deployment.md documents diagnostic flag. IMPLEMENTATION_PLAN.md final concurrent deployed acceptance checkbox is still unchecked; complete it only after actual live results.

## Validation already completed

- Focused diagnostic/CLI tests: 5 passed, including concurrent ALS isolation, secret exclusion and helper metadata stripping/logging failure isolation.
- **VITEST_MAX_WORKERS=2 npm run check PASSED:** 70 files passed,2 skipped; **665 tests passed,2 opt-in skipped**; lint, both typechecks, Vite build passed. Full output `/tmp/civic-spark-diagnostic-check.log`.
- **npm run test:participant-browser PASSED:** real local UI/auth/files/Git/ZIP, mocked terminal/agent transports, desktop/360/390/short viewports both themes; streaming phrase, repeated five-minute-equivalent fixture loop, injected503 and lost successful Share response. No paid models. Log `/tmp/civic-spark-participant-browser.log`. Inspected dark360x430 completion screenshot; earlier task inspected wider matrix too. No product UI changes this turn.
- **npm run test:deploy-context PASSED:** default-deny clean source context TypeScript/Vite build,160 packaged files. `/tmp/civic-spark-deploy-context.log`. Linux deployed image still needs live check.
- git diff --check passed. Docs markdown is outside Biome coverage (trying explicit doc paths reports no files; not a code failure).
- No need repeat full tests unless code changes/failure warrants it. Dependencies installed both root and packages/agents/runtime; Playwright installed.

## Earlier result being reproduced

Corrected single run `scripted-20260918-p01b` completed in **438448ms (7m18s)** on `Your first project`; one completion check after full5min, both commits, verified20-entry React ZIP. Evidence:
`artifacts/participant-load/scripted-20260918-p01b-2026-09-19T03-10-08-646Z/`.
Workspace2a3da85c-5aee-494e-b529-380b06826928; teamf1764cf2-eda3-47cb-85b9-ba67116ccc4c.
hello f73df4d73464e0487d8f376503bfe16c4fe64a66; MVP11875a50785a3216c9da9e790462a8708f8db591.
Browser logged **five502 and one409**, but old logging lacked URLs/timestamps/request IDs, so exact original cause is UNKNOWN. Completion screenshot showed generic Sprite CLI error. Do not claim old failures definitely were load/network/Git conflicts. New experiment is intended to establish evidence.

Earlier aborted trial p01 on Oak Park over time left hello commit/partial files. Stop UI did not settle promptly. Its dedicated native opencode.exe process was later terminated through its terminal and absence verified; no paid process left from that trial. Detailed notes in initial trial artifacts. That Stop failure cause remains unknown, separate from HTTP errors.

## Remaining work

1. Resolve already-running deployment status safely; verify same resources, deployed diagnostics, health and collector output.
2. Launch the prepared five-person cohort with key only in env; keep concise user progress updates.
3. Wait, inspect evidence, correlate 502/409 with command/helper logs. Investigate reproduced causes without raw secret/content logging.
4. Document actual outcomes and limitations, update final plan checkbox, save readable reproduction report with evidence links. Stop collector after capture.
5. Report to user concisely. Do not claim reproduced causes explain old requests conclusively if evidence cannot connect them. Do not publish source Git without authorization.

## Follow-ups noted during the September 19 cohort run (not started)

User requested, for the next test, after the current five-person run completes:

1. Raise provisioning concurrency from 2 to 5 (`maxProvisioning` in setup, `CIVIC_SPARK_MAX_PROVISIONING`).
2. Make the "Workspace preparation is busy" 429 retry transparent: the client should retry automatically
   with a preparing state instead of showing an error and a Retry button.

No code for these yet; user said to note them only.
3. Participant runner: during agent waits, poll the workspace runtime and fail fast when
   `runtime.held` becomes true (record reason, e.g. idle) or the agent socket closes / the
   "session no longer has workspace access" error renders, instead of waiting out agentTurnMs.
   Motivated by p03 in cohort-2026-09-20T01-06-06-269Z: paused idle at 01:20:05, runner waited until 01:34:58.

## Completion status (Fable 5.1, 2026-09-20 01:42 UTC)

Live run finished: cohort-2026-09-20T01-06-06-269Z, 4 passed / 1 failed (p03, harness observer defect; platform completed the turn).
Report: artifacts/participant-load/backend-20260919/REPORT.md. Collector stopped. Docs and plan updated. No source commit or push.
p03 workspace was resumed once for inspection (generation 1), no prompt sent. Event capacity 51 fully used.

## Cohort B (15 people) preparation, 2026-09-20 ~02:30 UTC
- Source commit c820ffa (local only): runner fixes, prepare retries, client busy retries, new diagnostics.
- Event capacity raised 51 -> 66 (revision 3 -> 4) via authenticated PATCH as admin demo account.
- setup.json maxProvisioning 2 -> 5; deployment via fly-setup helper (deploy-2.log).
- Roster: artifacts/participant-load/cohort-inputs-b/roster.json (cohortb-20260920-p01..p15, 15 distinct projects).
- Collector: artifacts/participant-load/backend-20260920b/collect.py -> backend.jsonl.
- Cohort B result (02:49 UTC): 15/15 passed; 14 busy 429 retried transparently; 0 502/409/423. Report: artifacts/participant-load/backend-20260920b/REPORT.md. Commits c820ffa, 7995ad0 local only (not pushed).
- Collector backend-20260920b still running while a Fable agent investigates stuck workspace 8b5ab350-e0c1-4c27-beba-bec7465de356 (user-reported: cannot send, Stop not working).
- Stuck workspace 8b5ab350 diagnosed (artifacts/participant-load/backend-20260920b/stuck-8b5ab350.md): dismissed question -> tool-calls finish never settled; abort loop livelock. User killed runner pid; recovery confirmed via diagnostics 03:03:37Z. Fix committed 5772c6d (tracker only). Deployment 3 launched ~03:25 UTC (deploy-3.log). Existing runner processes keep old code until restarted; new agent attaches upload the fixed runner.
- Deployment 3 verified 03:25 UTC: image deployment-01M2YDD5DWW3PWQ046M0J8E1MR, same Machine/volume, health 200 with request ID, deployed opencode-turn.ts sha256 matches commit 5772c6d. Local commits c820ffa, 7995ad0, 5772c6d not pushed.
- Cohort C (50 people) 03:43-04:0x UTC: 17/50 passed; bottleneck = management host single event loop saturated (native I/O) at ~25 concurrent. Report artifacts/participant-load/backend-20260920c/REPORT.md. Fixes not started. Branch sweet-chipmunk pushed to origin; origin/main diverged (backups work), rebase pending.

## Round 2 (2026-09-20 ~01:30 CDT) — load fixes, uncommitted in sweet-chipmunk
- Implemented: slim portal state + on-demand briefs, ETag/304, brotli/gzip, precompressed assets, conditional client GETs, 15 s visible-only portal poll, agent delta batching (50 ms), activity touch batching (30 s flush), adaptive file/preview polling, socket auth checks every 30 s, terminal ring buffer + coalescing + zero-client detach, fast branch head read, session fetched once per sign-in, loop telemetry; plus helper-session (F1) by sub-agent (packages/sprites/src/helper-session.ts, helper_session.py; CIVIC_SPARK_HELPER_SESSIONS=0 disables).
- setup.json managementCpus 2 -> 1 (user: dump the second core). Deploy rule: merge main, land on main, deploy main.
- Pending: smokes (participant-projects, mobile) green, full check, commit, ff main, deploy, canary (cohort-inputs-d), then 50-person rerun.
- 01:5x CDT: round two committed 93d0966, branch pushed, main fast-forwarded to 93d0966. Instance cleaned again (22 Sprites, 31 teams). Deploy 4 launched (1 vCPU). Collector: artifacts/participant-load/backend-20260920d. Next: verify deploy, canary cohort-inputs-d, then 50-person rerun (cohort-inputs-c identities are used; generate cohort-inputs-e).
- 06:46Z deploy v34 verified (commit 4c... main = branch; 1 vCPU; brotli+immutable assets; 304 works; loop telemetry). Canary canary-20260920-p01 running; helper session live: 80/89 commands via session, p50 67 ms vs 142 ms process. Next: 50-person run with cohort-inputs-e (stagger 3500 ms).
- 07:24Z cohort E result: 47/50 passed on 1 vCPU (baseline 17/50). Report artifacts/participant-load/backend-20260920d/REPORT.md. Collector stopped. Instance holds 50 cohort E teams + Sprites (idle-held). p05 agent may still be running in its Sprite (long turn).
- Round 3 (2026-09-20 ~02:30-03:00 CDT): merged relay workers (4d28c84) + events socket (e81ddba) into sweet-chipmunk; check 705 tests + 5 smokes green; main = 98ffdaa; deploy 6 launched (1 vCPU, relay workers default 2). Collector backend-20260920e; telemetry.py summarizes loop/relay per minute. Next: verify deploy, canary (cohort-inputs-f-canary), 50 (cohort-inputs-f).
- 15:17Z cohort G (4th 50-run) on main 903f55d: 48/50, median 7m39s, main loop 17% median / 35% peak, first byte 0.25 s; both failures stale-preview Share 409. Report artifacts/participant-load/backend-20260920f/REPORT.md; docs/plan landed on main 477ebf2.
- In progress: client retries Share once with refreshed preview when only the fingerprint changed (Changes.tsx), runner refreshes and retries; smoke case added (dark-1440). Then check, mobile smoke, commit, main, deploy. Instance holds 50 cohort G teams/Sprites (idle-held).

## 2026-09-20 later: ignored build output + Replace team repository escape hatch

- Changes now honors Git ignore rules on both adapters (`packages/workspace/src/files.ts` via `ignoredUntracked()` in `packages/git/src/repository.ts`; `packages/sprites/src/workspace.py` `ignored_untracked()`), using `git check-ignore -z --stdin` over the walked paths. Tracked files are never reported by check-ignore, so a committed file that later matches a rule still shows as modified. Ignored paths are dropped from `current`, so they neither move the preview fingerprint nor get staged by Share. Test: `tests/gitignore-paths.test.ts` third case. Reported by Josh: `tsconfig.tsbuildinfo` showed as "1 file changed" after `tsc -b`.
- Escape hatch: `POST /api/workspaces/:id/share` accepts `replaceShared: true`. Engine `publishPrepared(..., { replace })` skips the ancestry refusal (prepare job `replace` flag), backs up the displaced head at `refs/civic-spark/replaced/<yyyymmddThhmmss>-<sha12>` when the new head is not a fast-forward, CAS-updates main against the observed head, and records "<name> replaced the team repository with “…”. The previous team version is kept at <ref>." Repeat with unchanged main is a no-op. UI: collapsed `<details class="changes-replace">` under the Share form, typed `YES` gate, closes after success. Agent CLI path untouched (no force). Test: `tests/share-replace.test.ts`; smoke: `scripts/changes-browser-smoke.ts` (also covers ignored output). Docs: AGENTS.md, docs/product.md, docs/workspaces.md, IMPLEMENTATION_PLAN.md.
- Also in this batch (uncommitted before): Share stale-preview retry, prepared memo, 180 s terminal detach, terminal connecting cover (cover button label "Reconnect" to avoid duplicating the header button), tmux status off, Playwright + `civic-spark git fetch` guidance.
