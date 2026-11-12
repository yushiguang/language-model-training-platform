# Architecture

The MVP produces a labeled training set and a labeled test set for one task: Setup → Dataset →
Gold Labels → Prompt Engineering → Training Set (the final run labels train and test). It is a fixed-workflow website with agents built into each step.
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
new version on the eval set (system), the Optimiser's dry runs, eval-set labeling and the second
labeling that confirms a pass (system), model answers for the test set, and the final run. All of
them start by themselves (below).

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

## The Optimiser and the helpers

Both have their own design docs, which hold the design and the as-built detail:

- [design/optimiser.md](design/optimiser.md): Auto Optimise (GEPA ported to TypeScript) and
  Improve with AI. Pure parts in `packages/domain/src/gepa.ts`, the loop in
  `apps/bff/src/services/optimiser.ts`.
- [design/helpers.md](design/helpers.md): the helpers in Ask AI (agent presets, page views, read
  and start tools, what they may never see). Presets and runtime in `apps/agents`, page views and
  tools in `apps/bff/src/services/page-views.ts`.

## Scores, gold labels and what starts by itself

**Rebuild scores** (Evelyn, 2026-11-12: by hand only). A gold edit changes the evaluation context,
so reports are archived and `ProjectState.scoresUpdating` is set ("Scores out of date" on Gold
Labels and Prompt versions). Nothing rebuilds by itself: gold edits, Setup changes and new code all
move scores, and sensing each one is fragile. The Rebuild scores button on Prompt versions calls
`rebuildReports`, which gives every version of the current schema with a finished scoring a fresh
report from saved answers (nothing labeled); a report it replaces is marked `archived` and hidden.
`tick` builds only a version's first report. Saved answers on the whole eval set are kept in memory
per version for the Mismatches list.

**Auto-start manager** (2026-11-11). `dueStarts(state)` says what should be running; `tick` starts
it. The project provider (`apps/web/src/components/ProjectContext.tsx`) runs `tick` on every
change event and on a 60 s sweep, on every project page. Starts are keyed (`once()` plus the
labeling app's lock per task), so extra runs are safe. Every auto task also has a button that
sends the same start (Score/Resume, Optimiser Resume/Retry, training set Resume). In a microservice
system the same split holds: one workflow service owns `dueStarts`, woken by events and a sweep.

**Mismatches** (review finding 2, decided 2026-11-10). Gold Labels has a Mismatches tab: the eval
examples where a version's saved answer differs from the gold label, for the version picked in
"Compare with" at the end of the tab row (default: the best scored one; only versions with answers
on the whole eval set; answers the safety filter stopped are no mismatch). The examples wrong in
the most versions come first. The user keeps the label or changes it (to the model's answer or a
third answer), with an optional "Why"; each decision is an audit record (`gold.review`, with the
version) and the example moves from To review to Reviewed for that version only (acceptance R4-5).
A review stands until it is reopened (`gold.reopen`, which names the review; a changed label goes
back to what it was) or the gold label changes. `labelerNotes` gives the standing notes on
optimiser-half examples to the Optimiser and Improve with AI as `ExampleBrief.labelerNote`. A change saves a new gold label, so the evaluation context changes
and reports are rebuilt from saved answers: nothing is labeled again
(`apps/bff/src/services/mismatches.ts`). Prompt versions' AI Suggestion points to the tab right
after the first score (before any review or Optimiser run) and when Auto Optimise ends without a
pass; never while the Optimiser runs or after a pass. Helpers give the counts only, never which
side is right.

## Telemetry

One `TelemetryPort` from `apps/telemetry` goes to every app. Metrics are Prometheus style with
small label sets (model calls, limiter, labeling, catalog, agents, bff calls, gates, automatic
starts, page views and timings). Product events carry ids, counts and durations,
never content. The browser pushes both to `Platform.telemetry`; the stand-in keeps events in
`localStorage`. The audit log stays in the catalog. Conventions and the rules for changing the
catalogue: [design/telemetry.md](design/telemetry.md).

## Prompts with images

A labeling request is one user message whose content lists text and image parts in order; each
image sits where its placeholder was, and no caption text is added. The editor marks image
placeholders; labeling and the helpers' "try" tool use the same `renderPrompt`.

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
| Metrics (macro-F1 per field, shown as "Score" with the metric name in grey; per-value F1, accuracy, invalid rate, mix-ups; invalid and filtered answers left out of the scores and counted apart) and pass/fail (always at most 1% invalid, `INVALID_CAP`) | `packages/domain/src/metrics.ts` |
| Versions are major.minor and never overwritten; the catalog assigns the numbers | `packages/domain/src/versions.ts`, `apps/catalog/src/catalog.ts` |
| Gates between steps; Gold Labels is an ordinary step (R5-8) | `packages/domain/src/gates.ts` |
| The recommended next step (the best score wins; cost only breaks a tie) | `packages/domain/src/workflow.ts` |
| Agent prompts, handoffs (to known specialists only), read tools per preset | `apps/agents/src/presets.ts`, `apps/agents/src/runtime.ts` |
| What an agent sees of each page (page views) and the read tools' implementation | `apps/bff/src/services/page-views.ts` |
| No helper reads the held-out half (`visibleToAgents`) | `packages/domain/src/gepa.ts`, used in `page-views.ts`, `starts.ts`, `agents.ts` |
| When labeling starts, reports scored on the held-out half of the eval set | `apps/bff/src/services/evaluation.ts`, `work.ts` |
| Optimiser: Pareto front, parent, merge pair, dry-run pick and comparison | `packages/domain/src/gepa.ts` |
| Confirming a pass (second labeling of the held-out half) | `confirmScore` in `apps/bff/src/services/evaluation.ts` |
| Mismatches between saved answers and gold labels; keep or change | `apps/bff/src/services/mismatches.ts` |
| The label check on Dataset | `checkLabels` in `apps/bff/src/services/agents.ts` |
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
