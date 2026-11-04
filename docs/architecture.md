# Architecture

The MVP produces a labeled training set and a labeled test set for one task: Setup → Dataset →
Gold Labels (optional) → Prompt Engineering → Training Set (the final run labels train and test). It is a fixed-workflow website with agents built into each step.
Code decides the next step; agents explain and propose, people approve.

## Seven apps, three packages

```
apps/web ──► apps/web/src/backend-api (composition root)
                 │ builds and wires:
                 ├── apps/bff ──────────┬──► catalog      (product records)
                 │   (what pages call)  ├──► labeling     (tasks, predictions) ──► llm-gateway
                 │                      ├──► agents       (presets, runtime)   ──► llm-gateway
                 │                      └──► llm-gateway  (endpoint list, agent model)
                 └── @tsp/platform-impl (stand-ins, or the internal adapters)
                       document store · labeling models · agent model · identity · files · examples

All apps depend only on packages/contracts (types, contracts) and packages/domain (pure rules).
catalog and labeling also use packages/platform for DocRepo over the document store.
```

Apps never import each other. The bff receives the other apps as contract objects through
`configureBff()`; labeling receives the catalog and the gateway through `createLabeling()`. The
composition root is the only place that knows which implementation sits behind each contract.

| App | Owns | Contract |
|---|---|---|
| `llm-gateway` | Endpoint registry; one limiter per endpoint; per-call retries; token and cost accounting | `LlmGatewayContract` (`gateway-api.ts`) |
| `labeling` | Collections `labeling_tasks`, `predictions`. Runs tasks | `LabelingContract` (`labeling-api.ts`) |
| `catalog` | All product collections (`CatalogRecords` in `catalog-api.ts`). Assigns version numbers | `CatalogContract` |
| `agents` | Agent presets and the turn/handoff logic. Stateless | `AgentRuntimeContract` (`agent-api.ts`) |
| `bff` | Nothing stored. Workflow, gates, when labeling starts, reports, optimiser loop | `BffContract` (`bff-api.ts`) |
| `web` | Pages and components | calls `@/backend-api` |

## Model calls: llm-gateway

- **Registry.** Endpoints are registered by a tenant manager with their QPM and TPM; an endpoint is
  registered once across all tenants. Chat (agents) and labeling use separate endpoints, so they
  never share a quota. Until the platform supplies registered endpoints (`Platform.endpoints`),
  the gateway assumes conservative limits per model (`apps/llm-gateway/src/registry.ts`) and marks
  them `assumed`.
- **Limiter.** Per endpoint: a 60-second sliding window for requests (QPM) and tokens (TPM), a cap
  on calls in flight, and a first-in first-out queue. A call waits until it fits; it is never sent
  over the limit. Tokens are estimated before the call (text / 4, 800 per image, plus the output
  cap) and corrected with the real usage after. Reasoning tokens count toward TPM. After a 429 the
  limiter halves its rate and recovers after a quiet window.
- **Retries.** Busy (429), server and timeout errors are retried after 2, 4, 8 and 16 s. Rejected
  requests (other 4xx) and stops are not retried.

## Labeling: tasks

A labeling task runs one prompt version on one model (with fixed settings) over a list of
examples and stores one prediction per example. The bff creates tasks for four reasons: scoring a
new version on the eval set (system), labeling an optimiser candidate (system), "Get model answers"
for the test set on Gold Labels (the user approves the cost), and the final run over the train and
test splits (the user approves the cost). Code starts only the cheap work the workflow needs.

```
createTask ──► runTask (browser lock "labeling:<task>"; a second tab gets null)
                 │ rebuild counters from saved predictions; pending = not labeled, not failed
                 │ 4 workers take the next pending example:
                 │    render prompt ─► gateway.label ─► parse answer ─► save prediction ─► increment counters
                 │    a call that still fails after retries ─► record the example in failedExampleIds
                 │ every 2 s: re-read the task; a Stop pressed in another tab aborts
                 ▼
               done │ needs_attention (any example failed; early when > 5% or 20 in a row)
                    │ paused (cost passed 120% of the approved estimate, or the page closed)
                    │ stopped (Stop)
```

