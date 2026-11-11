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
- **Pool and parent.** The pool is the start version, the run's kept versions, and every other
  version with a current score on the model (2026-11-11), each scored per example on the optimiser
  half of the eval set (share of fields right). Round 1 always changes the start version (R5-7).
  Later parents are drawn from the Pareto front (versions best on at least one example and not
  dominated), weighted by how many examples each is best on; the round keeps that count
  (`parentWins`) so the panel can say why. After every 2 kept versions, two front versions that
  each win examples the other misses are merged instead.
- **A round.** The agent runtime writes one change from the parent's mix-ups and up to 8 of its
  wrong examples (`ExampleBrief`: gold, the model's answer, text features cut to about 300
  characters; optimiser half only, never the held-out half; a merge gets up to 4 examples each
  version wins). It may tick or untick a feature after reading feature descriptions with
  `read_feature_info` → the editor's Checks run (a failing or repeated change is dropped,
  unlabeled) → the change is saved and **dry-run** on half of the optimiser half, at most 20
  examples, picked at random (review finding 7), up to half of them from the examples that hold
  the parent's weakest value (in the gold label or the parent's answer) → it goes on only when it
  gets more fields right than the parent on them, the parent's weakest field counting double
  (`compareDryRun`, review finding 5), or ties it while being right on different examples (R5-6:
  `tied`, labeled in full and kept in the pool, but a wasted round; 2 ties in a row end the run) → it is labeled on the whole eval set (the dry run's
  answers are reused) and scored on the held-out half. `setOptimiserRandom` fixes the random picks
  in tests.
- **Confirming a pass** (decided 2026-11-10, review finding 6). A version that passes is not used
  yet: the held-out half is labeled a second time with the same version and settings (`pass: 2`
  in `ModelSettings`, so the answers are saved apart from the first labeling) and scored again
  (`confirmScore`). Only when both pass does the run end and the training and test sets start. A
  pass the second labeling does not confirm stays a kept version, shows "Not confirmed" in the
  Optimiser panel (`OptimiserRound.confirm`), and the run goes on.
- **Ends** when a version passes and the pass is confirmed (the Prompt step is approved and the training and test sets
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

**Images.** Wrong examples (`ExampleBrief.images`, up to 2 per example from the image features)
go to the helpers as image content parts after the text, for Improve with AI, the Optimiser and
the label check. A relative sample URL is not resolved for the model; the stand-in data uses them,
real items carry absolute URLs.

**Document links.** Helpers read a document link the user pastes with the `read_doc` tool
(front desk, Labels helper, Prompt helper). The bff reads it through `Platform.documents`
(`DocumentSource`, `packages/contracts/src/platform-api.ts`); the text is cut at 20,000
characters. The public build's stand-in (`noDocuments`) opens nothing, so the helper says the
link can't be opened here and asks for the pasted text. The internal build plugs in the real
document service (docs/handover/integration.md, "Document links").

**Broken replies.** When a helper's reply is not the JSON its preset asks for, the runtime asks
once more; on a second miss it shows plain prose as it is, or a short "please ask again" line when
the reply looks like broken JSON.

**The held-out half stays hidden from every helper** (review finding 3, decided 2026-11-11).
`visibleToAgents` in `packages/domain/src/gepa.ts` is the one rule, used wherever examples go to a
helper:
- the read tools (`get_examples`, `get_gold_labels`, `get_predictions`) leave held-out examples
  out and say so in a `note`; asking for one by id gives nothing;
- `get_report` and the report page view give mix-ups as counts only, since reports are scored on
  the held-out half;
- `try_template`, the label check, Improve with AI (its mistakes, mix-ups and wrong examples come
  from `scoreOnOptimiserHalf`) and the Optimiser read the optimiser half only.
Page views carry scores and counts only. Every preset's instructions (`common` and the
Optimiser's) say the held-out half is hidden and why, so a helper doesn't ask for it.

**The model's reason** (decided 2026-11-11). `apps/labeling` adds `REASON_LINE`
(`packages/domain/src/labels.ts`) as the last text part of every labeling prompt and of a try. It
is not part of the template. `parseOutput` reads the "reason" key into `Prediction.reason` (at most
300 characters), also when the answer is invalid. `answersForHelpers` gives the Optimiser and
Improve with AI each wrong example with `reason` and `invalid`, and leaves filtered answers out.
Exports read `answer` only. Answers saved before this have no reason.

**The Optimiser's pool** (decided 2026-11-11) is the start version, the run's kept versions and
every other version with a current report on the model, so a parent or a merge side can be a
version the user wrote or an earlier run made.

**The helpers' instructions** (rewritten 2026-11-11) are the shared rules in `common` plus one
text per helper in `apps/agents/src/presets.ts`. They say who does what (code runs the workflow,
helpers explain and propose, the user approves), what good labels and a good labeling prompt look
like, the Scores helper's six next steps, and what the Optimiser must avoid (rules that fit one
example, repeating a tried change). No helper judges a gold label. The report view carries
`scoredOn` and `confirmed` (the Optimiser's second labeling of the held-out half: true, false, or
null when there was none) for the Scores helper. The texts have not been tried on real models yet.

**The label check** (review finding 10). Dataset's AI Suggestion "Check the labels against your
data" sends the Labels helper 20 random examples (never the held-out half) with their gold labels
when they have one (`checkLabels`, intent `check_schema`). It answers in Ask AI, may put a schema
draft on Schema settings, and keeps answering on Dataset.

**Scores after gold edits** (acceptance R5-4, R5-5; lazy, Evelyn 2026-11-11). A gold edit changes
the evaluation context, so reports are archived; `ProjectState.scoresUpdating` says some must be
rebuilt. Gold Labels only writes (the Mismatches list updates in the page; "Scores out of date"
shows). The next reader of scores rebuilds them once from saved answers, nothing labeled:
`loadScoredState` (page views, helper read tools, the Optimiser) and the Prompt and Training Set
pages call `rebuildReports`. `tick` builds only a version's first report. Saved answers on the
whole eval set are kept in memory per version, since they never change once complete.

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

Three **start tools** spend money (`apps/bff/src/services/starts.ts`): `try_template` (prompt
agent: up to 5 eval examples with an unsaved draft, nothing saved), `score_version` and
`start_optimiser` (prompt and evaluation agents). They run at once, like every automatic start;
the user stops them from the page.

## Telemetry

One `TelemetryPort` from `apps/telemetry` goes to every app. Metrics are Prometheus style with
small label sets (model calls, limiter, labeling, catalog, agents, bff calls, gates, automatic
starts, page views and timings). Product events carry ids, counts and durations,
never content. The browser pushes both to `Platform.telemetry`; the stand-in keeps events in
`localStorage`. The audit log stays in the catalog.

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
