<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project rules

- Start with `../docs/handover/integration.md` (what to connect) and `../docs/architecture.md` (code map).
- Connect real services only in `src/platform/config.ts`, behind the interfaces in `src/platform/interfaces.ts`.
- Never commit keys, tokens, internal URLs or internal product names. Nothing secret may go in client code or `NEXT_PUBLIC_*` variables.
- Real examples never go in this repo; the prepared file is loaded from `NEXT_PUBLIC_EXAMPLES_URL`.
- Before pushing: `npm run typecheck && npm test && npm run build`.
