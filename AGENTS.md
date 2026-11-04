# Repository guide

An npm workspaces monorepo. Each folder in `apps/` is one future service; `packages/` holds what
they share. In the MVP everything runs in the browser as one static site, wired together in one
place (`apps/web/src/backend-api`). Later a service can move behind HTTP without its callers
changing, because apps only talk through the contracts in `@tsp/contracts`.

## Rules

- **English only** in code, comments, docs and commit messages.
- **Nothing internal.** Never commit keys, tokens, internal URLs, internal package scopes or
  internal product names. The public model names (`gpt-5.x`) are fine.
- **No real examples.** Real data is loaded from `NEXT_PUBLIC_EXAMPLES_URL`; only the made-up
  sample in `apps/web/public/sample-data/` lives here.
- **Stay inside your boundary.** `npm run check:boundaries` fails when a package imports something
  it may not (table below). Apps never import each other.
- **A contract change is its own change.** Changing a type in `packages/contracts` affects the
  internal adapters too: say so in the PR title and description (see the handover guide).
- **No content in telemetry.** Metrics and events carry counts, ids, enums and durations only
  (`packages/contracts/src/telemetry.ts`); never prompt or chat text, features, names or emails.
- **Check before pushing:** `npm run check && npm run build`. For changes to labeling, the
  bff or pages, also run the browser check: `node apps/web/scripts/e2e-check.cjs` against a
  served build (needs Playwright with Chromium).

## Layout

| Folder | Package | What it is | May import |
|---|---|---|---|
| `packages/contracts` | `@tsp/contracts` | Types and every service contract. No logic | nothing |
| `packages/domain` | `@tsp/domain` | Pure rules: templates, metrics, gates, versions, estimates | contracts |
| `packages/platform` | `@tsp/platform` | Stand-ins for the hosting platform, `DocRepo` over the document store | contracts, domain |
| `apps/llm-gateway` | `@tsp/llm-gateway` | Every model call: endpoint registry, QPM/TPM limits, retries | contracts, domain |
| `apps/catalog` | `@tsp/catalog` | Product records (projects, versions, reports, ...): CRUD, version numbers | contracts, domain, platform |
| `apps/labeling` | `@tsp/labeling` | Labeling tasks and predictions: runs, failures, resume | contracts, domain, platform |
| `apps/agents` | `@tsp/agents` | Agent presets and runtime, hand-written, no framework | contracts, domain |
| `apps/bff` | `@tsp/bff` | What pages call: workflow, decides when labeling starts, builds reports | contracts, domain |
| `apps/telemetry` | `@tsp/telemetry` | Prometheus-style metrics and product events, sent to the platform's sink | contracts |
| `apps/web` | `@tsp/web` | Next.js static site. Pages call `@/backend-api` only | contracts, domain, `@/backend-api`, `@/ui`, `@/components` |
| `apps/web/src/backend-api` | | The composition root: builds every app and wires them | anything |

`@tsp/platform-impl` is the one injection point: it resolves to the stand-ins by default and to
the internal adapters in the internal build. Only the composition root imports it.

Per-folder guides: each app and package has its own `AGENTS.md`.

## Who changes what

The public repo is changed by coding agents without internal access ("external") and by the
internal team's agent ("internal"), which also keeps an overlay of adapters outside this repo.

- External: everything in this repo, including contracts, plus the stand-ins and tests.
- Internal: the adapters behind `@tsp/platform-impl`, registered endpoints with real QPM/TPM,
  deployment. Details and the change-request flow: `docs/handover/integration.md`.
