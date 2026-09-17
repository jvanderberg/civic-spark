# Capacity and recovery review — September 16, 2026

This is isolated local evidence, not certification that the live one-shared-CPU/1 GiB Machine supports 60 active people. Root owns integration and deployment. No live participant data, cloud resources or paid models were used. The five-minute idle timeout is unchanged.

## Results and reproduction

`npm run test:capacity -- artifacts/capacity/target-final.json` creates disposable real SQLite accounts/sessions, 12 Git teams, and 60 concurrent personal workspace clients. It sends portal polls every 15 seconds and files/changes/team-status/provisioning/preview polls every five seconds for 30 seconds, with staggered starts. Provider responses have a fixed 25 ms in-process delay. The fixture then submits 60 explicit Share requests against real Git on the actual HTTP route and measures 60 conversation replays. All data is synthetic. `CIVIC_SPARK_LOAD_SECONDS=60` extends the polling scenario. The fixture event owner creates all 12 teams, so it also retains 11 additional inactive memberships; these are not additional concurrent clients.

Same-machine Node 22.23.2/macOS results, baseline versus capacity checkpoint `82861c7` (before the narrow provisioning-preflight follow-up):

| Measurement | Baseline | Final target |
| --- | ---: | ---: |
| Polling requests / unexpected failures | 1,920 / 0 | 1,920 / 0 |
| Portal p95 / p99 | 755 / 835 ms | 63 / 168 ms |
| Team status p95 / p99 | 674 / 857 ms | 158 / 236 ms |
| Polling event-loop p99 / maximum | 64 / 171 ms | 27 / 89 ms |
| Polling peak management RSS | 208 MiB | 197 MiB |
| 60 Share batch duration | 49.98 s | 34.20 s |
| Share event-loop maximum | **49,157 ms** | **85 ms** |
| Share results | 12 success, 48 divergence conflicts | 12 success, 48 divergence conflicts |
| 60 × 1 MB replay processing | 4,275 ms | 172 ms |
| Identical retained replay data | 60,245,460 bytes | 60,245,460 bytes |

The synthetic data occupied 12.4 MB before Share and 12.5 MB afterward in both runs; this short fixture does not measure long-term Git/history growth. The initial intermediate run remains in `target.json` (49 ms portal p95, 84 ms Share maximum loop delay); the table uses the final rerun.

The 48 Share conflicts are expected: five people independently start from each team's same main commit. The first can publish; four retain their real local commits and must explicitly update/resolve before another Share. They are not server failures. Bounded workers keep other requests responsive but do not make all shares instant. The target batch's p95 Share latency is 33.95 seconds.

`npm run test:capacity-streams` adds a separate actual-server transport scenario: 60 authenticated Agent sockets, 60 Terminal sockets, 60 private preview WebSockets, 600 echoed HMR messages, 6,300 agent and 6,300 terminal output messages, and 75 MiB of preview assets over about 10.6 seconds. Peak process RSS was 443 MiB; event-loop p95/p99/max were 43/45/50 ms. Agent child streams and terminal PTYs are in-process doubles. HTTP, WebSocket, session authorization, actual bridges, preview tickets/cookies and isolated wildcard hosts execute locally. The upstream serves only trusted synthetic data.

Raw results remain in ignored `artifacts/capacity/{baseline,target,target-final,streams}.json`. Measurements include the local load driver in the server process and use no CPU/memory cgroup limit. Worker process RSS is not included in the server RSS. The polling and stream scenarios are separate, not proof of one combined maximum workload. Real Sprite CLI process memory, provider latency/rate limits, cold starts, TLS ingress, WAN loss and live model streams are unmeasured. Dedicated provider rehearsal remains root-coordinated work.

## Implemented changes

