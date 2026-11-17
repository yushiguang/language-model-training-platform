# Repository guide

An npm workspaces monorepo. Each folder in `apps/` is one future service; `packages/` holds what
they share. In the MVP everything runs in the browser as one static site, wired together in one
place (`apps/web/src/backend-api`). Later a service can move behind HTTP without its callers
changing, because apps only talk through the contracts in `@sprint/contracts`.

## Rules

- **English only** in code, comments, docs and commit messages. The one exception is the
  translation catalogs in `packages/domain/src/locales/` (one file per language, keyed by the
  English text); nothing else, tests included, holds text in another language.
- **Nothing internal.** Never commit keys, tokens, internal URLs, internal package scopes or
  internal product names. The public model names (`gpt-5.x`) are fine.
- **No real examples.** Real data is loaded from `NEXT_PUBLIC_EXAMPLES_URL`; only the made-up
  sample in `apps/web/public/sample-data/` lives here.
- **Stay inside your boundary.** `npm run check:boundaries` fails when a package imports something
  it may not (table below), in any source file of an app or package (scripts and config too;
  static, side-effect and dynamic imports and `require`), or when an alias in a tsconfig or
  `next.config.mjs` points somewhere else. Apps never import each other.
- **A contract change is its own change.** Changing a type in `packages/contracts` affects the
  internal adapters too: say so in the PR title and description (see the handover guide).
- **Name branches for what they do.** Use `<type>/<short-kebab-topic>`, where `<type>` is one of
  `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, or `release` (for example
  `feat/v1-dataset-governance`, `fix/min-eval-judge`, `release/v1.0.0`). Never push opaque
  session-id branches such as `claude/project-thread-*`.
- **No content in telemetry.** Metrics and events carry counts, ids, enums and durations only
  (`packages/contracts/src/telemetry.ts`); never prompt or chat text, features, names or emails.
  The telemetry app enforces it: label values and event props are allowlisted there.
- **Check before pushing:** `npm run check && npm run build`. For changes to labeling, the
  workflow, bff or pages, also run the browser check: `node apps/web/scripts/e2e-check.cjs` against a
  served build (needs Playwright with Chromium).

## Layout

| Folder | Package | What it is | May import |
|---|---|---|---|
| `packages/contracts` | `@sprint/contracts` | Types and every service contract. No logic | nothing |
| `packages/domain` | `@sprint/domain` | Pure rules: templates, metrics, gates, versions, estimates | contracts |
| `packages/platform` | `@sprint/platform` | Stand-ins for the hosting platform, `DocRepo` over the document store | contracts, domain |
| `apps/llm-gateway` | `@sprint/llm-gateway` | Every model call: endpoint registry, QPM/TPM limits, retries | contracts, domain |
| `apps/catalog` | `@sprint/catalog` | Product records (projects, versions, reports, ...): CRUD, version numbers | contracts, domain, platform |
| `apps/labeling` | `@sprint/labeling` | Labeling tasks and predictions: runs, failures, resume | contracts, domain, platform |
| `apps/agents` | `@sprint/agents` | Agent presets and runtime, hand-written, no framework | contracts, domain |
| `apps/optimiser` | `@sprint/optimiser` | The Auto Optimise loop behind `OptimiserContract`; asks the workflow through `OptimiserHost` | contracts, domain |
| `apps/jobs` | `@sprint/jobs` | The job module: background work as jobs with a lease, heartbeat, recovery, retries, cancel and fair order across tenants; executors come from the apps that own the work, jobs live in an injected `JobStorePort` | contracts, domain |
| `apps/workflow` | `@sprint/workflow` | The application module behind `WorkflowContract`: project state, gates, when labeling starts, reports, dataset governance, Ask AI turns, page views and agent tools. A factory with no module-level state; every method takes the caller's `RequestContext` | contracts, domain |
| `apps/bff` | `@sprint/bff` | What pages call (`BffContract`): a thin adapter that builds each call's context and hands it to the workflow | contracts, domain |
| `apps/telemetry` | `@sprint/telemetry` | Prometheus-style metrics and product events, sent to the platform's sink | contracts |
| `apps/web` | `@sprint/web` | Next.js static site. Pages call `@/backend-api` only | contracts, domain, `@/backend-api`, `@/ui`, `@/components` |
| `apps/web/src/backend-api` | | `client.ts`: the `BffClient` pages call. `in-process.ts`: the composition root, builds every app and wires them (the default `@sprint/client-impl`). `index.ts`: takes the client from `@sprint/client-impl` | anything |

Two build-time switches, and no others: `@sprint/platform-impl` resolves to the stand-ins by
default and to the internal adapters in the internal build (only the composition root imports
it); `@sprint/client-impl` resolves to the in-process client by default and to an HTTP client in
a server deployment (only `backend-api/index.ts` imports it).

Per-folder guides: each app and package has its own `AGENTS.md`.

## Who changes what

The public repo is changed by coding agents without internal access ("external") and by the
internal team's agent ("internal"), which also keeps an overlay of adapters outside this repo.

- External: everything in this repo, including contracts, plus the stand-ins and tests.
- Internal: the adapters behind `@sprint/platform-impl`, registered endpoints with real QPM/TPM,
  deployment. Details and the change-request flow: `docs/handover/integration.md`.
