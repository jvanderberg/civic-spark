# Live participant roleplay — September 17, 2026

Site: https://civic-spark.fly.dev — Day in Our Data.

## Current status — 16:10 CDT

**38 of 40 participants have reviewed and manually Shared contributions across all 12 teams.** All 40 have usable workspaces and have submitted their role-specific model request. The final two are P14 (bus-stop UI review) and P36 (crime UI change, resolving concurrent team work before publication). No provisioning blocker remains in this cohort.

Seven newly verified Shares: P04 accessibility `7a7ab78`, P06 tax year selector `9fb4e84`, P10 cycling phone filters `4beb8da`, P19 transit eligibility `52127eb`, P33 commission phone controls `056c20e`, P37 crime count/period semantics `2bbc5b5`, and P40 ECHO suppressed-count interpretation `000105a`. Each participant recorded managed preview review and the normal Share success state. Several still saw stale generic Sprite-command or HTTP 502 alerts despite successful work; these remain usability observations, not erased failures.

The sections below are a chronological record; early holds and lower counts describe earlier stages, not current status. This remains a staggered functional exercise, not proof of sustained 40-person simultaneous inference capacity.

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

- **All 40 persona agents launched:** 12 leads, 12 UI reviewers, 12 data reviewers and 4 accessibility reviewers. These are independent Luna/Paseo browser operators with prose role instructions. Launched is not a claim that every person has joined or completed work.
- **12 teams created and lead workspaces prepared**, per individual browser evidence/logs.
- **14 participants joined/prepared so far:** 12 leads plus Jordan and Parker. The remaining 26 collaborator operators are now signing in, joining their assigned teams and reviewing briefs/shared work.
- **3 MVPs built and preview-reviewed. 2 successfully Shared:** assessment fairness (e96a5de) and safe school cycling (325e170, known correctness defects explicitly handed off). Tax-dollar Lead has been released to perform normal manual Share after completing review.
- **Further model prompts held** while the confirmed runtime tracking bug is repaired and verified. Signup/join/brief review continues. No automatic re-prompts were submitted after the false errors.

Coordinator now polls individual logs and Paseo status; participants do not send per-click/milestone messages to the user conversation. Installed Paseo 0.7.2 source inspection found no three-worker global limit, and nine new leads actually ran concurrently. The earlier claimed three-worker ceiling was an orchestration mistake, not a measured site or Paseo constraint.

Initial lead failures as displayed (subsequent investigation below established continued work):

| Participant | Team | Observed result |
|---|---|---|
| P01 Avery | Field test 01 — Assessment fairness | UI error after visible Working for 4m21s; underlying work continued and completed. Reviewed and Shared. |
| P05 Morgan | Field test 02 — Tax dollars | UI error after visible Working for 4m20s; underlying work continued and completed. Preview reviewed; Share verification pending. |
| P09 Riley | Field test 03 — Safe school cycling | UI error after approximately 4m37s; underlying work continued and completed. Reviewed and Shared as incomplete baseline with data defects noted. |

## Blocking finding: all three MVP turns fail

Exact visible error in all three browser sessions:

> The Sprite could not reach the provider. Check its network connection and retry.

All three produced partial project files before failing. Their agent connection indicators subsequently showed Ready. This establishes a repeated model-turn failure, not its root cause. Similar elapsed times suggest investigating a shared timeout or connection limit; no server/provider diagnosis has been performed and no attribution is established.

Partial work and browser sessions are preserved. No repeated paid prompts, automatic Share, backend repair or state manipulation has been performed. The roleplay is held at this blocker rather than counted as successful or replaced with scripted test results.

Evidence: artifacts/roleplay-20260917/screenshots/p01-provider-error.png, p01-provider-error-partial.png, p05-provider-error.png and p09-provider-error.png. Individual participant notes remain alongside these local artifacts. Screenshots and notes exclude credentials.

## Investigation: false failure while execution continued

Read-only browser follow-up found both Riley and Morgan continued receiving progress after the displayed failure, without any retry. Riley advanced from 9 to 20 changes; Morgan from 10 to 20. Both transcripts continued through checks, preview startup and a local commit. This is not a verified provider outage: the UI declared failure while the underlying agent kept working.

