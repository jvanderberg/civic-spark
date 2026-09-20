# Participant load harness

Operator tooling for the scripted participant rehearsal described in
[docs/scripted-participant-load.md](../../docs/scripted-participant-load.md). The
browser runners (`npm run test:participant`, `npm run test:participant-cohort`)
are TypeScript under `scripts/`; the pieces here prepare an instance, capture
backend diagnostics, analyse a run and clean up. Results of every run so far are
archived in [docs/participant-load-runs](../../docs/participant-load-runs/README.md).

Everything below was exercised against the hosted demo instance on
2026-09-19 and 2026-09-20. Paths under `artifacts/` and `.data/` are ignored by
Git and are per-machine.

## Tools

| File | Purpose |
| --- | --- |
| `make-roster.py` | Write N person JSON files plus `roster.json` (fresh identities, projects in rotation, optional single-person canary). |
| `raise-capacity.py` | Raise one event's participant capacity through the admin API with the optimistic revision check. |
| `collect.py` | Stream `fly logs --json` into one JSON-lines file of structured `civic-spark.diagnostic` records. Handles Fly's pretty-printed multi-line objects and backfills with `--no-tail` every 45 s. |
| `analyze.py` | Correlate a cohort directory's per-person `requests.jsonl` with backend records; prints a markdown report and writes `correlation.json`. |
| `telemetry.py` | Per-minute host telemetry from `loop` and `relay` records: event-loop delay, CPU, children, sockets, agent/terminal/HTTP counters. |
| `cleanup-event.py` | Delete every Sprite and team of one event through the admin lifecycle APIs; keeps the event, projects and accounts. |

All admin scripts read `CIVIC_SPARK_LOAD_ADMIN_EMAIL` (a demo admin identity of
the event) and `CIVIC_SPARK_LOAD_ORIGIN` (default `https://civic-spark.fly.dev`).
Demo sign-in accepts a name and email, not a password.

## One run, start to finish

1. **Deploy what you are measuring.** Deploying and landing on `main` go
   together: merge `origin/main`, get `npm run check` green, push `main`, then
   `npx tsx scripts/fly-setup.ts deploy .data/fly/setup.json` from that commit.
   The operator files `.data/fly/setup.json` and `.data/fly/civic-spark/receipt.json`
   are not in Git; see `docs/fly-deployment.md`. Settings that shaped the runs:
   `"diagnostics": true` (structured records), `maxProvisioning: 5`,
   `managementCpus: 1`, relay workers default 2. After the deploy confirm
   `fly status` shows the original machine and volume and `/api/health` answers.
2. **Clean the instance.** `python3 scripts/participant-load/cleanup-event.py <event-id>`
   removes the previous cohort's Sprites and teams. Then compare
   `sprite -o <org> list` with the app; destroy provider orphans one by one with
   `sprite -o <org> destroy <name> --force`. Leave unrelated Sprites alone.
3. **Check capacity.** A cohort of N needs N free participant slots plus the
   canary. `python3 scripts/participant-load/raise-capacity.py <event-id> <capacity>`.
4. **Generate fresh identities.** `python3 scripts/participant-load/make-roster.py --prefix cohorth --count 50 --out artifacts/participant-load/cohort-inputs-h --canary`.
   Never reuse a prefix against the same instance: the runner refuses identities
   that already own a workspace to avoid duplicate paid turns.
   `npm run test:participant-cohort -- artifacts/participant-load/cohort-inputs-h/roster.json --validate`.
5. **Start the collector** in its own terminal, before the canary:
   `python3 scripts/participant-load/collect.py artifacts/participant-load/backend-<run>/backend.jsonl`.
   Hit `/api/health` and confirm an `http` record appears; an empty file means
   capture is broken, not that the app is quiet.
6. **Inject the model key only into the runner's environment.** For example
   `read -rs CIVIC_SPARK_LOAD_GLM_KEY; export CIVIC_SPARK_LOAD_GLM_KEY`. Never
   pass it as an argument, write it to a file, echo it or commit it. Unset it
   afterwards.
7. **Canary first.** `npm run test:participant-cohort -- artifacts/participant-load/cohort-inputs-h-canary/roster.json --live`.
   One person proves sign-in, provisioning, terminal, agent and Share on the
   new deploy for the price of one turn.
8. **Run the cohort.** `CIVIC_SPARK_LOAD_STAGGER_MS=3500 npm run test:participant-cohort -- artifacts/participant-load/cohort-inputs-h/roster.json --live`.
   The stagger keeps arrivals under the demo sign-in throttle of twenty per
   minute per address. Fifty people share five Chromium processes on the test
   machine; a ten-core, 32 GB Mac stayed comfortable.
9. **Analyse.** `python3 scripts/participant-load/analyze.py artifacts/participant-load/cohort-<stamp> artifacts/participant-load/backend-<run>/backend.jsonl > REPORT.md`
   and `python3 scripts/participant-load/telemetry.py artifacts/participant-load/backend-<run>/backend.jsonl <run-start-iso>`.
   Read the failures' `result.json` and final screenshots before blaming the
   platform; several early failures were harness defects.
10. **Record the result** in `docs/scripted-participant-load.md` (one section per
    run), copy the report into `docs/participant-load-runs/`, and check the
    plan item in `IMPLEMENTATION_PLAN.md`. Stop the collector.
11. **Clean up** with step 2 when the evidence has been inspected. Teams and
    Sprites left idle are held by the lifecycle and still occupy capacity.

## Reading the diagnostics

Records are one JSON object per line with `kind: civic-spark.diagnostic`,
`event`, `at` and an allowlisted payload; no bodies, prompts, file contents or
secrets. Useful events:

- `http`: route template, status, duration, request ID, workspace ID.
- `sprite.command` / `sprite.operation` / `sprite.session`: CLI and helper-session
  timings and outcomes (`transport` is `process` or `session`).
- `loop` every 10 s: event-loop delay p50/p99/max, `cpuPercent`, handles,
  children, sockets, RSS and per-interval counters (`agentLines`, `agentFrames`,
  `terminalChunks`, `terminalBytes`, `sessionRequests`, `processSpawns`,
  `httpRequests`, `httpBytes`, `eventsOpen`, `eventsPushed`).
- `relay` / `relay.worker`: relay worker load and lifetimes.
- `agent.runner`, `agent.prepare`, `lifecycle.idle`, `ws`: session lifecycle.

Two pitfalls cost time: `fly logs --json` prints multi-line objects, so a
line-based parser records nothing; and a saturated main event loop shows up
first as slow first-byte times and provisioning 502s, not as CPU on `fly status`.

## What the runs established

Four fifty-person runs on one management vCPU went 17/50 → 47/50 → 48/50 →
48/50 as the host was moved off per-token state clones, structured-clone state
reads, host-owned relay children and idle terminal streaming. The remaining
failure class was a stale-preview Share conflict, since fixed with a single
client-side retry. See the archive for evidence and the exact commits.
