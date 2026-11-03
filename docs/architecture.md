# Architecture: Service-Aligned Monorepo

The MVP produces a labeled **training set** for one task: Setup → Dataset → Gold Labels (optional)
→ Prompt Engineering → Training Set. It is a fixed-workflow website with specialist agents built
into each step, not a free-form chat app.

## Why the monorepo is partitioned this way

During the MVP, the entire platform is deployed as a single static bundle so the team can validate
the workflow immediately. After the MVP, the backend orchestration and agent runtime will move to
standalone backend microservices (written in Go), while the frontend and agent strategies continue
to be iterated on by coding agents in this repository.

To make that transition zero-rewrite for the frontend, the monorepo is partitioned into **three
application services (`apps/`)** and **two shared packages (`packages/`)**:

```
language-model-training-platform/
  packages/
    contracts/        (@tsp/contracts) Domain types, pure rules, and the 3 service contracts
    infra/            (@tsp/infra)     Infrastructure stand-ins + config.ts integration point
  apps/
    web/                               1. Frontend SPA: pages, components, Astryx wrappers, BFF client
    agents/           (@tsp/agents)    2. Agent Runtime Service: 5 agent presets + reflection + repair
    bff/              (@tsp/bff)       3. BFF Service: workflow orchestration + document repository
```

### Dependency graph and ownership

```
apps/web  ──(Contract 1: bff-api)──►  apps/bff  ──(Contract 2: agent-api)──►  apps/agents
   │                                     │                                        │
   └──────────────►  packages/contracts  ◄────────────────────────────────────────┘
                                         ▲
                                         │ (Contract 3: infra-api)
                                   packages/infra
```

| Module | Owner | Responsibility | Future Production Form |
|---|---|---|---|
| `packages/contracts` | Shared | Domain entities, pure rules (`template`, `metrics`, `gates`, `versions`, `workflow`), and the 3 service contracts | IDL / OpenAPI specification shared between TS and Go |
| `apps/web` | External Agent | Next.js pages (`app/`), shared components (`components/`), UI wrappers (`ui/`), and the client boundary (`backend-api/`) | Static frontend hosted on CDN / static hosting |
| `apps/agents` | External Agent | Stateless Agent Runtime (`runAgentTurn`, `reflectPrompt`), 5 specialist agent prompts, context assembly, and output validation | Standalone Agent Runtime service or Go agent module |
| `apps/bff` | Internal Team | Workflow state orchestration (`services/`) and document storage repository (`data/repo.ts`) | Go BFF microservice deployed on container infrastructure |
| `packages/infra` | Internal Team | Default browser stand-ins (`standins/`) and runtime wiring (`config.ts`) | Replaced by internal platform adapters or Go service clients |

## Key domain rules and where they live

| Rule | Location |
|---|---|
| `{{Key}}` placeholders; single braces are plain text. Checks: unknown key (with closest match), not ticked, ticked but unused, broken braces; warnings for one type only, image cost, missing values. Quick fixes | `packages/contracts/src/template.ts` |
| Rendering: lines whose placeholders aren't ticked for the example's type are dropped; empty features become "none"; image features and `[Image N]` become image parts | `packages/contracts/src/template.ts` |
| Metrics: macro-F1 per field, per-value F1, accuracy, invalid rate, mix-ups, cost per 1,000. Pass/fail against thresholds | `packages/contracts/src/metrics.ts` |
| Versions are major.minor and never overwritten. Save = next minor in the edited line, Save as = next major | `packages/contracts/src/versions.ts` |
| Gates between steps; Gold Labels is optional | `packages/contracts/src/gates.ts` |
| The code decides the next step; agents only explain it | `packages/contracts/src/workflow.ts` |
| Specialist agent prompts, handoff rules, and context assembly | `apps/agents/src/presets.ts`, `apps/agents/src/runtime.ts` |
| Evaluation context (schema version + eval examples + gold labels) and held-out scoring | `apps/bff/src/services/evaluation.ts` |
| Optimiser: GEPA-style loop calling `@tsp/agents` `reflectPrompt` | `apps/bff/src/services/optimiser.ts` |
| Document repository (`_appId` mapping, snake_case filter translation, deduplication) | `apps/bff/src/data/repo.ts` |

## Storage

Document collections accessed through `DocRuntime` (`packages/contracts/src/infra-api.ts`) and
encapsulated by `Repo` (`apps/bff/src/data/repo.ts`). Each collection stores JSON records keyed by
an application ID (`_appId`) mapped to the underlying document-store ID.

In the public repository, `localDocRuntime` (`packages/infra/src/standins/local-db.ts`) stores
collections in the browser's `localStorage` (with an in-memory fallback for Node unit tests).