Source inspection identifies a long-running local OpenCode session.prompt HTTP request separate from the progress event stream. A failure of that local request is currently mapped to the generic provider-network error, releases the activity hold and marks the UI Ready. A loopback reproduction using Node 24.18.0 and OpenCode 1.18.31 confirmed the mechanism: the blocking prompt request failed at 303 seconds with TypeError fetch failed, caused by HeadersTimeoutError / UND_ERR_HEADERS_TIMEOUT. The session status was still busy; progress continued from 300 to 330 deltas and the fake provider finished at 332 seconds. No paid calls or live state changes were needed for this reproduction. This diagnostic fixture is separate from the prose-directed participant roleplay. A shorter 282-second blocking request succeeded, explaining why short smoke tests missed it. The async submission comparison acknowledged immediately and completed normally at 283 seconds; a beyond-timeout regression is required for the production fix. Evidence: artifacts/provider-diagnosis/{slow-turn,slow-turn-node24,async-turn}.log. No production fix or deployment is claimed yet.

## Lead preview reviews

- **Avery / assessment fairness:** preview opens at https://civic-spark-858930f9-d666-4633-bee6-2528faf08cd5-biglv.sprites.app/. Desktop and 360/390px review found a histogram, working year selector, peer-relative tables and visible data caveats. Repeated condo units dominate the top-over-assessed list; narrow tables require horizontal scrolling. Local commit reported: e96a5de. Manual Share succeeded; UI showed 0 files changed and No changes to share.
- **Riley / school cycling:** preview opens at https://civic-spark-6ba5ed42-cd36-4c31-b051-762b6ed32368-biglv.sprites.app/. Review found a working map, schools, phased bikeways, crashes, attribution and usable phone layout. **Data correctness issue:** Village severity shows zero injuries/fatalities and the severity filter empties the layer, while IDOT has nonzero totals. The network summary also remains Village-specific after switching sources. Some brief overlays/gap analysis remain unimplemented; mobile legend obscures part of the map. Local commit reported: 325e170. Authorized Share as an incomplete baseline with these defects explicitly handed to reviewers, not as a fully correct demo; Share succeeded with 0 files changed and No changes to share.

Runtime repair was reassigned to Astra in an isolated source worktree; Luna remains responsible for browser roleplay. It must preserve one prompt/session, accurate working/completion state and cancellation, with an actual pinned-runtime loopback regression exceeding five minutes. No production fix/deployment claimed yet.

## Abandoned pilot

The earlier scripted rehearsal is not part of these results. Its one test team and Sprite were deleted through the UI after stopping its single model turn. Nothing was Shared or launched. Its demo account remains because no account-delete UI exists. The real Bobs your uncle team remains untouched. See [the abandoned pilot record](live-rehearsal-2026-09-17.md).


## Full participant restart after deployed fixes

The runtime and initial-provisioning fixes are deployed at `10f4395`; live source hashes and HTTPS health were verified. Combined validation passed 436 tests, the full mobile matrix, deployment-context build, and independent review. The pinned runtime proof exceeded five minutes with one inference, continued activity holds, and exact answer delivery. The upgraded provider metadata reports 100 running / 100 warm.

All 40 existing Luna participant agents received the full roleplay release, and Paseo reported all 40 running at the restart check. This is agent-orchestration status, not a claim of 40 simultaneous successful model turns. Nine remaining leads may build and Share their brief-driven MVPs concurrently; collaborators may review and improve available shared work without another coordinator release. Completed leads preserve their existing MVPs and review incoming contributions.

A separate Luna browser operator handles only documented failed initial test provisioning through the normal admin UI. Previously ready workspaces and ambiguous private work are excluded from deletion. Two previously ready resources returned provider 404 during deployment preflight, including the cycling lead; those require separate recovery and are not silently replaced. Existing ready resources checked idle before deployment.

Per-person observations remain in `artifacts/roleplay-20260917/pNN.md`; operator recovery is recorded in `artifacts/roleplay-20260917/recovery.md`. No deterministic business-flow scripts replace participant decisions.


## Management contention during full restart

The live site became unresponsive under the resumed exercise. Measurements: external health timed out after 15 seconds; local health timed out after 8 seconds; CPU steal was 54% across a five-second sample, CPU pressure approximately 35%, available RAM 3.3 GiB, and the 10 GiB volume was 1% used. Node was observed waiting in `jbd2_log_wait_commit`. These are evidence of CPU contention and a synchronous storage wait, not proof of a single exclusive cause.

With user authorization, the existing Machine was upgraded from two shared CPUs to two performance CPUs, retaining 4 GiB RAM, the existing image and volume. Health returned 200 in 150 ms after restart. All 40 personas received a maintenance hold and then resume instructions, with explicit direction to inspect existing progress and avoid duplicating prompts. The restart may interrupt an active turn; participant logs must record any continuation needed. A separate Astra investigation is examining redundant synchronous persistence under polling. This mitigation does not establish 40-person performance acceptance.


## Recovery and remaining workflow defects

