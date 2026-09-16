# Workspace Sprite lifecycle

Event admins can inspect their event's allocated Sprite reservations and pause workspace execution. Inventory includes retained reservations after membership/team removal, labels, provider status and provider creation/update timestamps, portal activity time, observed browser model-turn state, and retryable stop failures. It never exposes another participant's files, keys, conversations or provider command details. Metadata refresh uses named provider GET requests and does not execute workspace commands.

## Pause and resume

**Pause all Sprites** durably holds the event's currently allocated workspaces and interrupts their managed work. An owner can reload to resume the same reserved Sprite. **Pause hackathon** first commits an event-wide execution gate, then holds and stops allocated workspaces. The gate survives restart and rejects provisioning, wake, execution HTTP routes, agent/terminal sockets, preview relays and integration callbacks. Unpause removes the event gate; it does not start every Sprite. Owners resume on demand.

Stops cancel and drain in-flight management commands and provisioning jobs, close agent/terminal bridges, invalidate preview tickets/sessions and close tunnels. Permanent preview origin assignments remain unchanged. Failed or interrupted stops keep the gate and display a retry. EventService validates event-admin writes; owner access, existing memberships, origin checks and verified/demo/prototype identity separation remain authoritative. A fabricated Upgrade header cannot bypass the HTTP gate.

The paused event remains available for portal browsing and **shared** team repository downloads, which are built from persisted canonical Git without a Sprite. Private workspace reads/writes are blocked. Event configuration, roles, membership cleanup and explicitly authorized shared-repository administration remain available: this is an execution pause, not a database freeze. No prototype-store fallback, automatic Share or private-source export is added.

## Provider mechanics and limits

Reviewed official documentation on **2026-09-16**. The [Sprite API](https://docs.sprites.dev/api/v001-rc48/sprites/) exposes status and creation/update metadata but no manual VM suspend operation. Its update endpoint changes URL settings. Civic Spark uses supported [service stop](https://docs.sprites.dev/api/v001-rc48/services/) and [exec kill](https://docs.sprites.dev/api/v001-rc48/exec/) operations, plus a fixed remote maintenance script to stop the managed tmux workloads and release the browser agent activity hold. It never deletes a Sprite, changes identity, rewrites Git or resets saved credentials as a pause shortcut. Already sleeping Sprites are left asleep.

Provider status is separate from “access paused.” Sprites normally suspend after about 30 seconds without provider activity. Warm sleep retains memory; cold sleep retains disk but loses processes, so shell memory and unsaved running-program state are not guaranteed. Saved source, Git, credentials and persisted provider conversation/context remain. See [lifecycle and persistence](https://docs.sprites.dev/concepts/lifecycle/).

There is no provider-wide deny-wake control in this implementation. External organization-token holders, directly exposed Sprite URLs and unmanaged detached work are outside the portal gate. Unknown activity holds cause stop failure, not a false success. A stopped service may restart on a later provider wake. This source implementation does not claim a live provider sleep/stop acceptance test or zero charges merely because portal access is paused.

## Inactivity

`CIVIC_SPARK_WORKSPACE_IDLE_MINUTES` is a setup-level integer from 1 to 120, default **5**. A 15-second management timer releases inactive platform polling and connections; it does not compete with provider VM sleep. Trusted participant input records portal use. Status polling does not. Actual pending/active browser model turns, preparation, in-flight operations, recent terminal input/output and meaningful managed preview traffic delay release. Preview HTTP requests and uncompressed client application messages count; open sockets, Vite HMR traffic, RFC ping/pong, known application heartbeats and server pushes do not. Compressed WebSocket messages are intentionally not counted because this observer does not decode private compressed application payloads. Inactive tunnels close, but permanent origins remain assigned. An idle retained terminal session no longer exempts a workspace indefinitely: its host bridge detaches after inactivity, preserving the remote tmux session for normal reconnect. Automatic idle release does not kill remote user processes.

Browser model turns acquire a [Tasks API hold](https://docs.sprites.dev/keeping-sprites-running/) with five-minute expiry and one-minute renewal, released at completion. Stop during hold acquisition cannot start a late paid turn. An idle runner has no hold. This follows the provider's documented heartbeat default. Arbitrary silent background programs/native terminal agents are not automatically instrumented with Tasks holds; their completion depends on provider activity detection or an explicitly managed task. Cold sleep can lose their process state. Recent terminal output is activity, not proof of a browser model turn.

## Cost display

[Official pricing](https://fly.io/sprites/#pricing), retrieved **2026-09-16**, USD: CPU $0.07 per CPU-hour, actual memory $0.04375 per GB-hour, hot storage $0.000683 per GB-hour, cold storage $0.000027 per GB-hour. Sleeping compute is not charged, but persisted storage can be. Provider GET metadata does not supply cumulative CPU, memory/storage usage or active-duration history.

The UI therefore reports total cost and runtime start/active hours as unknown. Its optional CPU-only range is zero to allocation age × eight CPUs × the CPU rate, explicitly a loose allocation-age ceiling that includes unknown sleep time. It is not elapsed-time compute billing or a total invoice estimate. Model charges, plan allowances and other hosting are excluded. No invoice or secret access is required.

## Recovery and portability

`SpriteLifecycleProvider` separates provider inspection/stop from durable event policy. `CIVIC_SPARK_SPRITE_API_URL` selects the authenticated HTTPS metadata API; execution uses the configured Sprite CLI organization and token. Replacing the execution provider requires its adapter, not a Fly Machine stop call. No private-network assumption is introduced.

The [backup/restore workflow](backup-restore.md) captures `event_execution` and `workspace_runtime` in access.sqlite. Restore remains fenced until explicit operator reconciliation validates installation/provider identity and records exact authenticated 404 evidence. Only an explicit authorized owner reopen can use that marker. Provisioning rechecks the same name immediately before creation and honors event pause before and after the check. A missing Sprite is recreated under its existing reserved name from canonical shared Git; workspace/user/team identity and permanent preview origin remain. A surviving Sprite is reattached without replacing its private project. Auth/network/provider errors never authorize recreation. The marker remains through failure and is consumed only after ready verification. No automatic startup provisioning or publication occurs. Unshared Sprite state is intentionally outside disaster recovery.

## Local validation

`tests/lifecycle.test.ts`, `tests/lifecycle-races.test.ts`, `tests/sprite-lifecycle.test.ts`, `tests/agent-cancellation.test.ts` and `tests/recovery-lifecycle.test.ts` and `tests/preview-idle.test.ts` cover authorization, event isolation, persistent gates/restart, partial failures, cancel/drain races, active socket revocation, idle retained terminal detachment, delayed Tasks cancellation and full isolated archive/restore/owner recovery. All provider actions and model calls use mocks or fixed isolated executables.

The lifecycle browser matrix covers 360/390 phones, desktop and short viewport in both themes: discoverable portal Menu, role-scoped inventory, touch/keyboard confirmation/cancel, paused shared download, unpause and same-Sprite reload. Physical iOS/Android keyboards and live provider idle transitions remain unverified.

Final local checks: `npm run check` passed 237 tests / 47 files, lint, both typechecks and build; `npm run test:deploy-context` passed with 141 packaged inputs. `npm run test:mobile` and portal, workspace, agent, terminal, provisioning, environment and hosted-preview browser suites passed. The final standalone lifecycle run additionally waits for restored file content before screenshots. Actual screenshots were inspected at phone, desktop and short sizes in both themes; consoles were clean. No live resources or paid inference were used. Existing build chunk-size and experimental SQLite notices remain.
