<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Frontend App Rules (`apps/web`)

- Read `../../AGENTS.md` and `../../docs/architecture.md` first.
- Pages and components (`src/app/`, `src/components/`) may import only `@tsp/contracts` (types),
  `@tsp/domain` (pure rules), `@/backend-api`, `@/components` and `@/ui`. The boundary check
  enforces this, and also checks the aliases in `tsconfig.json` and `next.config.mjs`.
- The look comes from `src/ui/kit.css`, a copy of the Unified UI canvas styles: keep it identical
  to the canvas and put app-only rules in `src/ui/app.css`. Pages build from the parts in `@/ui`.
  Anything that can't match the canvas goes in `docs/ui-gaps.md`.
- `src/backend-api/in-process.ts` is the composition root (`index.ts` picks the client, `client.ts`
  is the `BffClient` interface): the only file that builds the apps and
  imports `@tsp/platform-impl`.
- UI text uses plain words (for example "the optimiser", never the method name).
- Before pushing, from the repo root: `npm run check && npm run build`; for flow changes also
  `node apps/web/scripts/e2e-check.cjs`.