Admin browser recovery handled nine documented failed-initial test reservations (p04, p06, p10, p14, p19, p33, p36, p37, p40), and owners were instructed to reopen. This did not establish successful recovery: p06 and p10 subsequently reported `Provider organization mismatch`. Read-only provider evidence shows authenticated top-level organization identity matches configuration, but an unrelated row in the unfiltered list carries a contradictory organization value. Exact named GETs for those two reservations return404. A narrow provider-contract correction is underway; no arbitrary alias or cross-organization resource is accepted. The original user workspace d416 differs from p40 and remains separately unresolved.

Additional lead publication evidence now includes transit, schools, architecture, commissions, crime, ECHO and urban forest MVPs, beyond the initial assessment/tax/cycling baselines. Architecture explicitly uses fictional demonstration data. Urban forest Shared successfully but its native preview returns Vite Host403 even after managed Restart; product integration diagnosis is assigned to Astra. Bus-stop and over-time leads have reviewed implementations but publication/update difficulties remain; their browser personas are continuing the normal conflict/update flow without force overwrite.

The integrated owner-recovery and redundant-write fixes passed 480 tests and the clean deployment build (155 packaged inputs). Independent source review cleared their local contracts; the known live organization mismatch still blocks recovery acceptance/deployment. Combined mobile verification is in progress. These are engineering checks, separate from participant roleplay outcomes.


## Recovery release deployed

`49fd716` is deployed on the existing dedicated-CPU Machine and volume. Exact deployed hashes for provider metadata, recovery, provisioning, asynchronous health and recovery UI matched; HTTPS health returned 200 in243ms. Final validation: combined510 tests, final ownership-guard focused136 tests, full combined mobile, clean context156 inputs, independent scoped clearance. The final guard rejects conflicting ownership on the requested target row even when the list-level identity matches; unrelated contradictory row claims do not override the authenticated organization identity.

All nine failed-initial personas were resumed for actual browser recovery after deployment. Riley/p09 was separately authorized to explicitly rebuild the confirmed-missing test Sprite from already-shared teamGit. Deployment/source verification is not a claim that these browser recoveries have succeeded; persona logs supply those outcomes. Original user workspace d416 remains distinct from p40 and requires its owner to confirm the shared-only recovery.

All12 leads now have documented manually Shared MVP baselines. The final over-time lead used the explicit agent conflict-resolution workflow, preserved both histories, reviewed the merge, and then manually Shared. This establishes lead publication progress, not full correctness of all demos or completed contribution work for all40 attendees.


## Observed creation confirmation failure

Observer/preview release `3b49122` deployed with exact hashes verified and health200. Quinn/p10 made exactly one normal browser Resume at the existing reservation; no duplicate creation was requested. The sanitized outbound diagnostic recorded HTTP201 after81,996ms, matching requested resource name, valid object/string field types and no abort. Application confirmation was false because the response organization string matched neither configured slug nor token-account component. This directly establishes an application identity-contract rejection after provider creation, not a quota error or timeout for this attempt. The created resource is preserved; correction and existing-resource reconnect acceptance remain pending. Other earlier120-second failures may have different timing and are not retroactively explained solely by this one observation.

Evidence: `artifacts/roleplay-20260917/p10-create-observer.jsonl` and p10's browser log. No provider credentials, raw response body or participant file contents were logged.


## Exact-resource correction and completion backlog

The complete provider list proved p10's exact resource membership using matching ID/name/organization fields within the authenticated organization scope. The reviewed correction checks that proof rather than treating the returned opaque organization value as a slug alias. Final identity-only combined validation passed581 tests and packaging; the previously-ready/missing Resume UI fix is separately reviewed and integrated for final combined validation. Neither correction is claimed live yet.

The participant audit established20 personas with documented Shared contributions (12 leads and8 collaborators), and23 personas who submitted at least one model request—not23 total turns. Eleven participants whose old logs awaited a lead MVP or unfinished-turn review were resumed after all12 leads Shared. Nine initial-provisioning personas remain blocked; four of their resources plus p10 were confirmed created and must be preserved. Previously-ready Riley/p09 remains a separate missing-resource recovery case.

Deployment was deferred because seven real model turns were active, falling to five on the next check. New submissions are held while existing turns finish. The management upgrade and deployed preview correction remain healthy; p26's actual native preview now renders and its controls work at desktop/360/390 without a project edit or new model call.

## Recovery release deployed; browser acceptance in progress

Release `da2aa9d` deployed after the final preflight found 37 ready workspace records, zero working turns and two confirmed missing resources. Combined validation passed 605 tests (two opt-in skips), lint/types/build and 158-input packaging. Exact deployed hashes for provider identity checks, missing-workspace recovery and UI matched; health returned 200, all 16 project hashes and team/workspace counts were preserved, with the same Machine and volume.

