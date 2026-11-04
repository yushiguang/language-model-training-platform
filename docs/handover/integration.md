# Integration & Service Migration Handover

This guide explains the three contract boundaries in the monorepo and how to:
1. Develop the Frontend (`apps/web`) and Agent Runtime (`apps/agents`) in the public repository.
2. Connect managed platform runtimes (`packages/infra/src/config.ts`) for the MVP deployment.
3. Migrate the BFF (`apps/bff`) and Agent Runtime (`apps/agents`) to standalone Go microservices.

Keep this public repository free of internal product names, internal URLs, package scopes, keys
and tokens.

## The Four-Part Call Flow

Every user action and agent interaction flows through four clearly separated layers:

1. **Part 1 — Frontend & BFF Client Contract (`apps/web` + `packages/contracts/src/bff-api.ts`)**
   - Owned by external coding agents.
   - UI components in `apps/web/src/app` and `apps/web/src/components` call async methods on
     `apps/web/src/backend-api/index.ts`.
   - Browser `File` objects are converted to text or uploaded at the client boundary in
     `backend-api/index.ts` so all BFF parameters are JSON-serialisable.

2. **Part 2 — BFF Dispatcher & State Orchestration (`apps/bff`)**
   - Maintained internally (and slated for Go microservice migration).
   - Reads and writes project state via `Repo` (`apps/bff/src/data/repo.ts`), manages background
     labeling/training runs, and assembles `AgentWorkspaceSnapshot` for assistant turns.

3. **Part 3 — Stateless Agent Runtime & Agent Instances (`apps/agents` + `packages/contracts/src/agent-api.ts`)**
   - Owned by external coding agents.
   - Receives `AgentTurnInput` (user text, page context, attachments, workspace snapshot) and an
     `AgentModel` interface; returns `AgentTurnOutput` (invocations, agent/event messages, and
     optional schema or prompt proposals).
   - Also provides `reflectPrompt(input, llm)` for the optimiser loop.
   - Contains zero database or storage calls.

4. **Part 4 — Infrastructure Runtime Interfaces (`packages/contracts/src/infra-api.ts` + `packages/infra`)**
   - Maintained internally.
   - Provides `DocRuntime`, `LabelingModels`, `AgentModel`, `Identity`, `FileStore`, and
     `ExampleSource`.
   - Default stand-ins live in `packages/infra/src/standins/`; internal platform adapters replace
     `packages/infra/src/config.ts` during internal builds.

## Connecting Platform Runtimes (MVP)

Replace the stand-ins in `packages/infra/src/config.ts` with adapters implementing
`packages/contracts/src/infra-api.ts`:

| Interface | Purpose | Public Stand-in |
|---|---|---|
| `DocRuntime` | Document collections (`add`, `get`, `set`, partial `update` with `DocFieldValue`, `delete`, `find`, paginated `query` with 11 `DocFilter` ops & `AND`/`OR`, `subscribe`, and `batch()`) | `localDocRuntime` (`localStorage` + in-memory fallback) |
| `LabelingModels` | Online and streaming labeling calls for evaluation, optimiser, and training sets (`chat`, `chatStream`) | `simulatedModels` |
| `AgentModel` | LLM completions (`chat`, `complete` with `thinking`/`usage`, `chatStream`, and `models()`) for `@tsp/agents` | `scriptedAgent` |
| `Identity` | Display user (`id`, `name`, `email`, `organization`) in header and audit logs | `localIdentity` |
| `FileStore` | Prompt and chat file uploads with progress reporting (`upload(file, name, {mimeType, onProgress})`) | `browserFiles` (data URLs) |
| `ExampleSource` | Example pool for Dataset sampling and ID lookup | `sampleExamples` (`public/sample-data/examples.json`) |

## Migrating to Standalone Go Microservices

When moving `apps/bff` (and optionally `apps/agents`) to Go services:

1. Implement HTTP endpoints in the Go BFF matching `BffContract` in
   `packages/contracts/src/bff-api.ts`.
2. Swap `apps/web/src/backend-api/index.ts` from importing `@tsp/bff` to calling `fetch()` against
   the Go BFF service URL (and back `subscribeChanges` with polling or SSE).
3. Neither `apps/web/src/app/*` nor `apps/web/src/components/*` requires any code changes.

## Verification

```bash
cd apps/web
npm ci
npm run typecheck && npm test && npm run build
```
