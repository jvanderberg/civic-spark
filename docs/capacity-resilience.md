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

## Management disk writes — local follow-up

The September 17 rehearsal reported management health timeouts alongside CPU steal and a Node `jbd2_log_wait_commit` wait. That identifies a journal wait, not which source operation caused it or whether storage capacity was exhausted. This bounded source investigation made no live/cloud changes and does not establish a measured hosted latency improvement.

Steady `/api/state` polling already compares remembered identities and does not save unchanged users. Engine snapshots deep-copy memory without writing SQLite. Team-head polling already uses asynchronous read-only Git. The single-writer SQLite lock is acquired at startup, and database health checks use `SELECT 1`. Actual event/team mutations, management seed Git operations, activity timestamps and provisioning transitions can still perform synchronous durable writes.

The local fix skips exactly unchanged access-state saves and runtime values. Identical provisioning status/phase/error/cause observations retain the last transition's timestamp and activity entry instead of appending duplicate activity and rewriting the whole state. The initial-creation checkout barrier still seals before this check; genuine error, phase, identity and cause changes still commit. No changed write is deferred, sampled or acknowledged before the existing commit. SQLite journal/synchronous settings, failure rollback, generation advances, membership revocation, idle policy and every changed activity timestamp are unchanged.

HTTP health filesystem checks now use asynchronous filesystem operations and share only an overlapping in-flight probe. The probe still checks both data/temp headroom and opens, writes, closes and removes a real private data-directory file. There is no success/failure cache after completion, and a failed write remains503. Concurrent checks no longer create/remove one file each or hold the Node event loop in the probe's filesystem call. Startup readiness and authenticated-write headroom admission retain their existing checks.

`tests/management-disk.test.ts` counts real SQLite INSERT/UPDATE events: 400 steady portal polls add no writes; repeated unchanged membership/role/runtime operations add none; 40 identical provisioning observations add no writes or activity beyond the first transition. Changed timestamps, generations and revoked memberships remain durable across reopening, and injected failed writes preserve rollback. Forty overlapping HTTP health requests share one deliberately delayed real-file probe while another API request completes. Both successful and failed probes are followed by a fresh next check; low-space failure and cleanup are covered. These are deterministic local regression assertions, not fsync counts, a disk-throughput benchmark or cloud-load certification.

Agent `user`/`text`/`tool`/`done` events still update the actual durable activity timestamp; token streaming can therefore produce frequent SQLite commits. Removing or batching those changing timestamps would require a separate durability/idle-semantics design. Synchronous whole-state commits, JSON copying, event/team Git creation and admin/prototype Git/filesystem operations also remain possible stalls. Dedicated CPU setup and live acceptance belong to the integration workstream.

Git workers have a 30-second execution deadline and kill/drain their process group on cancellation; individual Git commands have a 15-second bound. Worker and per-repository queues admit at most 120 pending operations and expire waits at two minutes. A killed management process can leave a preparation worker or Git lock temporarily behind; workers do not publish main, and retry fails rather than deleting an unknown lock. Investigate stale locks against running processes before manual removal. Permanent publication intents and prepared refs survive crash for inspection; orphan cleanup is not automatic.

## Fault evidence

`tests/capacity-resilience.test.ts` exercises the actual HTTP Share path with deferred workers, membership revocation, event pause, session revocation, authorization immediately before CAS, stale shared refs, lost CAS responses, and metadata write failures. Isolated SQLite triggers inject a full-disk write failure; no host filesystem is filled. Restart fixtures retain intents both before CAS and after successful CAS with failed metadata persistence. Paused retry remains blocked; explicit authorized retry retains the exact local/shared commit and avoids a duplicate publication. Separate real subprocess SIGKILL testing proves the OS releases the single-writer SQLite lock. Worker cancellation drains a slot and permits a clean retry. This is phase fault injection plus real lock-process death, not a power-loss durability certification.

Setup tests exercise explicit same-volume extension, repeatability, bounded auto-growth, disabled expansion after growth, wrong-volume/shrink/oversize drift, receipt-field preservation and historical origin tombstones without new preview allocation. Queue tests cover bounded concurrency, cancellation, timeout recovery and read isolation/coalescing. Existing owner/lifecycle/provisioning/history tests remain required.

Provisioning preflight rejects dirty local work with HTTP 409 before reserving a Sprite name or changing its local status. An actual HTTP regression then Shares the preserved edits and retries preparation successfully. Deferred preflights deduplicate and count against transient concurrency; session/owner/pause and workspace generation/state are revalidated before reservation. Deferred revocation, sign-out, pause, generation changes and Git-check failure leave the workspace local without a Sprite. Provider reconnect/create uncertainty remains fail-closed; a failed provider probe is never treated as proof of absence.

For deleted-Sprite recovery, failed preflight authorization or state validation restores the hold only if the attempt's deletion record and generation still match. Newer lifecycle holds/releases or deletion records are preserved. Both HTTP wake/prepare routes have deferred sign-out/revocation/stale-state regressions: no provider call or replacement reservation on failure, followed by a successful authorized retry. Normal dirty local preflight still reserves no Sprite identity.