- Remove the total Sprite allocation admission cap. Event participant capacity remains enforced; event budget remains planning metadata rather than an enforced spend limit. Provisioning remains two concurrent jobs by default, with explicit retryable busy responses.
- Move Share commit preparation and history validation to two bounded trusted Git workers. Workers receive immutable validated input, do not open SQLite, do not receive provider credentials, and never run participant scripts/hooks. Actual HTTP Share and native agent publication use the new path. Shared repository publication is ordered per repository and updates main asynchronously with an expected-old-ref check.
- Check the current session, owner membership, closed-event and lifecycle policy after worker completion and immediately before publication. An explicit Share starts the operation; disconnection does not authorize a second Share or history rewrite. An in-flight authorized request finishes or records its outcome rather than silently abandoning a child mutation.
- Persist a publication intent before main's compare-and-swap. If the result is uncertain, inspect the ref instead of repeating the write. If Git succeeds but SQLite cannot save metadata, retain the intent. Startup performs no automatic publication. The owner's next explicit authorized Share can reconcile the same commit, including an already-published ancestor of newer main, without rewriting shared history. Cross-store atomicity is not claimed.
- Run team-head polling, bundle preparation and incoming quarantine Git asynchronously. Existing synchronous admin history/restore/team creation and legacy prototype helpers remain; these are still potential latency spikes.
- Retain exactly the same transcript limits while sizing only new/replaced events. This avoids serializing the entire replay on every token. No conversation truncation policy changed.
- Bound Sprite CLI command execution (default 16 active, 120 queued, ten-second queue wait), large transfer commands (two active), and accepted concurrent request-body reservations (256 MiB). Return explicit retryable busy errors; these constrain transient work, not eligible people or allocated workspaces. Matching concurrent read polls coalesce by Sprite/script/payload. Long preview preparation still competes for command slots.
- Restore the last durable in-memory event/access snapshot after failed SQLite writes. A failed write cannot leave an uncommitted role, membership or Sprite status active in memory. Provisioning cleanup handles rejected error-persistence promises without an unhandled rejection crash.
- Check at least 128 MiB available on both the persistent data filesystem and temporary filesystem, plus twice declared incoming body size, before authenticated API writes. Health also checks both filesystems and a real data-directory write. This is an early warning/failure reserve, not protection against every race to ENOSPC or a replacement for monitoring/backups. It can temporarily block metadata/control writes too; operator storage recovery is required.

Git workers have a 30-second execution deadline and kill/drain their process group on cancellation; individual Git commands have a 15-second bound. Worker and per-repository queues admit at most 120 pending operations and expire waits at two minutes. A killed management process can leave a preparation worker or Git lock temporarily behind; workers do not publish main, and retry fails rather than deleting an unknown lock. Investigate stale locks against running processes before manual removal. Permanent publication intents and prepared refs survive crash for inspection; orphan cleanup is not automatic.

## Fault evidence

`tests/capacity-resilience.test.ts` exercises the actual HTTP Share path with deferred workers, membership revocation, event pause, session revocation, authorization immediately before CAS, stale shared refs, lost CAS responses, and metadata write failures. Isolated SQLite triggers inject a full-disk write failure; no host filesystem is filled. Restart fixtures retain intents both before CAS and after successful CAS with failed metadata persistence. Paused retry remains blocked; explicit authorized retry retains the exact local/shared commit and avoids a duplicate publication. Separate real subprocess SIGKILL testing proves the OS releases the single-writer SQLite lock. Worker cancellation drains a slot and permits a clean retry. This is phase fault injection plus real lock-process death, not a power-loss durability certification.

Setup tests exercise explicit same-volume extension, repeatability, bounded auto-growth, disabled expansion after growth, wrong-volume/shrink/oversize drift, receipt-field preservation and 60 new permanent preview bindings after eight retained ones. Queue tests cover bounded concurrency, cancellation, timeout recovery and read isolation/coalescing. Existing owner/lifecycle/provisioning/history tests remain required.

Provisioning preflight rejects dirty local work with HTTP 409 before reserving a Sprite name or changing its local status. An actual HTTP regression then Shares the preserved edits and retries preparation successfully. Deferred preflights deduplicate and count against transient concurrency; session/owner/pause and workspace generation/state are revalidated before reservation. Deferred revocation, sign-out, pause, generation changes and Git-check failure leave the workspace local without a Sprite. Provider reconnect/create uncertainty remains fail-closed; a failed provider probe is never treated as proof of absence.

## Setup for a 60-person rehearsal

Start with one management writer, **2 shared CPUs, 4 GiB RAM and a 10 GB persistent volume** for the dedicated rehearsal, then size from real measurements. This is a headroom recommendation, not a proven capacity minimum. The example config shows the configurable CPU/memory fields; do not horizontally replicate the SQLite/Git writer. Sixty maximum 10 MiB replay histories alone retain up to 600 MiB serialized data before object/string overhead. Add CLI processes, buffers, Git workers, auth, preview tunnels and the Node heap. The measured live 1 GiB volume with ~904 MiB available and 3.5 MiB current app data describes today's small dataset, not event-day headroom.

The operator explicitly chooses native volume growth, for example:

```json
{
  "volumeGb": 10,
  "volumeAutoExtend": {
    "enabled": true,
    "thresholdPercent": 80,
    "incrementGb": 5,
    "ceilingGb": 50
  },
  "managementCpus": 2,
  "managementMemoryMb": 4096,
  "maxProvisioning": 2,
  "previewPoolSize": 68
}
```