Quinn/p10 is released for one normal browser reconnect to the existing provider-created resource. Riley/p09 separately tests the owner-confirmed recovery control for a previously-ready missing resource. Neither is claimed recovered until browser readiness is observed. Eleven non-creation-blocked collaborators have been released to review and Share their existing work, checking transcripts before any continuation so completed paid prompts are not repeated.

### Live acceptance exposed a checkout defect and a browser-state discrepancy

Quinn/p10's single Retry passed resource confirmation and opened the workspace, but the Files explorer remained empty after a bounded wait and reload. The file API currently returns an empty successful list for an absent project directory, so the existing-resource recovery path skips checkout and incorrectly marks the workspace ready. The resource is preserved; no model prompt, Share or file mutation was performed. A narrow absent-directory repair is under implementation, with explicit protection for existing private directories and symlinks.

Riley/p09's missing-resource detection persisted the correct error while retaining the idle hold, but the browser displayed a disabled Preparing control instead of an actionable recovery confirmation, including after reload. No replacement was authorized through the UI or created in this acceptance attempt. A separate fresh Playwright context with the same saved session, current bundle and matching state response correctly rendered the preparation panel. The preserved tab is being restarted before attributing this to production UI; no speculative UI patch is being made. The browser adapter also now supports explicit one-shot, exact-message approval of native confirmation dialogs, which Playwright otherwise dismisses. Neither case is counted recovered.

Ellis/p30 completed the architecture-tour accessibility review at desktop, 360px and 390px and manually Shared commit `fa8b356`; the UI confirmed zero remaining changes. This raises the documented contribution count to at least 22 of 40, including Remy/p39’s independently documented Share, while the latest roster audit continues.

### Completion audit at 15:30 CDT

The updated persona evidence records 26 Shared contributions: all 12 leads plus p02, p03, p07, p08, p11, p16, p21, p22, p24, p25, p27, p30, p31 and p39. Thirty-one people submitted at least one model request. Four collaborators are finishing review/Share (p12, p15, p28, p34); ten remain technically blocked (the nine initial-provisioning cases plus p18). Riley/p09 is a separate post-Share recovery check and is not counted as an unfinished contribution. These are role-completion counts, not a claim of 40 simultaneously healthy runtimes.

### Checkout repair release and recovery evidence

Current documented completion is 30 of 40 Shared contributions. Riley/p09 also completed live shared-only recovery: a fresh browser exposed the correct confirmation, recovery restored the shared source, and managed preview rendered at desktop, 360px and 390px. Parker’s severity/source fixes and the shared Findings summary were present. No model call or new Share was needed.

The existing-resource absent-checkout repair is integrated as `24de48f` (reviewed source `e5c8be3`). It distinguishes a genuinely absent project root from empty/private/unreadable/symlink paths, preserves ordinary reattachment during active turns or listing failures, and publishes the staged shared checkout without overwriting a concurrently appeared destination. Final canonical validation passed 639 tests/68 files with two opt-in skips, lint/types/build, provisioning browser checks and 158-input packaging. The author worktree’s first broad run could not start runner tests because its pinned runtime SDK was absent; canonical validation used the installed locked runtime, with no test relaxation.

Deployment started after a fresh read-only check found 39 ready workspace records, zero active turns and one confirmed missing resource. Quinn’s actual shared-files acceptance remains the next gate before releasing the blocked cohort.

### Existing-resource repair accepted live; final cohort released

`24de48f` deployed successfully. Exact source hashes for provisioning, file checks and atomic checkout matched; health and preserved project/state checks passed. Quinn/p10 reopened the same existing workspace, verified the restored shared file tree, launched its managed preview and reviewed desktop/360px/390px. Only after that did the participant begin the assigned focused UI improvement. No Sprite deletion or replacement was needed.

The other eight initial-provisioning participants were released in parallel through their normal browser workflows, with explicit file verification before any model prompt and no repeated prompts or blind resets. The completion count is 31 Shared contributions, including the transit UI reviewer’s `2bcad30`; the final nine are now authorized to complete their original roles autonomously.

### All attendees reached model work

All 40 personas now have browser evidence of usable shared project files and a submitted role-specific model request. Thirty-one have completed review and manual Share; the final nine are in model completion or review. The last provisioning failure was a provider HTTP 502 in 76 ms for p36, with no resource present afterward. One normal owner retry succeeded without deletion or identity replacement. No further runtime deployment is planned for this exercise.

A management snapshot during final-cohort resumption returned health 200 in 166 ms, approximately 3.3 GiB available RAM and 9.3 GiB free volume space. This is a point-in-time observation, not a sustained 40-inference concurrency benchmark. The run included recovery holds and staggered work; completion counts must not be presented as a measured simultaneous 40-user capacity result.
