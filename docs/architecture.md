# Architecture

The MVP produces a labeled training set and a labeled test set for one task: Setup → Dataset →
Gold Labels (optional) → Prompt Engineering → Training Set (the final run labels train and test). It is a fixed-workflow website with agents built into each step.
Code decides the next step; agents explain and propose, people approve.

## Eight apps, three packages

```
apps/web ──► apps/web/src/backend-api (composition root)
                 │ builds and wires:
                 ├── apps/bff ──────────┬──► catalog      (product records)
                 │   (what pages call)  ├──► labeling     (tasks, predictions) ──► llm-gateway
                 │                      ├──► agents       (presets, runtime)   ──► llm-gateway
                 │                      └──► llm-gateway  (endpoint list, agent model)
                 ├── telemetry (one port, given to every app above) ──► the platform's sink
                 └── @tsp/platform-impl (stand-ins, or the internal adapters)
                       document store · labeling models · agent model · identity · files · examples · telemetry sink

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
| `telemetry` | Metrics (Prometheus style, `tsp_*`) and product events; sends them to `Platform.telemetry` | `TelemetryPort` (`telemetry.ts`) |
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
new version on the eval set (system), the Optimiser's dry runs and eval-set labeling (system), "Get model answers"
for the test set on Gold Labels (the user approves the cost), and the final run (the user approves
the cost). Code starts only the cheap work the workflow needs, and only while automatic starts are
allowed (below).

**The final run** labels every train example. A test example's label is its gold label when
someone gave one, else the chosen version's saved valid answer (an answer that isn't valid JSON
for the labels is not a label); only test examples with neither are labeled, and only when the
user ticks that line in the confirm ("Test set: a have a gold label,
b have an answer from v1.3. Label the other c?"). The results page has a Training set tab and a
Test set tab, each with counts, rows and JSONL/CSV downloads; test rows say where their label
came from (gold or model).

**Automatic paid starts.** Every task starts by itself, with no cost limit and no approval
(decided 2026-11-06: the exact cost of a task can't be predicted, the platform is there to make
training faster, and every running task has a Stop button). This covers scoring a new version,
resuming scoring after a closed page, and the agents' start tools. The Optimiser is the one
exception: it starts only on the user's Auto Optimise (or an agent's start tool after the user asks
in Ask AI), never from `tick` (decided 2026-11-09). `dueStarts`
(`packages/domain/src/auto-start.ts`) says what the workflow would start, and `tick` starts all
of it. Test answers and the final run start from their page's button. Every automatic start
writes an `auto_start` audit record.

Automatic spend is counted per labeling run, not per task: a run started by code adds its cost to
the task's `autoCostUsd`, so an automatic resume of a task the user started counts too, and so do
the optimiser's own labeling runs. try_template saves no task, so it writes an `auto_spend` audit
record with its cost. Automatic spend is recorded for the audit log and telemetry only; it
limits nothing.

```
createTask ──► runTask (browser lock "labeling:<task>"; a second tab gets null)
                 │ rebuild counters from saved predictions; pending = not labeled, not failed
                 │ 4 workers take the next pending example:
                 │    render prompt ─► gateway.label ─► parse answer ─► save prediction ─► increment counters
                 │    a call that still fails after retries ─► record the example in failedExampleIds
                 │ every 2 s: re-read the task; a Stop pressed in another tab aborts
                 ▼
               done │ needs_attention (any example failed; early when > 5% or 20 in a row)
                    │ paused (the page closed; or, for a task given a budget, cost passed 120% of it)
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

## The Optimiser (Auto Optimise)

GEPA, ported to TypeScript (design doc "Prompt optimising in Sprint", 2026-11-09). One run
improves the prompt on the project's one labeling model, for up to the user's Max rounds
(default 10). The pure parts are in `packages/domain/src/gepa.ts`; the loop is
`apps/bff/src/services/optimiser.ts`.

- **Versions.** A run reserves the next major number when it starts; every change it tries is the
  next minor of that major (v3.1, v3.2…). The editor's Save (the main button) makes the next minor
  of the version's own major; Save as vN makes the next major, written without ".0"
  (2026-11-10). The catalog assigns every number.
- **Change marks.** The editor diffs word by word (`diffWords` in `packages/domain/src/template.ts`)
  and gives each change a reason with `withReasons`: the helper's change that shares its words, or
  for an Optimiser version, the round's change line. The marks are drawn under the text box; the
  editor finds the mark under the pointer with `elementsFromPoint` to show the hover.