- **Predictions are shared.** The prediction id is a hash of version + model + settings + example,
  so a task for the same combination reuses what is saved; only missing examples are labeled.
- **Resume.** The MVP runner is the open page (datasets are 50 to 100 examples). Closing the page
  stops the runner; the task stays `running` with no lock held, and the next read reports it as
  `paused` with reason `closed`. Scoring and optimiser tasks resume by themselves on the next page
  tick; user-started tasks (test answers, the final run) wait for the user's Resume. Retry failed clears the failed list and runs
  again.
- **Other tabs.** Writes are announced to other tabs of the site, and pages re-read every 5 s
  while something runs, so a second tab follows a run and sees it pause.
- **Later (not in the MVP):** a worker outside the browser, ordered claims with heartbeats so
  several runners can share a task, and shared quota records across runners.

## Agents: the page is the workspace

Agents never read the DOM. When the user sends a message, the assistant panel says where the user
is (path and URL parameters), and the bff builds that page's **page view** from the same saved data
the page shows (`apps/bff/src/services/page-views.ts`). The view goes with every turn, together
with the page's unsaved edits. To see more, an agent calls **read tools** (other pages, versions,
reports, examples, gold labels, predictions, template checks), like a coding agent reading files in
a repo: up to 4 calls per turn, each one logged, nothing changed. Changes stay proposals the user
approves on the page. All presets use the reasoning model.

## Prompts with images

A labeling request is one user message whose content lists text and image parts in order; each
image sits where its placeholder was, and no caption text is added. The editor marks image
placeholders, and "Preview with an example" shows the parts in order with UI-only captions and the
token and cost estimate. Preview and labeling use the same `renderPrompt`.

## Storage

The document store (MongoDB in the real system; `localStorage` in the stand-in) is reached through
`DocRuntime`. There is no conditional write; atomic `increment` and `arrayUnion` are available and
used for counters, failed lists and approvals. Writes are partial (`patch`) so a background run
and a page action never overwrite each other's fields. `DocRepo` (`packages/platform`) maps the
application `id` to the store's document id.

## Where the rules live

| Rule | File |
|---|---|
| `{{Key}}` placeholders, checks and quick fixes; rendering to text and image parts | `packages/domain/src/template.ts` |
| Reading a model answer against the schema; settings hash; evaluation context id; token estimate | `packages/domain/src/labels.ts` |
| Metrics (macro-F1 per field, per-value F1, accuracy, invalid rate, mix-ups, cost per 1,000) and pass/fail | `packages/domain/src/metrics.ts` |
| Versions are major.minor and never overwritten; the catalog assigns the numbers | `packages/domain/src/versions.ts`, `apps/catalog/src/catalog.ts` |
| Gates between steps; Gold Labels is optional | `packages/domain/src/gates.ts` |
| The recommended next step and cost/time estimates | `packages/domain/src/workflow.ts` |
| Agent prompts, handoffs (to known specialists only), read tools per preset | `apps/agents/src/presets.ts`, `apps/agents/src/runtime.ts` |
| What an agent sees of each page (page views) and the read tools' implementation | `apps/bff/src/services/page-views.ts` |
| When labeling starts, reports scored on the held-out half of the eval set | `apps/bff/src/services/evaluation.ts`, `work.ts` |
| Optimiser: GEPA-style loop; candidates are labeled as optimiser tasks | `apps/bff/src/services/optimiser.ts` |
| Test answers and the final run (train + test) as labeling tasks with a budget | `apps/bff/src/services/training.ts` |

## Known limits of this version

- `BffContract` still passes some non-JSON values (a `Map` in `ProjectState`, the full state into
  `tick`) and some client-sent records; a fully serialisable v2 is planned.
- Dataset sampling still runs in the page's memory.
- The optimiser loop itself (not its labeling) has no cross-tab lock.
