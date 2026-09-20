# Stuck agent turn: workspace 8b5ab350-e0c1-4c27-beba-bec7465de356

Investigated 2026-09-20 02:41-03:00 UTC on https://civic-spark.fly.dev while the
Cohort B load test was finishing. No prompts were sent; one `{"type":"stop"}`
control message was sent (see below). Nothing was deployed, restarted, deleted
or committed. No other workspace was touched.

## Identity and ownership

- Signed in as the demo account jvanderberg@gmail.com (user id
  `YtvOTQYg33NNQ5VaxrMdqbKUUp5Tounq`, display name "Bobula").
- `GET /api/state` lists the workspace in `myWorkspaces`, so it is the user's own
  membership workspace (event `b8892f83-8375-492d-a37f-6221c312424f` "Day in Our
  Data", team "Cohort B test 20260920 06", created 02:41:37.387Z). File, chat and
  in-Sprite inspection were therefore permitted.
- Sprite `civic-spark-8b5ab350-e0c1-4c27-beba-bec7465de356`, status `ready`,
  provider `running` since 02:41:41.9Z. Runtime: `generation 0, held false,
  reason null, lastUsedAt 02:46:35.064Z, stopState null`.
- Admin status (`GET /api/events/:id/sprites`) reports `working: true` for this
  workspace; that is `AgentSessions.isWorking` in `apps/server/src/agents.ts`
  (pendingPrompt or the replay snapshot's `working`).

## Symptom, confirmed

Attaching read-only to `wss://civic-spark.fly.dev/api/workspaces/<id>/agent`
(script `inspect-stuck-8b5ab350.mjs` in this directory) replays 13 journal
events and then a live `state` event:

    runtimeReady true, working true, workingStartedAt 2026-09-20T02:42:42.273Z,
    currentError null, configuredProviders [opencode], savedProviders [opencode]

No live event followed in 50 s (02:50:27-02:51:17Z). Because `working` is true,
`apps/web/src/Agent.tsx` shows Stop instead of Send, and any prompt would be
rejected server-side with "A turn is already running" (`agents.ts` message
handler, `pendingPrompt || replay.snapshot().working`).

## Timeline (UTC; request ids from the backend collector `backend.jsonl`)

| Time | Evidence |
| --- | --- |
| 02:41:41.814 | `POST /api/workspaces/:id/sprite` 202 (`9b04573a-89bd-40a6-a874-bd07867bde13`), Sprite created/woken |
| 02:42:28.760 | `agent.prepare` ok, attempt 1, 17027 ms (`6b34f2bc-aab3-462a-a3e1-d936f00718bb`) |
| ~02:42:29 | Runner spawned in the Sprite (pid 4495 `node runner.ts`, elapsed 13:01 at 02:55:30); OpenCode serve started 02:42:31.9 (opencode.log run `c1c4877c`, v1.18.31, listening 127.0.0.1:4096) |
| 02:42:42.273 | Turn started (`status Working`), prompt "hey, can you install deps and launch this for me?", provider opencode (openrouter z-ai/glm-5.3-flash), OpenCode session `ses_f434e3a0bffeoZ6fjZaShlDfTx` |
| 02:42:49.975 | opencode.log `asking id=que_0bcb1e3f7001sRc0CaT5lHXghN questions=1`; runner emitted `approval` |
| 02:43:26.832 | opencode.log `rejected requestID=que_0bcb1e3f7001...`; journal `resolved` text "Denied". Question tool state: `status error`, "The user dismissed this question", ended 02:43:26.834. Session `updated` 02:43:26.888; no further loop/stream/error lines for this session |
| 02:43:29.992 | First `cancel session.id=ses_f434e3a0...` in opencode.log (runner's `session.abort`); repeats every ~1.01 s since (785 by 02:56:44, 1010 by 03:00:32) |
| 02:44:12.684 | Agent WebSocket closed code 1001 after 103742 ms (browser reload/navigation) |
| 02:44:18.229 | `agent.prepare` ok 4849 ms (`9d817467-dc60-4b09-9d36-44526a03e760`); client reattached to the same server session and replayed `working true` |
| 02:45:36.698 | `agent.prepare` ok 4753 ms (`c526092f-30b2-4631-a289-01916be91c8b`), another reconnect/tab |
| ~02:45:37 | Terminal opened (tmux client/server started in the Sprite) |
| 02:46:09-02:46:19 | A second OpenCode instance run by the user in the terminal (opencode.log run `47c54daa`, pid 10508 under tmux, new session `ses_f434afe1cffe8WFfEmV2aMUHLo`, one GLM turn, "exiting loop" 02:46:19). Unrelated to the stuck turn but still running (722 MB RSS) |
| 02:46:35.065 | Last browser activity POST (`lastUsedAt`); browser polling paused until 02:51:11 |
| 02:52:54.925 | My single `{"type":"stop"}` sent; no `done`, `error` or `status` arrived in 78 s; admin status still `working: true` at 02:54:44 |

Collector facts for this workspace: 806 records; all 245 `sprite.command` and
all `sprite.operation` outcomes `ok`; no http status >= 400; no `agent.runner`
exit; no `lifecycle.idle`; ws closes: 1001 at 02:44:12 (browser), 1005 twice
(my read-only attaches). No 1008/1011/1013 closes. The runner process is alive
and the server session still exists.

## Cause

Two defects in the in-Sprite runner (`packages/agents/src/runner.ts` +
`packages/agents/src/opencode-turn.ts`), triggered by the user dismissing an
OpenCode question:

1. The turn could never complete. Dismissing the question made OpenCode end the
   run at a tool-call step: the last assistant message
   `msg_0bcb1d88b001kFAgY1H784gNjF` has `finish: "tool-calls"`, no `error`, and
   `GET /session/status` returns `{}` (session idle). `OpenCodeTurnTracker.trySettle`
   success requires `assistantComplete || providerError`, and `isFinished()`
   treats `finish === "tool-calls"` as not finished. So the tracker never
   settled and `openTurn` never returned; `working` stayed true.

2. Stop cannot settle it either (livelock). After `stop`, every
   `reconcileOpenCodeTurn` iteration calls `tracker.confirmStop()` (which resets
   `idle`/`authoritativeIdle`) and then `client.session.abort(...)`. OpenCode
   answers each abort by publishing `session.status {idle}` + `session.idle`
   for this session (observed live on `/event`: 9 status + 8 idle events in
   8.7 s, one pair per second, matching the `cancel` log lines). Those events
   increment `tracker.eventRevision` between the `revision` capture and the
   status read, so `revision === tracker.eventRevision` fails, the authoritative
   `tracker.reconcile(..., true)` never runs, `trySettle` never runs, and the
   loop aborts again. This has repeated once per second since 02:43:29.992.
   The user's Stop presses and my test stop were all absorbed this way.

Secondary observations:

- `reconcileOpenCodeTurn` only exits on its own if both loopback reads are
  `ECONNREFUSED` three times; a healthy idle OpenCode never triggers that.
- The turn is not marked interrupted on the server, and `lifecycle.releaseIdle`
  skips workspaces where `working(id)` is true, so this Sprite will never be
  idle-released while stuck (it has been billing since 02:41:41).
- Page reload does not help: the server session persists and replays
  `working: true` (`AgentReplay.snapshot`).
- Browser client symptom matches code: `Agent.tsx` renders Stop while `working`
  and `send({type:"stop"})` reaches the runner, whose `stop` handler awaits
  `activeOpenTurn.stop()` -> `reconcile()` -> the livelock above.

## What I did

- Read-only: collector analysis, `fly logs` (only the last 100 lines are
  retained; nothing about this workspace), sign-in as the demo account, `/api/state`,
  admin Sprite status, two read-only agent WebSocket attaches (replay only),
  `sprite exec` inside the user's own Sprite for `ps`, listeners, the OpenCode
  log (filtered/redacted), the journal metadata, `GET /session/status`,
  `GET /session/<id>/message` and an 8 s `/event` observation (loopback with
  the runtime's own password read from the OpenCode child's environment,
  never printed).
- One `{"type":"stop"}` control message at 02:52:54.925Z; it produced no
  events (expected given the livelock).
- No prompts, no kills, no pause/delete, no deploy or restart. Temporary
  cookie files were deleted.

## Remedy

The turn will not end by itself. The runner must be restarted; the journal
already has top-level `working: true`, so on restart `journal.interrupted` is
true and the new runner emits "The previous turn was interrupted..." plus
`done {outcome: stopped}` and a `state` with `working: false` (`runner.ts`
`initialized`). Conversation and the OpenCode session id are retained.

Least destructive, owner-side (recommended): from the workspace Terminal in
the browser run `kill 4495` (the `node runner.ts` process; verify first with
`ps -eo pid,comm,args | grep runner.ts`). SIGTERM runs the runner's `shutdown`
(flushes the journal, closes its OpenCode server). The server's `sprite exec`
child exits, `AgentSessions` closes the browser socket with 1011, and
`Agent.tsx` auto-reconnects (1011 is retryable), spawns a fresh runner and
shows the interrupted-turn message. Terminal, preview and the user's own
tmux OpenCode instance are untouched.

Admin-side alternative: Admin console -> Sprites -> this row -> "Pause"
(`POST /api/events/:id/sprites/:workspaceId` action `pause`,
`lifecycle.ts`). That holds the workspace, calls `agents.stop`,
`terminals.stop` and `integrations.stop`, stops the Sprite VM, and the user
then clicks Resume/reload. Heavier: it also ends the terminal/tmux session and
preview and requires a wake.

Do not delete/replace the Sprite; nothing here requires it.

## Code fixes to consider (not applied)

- `opencode-turn.ts` `trySettle`: when the session is authoritatively idle and
  the current user message has been observed, treat a run whose last step
  ended with a dismissed/errored `question` tool (or any `tool-calls` finish
  with no in-flight tool) as terminal (`stopped`), instead of waiting for a
  non-`tool-calls` finish.
- `runner.ts` `reconcileOpenCodeTurn`: do not issue `session.abort` on every
  iteration; abort once after acceptance, and do not let the abort's own
  `session.status`/`session.idle` events invalidate the revision check (for
  example capture `revision` before the abort, or ignore idle events for the
  revision test). Add a bounded fallback so a stop against an idle session
  settles as `stopped`.
- Cover both with a unit test using the recorded message/status shapes above.
