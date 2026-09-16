# Portability requirement

Civic Spark must not depend on Fly private networking for correctness or access control. Fly is the first deployment target and Sprites the first workspace runtime. A private network may be an optional deployment optimization after its connectivity is verified.

The portable Git contract is standard Smart HTTP over HTTPS, with mutually authenticated client certificates and application-level team/ref authorization. The repository URL is configuration, not an assumed `.internal` name. A deployment can terminate mTLS in its own Git gateway or a capable provider edge, provided the application receives verified identity through a trusted, non-spoofable channel.

## Keep these concerns separate

| Concern | First implementation | Future replacement boundary |
| --- | --- | --- |
| Browser UI | React/Vite static assets | Any static host, including Cloudflare |
| Control plane | Node/Fastify and local SQLite | HTTP API and domain operations; persistence/runtime adaptation required for Workers |
| Workspace runtime | Authenticated Sprite CLI adapter | Provision, execute, read/write files, checkpoint, destroy |
| Repository service | Local bare Git; planned HTTPS Git gateway on persistent volume | Git remote URL, authenticated Git protocol, authorization policy, backup/restore |
| Access policy | Planned event CA and participant/team/ref registry | Independent of network location and provider-specific identity |
| Async orchestration | Local in-process prototype | Durable job state with provider-specific queue/worker adapter |

The current prototype separates source by concern, but its domain service still directly uses Node SQLite/filesystem/Git. It is not already Worker-compatible. Extract concrete interfaces when implementing the second storage/runtime adapter.

## Cloudflare path

The UI can move independently. A Cloudflare-hosted control plane could use Workers with an appropriate persistence adapter while continuing to orchestrate Sprites and a separately hosted Git gateway over HTTPS. Replacing Sprites is another, independent step.

An all-Cloudflare backend needs a repository durability design. Cloudflare Containers run Linux workloads but their disks are ephemeral; Durable Object storage persists separately. A running bare Git repository therefore cannot rely on container disk alone. Do not assume an object-store FUSE mount provides Git's required locking/atomic update semantics without testing. An external durable Git service is the simpler initial port. [Cloudflare container architecture](https://developers.cloudflare.com/containers/concepts/architecture/), [container and Durable Object storage](https://developers.cloudflare.com/containers/reference/container-class/)

Cloudflare also offers client certificate validation, but accepting our own event CA and enforcing revocation requires checking the relevant product/plan capabilities at implementation time. The portable baseline remains our own mTLS-capable Git service. [Cloudflare client certificates](https://developers.cloudflare.com/ssl/client-certificates/)

## Runtime lifecycle policy

Event execution gates and per-workspace holds persist through EventService independently of provider status. `SpriteLifecycleProvider` supplies named-resource inspection, non-destructive stop and explicit permanent deletion mechanics; its current HTTPS adapter uses `CIVIC_SPARK_SPRITE_API_URL`, while commands use the configured Sprite CLI organization. A second provider must implement non-destructive lifecycle operations and activity/wake semantics explicitly. Fly Machine stop is not a Sprite sleep operation. See [lifecycle contracts](sprite-lifecycle.md), including native idle and billing-data limits.
