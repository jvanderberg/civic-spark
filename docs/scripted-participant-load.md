# Scripted participant rehearsal

`npm run test:participant` runs one deterministic Playwright participant from a JSON file. It is separate from the prose-driven September 17 roleplay and from the local capacity benchmarks. One successful run establishes functional acceptance, not concurrent-user capacity or MVP correctness.

Copy [person-01.json](../examples/participant-load/person-01.json) into ignored `artifacts/participant-load/` and set the target origin, exact event/project names, participant name/email and a unique team name. [person-02.json](../examples/participant-load/person-02.json) shows a different project and a phone viewport. Each process has an independent browser context and JSON identity; use different projects across the roster. Validate one participant before launching a concurrent cohort.

The script supports the existing demo and loopback prototype sign-in flows. Verified-email sign-in needs a separate mail-link integration and is not bypassed. Live runs create a dedicated team and Sprite, use paid GLM turns, and publish the two requested commits through Share. Existing workspaces or a duplicate team name cause a stop. Use dedicated Civic Spark test identities/resources, with enough event membership capacity. Failures preserve created resources and local/shared work for inspection; restarting with the same account is deliberately rejected rather than silently repeating paid work. Resource deletion is a separate operator action.

## Run one participant

Install the repository's locked dependencies with `npm ci` and the matching Chromium with `npx playwright install chromium` if needed. For the complete existing test suite, also install its pinned harness dependencies with `npm ci --prefix packages/agents/runtime`. ZIP inspection uses the system `unzip` executable. The unit checks additionally use `zip`. No new runtime dependency is required.

```sh
npm run test:participant -- artifacts/participant-load/person-01.json --validate

# Read the key without echoing it or putting it in shell history (bash/zsh).
read -rs CIVIC_SPARK_LOAD_GLM_KEY
export CIVIC_SPARK_LOAD_GLM_KEY
npm run test:participant -- artifacts/participant-load/person-01.json --live
unset CIVIC_SPARK_LOAD_GLM_KEY
```

Set `credentialEnv` to select a different `CIVIC_SPARK_*` environment variable per person. Never put keys in JSON, project files or committed examples. The script does not save storage state, cookies, outbound WebSocket frames, HAR, video or Playwright traces. Logs redact provider-key patterns; screenshots mask password inputs. JSON validation rejects unknown fields, including inline credentials.

## Run a concurrent cohort

Create a roster JSON containing one to five paths to person JSON files, relative to the roster file. Every person must have a unique ID, email and team name; choose different projects. For example: `["person-01.json", "person-02.json"]`.

```sh
npm run test:participant-cohort -- artifacts/participant-load/cohort-inputs/roster.json --validate
npm run test:participant-cohort -- artifacts/participant-load/cohort-inputs/roster.json --live
```

The cohort launches independent browsers concurrently, retains each person's evidence in its own directory, waits for all outcomes and writes `cohort.json`. The application retains its normal provisioning admission limit. A participant failure does not cancel the other runs. Closing a failed test browser does not stop an agent; inspect any unfinished paid turn before further tests.

Each run sends a random `x-civic-spark-test-trace` UUID. `requests.jsonl` records timestamps, current steps, methods, API paths without query strings, status codes and server-generated `x-civic-spark-request-id` values. Failed HTTP responses also appear in `result.json`. This includes the runner's authenticated verification requests as well as page traffic. It does not capture request/response bodies, cookies or credential headers.

Enable backend diagnostics with `CIVIC_SPARK_DIAGNOSTICS=1`; the Fly setup helper accepts `"diagnostics": true` in the existing public setup JSON. Diagnostics are off by default. Structured `civic-spark.diagnostic` records correlate registered HTTP route templates, status/duration, workspace UUIDs, command queue/execution timings and operation IDs. Sprite failures record allowlisted outcomes, exit codes/signals and stderr classification/hash, never raw command arguments, stdin, stdout, stderr, prompts or file contents. Trusted workspace/Git helpers provide numeric exception metadata to the server, stripped before API responses. Correlation headers are diagnostic labels only and never authorize access. A server-side coalesced read can serve several HTTP requests; its command belongs to the initiating request. `sprite.command` records carry `transport` (`process` for a CLI spawn, `session` for the per-Sprite helper session) and `sprite.session` records mark each session start and end with its outcome and duration.

## Exact sequence

