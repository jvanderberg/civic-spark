# Project conventions researched

Reviewed Josh’s existing local projects before scaffolding. These are references for this repository, not imports of every unrelated project rule.

| Reference | Practice adopted |
| --- | --- |
| `~/git/gimpish/package.json`, `biome.json` | React/Vite, strict TypeScript, npm, Biome, simple repository scripts |
| `~/git/tax_appeal_app/AGENTS.md`, `CLAUDE.md` | Zod boundary validation, explicit domain results, domain-owned writes, meaningful behavior tests |
| `~/git/wikimemory/AGENTS.md`, `package.json` | Clear persistence boundaries, structured types, test/typecheck/lint commands, durable context |
| `~/git/trivia/package.json` | Lightweight React/Vite application structure |
| `~/git/spritebox/AGENTS.md`, `src/app.rs`, `src/sprites_api.rs` | Existing Sprites setup and repository/branch orchestration reference; reuse installed authentication |
| `~/.claude/CLAUDE.md` | Inspect real APIs/source, verify in a browser with screenshots and console checks, keep secrets out of code |

## Choices

- React and strict TypeScript for the management UI; Tailwind 4 through the official Vite plugin, with named CSS components for the design system. No additional UI framework.
- Biome for formatting, import organization, and linting; npm lockfile for reproducible installs.
- Fastify and Node SQLite for the local control plane. A single domain service owns writes; HTTP handlers validate input and delegate operations.
- Explicit result types for expected failures, including stale file saves, merge conflicts, invalid transitions, and capacity constraints.
- Tests exercise actual Git repositories, persistence, path boundaries, conflict preservation, and browser flows. Default tests never provision cloud resources or invoke paid models.
- Runtime state, generated artifacts, credentials, and restricted invitation links are excluded from source control.
- Participant code must execute inside Sprites. The local management server only manages files and Git metadata.

Tailwind integration follows the [official Vite installation guide](https://tailwindcss.com/docs/installation/using-vite). Sprite transport follows the installed CLI’s actual command help and was verified against a dedicated resource. See [prototype evidence](prototype-results.md).
