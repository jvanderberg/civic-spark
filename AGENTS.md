# Civic Spark contributor guide

Use Civic Spark as the provisional platform name; keep branding modest and emphasize the event name in participant views. Preserve existing runtime/configuration identifiers unless a migration is explicitly needed.

Provider portability is required. Do not assume Fly private networking; keep Git URLs configurable and use standard authenticated protocols. Read `docs/portability.md` before adding deployment or runtime dependencies.

Read docs/product.md and IMPLEMENTATION_PLAN.md before changing behavior. Keep the plan honest about prototype versus production capabilities.

- React and TypeScript throughout; npm and its lockfile; Vite; Tailwind; Biome.
- Strict types, validated API boundaries, explicit errors. Domain writes go through the event service.
- Keep event configuration reusable. No private event invitations or provider secrets in source, examples, logs, exports, or browser responses.
- Participant-generated code must never execute on the management host. Use Sprites for execution. Git operations and plain file editing are allowed on the local prototype host.
- Runtime setup must use the committed, version-locked scripts and executable checks; never ask a coding agent to install or configure its own harness.
- Claude and OpenCode intentionally use bypass permissions inside the participant Sprite. Browser and terminal must share that person's saved key and fixed model; keep credentials outside project files and exports.
- Reopening or refreshing a workspace must reattach to the existing agent context and conversation. Do not treat browser disconnection as Stop, erase provider session IDs, or require a saved key to be pasted again.
- Keep agent chat faithful to the copied T3 Code UI and interactions. Do not add original chat UX, decorative magic icons, or per-turn completion/cost rows. Preserve upstream attribution and verify adaptations against the upstream source.
- Follow the system light/dark theme throughout the app, including code, diffs and terminal. Work panels must fit the viewport and scroll internally; avoid guessed viewport-minus-header heights.
- Share stages all shown changes, makes a real local Git commit with the user-written description, then pushes that same commit to the remote repository. No snapshot substitute, parallel history, separate review gate or hidden merge. A failed push retains the local commit; never force-push diverged remote history.
- Team updates poll Git ancestry, preserve unshared local work, and offer explicit agent resolution or backed-up replacement. Polling never triggers paid agent work; pulling never publishes automatically.
- Agents may prepare meaningful local commits, but must ask periodically at useful milestones and publish only after explicit user confirmation for the current changes. A direct publish request counts; silence or approval of earlier work does not. Use `vibehack git publish`, preserve unrelated work, rebase only unpublished linear commits, and require an owner-confirmed ticket before conflict resolution. Confirm publication of the resolved result separately. Manual Share is the user's explicit publication action.
- Agents must launch apps through the configured managed preview integration and direct participants to Open preview. Default app guidance is React/TypeScript/Vite/Tailwind/Biome unless the user asks for a different stack; maps prefer Leaflet with OpenStreetMap. Favor static client-side data and simple mobile-ready interfaces. Preserve existing work; launch-only requests do not authorize rewriting the app.
- No silent overwrites of unsaved edits. Compare file revisions before saving.
- Do not run paid models as part of normal tests. Live Sprite tests are explicit and use only dedicated vibehack resources.
- Verify behavioral changes with tests; run npm run check. Review actual browser screenshots and console errors for UI changes.
- All application APIs require a session. Production email mode requires verified email. The user explicitly authorized local prototype email sign-in: enable only with VIBEHACK_AUTH_MODE=prototype, loopback access, separate data/cookies, and a visible prototype label. Never accept request body/header user IDs as authorization outside that explicit sign-in flow.
- Event admins manage roles and memberships; they cannot browse another person’s private files. Each user/team membership owns a separate workspace.
- Public deployment still requires live email delivery/sign-in verification, durable provisioning/resource limits, trusted proxy configuration, and hosted Git access review.