1. Sign in through the page with the configured name/email; choose the exact event and project, create a uniquely named test team, and open its workspace.
2. Use New file and the editor to save `hello.txt` containing exactly `42`. Share with `hello`. Verify the shared Git HEAD, its commit subject, and the committed file contents.
3. Open Terminal, type `ls` and Enter, and require returned output containing both `hello.txt` and `PROJECT.md`.
4. Open Agent, select GLM, save the environment-provided key, and send the MVP request. The default prompt asks it to read `PROJECT.md`, answer the project's civic question with real data fetched from the sources the brief lists (trimmed extracts under `public/data` with a `SOURCES.md`, placeholders only when a source is unreachable and then clearly labelled), use React/TypeScript, preserve `hello.txt`, and leave publication to the script. Earlier runs allowed only labelled sample data, which produced apps with no real content. Any agent-created local commit must use exactly `MVP`: Share preserves an existing local HEAD when the working tree is already committed.
5. Wait 300,000 ms, then ask whether it is finished and request `WE'RE ALL GOOD` in caps on its own line. If the agent is still working, draft the question and wait for Send to become available; never Stop its current turn. Require a new assistant response after this specific question and a successful end-of-turn event. User echoes, tool output, historical/replayed replies, failed turns and partial streaming responses cannot satisfy the check. Repeat the five-minute wait/question up to `completionChecks` (default six).
6. After completion, use Changes → Share with `MVP` and verify the shared HEAD/subject.
7. Return to My teams in the main portal and download Team ZIP. Inspect the actual archive: exact `hello.txt`, a `package.json` declaring React and React DOM plus a build script, an `index.html`, and source importing React or React DOM. Do not install, build or execute exported participant code on the management/test host. This is source-structure verification, not a build or product-quality check.

`timing` configures action/provisioning/agent timeouts, polling, think time and bounded exponential retry delay. Live runs enforce at least five minutes between completion questions. Navigation and read operations retry transient failures. Share retries reconcile shared history first so a lost successful response does not publish a duplicate commit. Conflicts/stale reviews stop for inspection. Team creation and paid prompts are not blindly resubmitted after ambiguous results. Browser transport reconnects remain the app's own bounded behavior. A failed or stopped completion turn ends the run.

Each invocation writes a timestamped directory under `artifacts/participant-load/` containing `steps.jsonl`, `result.json`, milestone/failure screenshots and, on success, `project.zip`. Results include workspace/team IDs, verified commit hashes, completion-check count, timings and browser console/page errors. Console errors are retained even if the workflow recovers; a passing workflow does not imply a clean console. Artifacts and generated JSON stay ignored by Git.

## Live concurrent acceptance — September 21, 2026, fifty people on the final September build

Release v40 (main `0ad0cd5`), one vCPU, cohort H with a canary first. 41 of 50 passed; median 8m55s, p90 12m24s; main loop 32 % peak and p99 delay 146 ms during the arrival minute, no 5xx/429 across about 17,000 requests. Eight failures were Share refusals with a single cause, the scaffold-written `.oxlintrc.json` rejected by the old hidden-file rule, and one was a runner timing miss on the editor during the peak minute. The hidden-path policy became a denylist afterwards. Report: [participant-load-runs/run-20260921a.md](participant-load-runs/run-20260921a.md).

## Operator tooling and run archive

The instance-side helpers (roster generation, capacity, backend log capture, correlation, per-minute telemetry, cleanup) are tracked under [scripts/participant-load](../scripts/participant-load/README.md) with a start-to-finish runbook. Every run's report is archived under [docs/participant-load-runs](participant-load-runs/README.md).

## Free validation

```sh
npm run check
npm run test:participant-browser
```

The specialized browser check uses the actual sign-in, UI, local file service, Git Share and ZIP export with terminal/agent transport doubles. It runs desktop, 360px, 390px and short phone viewports in both themes, deliberately requiring two completion checks and splitting the successful phrase across streamed chunks. One case injects a failed Share followed by a lost successful Share response and asserts no duplicate publication. Unit checks cover config limits, credential redaction, bounded retries, completion false positives and archive content failures. Neither command runs paid models. Physical phone keyboards remain outside browser emulation coverage.

## Live acceptance — September 18, 2026

The corrected runner completed one participant on the hosted demo in **438,448 ms (7m18s)**, selecting **Your first project** with a small starter-MVP prompt in the person's JSON. The first completion question followed the full five-minute wait; GLM returned the required phrase, then the script shared and downloaded through the UI.

- Shared `hello`: `f73df4d73464e0487d8f376503bfe16c4fe64a66`, with committed `hello.txt` exactly `42`.
- Shared `MVP`: `11875a50785a3216c9da9e790462a8708f8db591`.
- Download: 20 entries, `project/package.json` declaring React/React DOM, a build script and HTML entry, React source at `project/src/App.tsx`, and preserved `project/hello.txt`.
- Evidence: ignored `artifacts/participant-load/scripted-20260918-p01b-2026-09-19T03-10-08-646Z/` contains the JSON result, timings, inspected screenshots and actual ZIP. The person configuration is `artifacts/participant-load/person-01-validated.json`; it contains no key and cannot be rerun as a fresh identity.
- The browser recorded **five HTTP502 errors and one HTTP409 error** despite completing the workflow. Those remain in `result.json`; their endpoint/root cause was not established by this harness. This is not a clean-console claim, generated-app quality/build certification, or a concurrent-user capacity measurement.

