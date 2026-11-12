# contracts (`@tsp/contracts`)

Types and every contract between apps and with the hosting platform. No logic (pure rules live in
`@tsp/domain`).

| File | Contract |
|---|---|
| `types.ts` | Domain records and page views (`ProjectState`, `WorkflowFacts`) |
| `bff-api.ts` | web → bff |
| `catalog-api.ts` | bff/labeling → catalog |
| `labeling-api.ts` | bff → labeling |
| `gateway-api.ts` | labeling/bff → llm-gateway; endpoint registry types |
| `agent-api.ts` | bff → agents |
| `platform-api.ts` | everything → hosting platform runtimes (`Platform`, `DocRuntime`, models, files, ...) |
| `errors.ts` | `LlmCallError`, `errorKindOf` |

Rules: imports nothing. Any change here is a contract change: mark it in the PR and follow
"Asking for a contract change" in `docs/handover/integration.md`.
