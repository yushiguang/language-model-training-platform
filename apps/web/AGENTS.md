<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Frontend App Rules (`apps/web`)

- Read `../../AGENTS.md` and `../../docs/architecture.md` first for the monorepo service boundaries.
- All documentation and code comments must be written in English only.
- Pages and components under `src/app/` and `src/components/` may **only** import from:
  - `@tsp/contracts` (or `@/core/*`) for domain types and pure rules
  - `@/backend-api` for all asynchronous backend operations and state subscriptions
  - `@/ui` for Astryx UI primitives
- Never import `@tsp/bff`, `@tsp/agents`, or `@tsp/infra` directly from UI components.
- Never commit keys, tokens, internal URLs, internal package scopes, or internal product names.
- Before pushing: `npm run typecheck && npm test && npm run build`.
