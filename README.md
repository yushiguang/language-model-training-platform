# Language model training platform

A platform where PMs and operations staff produce task models (teacher-to-student distillation).
The MVP covers training set production: a fixed-workflow web application with specialist agents
built into each step.

## Monorepo Structure

The repository is structured along future microservice boundaries:

- [`packages/contracts/`](packages/contracts/AGENTS.md): Shared domain objects, pure rules, and the
  three service contracts (`bff-api`, `agent-api`, `infra-api`).
- [`packages/infra/`](packages/infra/src/config.ts): Local browser stand-ins implementing
  `infra-api` so the public repository runs end-to-end without internal credentials.
- [`apps/web/`](apps/web/README.md): Frontend SPA (Next.js static export + Astryx).
- [`apps/agents/`](apps/agents/AGENTS.md): Stateless Agent Runtime service and the 5 specialist
  agent presets implementing `agent-api`.
- `apps/bff/`: BFF orchestration and data repository service implementing `bff-api` (runs
  in-process for the MVP; designed to be migrated to a standalone Go service).
- [`docs/architecture.md`](docs/architecture.md): Architecture map and dependency rules.
- [`docs/handover/integration.md`](docs/handover/integration.md): Guide for connecting platform
  runtimes or splitting services into remote deployments.
