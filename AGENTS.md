# Monorepo Agent Guide

This repository is organized as a **service-aligned monorepo**. Every top-level directory under
`apps/` and `packages/` corresponds to a distinct architectural boundary that runs in-process for
the MVP and splits cleanly into standalone microservices in production.

## Global Rules

- **English only.** All documentation, commit messages, and code comments must be written in English.
- **No internal identifiers or secrets.** Never commit keys, tokens, internal URLs, internal package
  scopes, or internal product names to this public repository.
- **Real examples never go in this repository.** Prepared example pools are loaded via
  `NEXT_PUBLIC_EXAMPLES_URL`; only synthetic sample data lives in `apps/web/public/sample-data/`.
- **Verification before pushing:**
  ```bash
  cd apps/web
  npm run typecheck && npm test && npm run build
  ```

## Directory Layout and Microservice Mapping

```
language-model-training-platform/
  packages/
    contracts/      (@tsp/contracts) Shared domain types, pure rules, and the 3 service contracts
    infra/          (@tsp/infra)     Default local/browser stand-ins for infrastructure interfaces
  apps/
    web/                             1. Frontend SPA (Next.js static export + Astryx)
    agents/         (@tsp/agents)    2. Stateless Agent Runtime & 5 specialist agent presets
    bff/            (@tsp/bff)       3. BFF orchestration & data repository service
  docs/                              Architecture and integration handover documentation
```

### Why the repository is split this way

1. **`packages/contracts` (`@tsp/contracts`) — Shared Objects, Pure Rules & IDL Equivalent**
   - Holds all domain entities (`types.ts`), pure validation/scoring functions (`template.ts`,
     `metrics.ts`, `gates.ts`, `versions.ts`, `workflow.ts`), and the three service contracts:
     - `bff-api.ts`: Frontend (`apps/web`) <-> BFF (`apps/bff`)
     - `agent-api.ts`: BFF (`apps/bff`) <-> Agent Runtime (`apps/agents`)
     - `infra-api.ts`: BFF / Agents <-> Infrastructure (`packages/infra`)
   - Has zero I/O and zero framework dependencies. When backend services are written in Go, this
     package serves as the source-of-truth specification (IDL).

2. **`apps/web` — Frontend Service (Owned by External Coding Agents)**
   - Next.js App Router static export (`app/`, `components/`, `ui/`) plus the BFF client boundary
     (`src/backend-api/`).
   - Pages and components under `src/app/` and `src/components/` may **only** import from
     `@tsp/contracts` (or `@/core/*`), `@/backend-api`, and `@/ui`. They must never import
     `@tsp/bff`, `@tsp/agents`, or `@tsp/infra` directly.

3. **`apps/agents` (`@tsp/agents`) — Agent Runtime Service (Owned by External Coding Agents)**
   - Stateless runtime that implements `@tsp/contracts/agent-api` (`runAgentTurn` and
     `reflectPrompt`).
   - Owns the 5 agent presets (`front_desk`, `schema_agent`, `prompt_agent`, `evaluation_agent`,
     `optimiser`), multi-turn context assembly, specialist handoffs, and output validation/repair
     loops.
   - Must remain completely free of database (`Repo`) or UI dependencies; it communicates with the
     LLM solely through the `AgentModel` interface passed in by the caller.

4. **`apps/bff` (`@tsp/bff`) — BFF Orchestration Service (Maintained for Go Migration)**
   - Implements `BffContract` (`@tsp/contracts/bff-api`).
   - Owns persistence (`src/data/repo.ts`), workflow state loading, dataset splitting, online
     labeling/training-set execution loops, and dispatches assistant turns to `@tsp/agents`.
   - In the MVP this runs in-process; in production it is replaced by a standalone Go BFF service
     without requiring any changes to `apps/web` or `apps/agents`.

5. **`packages/infra` (`@tsp/infra`) — Infrastructure Stand-ins**
   - Implements `@tsp/contracts/infra-api` (`DocRuntime`, `LabelingModels`, `AgentModel`,
     `Identity`, `FileStore`, `ExampleSource`) using local browser stand-ins so the public repo
     works out of the box. Real company adapters are injected at `packages/infra/src/config.ts`
     during internal builds.
