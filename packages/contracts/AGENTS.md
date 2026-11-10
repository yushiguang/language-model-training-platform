# Shared Contracts & Domain Rules (`packages/contracts`)

`packages/contracts` (`@tsp/contracts`) is the foundational contract layer shared by every service
in the monorepo (`apps/web`, `apps/agents`, `apps/bff`, and `packages/infra`).

## Contents

- `src/types.ts`: Domain entities (`Project`, `SetupVersion`, `Schema`, `DatasetSnapshot`,
  `Example`, `GoldLabel`, `PromptVersion`, `Prediction`, `EvalReport`, `OptimisationRun`,
  `TrainingSet`, `ChatMessage`, `AgentProposal`).
- `src/bff-api.ts`: **Contract 1 (Web <-> BFF)** — HTTP-friendly async interface (`BffContract`)
  consumed by `apps/web` and implemented by `apps/bff`.
- `src/agent-api.ts`: **Contract 2 (BFF <-> Agent Runtime)** — Pure JSON request/response types
  (`AgentTurnInput`, `AgentTurnOutput`, `OptimiserReflectInput`, `OptimiserReflectOutput`) between
  `apps/bff` and `apps/agents`.
- `src/infra-api.ts`: **Contract 3 (Services <-> Infrastructure)** — Complete runtime interfaces
  implemented by `packages/infra` stand-ins and internal platform adapters:
  - `DocRuntime` & `DocCollection`: `add`, `get`, `set`, `update` (partial updates + atomic
    `DocFieldValue.increment`, `arrayUnion`, `arrayRemove`, `delete`), `delete`, `find`
    (auto-paginated), `query` (paginated `{documents, total}` with `limit`/`offset`, multi-field
    `orderBy`, and 11 filter operators via `DocFilter.where`, `DocFilter.and`, `DocFilter.or`),
    polling `subscribe`, and cross-collection `batch()` writes.
  - `AgentModel` & `LabelingModels`: `models()` (returns `AVAILABLE_LLM_MODELS`), `chat()`,
    `complete()` (returns `text`, `thinking`, `stopReason`, and token `usage`), and `chatStream()`
    (SSE streaming generator yielding `delta`, `thinking`, `done`, `error` chunks).
  - `FileStore`, `Identity`, and `ExampleSource`.
- Pure domain rules (`catalogue.ts`, `drafts.ts`, `gates.ts`, `metrics.ts`, `template.ts`,
  `versions.ts`, `workflow.ts`) and their unit tests (`core.test.ts`).

## Rules

- **Zero I/O, zero side effects, zero framework imports.** Everything in this package must be pure
  TypeScript types and deterministic functions.
- **Serialisable contracts.** All types in `bff-api.ts` and `agent-api.ts` must remain plain
  JSON-serialisable structures so in-process calls can be swapped for HTTP/RPC calls without
  touching caller code.
- **English only.** All comments and documentation must be in English.
