# Where Git lives and who can access it

## On the organizer’s Mac today

The canonical repository for a team is `.data/repos/<team-id>.git`, a private bare repository. Independent local participant clones and a trusted integration checkout fetch and push to that filesystem path.

A Sprite cannot read a path on the Mac. The implemented bootstrap makes a self-contained Git bundle and uploads it with the authenticated Sprite CLI. The Sprite clones the bundle into `/home/sprite/project`; the local bundle path is removed as `origin` because it is not a continuously available server.

The round-trip script creates another bundle after committing inside the Sprite, downloads it via the CLI, verifies it, fetches the remote branch, and merges it into the host checkout. Both directions preserve commit IDs. No Mac port needs to be publicly reachable. This is an explicit transfer proof, not ongoing multi-user synchronization.

For interactive local development of the future Git endpoint, use either a development Fly-hosted remote or an authenticated reverse HTTPS tunnel into a locally running Git service. Build repository authorization first. `sprite proxy` connects a local port to a service in the Sprite; it does not expose the Mac to a Sprite. [Sprites networking](https://docs.sprites.dev/concepts/networking/)

## On Fly in the deployed version

Proposed repository path: `/data/repos/<event-id>/<team-id>.git` on the Fly Machine’s persistent volume. Sprites clone and fetch through an HTTPS endpoint such as:

```text
https://your-event-app.fly.dev/git/<event-id>/<team-id>.git
```

A separate Git listener uses Fly TCP passthrough and terminates mutual TLS inside our service. It requires a client certificate signed by the event’s certificate authority, checks its event/team/participant identity against the active certificate registry, then delegates authorized Smart HTTP operations to `git-http-backend`. That service reads/writes the bare repository on the volume. The public registration portal can keep ordinary Fly-managed HTTPS. The Git listener needs its own passthrough port or service/IP; finalize the address allocation when implementing deployment. This endpoint is designed, not implemented in the current prototype. [Git HTTP backend](https://git-scm.com/docs/git-http-backend), [Fly TLS passthrough](https://fly.io/docs/security/tls-termination/)

Do not assume a Sprite can resolve or reach a Machine’s `.internal` hostname. Use authenticated HTTPS over the public hostname as the baseline. Fly Machine private networking and Sprite networking are distinct documented environments. [Fly private networking](https://fly.io/docs/networking/private-networking/), [Sprites networking](https://docs.sprites.dev/concepts/networking/)

## Event-scoped mutual TLS (user-selected design)

**Finding the app or repository URL must grant no Git access.** The organizer explicitly chose our own SSL/TLS keys: mutual TLS client certificates, rather than relying only on bearer tokens over HTTPS. A self-signed server certificate alone would not restrict clients. The server must require and verify a client certificate as well.

Create a certificate authority (CA) for the event and issue a distinct short-lived client certificate/key pair to each Sprite. A connection without a trusted client certificate is rejected before Git requests are accepted. Keep server identity verification enabled: configure the trusted CA explicitly and never set `http.sslVerify=false`.

| Credential | Scope | Lifecycle |
| --- | --- | --- |
| Event invite | Redeem access to one event, with an organizer-defined use limit | Expiring, revocable; optionally one per registrant |
| Participant browser session | One participant’s identity, team, and event capabilities | Secure HttpOnly cookie; logout/revocation and event expiry |
| Sprite client certificate + key | Authenticate one Sprite; registry authorizes read of its team repo and writes to its participant/contribution refs | One per Sprite; short-lived; independently revocable |
| Integration certificate + key | Read team contributions and update that team’s accepted branch | Held only by integration service/Sprite |
| Organizer session | Manage the organizer’s authorized events | Separate from participant invites and Git credentials |

Git supports client certificates using `http.sslCert`, `http.sslKey`, and `http.sslCAInfo`. [Git HTTP configuration](https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpsslCert) Provision them automatically outside the project checkout, with restricted file permissions, scoped to the Git service URL. Participants need no browser certificate or local setup. Never commit private keys, put them in URLs, or log them. The CA signing key stays in the control plane’s protected secret storage and is never sent to participant Sprites. Certificate signatures establish identity; server-side repository and ref checks establish authorization.

The service maintains certificate serial/fingerprint, event, participant, team, permissions, expiry, and revocation state. Check that state on every Git request, including keep-alive connections, so revocation and event close take effect without waiting for a new TLS handshake. Use server-side receive validation to reject writes to `main` or other participants’ refs. Test clients with no certificate, an untrusted CA, expired/revoked certificates, another team’s certificate, and unauthorized branch updates.

A reachable TCP port remains discoverable; mTLS prevents unauthorized Git access, not network-level discovery. If the port itself must be unreachable from the public internet, use a private overlay network between Sprites and Machines as an additional, separately tested design.

A participant with shell/agent execution in their Sprite can potentially read that Sprite’s client key, so its permissions must never exceed their team/branch scope. End-of-event expiry and per-certificate revocation limit its useful lifetime. Do not share one event-wide private client key across all workspaces.

Browser registration still uses invites and sessions. A leaked invite can be redeemed until revoked or exhausted; use individual limited-use invites or organizer approval when joining needs tighter control. Also authorize file APIs, agent streams, app previews, exports, and websocket upgrades. A private Git endpoint does not make a separately public preview private.

At event close, reject new writes immediately and revoke/expire Sprite certificates. Read/export access can have a separate explicit grace period before retention ends. Organizer access remains available for recovery and export.

The server now has verified email-link session integration, event roles, and owner-only file APIs. The Git certificate system is still planned. Public hosting remains future work pending live email delivery verification, hosted Git authorization, durable jobs, and deployment review.