An earlier dedicated Oak Park over time trial was interrupted before completion acceptance while validation fixes were being finalized. Its hello commit and partial files were preserved. The UI Stop request did not settle promptly; its exact native `opencode.exe` process was subsequently terminated through that dedicated Sprite's terminal and absence verified. Notes are in the initial trial's ignored evidence directory. Earlier roleplay participants were not changed.

Local validation also passed `VITEST_MAX_WORKERS=2 npm run check` (662 tests, two opt-in skips, lint/typechecks/build) and the full specialized browser matrix. The initial fresh-worktree check lacked the separately pinned runtime dependencies; installing those resolved that setup failure.

## Live concurrent acceptance — September 20, 2026 (UTC)

Five people ran together against the hosted demo with backend diagnostics enabled on the existing Machine and volume, one per project. Four passed the full sequence; each answered the first completion question after the five-minute wait, Shared `MVP`, and downloaded a React ZIP: **Your first project** 6m05s (21 entries), **Where does my tax dollar go?** 9m47s (27), **Which bus stops need help?** 8m41s (25), **How resilient is our urban forest?** 6m15s (27). Zero browser HTTP errors for those four.

**Can I park here right now?** failed the completion loop after 28m49s. The Sprite journal shows the agent answered `WE'RE ALL GOOD` with a successful `done` twelve seconds after the question, the browser client ran its post-completion refresh at that moment, and the workspace was held idle five minutes later exactly as the lifecycle policy specifies. The scripted observer never registered that `done`; the most likely cause is its 10,000-event ring buffer invalidating the precomputed turn start index during a long streamed turn. This is a harness defect to fix before the next run, not a platform failure. Its MVP commit exists in the Sprite and was not Shared.

Backend correlation over 11,996 diagnostic records: 2,232 Sprite commands succeeded, command queue wait p95 4 ms, no helper failures, **no 409**. Non-2xx responses were one 429 (our own `maxProvisioning` 2 refusing the third simultaneous create; the client retried), four 423 (the idle hold above), and one 502 reproduced during inspection: `POST .../agent/prepare` on a just-resumed Sprite when `sprite exec` exited after a 30-second CLI-side timeout; a retry succeeded in 7.6 s. That is the first evidence-backed 502 path; the September 18 errors cannot be tied to it because that run lacked request IDs.

Notes for the next iteration: `fly logs --json` emits pretty-printed multi-line objects, so collectors must stream-decode; the runner should fail fast when the workspace becomes held; websocket lifecycle and agent runner exits are not yet instrumented. Evidence lives in ignored `artifacts/participant-load/cohort-2026-09-20T01-06-06-269Z/` and `artifacts/participant-load/backend-20260919/REPORT.md`.

## Runner changes after the September 20 cohort

- Observed agent events are written to `agent-events.jsonl` per person (key redacted), streamed text deltas are coalesced per message, and the current turn is located by its fresh user echo on every poll. Buffer trimming can no longer hide an end-of-turn event.
- Agent waits fail fast with the actual cause when the workspace becomes held, the Sprite paused dialog appears, or the app reports that the agent connection ended, instead of waiting out the turn timeout.
- The cohort launcher accepts up to fifteen people. Provisioning busy answers and a failed first agent preparation are now retried by the app itself, so the runner no longer needs a manual Retry click for either; the browser check covers both with injected 429 and 502 responses.

## Live concurrent acceptance — September 20, 2026, fifteen people

After the runner and retry changes were deployed with `maxProvisioning` 5, fifteen people ran together on fifteen different projects and **all fifteen passed** the full sequence in 6m20s to 17m42s. The provisioning limit refused fourteen first attempts with 429; the app retried them automatically and every workspace was ready within 29 seconds with no Retry click. Backend correlation over 26,229 records: 6,525 Sprite commands all succeeded, command queue wait p95 8 ms and max 687 ms, no 502, 409 or 423. The new lifecycle records confirmed clean socket closes, idle holds five minutes after each person finished, and runner exits with code 0. Evidence: ignored `artifacts/participant-load/cohort-2026-09-20T02-30-36-952Z/` and `artifacts/participant-load/backend-20260920b/REPORT.md`.

## Live concurrent attempt — September 20, 2026, fifty people

