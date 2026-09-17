# Live rehearsal — September 17, 2026

Status: live UI inspection complete; roster approved and execution starting.

Site: https://civic-spark.fly.dev — Day in Our Data.

The user authorized real live Playwright interactions and OpenRouter inference. Luna operates the browsers; the root agent coordinates, records findings and publishes this report. Existing participant teams and project catalog are preserved. All application interactions use browser UI; no direct API, database, provider CLI or mocked transport shortcuts.

## Attendance and roles

Forty new, clearly labelled rehearsal attendees form twelve teams. All attendees are ordinary participants. Each team has a lead and two or three collaborators; lead is a test responsibility, not elevated application authorization. An existing test organizer observes admin flows without changing roles.

| Team | Lead | Collaborators | Project |
| --- | --- | --- | --- |
| Rehearsal 01 | P01 | P02, P03, P04 | Is my assessment fair? |
| Rehearsal 02 | P05 | P06, P07, P08 | Where does my tax dollar go? |
| Rehearsal 03 | P09 | P10, P11, P12 | Can a kid bike to school safely? |
| Rehearsal 04 | P13 | P14, P15, P16 | Which bus stops need help? |
| Rehearsal 05 | P17 | P18, P19 | Build the Oak Park transit dashboard |
| Rehearsal 06 | P20 | P21, P22 | Oak Park over time |
| Rehearsal 07 | P23 | P24, P25 | How are our schools doing? |
| Rehearsal 08 | P26 | P27, P28 | How resilient is our urban forest? |
| Rehearsal 09 | P29 | P30, P31 | Build an architecture walking tour |
| Rehearsal 10 | P32 | P33, P34 | What do our commissions do? |
| Rehearsal 11 | P35 | P36, P37 | Oak Park crime data explorer |
| Rehearsal 12 | P38 | P39, P40 | What does ECHO see? |

Account namespace: `rehearsal-20260917-pNN@example.test`. Team names begin with `Rehearsal NN`. Twelve distinct existing project briefs selected through the live catalog. Inspection found 3 existing participants in one team and capacity40; authorized UI-only capacity adjustment to43 accommodates forty test attendees without altering existing memberships.

## Execution

1. Inspect the live catalog, capacity and navigation; finalize the roster/project mapping.
2. Create the twelve teams through their leads, then join the other twenty-eight attendees through Teams.
3. Each lead opens their workspace and asks the existing OpenRouter-backed model to read PROJECT.md and build a small MVP visualization. No automatic publication. Review Changes, Share with a meaningful message, then Launch/Open the demo.
4. Each collaborator opens their own workspace, explicitly receives team updates, asks for one small improvement, reviews Changes and Shares. Work is sequential within a team to test the normal collaboration path without manufacturing avoidable conflicts.
5. Check the resulting shared demo and repeated team updates. Record failures, retries, timing, console errors and usability observations rather than bypassing them.
6. Preserve rehearsal teams and shared demos for review. Remove saved test credentials through supported UI where possible; record any cleanup limitation.

Initial concurrency: at most two provisioning flows and three model turns at once. Forty attendees is the attendance target, not a claim of forty simultaneous model turns or a certified load limit. Plan: twelve MVP turns plus twenty-eight bounded collaborator turns; extra repair turns must be recorded. Sign-ins are paced to respect the live rate limiter.

Credential values, browser cookies, private storage states and request bodies are excluded from this report, screenshots and committed scripts. Evidence is recorded in the shared ignored `artifacts/live-rehearsal-20260917/` directory; this report is the published summary.

## Progress

- Plan published; Luna headed-browser inspection completed.
- Found 16 projects, one existing team with3participants, two admins, capacity40.
- Twelve-project roster approved. Capacity adjustment40→43 authorized through Eventdetails UI; no other event settings/roles change.
- First-team pilot will run MVP→Share→collaborator update before expanding the remaining teams.

## Errors, quirks and observations

None observed yet. This means testing has not reached the workflows, not that they pass.
