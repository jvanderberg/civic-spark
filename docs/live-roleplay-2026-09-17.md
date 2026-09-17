# Live participant roleplay — September 17, 2026

Site: https://civic-spark.fly.dev — Day in Our Data.

## Method

40 participant identities, 12 teams. Each participant is operated by a separate Luna agent with a prose role brief. The agent observes the live browser and chooses its next action. Playwright supplies browser actions only; there are no deterministic scenario scripts, API setup, injected state, or prewritten application changes. Headed browsers and live team activity make progress visible.

Leads ask the product AI to read the brief and make an MVP visualization, review the result, launch the preview and manually Share. UI reviewers and data reviewers join, inspect the actual shared result, choose a useful improvement and Share it back. Four teams also have an accessibility reviewer. Work within a team is handed off sequentially. Leads on different teams can work in parallel.

All participants have ordinary participant permissions. Existing organizers remain admins. Existing real teams and private work are excluded. The event capacity was raised from 40 to 43 to accommodate 40 test people alongside three existing participants. This is a functional roleplay, not a certified 40-simultaneous-user performance benchmark.

## Roster and handoffs

| Team | Lead | UI reviewer | Data reviewer | Accessibility | Project |
|---|---|---|---|---|---|
| Field test 01 | P01 Avery | P02 Jordan | P03 Casey | P04 Sam | Is my assessment fair? |
| Field test 02 | P05 Morgan | P06 Taylor | P07 Cameron | P08 Devon | Where does my tax dollar go? |
| Field test 03 | P09 Riley | P10 Quinn | P11 Parker | P12 Reese | Can a kid bike to school safely? |
| Field test 04 | P13 Alex | P14 Skyler | P15 Jamie | P16 Drew | Which bus stops need help? |
| Field test 05 | P17 Blake | P18 Finley | P19 Robin | — | Build the Oak Park transit dashboard |
| Field test 06 | P20 Jesse | P21 Dakota | P22 Kendall | — | Oak Park over time |
| Field test 07 | P23 Charlie | P24 Emery | P25 Hayden | — | How are our schools doing? |
| Field test 08 | P26 Rowan | P27 Sage | P28 River | — | How resilient is our urban forest? |
| Field test 09 | P29 Harper | P30 Ellis | P31 Ari | — | Build an architecture walking tour |
| Field test 10 | P32 Logan | P33 Sidney | P34 Terry | — | What do our commissions do? |
| Field test 11 | P35 Noel | P36 Marley | P37 Micah | — | Oak Park crime data explorer |
| Field test 12 | P38 Adrian | P39 Remy | P40 Lane | — | What does ECHO see? |

Emails use roleplay-20260917-pNN@example.test. Test identity names are labeled Field test.

## Progress

Three independent Luna leads created their assigned teams, read the briefs and submitted one MVP request each through the Agent UI. No lead has Shared, no collaborator has started, and no MVP completion is claimed. Further model requests are held after the same failure affected all three runs.

| Participant | Team | Observed result |
|---|---|---|
| P01 Avery | Field test 01 — Assessment fairness | Failed after visible Working for 4m21s; Ready afterward; 13 changes at follow-up. Last conversation text: Now write App.tsx. No continuation sent. |
| P05 Morgan | Field test 02 — Tax dollars | Failed after visible Working for 4m20s; Ready afterward, Send disabled; 10 changes. Last activity preparing PieChart.ts after fetching CSVs and scaffolding. No retry. |
| P09 Riley | Field test 03 — Safe school cycling | Failed after approximately 4m37s; Ready afterward; 9 changes at follow-up. Last activity editing src/App.tsx. No retry. |

The other 37 participants remain planned, not executed. Existing real participants remain outside the exercise.

## Blocking finding: all three MVP turns fail

Exact visible error in all three browser sessions:

> The Sprite could not reach the provider. Check its network connection and retry.

All three produced partial project files before failing. Their agent connection indicators subsequently showed Ready. This establishes a repeated model-turn failure, not its root cause. Similar elapsed times suggest investigating a shared timeout or connection limit; no server/provider diagnosis has been performed and no attribution is established.

Partial work and browser sessions are preserved. No repeated paid prompts, automatic Share, backend repair or state manipulation has been performed. The roleplay is held at this blocker rather than counted as successful or replaced with scripted test results.

Evidence: artifacts/roleplay-20260917/screenshots/p01-provider-error.png, p01-provider-error-partial.png, p05-provider-error.png and p09-provider-error.png. Individual participant notes remain alongside these local artifacts. Screenshots and notes exclude credentials.

## Investigation: false failure while execution continued

Read-only browser follow-up found both Riley and Morgan continued receiving progress after the displayed failure, without any retry. Riley advanced from 9 to 20 changes; Morgan from 10 to 20. Both transcripts continued through checks, preview startup and a local commit. This is not a verified provider outage: the UI declared failure while the underlying agent kept working.

Source inspection identifies a long-running local OpenCode session.prompt HTTP request separate from the progress event stream. A failure of that local request is currently mapped to the generic provider-network error, releases the activity hold and marks the UI Ready. A loopback reproduction using Node 24.18.0 and OpenCode 1.18.31 confirmed the mechanism: the blocking prompt request failed at 303 seconds with TypeError fetch failed, caused by HeadersTimeoutError / UND_ERR_HEADERS_TIMEOUT. The session status was still busy; progress continued from 300 to 330 deltas and the fake provider finished at 332 seconds. No paid calls or live state changes were needed for this reproduction. This diagnostic fixture is separate from the prose-directed participant roleplay. A shorter 282-second blocking request succeeded, explaining why short smoke tests missed it. The async submission comparison acknowledged immediately and completed normally at 283 seconds; a beyond-timeout regression is required for the production fix. Evidence: artifacts/provider-diagnosis/{slow-turn,slow-turn-node24,async-turn}.log. No production fix or deployment is claimed yet.

## Abandoned pilot

The earlier scripted rehearsal is not part of these results. Its one test team and Sprite were deleted through the UI after stopping its single model turn. Nothing was Shared or launched. Its demo account remains because no account-delete UI exists. The real Bobs your uncle team remains untouched. See [the abandoned pilot record](live-rehearsal-2026-09-17.md).