These are fields to edit in the retained installation JSON, not a complete new installation. To decline automatic growth use `"volumeAutoExtend": {"enabled": false}`. Setup emits the provider-native threshold/increment/ceiling fields; management receives no Fly administration credential. See [Fly mount configuration](https://fly.io/docs/reference/configuration/#auto-extend-volume-size-configuration) and [explicit volume extension](https://fly.io/docs/volumes/volume-manage/#extend-a-volume). Volume expansion is one-way and does not expand rootfs or repair a full temporary filesystem.

For the retained eight-origin installation, **remove `maxSprites`** and set `previewPoolSize: 68` to reserve room for 60 additional first-use personal workspaces even if all eight old origins are occupied. No compatibility alias exists. Preserve app/org/region, original receipt, Machine/volume IDs, relay secret, origin slots, and live `preview-origins.json`. Do not copy example organization names, proxy peers or credentials into the retained setup. No runtime Sprite allocation cap replaces the removed field.

Only root may run the following against the retained installation after reviewing the concrete configuration and coordinating the normal idle-safe maintenance window:

1. Run the existing setup `plan` with the edited JSON. This writes local configuration/append-only origin planning metadata and makes no cloud requests. Review the displayed disk choice, CPU/RAM and total permanent origins.
2. Run `provision` to explicitly extend the original volume from 1 to 10 GB when requested. It validates receipt/app/org/region/Machine/mount, checks the resulting size, and pins the retained volume identity/high-water size. It never shrinks or replaces a volume. A failure is not assumed success; inspect before retry.
3. If retaining the no-domain route, run the existing `preview-provision` with its retained private credential input. It provisions only newly planned slots and reuses all old identities. Then perform the separately owned deploy. This workstream runs none of these cloud actions.
4. Verify actual persistent-volume **and rootfs/tmp** headroom, native auto-extension policy, process RSS/CLI count, health, provider backpressure and full-history bundle size on dedicated fixtures before inviting 60 people.

No-domain previews remain a finite infrastructure pool: each origin is permanently bound to one membership workspace on first use, even after deletion. Pool exhaustion is explicit and recoverable by appending origins and reloading the configuration; it does not block creating a Sprite or permit identity reuse. More than one team membership per person, retained historical workspaces and rehearsal accounts require additional origins. The practical alternative is the existing owned-domain wildcard DNS/TLS template (`previewOriginTemplate`), which uses a unique workspace UUID host without a preallocated ingress pool. DNS/certificate setup remains operator work. Arbitrary new origins cannot be minted safely from one provider-issued app certificate without provider provisioning or owned DNS.

## Remaining architectural limits

- The control plane is still a single SQLite/Git writer with synchronous whole-state JSON writes and deep-copy reads. State/activity/contribution history grows without a retention policy. Event/team creation, admin repository browsing/restoration and some prototype local-file operations still run synchronous Git. A simultaneous arrival/import/admin-history burst needs its own measurement; increasing CPU alone cannot remove those stalls.
- Working-file limits (25 MiB/file, 50 MiB/tree, 5,000 files) and a 10 MiB compressed bundle transport do not bound all historical Git objects. Full-history bundle transfers eventually fail even when the current tree is small. Per-team integration checkouts, per-membership management seed clones, quarantines, WAL, retained Git objects and backups duplicate storage. Do not delete participant history or auto-share to recover space. Incremental authenticated Git transport and reviewed storage reclamation remain follow-up work.
- Metadata rollback is per store. Team/membership creation still spans files, Git and two SQLite stores, and failed creation can leave retained orphan resources. Publication now has a specific durable reconciliation path; this does not make all operations atomic. A 30-second forced management shutdown can interrupt other jobs, with existing owner retry and fail-closed provider uncertainty rules.
- Preview assets/WS still cross management and consume its network, socket, buffer and tunnel process budget. Stateless ingress Machines do not offload the management gateway. Large file JSON/base64 transfers remain buffered, albeit with backpressure; maximum-sized simultaneous upload/download workloads have not been certified.
- Real provider allocation/rate limits, live 60-Sprite cold/warm start, saved-key/model reconnect, native background work and physical mobile devices remain unverified here. A dedicated rehearsal must cover staggered arrival, active editing, both providers' mocked/live-authorized streams, preview asset bursts/HMR, same-team Share contention, disconnect/restart, provider throttling/timeouts and disk-pressure recovery while measuring latency/errors, event-loop delay, management plus child RSS, disk and provider-side usage.

Do not change the five-minute idle setting, automatically publish participant work, rewrite diverged history, recycle origins, access private participant files, or treat planned event budget as enforced model spend.