## Setup for a 60-person rehearsal

Start with one management writer, **2 shared CPUs, 4 GiB RAM and a 10 GB persistent volume** for the dedicated rehearsal, then size from real measurements. This is a headroom recommendation, not a proven capacity minimum. The example config shows the configurable CPU/memory fields; do not horizontally replicate the SQLite/Git writer. Sixty maximum 10 MiB replay histories alone retain up to 600 MiB serialized data before object/string overhead. Add CLI processes, buffers, Git workers, auth and the Node heap (native preview traffic bypasses management). The measured live 1 GiB volume with ~904 MiB available and 3.5 MiB current app data describes today's small dataset, not event-day headroom.

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
  "maxProvisioning": 2
}
```

These are fields to edit in the retained installation JSON, not a complete new installation. To decline automatic growth use `"volumeAutoExtend": {"enabled": false}`. Setup emits the provider-native threshold/increment/ceiling fields; management receives no Fly administration credential. See [Fly mount configuration](https://fly.io/docs/reference/configuration/#auto-extend-volume-size-configuration) and [explicit volume extension](https://fly.io/docs/volumes/volume-manage/#extend-a-volume). Volume expansion is one-way and does not expand rootfs or repair a full temporary filesystem.

Remove `maxSprites`, `previewIngress`, `previewPoolSize` and `previewOriginTemplate` from retained setup JSON. No compatibility aliases exist. The previous 68-origin recommendation is superseded by the explicitly authorized **public native Sprite preview** design. All ingress apps were removed by root; this branch never recreates them. Preserve app/org/region, original receipt, Machine/volume IDs and historical `preview-origins.json`; native routing does not use or recycle those tombstones. Remove old pool/template/relay runtime configuration during root-owned deployment; preserve credential backups and stage secret cleanup explicitly.

Only root may apply retained installation changes after review and an idle-safe maintenance window:

1. Run setup `plan` with edited JSON and review disk choice and CPU/RAM. No cloud requests or preview resource planning occurs.
2. Use `provision` only if the original volume needs an explicit extension; root reports it is already 10 GB. Receipt/app/org/region/Machine/mount and high-water size remain checked. Never shrink, replace or silently adopt resources.
3. Deploy management separately. No ingress provisioning step exists. Validate a dedicated Sprite's native public service/URL, anonymous HTTPS/assets/HMR, unchanged source/install cache, stable reopen, native hibernation/wake and explicit Stop/Launch recovery. See [native acceptance](fly-deployment.md#public-native-previews).
4. Measure persistent-volume **and rootfs/tmp** headroom, growth policy, RSS/CLI count, provider backpressure and full-history bundle sizes on dedicated fixtures before inviting 60 people.

Native per-Sprite HTTPS endpoints remove the management origin-pool admission boundary and preview proxy traffic. More team memberships still allocate separate workspaces/Sprites and consume provider resources. Public app visits intentionally bypass management session checks and may wake a natively hibernating provider. Ordinary idle does not stop the service; explicit Pause/Stop does, requiring owner Launch after unpause. Local fixtures cannot certify actual provider limits or wake semantics.

## Remaining architectural limits

- The control plane is still a single SQLite/Git writer with synchronous whole-state JSON writes and deep-copy reads. State/activity/contribution history grows without a retention policy. Event/team creation, admin repository browsing/restoration and some prototype local-file operations still run synchronous Git. A simultaneous arrival/import/admin-history burst needs its own measurement; increasing CPU alone cannot remove those stalls.
- Working-file limits (25 MiB/file, 50 MiB/tree, 5,000 files) and a 10 MiB compressed bundle transport do not bound all historical Git objects. Full-history bundle transfers eventually fail even when the current tree is small. Per-team integration checkouts, per-membership management seed clones, quarantines, WAL, retained Git objects and backups duplicate storage. Do not delete participant history or auto-share to recover space. Incremental authenticated Git transport and reviewed storage reclamation remain follow-up work.
- Metadata rollback is per store. Team/membership creation still spans files, Git and two SQLite stores, and failed creation can leave retained orphan resources. Publication now has a specific durable reconciliation path; this does not make all operations atomic. A 30-second forced management shutdown can interrupt other jobs, with existing owner retry and fail-closed provider uncertainty rules.
- Native previews move assets/WS directly to the provider. Earlier gateway load measurements are historical and do not validate native edge capacity. Large file JSON/base64 transfers still cross management and remain buffered with backpressure; maximum-sized simultaneous uploads/downloads have not been certified.
- Real provider allocation/rate limits, live 60-Sprite cold/warm start, saved-key/model reconnect, native background work and physical mobile devices remain unverified here. A dedicated rehearsal must cover staggered arrival, active editing, both providers' mocked/live-authorized streams, preview asset bursts/HMR, same-team Share contention, disconnect/restart, provider throttling/timeouts and disk-pressure recovery while measuring latency/errors, event-loop delay, management plus child RSS, disk and provider-side usage.

Do not change the five-minute idle setting, automatically publish participant work, rewrite diverged history, recycle origins, access private participant files, or treat planned event budget as enforced model spend.