After deleting all test teams and Sprites, fifty people arrived 3.5 s apart on a fresh instance. **17 passed; 33 failed on 30-second timeouts** at sign-in or at opening their new team while the site was unresponsive for everyone, including the operator, from roughly 25 concurrent sessions. The app returned no 429/502/5xx: the management host's single Node event loop saturated on native I/O (93 % of one core, second core idle, JavaScript profile idle), so new connections queued before reaching handlers, which themselves stayed at 100–250 ms. Measured feeders: the 235 KB uncompressed `/api/state` polled every 5 s per person, 26 requests/s and 12 Sprite CLI spawns/s of per-person helper polling, and 300–400 agent text-delta events per second from 17 people. Remedies and evidence: `artifacts/participant-load/backend-20260920c/REPORT.md`.

## Load fixes after the fifty-person attempt

- The portal state no longer embeds project briefs; teams carry the project name and the brief is fetched once per project through `GET /api/events/:id/projects/:projectId`. At 31 teams this cut the poll body from 235 KB to under 20 KB before compression.
- API GET responses carry weak ETags and answer 304 to matching `If-None-Match`; bodies over 1 KB are Brotli or gzip compressed on the threadpool. Built assets are precompressed at build time and hashed bundles are immutable for a year. The web client sends conditional GETs and reuses cached bodies.
- The portal polls every 15 s and only while the tab is visible; file listings poll every 5 s while the agent works and every 20 s otherwise; preview status polls every 30 s when nothing is changing.
- Agent text deltas are merged per message for 50 ms on the server before replay bookkeeping and WebSocket fan-out; activity touches happen at most once a second per session.
- Diagnostics record response bytes per request and a `loop` record every ten seconds with event-loop delay percentiles, CPU share and handle counts, so a saturated loop is visible while handlers still look fast.

## Live concurrent acceptance — September 20, 2026, fifty people on one core

After the load fixes were deployed on a single performance vCPU, a fresh fifty-person cohort passed **47 of 50** (previously 17 of 50 on two cores). All fifty workspaces reached ready, 15,543 of 16,119 Sprite commands went through 49 long-lived helper sessions, first byte stayed under a second until the final concurrent agent phase and peaked at 7–11 s instead of 34 s, and the only HTTP error was one Share conflict. Loop telemetry showed CPU median 68 % and max 96 % with event-loop delay p99 under 250 ms, so the host is now throughput-bound rather than queueing connections. The three failures were one Share conflict, one 30 s editor wait at peak, and one agent turn still streaming after the runner's 20-minute limit. Evidence: ignored `artifacts/participant-load/cohort-2026-09-20T06-54-19-968Z/` and `artifacts/participant-load/backend-20260920d/REPORT.md`.

## Idle terminals and attributable telemetry

An idle terminal no longer streams through the host: tmux starts with its status line off, and the browser detaches the terminal socket five seconds after the Terminal tab is hidden, reattaching to the same tmux session when it is shown again. Each ten-second `loop` diagnostic now carries per-interval counters (agent lines and frames, terminal chunks, bytes and frames, helper-session requests, process spawns, HTTP requests and bytes) so a busy loop can be attributed without a profiler.

## Live concurrent acceptance — September 20, 2026, fifty people with relay workers and pushed status

With relay worker processes owning every Sprite child, the per-workspace events socket replacing status polls, hidden terminals detaching and one vCPU, a fresh fifty-person cohort passed **48 of 50** with zero HTTP errors, median 9m39s per person (11m34s before), 14,085 requests instead of 26,949, and 2,370 pushed change notifications. Relay workers peaked at 3.6 % CPU. The main loop still peaked near 90 % during the concurrent agent phase; a live profile attributed 79.5 % of that to cloning the domain state on every lookup, now replaced by a zero-copy read view, and 49 host-side agent Git relay children, which are moving into the relay workers next. Evidence: ignored `artifacts/participant-load/cohort-2026-09-20T13-58-33-335Z/` and `artifacts/participant-load/backend-20260920e/REPORT.md`.

## Live concurrent acceptance — September 20, 2026, fifty people after the zero-copy state fix

With read-only lookups no longer cloning the domain state and the agent Git relay children owned by relay workers, a fresh fifty-person cohort passed **48 of 50** with median 7m39s per person, HTTP handler p50 43 ms, home page first byte 0.25 s at the busiest moment, and the main loop at 17 % median and 35 % peak on one vCPU (the peak is provisioning; the concurrent agent phase ran at 15–20 %). The main process owned no Sprite children. Both failures were Share requests whose Changes preview was refreshed between preview and click. Evidence: ignored `artifacts/participant-load/cohort-2026-09-20T15-01-48-360Z/` and `artifacts/participant-load/backend-20260920f/REPORT.md`.
