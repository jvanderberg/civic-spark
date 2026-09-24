# Civic Spark

A browser platform for civic hackathons. The event name leads the participant experience; Civic Spark is the platform name. Sign in, create or find an event, join teams, and work in your own checkout of each team’s project.

For the current checkpoint and next-session priorities, start with [the handoff](docs/handoff.md).

Source: [jvanderberg/civic-spark](https://github.com/jvanderberg/civic-spark).

Configuration uses `CIVIC_SPARK_*` settings and the Sprite runtime command is `civic-spark`. This is a breaking namespace change; existing installations require an explicit [migration](docs/rename-migration.md) before reconnecting saved workspaces.

## Start locally

Requires Node 22.23+, npm, and Git. The host implementation has been tested on macOS; participants only need a browser.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:4310**. For a local UI rehearsal, set `CIVIC_SPARK_AUTH_MODE=prototype` in `.env` and restart. Enter any email to create or resume that prototype identity; sign out and use another email to try another person's view. Prototype mode uses separate `.data/prototype/` storage and cookies, accepts only loopback access, and visibly labels the app. Existing real-auth data is preserved.

For verified sign-in, use `CIVIC_SPARK_AUTH_MODE=email` (the default) and configure SMTP or Resend using [sign-in setup](docs/authentication.md). Prototype identities are not promoted into verified accounts.

## The experience

- **Create an event:** the signed-in creator becomes its first admin. Draft events are visible only to their event members; opening registration makes the event discoverable to signed-in users.
- **Admin overview:** see people, roles, teams, and shared contributions. Promote existing event members, add an already signed-in admin by verified email, or remove an incorrect team membership. The last admin cannot be removed.
- **Explore projects:** see project briefs and existing teams. Join a team or create one from a listed project or a custom brief. Creating a team also joins it, and its brief is included in `PROJECT.md`.
- **My teams:** a person can join several teams. Each user/team pair has a separate workspace. Capacity counts distinct people in active teams, not their number of memberships.
- **My workspace:** only its owner can list, read, or edit its private files. Admin roles do not grant access to other people’s working files. Removing a membership revokes workspace access and preserves the files; rejoining restores the membership and work.
- **Shared work:** review your Changes, enter a change description, and choose Share. One action commits and publishes to the shared team version; conflicts preserve both versions. Export the shared repository as a ZIP. Unpublished working files remain private.

## Sprites

Authenticate the official `sprite` CLI and set `CIVIC_SPARK_ENABLE_SPRITES=1`. Optional `CIVIC_SPARK_SPRITE_ORG` selects an organization. Opening a team workspace for the first time prepares a dedicated Sprite using the organizer’s configured account, uploads its committed team checkout, and then displays the real remote filesystem. Reopening uses the same Sprite.

The remote browser/editor supports text and CSV files, rejects stale saves and path escapes, and checks the authenticated owner before every operation. Files live at `/home/sprite/project`. Team Git uses independent clones, not cross-VM filesystem worktrees.

**Current transport:** remote browsing/editing and Share use the authenticated Sprite connection. Share makes a real local commit and transfers that exact commit in a bounded Git bundle, pushing the shared branch without a separate review gate. Diverged remote history is reported instead of force-pushed. The top bar checks for incoming team updates and offers Get updates, agent-assisted conflict resolution, or a backed-up replacement with the team version. The continuous hosted Git service will use HTTPS/mTLS. Agent chat adapters and the browser terminal are implemented; GLM has passed a live request, approval, and SVG edit; The full Claude questions/cancellation/provider-failure rehearsal remains outstanding. Personal previews have Launch/Restart/Open controls and use each existing Sprite's native public HTTPS URL. App visits can wake a natively hibernating Sprite; after explicit Stop/Pause the owner must Launch again. Management actions remain owner/session/event gated. No preview ingress app, Machine or custom domain is required. See docs/workspaces.md for the managed command/dependency contract and docs/fly-deployment.md for dedicated native-provider acceptance.

When Sprites are disabled, the same membership permissions apply to local checkouts. This is used by automated tests and allows local file/Git development without cloud resources.

## Workspace views

- **Files:** syntax-highlighted editing for common code/data formats; create, upload, download or delete files, and preserve unsaved edits when another source changes the file.
- **Changes:** refreshes a diff against the last synchronized team baseline, including changes committed by an agent and new/deleted files.
- **Agent:** Fixed Opus 5 (Anthropic key) or GLM (OpenRouter key), with streaming Markdown, compact tool activity, questions, and stop/reconnect. The chat uses copied and adapted T3 Code components under the MIT license. Connect runs a locked, scripted installation and verifies executable health inside the Sprite. Model readiness waits for the runtime and key check. Keys and fixed model defaults are saved privately in the Sprite for both browser and terminal use. Both harnesses bypass tool permissions; no model calls happen on connect. Refresh/reopen restores your project, model, conversation, and active session automatically. Saved keys stay hidden unless missing or their provider fails; reconnect retries the saved key. Active turns use the T3 elapsed-time and animated activity indicators.
- **Terminal:** xterm.js connects through the authenticated API to the Sprite CLI and a persistent tmux shell. Tools execute inside the Sprite. Opening the terminal prepares the same agent tools. No SSH setup needed.
- **Local folder:** Chrome/Edge users grant folder access and review initial changes. The single Sync now action transfers changes in both directions. Later nonconflicting saves sync while the workspace remains open and the page active. Conflicts and deletions require review. Reconnect the same folder after reopening; `.civic-spark-sync.json` retains its workspace binding and baseline.

Sync supports project files up to 25 MiB each, 50 MiB total, and 5,000 files. Hidden paths, credentials, dependencies, caches, build output, symlinks, and nonportable filenames are excluded or rejected. Unsupported browsers can use file upload/download. Local folder sync is separate from sharing changes with the team. See [workspace implementation](docs/workspaces.md) for boundaries and verification limits.

Agents ask whether to publish at useful milestones and require explicit confirmation for the current changes before pushing. Approval to resolve conflicts does not also approve publication. Clicking Share is an explicit publication action. See [agent publication](docs/workspaces.md#agent-publication-and-conflict-confirmation).

## Verification

```sh
npx playwright install chromium
npm run check
npm run test:browser
npm run test:workspace-browser
npm run test:agent-browser
npm run test:mobile
npm run test:hosted-preview-browser
```

The browser test signs up two people through the real email endpoints, one by link and one by code, using an in-memory test mailbox. A separate test-only session fixture supplies an extra coordinator account; no live email is sent. It checks event ownership, discovery, multi-team membership, custom briefs, private file access, contribution/ZIP, admin promotion, removal/revocation, logout, mobile layout, and browser errors. Screenshots are saved in ignored `artifacts/`.

Run `npm run check` first to build the assets used by browser checks. `npm run test:mobile` exercises phone touch flows at 360px/390px widths plus short and landscape viewports, including admin forms, repository controls, editing, Share, chat and unsupported-folder fallbacks. It uses disposable data and deterministic agent/preview responses, with screenshots in `artifacts/mobile/`. Physical iOS/Android keyboard and native-picker behavior still needs device rehearsal. `npm run test:terminal-browser` also checks xterm at phone sizes without cloud or model calls.

Explicit cloud checks:

```sh
# Creates and retains one dedicated test Sprite; makes zero model calls.
npm run test:sprite -- --live
# Uses an existing dedicated test Sprite, temporarily edits README, and restores it.
npm run test:remote-files -- --sprite civic-spark-smoke-NAME
# Existing test Sprite only; installs pinned agent tools, tests terminal/runner reconnect, no model calls.
npm run test:workspace-live -- --sprite civic-spark-smoke-NAME
# Verify or repair an existing workspace runtime with the same setup used by the UI.
npm run setup:sprite -- --sprite civic-spark-NAME
```

## Storage and limits

Runtime data stays under ignored `.data/`: `auth.sqlite` stores accounts, hashed verification tokens, and sessions; `access.sqlite` stores user/event roles and team memberships; `state.sqlite` stores project/Git metadata. Repository and workspace directories hold code. Local startup generates a protected `auth-secret` if none is configured. Back up the whole directory with the server stopped; run one server against a data directory.

The old anonymous rehearsal is preserved on disk but has no authenticated ownership records and is therefore not exposed or automatically assigned to whoever logs in first. The old `npm run demo` account-seeding flow was removed.

A repeatable [Fly deployment package](docs/fly-deployment.md) now prepares a single Machine and persistent volume, explicit authentication, safely staged Sprite credentials, provisioning limits and restart reconciliation. No Fly deployment has been performed. Linux container execution, real email delivery, proxy verification, dedicated Sprite lifecycle and coordinated backup/recovery still need live rehearsal. Model budgets remain planning amounts, not enforced spending limits.

## Source structure

```text
apps/web/           React/TypeScript account, discovery, team, and admin views
apps/server/        Fastify API, Better Auth integration, authenticated file routing
packages/domain/    Session-actor authorization, event roles, memberships, Git engine
packages/agents/    Deterministic harness setup, prompt/context, sessions and integrations
packages/git/       Bare repositories, checkouts, safe local file operations
packages/sprites/   Sprite CLI, remote files, Git and preview adapters
packages/workspace/ File sync, sharing and recovery
templates/         Reusable event definitions and starter projects
scripts/            Browser and explicit cloud checks
tests/             Access-control, session, membership, and Git behavior tests
```

See [product flow](docs/product.md), [authentication setup](docs/authentication.md), [Git/mTLS design](docs/git-and-access.md), [portability](docs/portability.md), [project conventions](docs/project-conventions.md), and the [implementation plan](IMPLEMENTATION_PLAN.md).