- **Start version.** A run starts from the version selected in the list (the page asks first when
  a better minor of the same major exists); an agent's start uses the best scored version.
- **Pool and parent.** The pool is the start version plus the run's kept versions, each scored per
  example on the optimiser half of the eval set (share of fields right). The parent is drawn from
  the Pareto front (versions best on at least one example and not dominated), weighted by how
  many examples each is best on. After every 2 kept versions, two front versions that each win
  examples the other misses are merged instead.
- **A round.** The agent runtime writes one change from the parent's mix-ups and up to 8 of its
  wrong examples (`ExampleBrief`: gold, the model's answer, text features cut to about 300
  characters; optimiser half only, never the held-out half; a merge gets up to 4 examples each
  version wins). It may tick or untick a feature after reading feature descriptions with
  `read_feature_info` → the editor's Checks run (a failing or repeated change is dropped,
  unlabeled) → the change is saved and **dry-run** on half of the optimiser half, at most 20
  examples, the ones the parent gets wrong first →
  it goes on only when it passes more of them than the parent → it is labeled on the whole eval
  set (the dry run's answers are reused) and scored on the held-out half.
- **Ends** when a version passes (the Prompt step is approved and the training and test sets
  start with it, test examples without gold included), at Max rounds, after 3 wasted rounds in a
  row, on Stop, or when a step fails 3 times in a row: the run shows Failed with the step and the
  error, and nothing else starts until the user presses Retry, which goes on from that step. A
  run whose page closed shows Paused with Resume.
- **The record.** `OptimisationRun.history` holds every round (parent, change, outcome, dry-run
  counts, score); versions stay immutable, and the Versions list derives its Optimiser, Dropped
  and Running tags from it.

## Agents: the page is the workspace

Agents never read the DOM. When the user sends a message, the assistant panel says where the user
is (path and URL parameters), and the bff builds that page's **page view** from the same saved data
the page shows (`apps/bff/src/services/page-views.ts`). The view goes with every turn, together
with the page's unsaved edits. To see more, an agent calls **read tools** (other pages, versions,
reports, examples, gold labels, predictions, template checks), like a coding agent reading files in
a repo: up to 4 calls per turn, each one logged, nothing changed. Changes stay proposals the user
approves on the page. All presets use the reasoning model. A question gets an answer and never a
proposal: the answer shapes make "template" and "schema" optional, a reply with "question" (one
short question when the request is unclear) proposes nothing, and neither does a template equal to
the one on the page. Improve with AI reads the same wrong examples as the Optimiser.

Three **start tools** spend money (`apps/bff/src/services/starts.ts`): `try_template` (prompt
agent: up to 5 eval examples with an unsaved draft, nothing saved), `score_version` and
`start_optimiser` (prompt and evaluation agents). They run at once, like every automatic start;
the user stops them from the page.

## Telemetry

One `TelemetryPort` from `apps/telemetry` goes to every app. Metrics are Prometheus style with
small label sets (model calls, limiter, labeling, catalog, agents, bff calls, gates, automatic
starts, cost confirms, page views and timings). Product events carry ids, counts and durations,
never content. The browser pushes both to `Platform.telemetry`; the stand-in keeps events in
`localStorage`. The audit log stays in the catalog.

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
| Optimiser: Pareto front, parent, merge pair, dry-run pick and comparison | `packages/domain/src/gepa.ts` |
| Optimiser loop: rounds, retries, Failed and Retry, the training set after a pass | `apps/bff/src/services/optimiser.ts` |
| Improve with AI (a draft with marked changes, nothing labeled) | `improveWithAi` in `apps/bff/src/services/agents.ts` |
| Test answers and the final run (train, plus unlabeled test when ticked) as labeling tasks; output rows with their label source | `apps/bff/src/services/training.ts`, `finalRunPlan` in `packages/domain/src/workflow.ts` |
| What starts without a click | `packages/domain/src/auto-start.ts`, `tick` in `apps/bff/src/services/work.ts` |
| Agent start tools | `apps/bff/src/services/starts.ts` |
| Metric and event names, labels and props | `packages/contracts/src/telemetry.ts` |

## Known limits of this version

- `BffContract` still passes some non-JSON values (a `Map` in `ProjectState`, the full state into
  `tick`) and some client-sent records; a fully serialisable v2 is planned.
- Dataset sampling still runs in the page's memory.
- The Optimiser loop holds a browser lock per project and model, so a second tab cannot run it
  twice; like labeling, it runs only while its page is open.
