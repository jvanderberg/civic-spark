# Participant load runs, September 2026

Archived reports from the scripted participant rehearsals against the hosted
demo instance. Each report was written at the time from the run's evidence
(per-person `steps.jsonl`, `requests.jsonl`, `result.json`, screenshots and the
backend diagnostic capture). The evidence directories under
`artifacts/participant-load/` are ignored by Git and live on the machine that
ran the cohort; the reports are the durable record. How to repeat a run is in
[scripts/participant-load/README.md](../../scripts/participant-load/README.md).

| Date (UTC) | People | Result | Deployed | Report |
| --- | --- | --- | --- | --- |
| 2026-09-19 03:10 | 1 | pass, 7m18s | a37a603 | earlier single run, see `docs/scripted-participant-load.md` |
| 2026-09-20 01:06 | 5 | 4/5, the failure was a runner observer defect | diagnostics build | [run-20260919.md](run-20260919.md), [correlation-20260919.md](correlation-20260919.md) |
| 2026-09-20 02:30 | 15 | 15/15, fourteen busy-provisioning retries handled transparently | c820ffa | [run-20260920b.md](run-20260920b.md), [correlation-20260920b.md](correlation-20260920b.md) |
| 2026-09-20 03:43 | 50 | 17/50, management event loop saturated at about 25 concurrent | 5772c6d, 2 vCPU | [run-20260920c.md](run-20260920c.md), [audit-20260920c.md](audit-20260920c.md) |
| 2026-09-20 06:54 | 50 | 47/50 on one vCPU after the round-two fixes | b6608e5, 1 vCPU | [run-20260920d.md](run-20260920d.md) |
| 2026-09-20 13:58 | 50 | 48/50 with relay workers and pushed status | 98ffdaa | [run-20260920e.md](run-20260920e.md) |
| 2026-09-20 15:01 | 50 | 48/50, main loop 17 % median, first byte 0.25 s at peak | 903f55d | [run-20260920f.md](run-20260920f.md) |
| 2026-09-21 19:05 | 50 | 41/50; eight refused Shares from scaffold `.oxlintrc.json` under the old dotfile rule, one harness timing miss; host 32 % peak, no platform errors | 0ad0cd5 (v40) | [run-20260921a.md](run-20260921a.md) |

## Timeline of findings

1. **Diagnostics before load.** The first task was reproducing earlier 502 and
   409 errors with evidence. Opt-in structured diagnostics (`CIVIC_SPARK_DIAGNOSTICS=1`)
   with request, trace and operation IDs were added so browser-side request
   logs could be joined to backend records. The five-person run showed the
   platform completing every turn; the one failure was the runner's own event
   buffer dropping a completion event.
2. **Fifteen people.** Provisioning admission was raised from two to five and
   the "workspace preparation is busy" response became a transparent retry.
   Clean run.
3. **Fifty people, first attempt.** Seventeen passed. The Node event loop on
   the management host saturated: activity touches cloned and fsynced state per
   streamed token, and dozens of host-owned relay children competed for the
   loop. Not a Fly proxy problem.
4. **Round two.** Slim portal state with briefs on demand, ETag/304 with
   Brotli and precompressed assets, batched agent deltas and activity touches,
   adaptive polling, terminal output coalescing with zero-client detach, and
   per-Sprite helper sessions replacing one CLI process per command. The
   second core was dropped deliberately to make the single-loop limit visible.
   Forty-seven passed on one vCPU.
5. **Round three.** Relay worker processes own agent, terminal and Git
   integration relays; a per-workspace events socket replaced polling; idle
   terminals detach. Forty-eight passed. A live inspector profile then showed
   `structuredClone` in state reads at nearly eighty percent of loop CPU, which
   the zero-copy `peek()` read removed.
6. **Round four.** Forty-eight passed with the host at seventeen percent median
   loop CPU. Both failures were Share refusing because the preview fingerprint
   had moved under a background refresh; the client and runner now retry once
   when only the fingerprint changed.
7. **Operational lessons recorded along the way:** deploying from a branch that
   was not a descendant of `main` removed the admin backup feature from the
   live site for hours, hence the rule that a deploy always lands on `main`
   first; `fly logs --json` is multi-line; the demo sign-in throttle needs a
   3.5 s arrival stagger; a stuck agent session came from a dismissed question
   that never settled the turn tracker ([stuck-workspace-20260920.md](stuck-workspace-20260920.md)).
8. **Fifth run, 2026-09-21.** Forty-one passed. Every Share refusal traced to
   one file: the Vite scaffold's `.oxlintrc.json`, which the "no hidden files
   except `.gitignore`" policy rejected across the whole committed history.
   The policy became a denylist of genuinely private paths; hidden config
   files and directories are now ordinary project data.
9. **Instance cleared on 2026-09-20 after the fourth run:** 55 Sprite rows and
   51 teams deleted through the admin APIs, the event and its 16 projects kept,
   and the provider left with no `civic-spark-*` Sprites. One admin-list row
   remains for workspace `02b81fe6` (Rehearsal P01, 2026-09-17): its Sprite and
   team are gone, but it was deleted before the reset marker existed, so the
   admin API reports it as already deleted and cannot retire the record.

[handoff-notes-2026-09-19.md](handoff-notes-2026-09-19.md) is the verbatim
working log kept during these sessions, including the session-specific process
IDs and paths as they were; it is preserved for provenance rather than as
instructions.
