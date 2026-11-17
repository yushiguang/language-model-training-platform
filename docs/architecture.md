# Architecture

Since 1.0.0 a prompt tuning project has four steps: Prompt Design → Eval Dataset → Gold Labels →
Prompt Tuning. Its output is a prompt that passes the project's checks, copied from the last step.
The pass rule and the labeling model are Project Settings, not steps. A batch labeling project
(which produces labeled data with a finished prompt) has its contracts designed and no screens yet.
It is a fixed-workflow website with agents built into each step.
Code decides the next step; agents explain and propose, people approve.

## Ten apps, three packages

```
apps/web ──► apps/web/src/backend-api (the BffClient the pages call; in-process.ts is the composition root)
                 │ builds and wires:
                 ├── apps/bff (what pages call: builds each call's RequestContext)
                 │     └──► apps/workflow (WorkflowContract, through a JSON loopback in-process)
                 │            ├──► catalog      (product records)
                 │            ├──► labeling     (tasks, predictions) ──► llm-gateway
                 │            ├──► agents       (presets, runtime)   ──► llm-gateway
                 │            ├──► optimiser    (Auto Optimise runs) ──► catalog, labeling, agents
                 │            ├──► jobs         (JobsContract: the workflow queues work, reads it back)
                 │            └──► llm-gateway  (endpoint list, agent model)
                 ├── jobs (runs the queued work: executors of labeling, optimiser and workflow)
                 ├── telemetry (one port, given to every app above) ──► the platform's sink
                 └── @sprint/platform-impl (stand-ins, or the internal adapters)
                       document store · labeling models · agent model · identity · files · examples · shared state · telemetry sink

All apps depend only on packages/contracts (types, contracts) and packages/domain (pure rules).
catalog and labeling also use packages/platform for DocRepo over the document store.
```

Apps never import each other. The workflow receives the other apps as contract objects through
`createWorkflow()` and `connect()`; the bff receives the workflow and the identity through
`createBffApi()`; labeling receives the catalog and the gateway through `createLabeling()`. The
composition root is the only place that knows which implementation sits behind each contract.

**A thin bff, a stateless workflow (deployment readiness spec, 2).** The bff only finds out who
the caller is, builds a `RequestContext` per call (request id, user, caller, language, time zone,
app version) and keeps a repeated start from running twice. Everything a CLI or tool channel would
also need is in `@sprint/workflow`, whose every method takes that context first. The workflow is a
factory with no module-level state: who acts comes from the context of each call, never from a
process-wide user, and short-lived state every instance must see (the live turn, the helper that
answers, the running turn's context, problem-report drafts) sits behind `SharedStatePort` with a
TTL (`Platform.sharedState`; the stand-in is a map in the page). In the browser the bff calls the
workflow through `loopback` (`packages/platform`): context, arguments, results and errors go
through JSON as they would over RPC, so the browser check proves the workflow can move behind RPC
without the bff or the pages changing.

| App | Owns | Contract |
|---|---|---|
| `llm-gateway` | Endpoint registry; one limiter per endpoint; per-call retries; token and cost accounting | `LlmGatewayContract` (`gateway-api.ts`) |
| `labeling` | Collections `labeling_tasks`, `predictions`. Runs tasks | `LabelingContract` (`labeling-api.ts`) |
| `catalog` | All product collections (`CatalogRecords` in `catalog-api.ts`). Assigns version numbers | `CatalogContract` |
| `agents` | Agent presets and the turn/handoff logic. Stateless | `AgentRuntimeContract` (`agent-api.ts`) |
| `optimiser` | The Auto Optimise loop and the `optimisation_runs` records. Asks the workflow (through `OptimiserHost`) to save a version, label examples and build a score | `OptimiserContract` (`optimiser-api.ts`) |
| `jobs` | Nothing stored itself: jobs live in the injected `JobStorePort`. Runs background work with a lease per job, heartbeats, recovery, retries and cancel; each kind's work is an executor of the app that owns it | `JobsContract` (`jobs-api.ts`) |
| `workflow` | Nothing stored. Project state, gates, when labeling starts, reports, dataset governance, Ask AI turns, page views and agent tools | `WorkflowContract` (`workflow-api.ts`) |
| `bff` | Nothing stored, no business decision. The caller's context per call, idempotency keys | `BffContract` (`bff-api.ts`) |
| `telemetry` | Metrics (Prometheus style, `sprint_*`) and product events; sends them to `Platform.telemetry` | `TelemetryPort` (`telemetry.ts`) |
| `web` | Pages and components | calls `@/backend-api` (`BffClient`) |

### Contracts are ready for an interface definition language

Since 1.0.0 phase 1 every service contract is written so it maps one to one to an RPC interface
(spec 1.0.0, section 7):

- Arguments and results are plain JSON: records and arrays, never `Map`, `Set`, `File` or a
  function. `ProjectState.gold` and a version's saved answers are records by example id.
- A call passes ids and the user's input, never a record the caller holds. Starts take one
  request struct (`ScoreVersionRequest`, `CreateVersionRequest`, `StartOptimiserRequest`, ...)
  with an optional `idempotencyKey`: the same key never starts the same work twice.
- Live updates are not methods: a client listens on an `EventStreamPort` (in-process the
  services' bus, over HTTP Server-Sent Events or polling).
- **Revisions (review G9).** Every change to a project gives it a new revision, kept in shared
  state so every replica sees it (`emitChange(projectId)`; labeling and the Optimiser report their
  writes with the project). It is a fresh random id, not a count: shared state has no atomic
  increment, so two replicas counting at once could write the same number and hide a change.
  Writes to one project within 200 ms give one revision (a labeling run does not write it per
  example); a read in the same instance writes a waiting one first. `ProjectState.revision` is read
  before the rest of the state. `projectStatus(projectId)` is the light read a remote client polls:
  the revision, sampling, labeling runs with their counts and Optimiser runs without their rounds,
  never examples, gold labels or reports; it reads the whole state again only when the revision
  moved.
- `apps/bff/src/api.ts` (`createBffApi`) is the bff as its contract, and
  `apps/workflow/src/workflow.ts` (`createWorkflow`) the workflow as its own. Services inside the
  workflow still pass records to each other.
- No callbacks or signals cross a service contract (phase 3, and deployment readiness spec 4.1).
  The agent runtime is built once with `createAgentRuntime({llm, tools, progress})`: the model, a
  project's tools and an `AgentProgressPort` for Ask AI's live line are injected, so `runTurn`,
  `reflectPrompt` and `draftImprovement` take and return plain data. Work is stopped by id: the
  caller passes a `requestId` and calls `cancel(requestId)` on the agent runtime (an Optimiser
  change), the gateway (`label`; a labeling run gives all its calls one id, so Stop cancels them
  together) or labeling (`tryTemplate`). Signals stay inside the process that owns the work.
  Platform ports (`ChatRequest`, `AgentChatOptions`) keep their `signal`: they are called
  in-process by the gateway and never cross our RPC, and without it a stopped call would keep its
  request to the model open. `ExampleSource.sample` keeps its progress callback and signal too:
  only the `dataset.sample` job's executor calls it, in the process that runs the job.
- Example features are `FeatureValue {text?, items?}` (text, or a list such as image URLs), read
  with `featureText` and `featureItems` (`packages/domain/src/template.ts`). Files and older
  records with plain strings and arrays are read through `toFeatures`.

`apps/web/src/backend-api` has three files: `client.ts` (the `BffClient` interface pages use:
the contract plus live listeners, file uploads and page telemetry), `in-process.ts` (the default
client and composition root: every service runs in the page on `@sprint/platform-impl`) and
`index.ts` (takes the client from `@sprint/client-impl`). That alias is a build-time switch like
`@sprint/platform-impl`: the in-process client by default, or the module `SPRINT_CLIENT_IMPL`
names, such as an HTTP client for a server deployment, which bundles no backend app. No page
changes either way.

### One place for every tunable number

`SystemConfig` (`packages/contracts/src/config.ts`) holds every threshold, limit and estimate,
grouped by area; the defaults are `DEFAULT_SYSTEM_CONFIG` in `packages/domain/src/config.ts`.
Code reads `systemConfig()` at the time of use. A hosting adapter overrides any value through
`Platform.config`, merged over the defaults at startup. `Platform` also has optional ports for
per-tenant configuration and permission checks (`RequestContext`, `TenantConfigPort`,
`AuthorizationPort`), with single-tenant stand-ins, and a job store (`JobStorePort`, stand-in
`memoryJobStore`).

### Background work is jobs (deployment readiness spec, 3)

Every piece of work that outlives a request is a job of `@sprint/jobs`: `labeling.runTask`
(executor in `@sprint/labeling`), `optimiser.run` (`@sprint/optimiser`), and `report.build`,
`dataset.sample` and `project.delete` (`@sprint/workflow`). The workflow decides what should run
and queues it with the caller's context; the job module runs it with a lease per job, heartbeats,
recovery of a dead runner's jobs, retries and cancel. A job holds ids only; the domain record
(the labeling task, the Optimiser run) keeps the state, so an executor resumes from it.

- **Commands return once queued.** `scoreVersion` returns the tasks it queued (each labeling job
  is followed by `report.build`), `startOptimiser` and `retryOptimiser` the run's id,
  `startSampleDataset` and `appendSample` the sampling as the Dataset page shows it, and
  `deleteProject` returns once the project is marked `deleting`. Pages read progress back through
  `loadProjectState`, as they did while work ran.
- **Keys.** While a job with the same idempotency key is queued or running, queueing it again
  returns it (`label:<task>`, `report:<version>:<model>`, `optimiser:<project>`,
  `delete:<project>`), so the page tick, a click and a helper's start tool never start work twice.
- **Sampling** progress is the job's stored progress (`ProjectState.samplingTask` is projected
  from it). Loading an uploaded file's features stays inside its request, with its progress and
  Stop in shared state (`loading:{projectId}`).
- **Deleting a project** hides it from every read at once (`Project.deleting`); the
  `project.delete` job cancels the project's other jobs and removes its records in batches
  (`DocRepo.deleteWhere`), never one awaited request per record.
- **Who drives.** In the browser the open page's `tick` queues due work (it never runs work in the
  request). A server sets `tickFromPages: false`, and a cron job calls `workflow.sweep()` (queue
  due work for every project) and the job module's `sweep()` (recover expired leases).
- In the browser the job store is this tab's memory (`memoryJobStore`) and the tab runs its own
  jobs as soon as they are queued, so every flow behaves as before; labeling and the Optimiser keep
  their browser locks, so two tabs never run the same task or run.

## The structured prompt (1.0.0)

A prompt version stores a `StructuredPrompt`: the persona and task (`taskSummary`), the input
features, the project's one label (`label`: a key, single or multi select (`kind`, with `min` and
`max` for multi), and its values, each with a definition, a value optionally `exclusive`; the
model answers a list of values, one for single select) and the rule groups (`ruleGroups`: a title and free-text rules each, named by the
user; they replace the per-field tie-break notes and the one general-rules box). Rules about one
value belong in that value's definition; rule groups hold rules across values. This is the only thing people and
helpers edit. The text sent to the model is compiled from it by `compilePrompt`
(`packages/domain/src/structured.ts`) in XML-tagged sections (`<persona_and_task>`,
`<input_features>`, `<output_labels>`, `<rules>`, `<reference_images>`, `<output_format>`), which
give the model clear boundaries so text inside an item's features cannot pass for an instruction;
the same input always gives the same text. "View full prompt" shows that text read-only with a
Copy button. A new project starts with no feature ticked. A prompt saved before rule groups reads
as one ("General rules", and "<field> rules" per old note) through `normalizeStructured`, and a
prompt saved with several fields reads its first field as the label.

- **Label signature.** The label key and its value names are the label signature (`signatureOf`).
  New wording never changes it; adding, removing or renaming the key or a value does. When it
  changes, the version starts a new schema version: gold labels need a re-check and earlier scores
  no longer count. The editor says so before the save. The Optimiser and Improve with AI may only
  reword (`rewordOnly`), so they never change the signature.
- **Import.** A prompt pasted into Ask AI is sorted into the structured parts. Passages with no
  place (few-shot examples, an output format) are returned word for word as `unmapped` and listed
  on the page under "Not carried over", so nothing is dropped silently.
- **Project Settings.** A new project starts from defaults (`DEFAULT_THRESHOLDS`, the first
  labeling endpoint). The Settings button opens the dialog at any time, and it opens once by itself
  before the first paid run (`settingsConfirmed`). `dueStarts` starts nothing until the settings
  are confirmed and the dataset can be scored (`canScore`: enough examples and gold labels in both
  halves).
- **Deleting a project** asks for its exact name, then removes its records in every collection.

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
examples and stores one prediction per example. The workflow creates tasks for four reasons: scoring a
new version on the eval set (system), the Optimiser's dry runs, eval-set labeling and the second
labeling that confirms a pass (system). All of
them start by themselves (below).

**Automatic paid starts.** Every task starts by itself, with no cost limit and no approval
(decided 2026-11-06: the exact cost of a task can't be predicted, the platform is there to make
training faster, and every running task has a Stop button). This covers scoring a new version,
resuming scoring after a closed page, and the agents' start tools. The Optimiser is the one
exception: it starts only on the user's Auto Optimise (or an agent's start tool after the user asks
in Ask AI), never from `tick` (decided 2026-11-09). `dueStarts`
(`packages/domain/src/auto-start.ts`) says what the workflow would start, and `tick` starts all
of it. Every automatic start
writes an `auto_start` audit record.

Automatic spend is counted per labeling run, not per task: a run started by code adds its cost to
the task's `autoCostUsd`, so an automatic resume of a task the user started counts too, and so do
the optimiser's own labeling runs. try_prompt saves no task, so it writes an `auto_spend` audit
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
- **Resume.** A task runs as a `labeling.runTask` job; in the browser the open page is the
  runner. Closing the page stops the runner; the task stays `running` with no lock held, and the
  next read reports it as `paused` with reason `closed`. Scoring and optimiser tasks resume by
  themselves on the next page tick (which queues a new job). Retry failed clears the failed list
  and runs again.
- **Other tabs.** Writes are announced to other tabs of the site, and pages re-read every 5 s
  while something runs, so a second tab follows a run and sees it pause.
- **Later:** several runners sharing one task, and shared quota records across runners. A worker
  outside the browser is a job runner (`@sprint/jobs` with a shared `JobStorePort`).

## The Optimiser and the helpers

Both have their own design docs, which hold the design and the as-built detail:

- [design/optimiser.md](design/optimiser.md): Auto Optimise (GEPA ported to TypeScript) and
  Improve with AI. Pure parts in `packages/domain/src/gepa.ts`, the loop in
  `apps/optimiser/src/optimiser.ts`.
- [design/helpers.md](design/helpers.md): the helpers in Ask AI (agent presets, page views, read
  and start tools, what they may never see). Presets and runtime in `apps/agents`, page views and
  tools in `apps/workflow/src/services/page-views.ts`.

## Scores, gold labels and what starts by itself

**Rebuild scores** (Evelyn, 2026-11-12: by hand only). A gold edit changes the evaluation context,
so reports are archived and `ProjectState.scoresUpdating` is set ("Scores out of date" on Gold
Labels and Prompt Tuning). Nothing rebuilds by itself: gold edits, changed settings and new code all
move scores, and sensing each one is fragile. The button is on only while scores are out of date,
and while they are, Edit prompt, Improve with AI and Auto Optimise ask "Rebuild scores first?";
the AI Suggestion reads each version's newest score (`withNewestReports`). The button calls
`rebuildReports`, which gives every version of the current schema with a finished scoring a fresh
report from saved answers (nothing labeled); a report it replaces is marked `archived` and hidden.
`tick` builds only a version's first report. Saved answers on the whole eval set are kept in memory
per version for the Mismatches list.

**Auto-start manager** (2026-11-11). `dueStarts(state)` says what should be running; `tick` starts
it. The project provider (`apps/web/src/components/ProjectContext.tsx`) runs `tick` on every
change event and on a 60 s sweep, on every project page. `tick` only queues jobs; starts are keyed
(job idempotency keys, `once()` while a task is created, and the labeling app's lock per task), so
extra runs are safe. Every auto task also has a button that
sends the same start (Score/Resume, Optimiser Resume/Retry). In a microservice
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
optimiser-half examples to the Optimiser and Improve with AI. Since 1.0.0 the "Why" is a
`LabelComment` (below), and the helpers get every comment on an optimiser-half example as
`ExampleBrief.comments`. A change saves a new gold label, so the evaluation context changes
and reports are rebuilt from saved answers: nothing is labeled again
(`apps/workflow/src/services/mismatches.ts`). Prompt Tuning' AI Suggestion points to the tab right
after the first score (before any review or Optimiser run) and when Auto Optimise ends without a
pass; never while the Optimiser runs or after a pass. Helpers give the counts only, never which
side is right.

**The eval dataset changes (1.0.0, spec 4).** `apps/workflow/src/services/governance.ts`:

- *Halves.* `assignEvalHalves` (`packages/domain/src/dataset.ts`) puts gold-labeled examples in
  the two halves by their rarest value, so a rare value lands in both. The workflow balances the halves
  when Gold Labels is left (`approveNode('gold')`) and once more just before a helper or the
  Optimiser first reads examples (`lockHoldout`: the read tools that return examples, `try_prompt`,
  Improve with AI, Auto Optimise). From then on `Project.holdoutLocked` is set and no example ever
  changes half; an added example is placed in the half that keeps the two even.
- *Adding.* Add from file and Add sampled append to the dataset: ids already in it (removed ones
  too) are skipped, and nothing there changes. The evaluation context counts gold-labeled examples
  only, so an unlabeled example is *pending*: it is left out of scores, does not make them stale,
  and is counted on Eval Dataset and next to the score. Its gold label does make scores stale
  (Rebuild scores).
- *Removing.* Remove example on Gold Labels, Remove unlabeled and Downsample on Eval Dataset
  (`pickToPrune`: evenly from both halves) soft-delete examples (`Example.removed`). Each removal
  writes a `DatasetRemoval` with the half and gold label at the time, why, who and when; Restore
  puts the example back in its half. The score line names how many gold-labeled examples were
  removed before the score was worked out.
- *Comments.* `LabelComment` records (`label_comments`), append-only, from Save on either Gold
  Labels tab; a comment on Mismatches keeps the version. Helpers read comments on optimiser-half
  examples only.
- *Rough reading.* Below `thresholds.minEval` gold-labeled eval examples a score never passes
  (`judge` returns `rough`); the Finish gate stays closed.

## Telemetry

One `TelemetryPort` from `apps/telemetry` goes to every app. Metrics are Prometheus style with
small label sets (model calls, limiter, labeling, catalog, agents, bff calls, gates, automatic
starts, page views and timings). Product events carry ids, counts and durations,
never content. The browser pushes both to `Platform.telemetry`; the stand-in keeps events in
`localStorage`. The audit log stays in the catalog. Conventions and the rules for changing the
catalogue: [design/telemetry.md](design/telemetry.md).

## Languages (1.1.0)

English is the source language: every UI text is its own key, and `t()` (`apps/web/src/i18n.tsx`)
looks it up in the chosen catalog (`packages/domain/src/locales/`). Texts the services and the
domain make (action lines, the AI Suggestion card, the Optimiser's now line, gate and check lines,
reasons a prompt cannot be saved, a helper's live line) carry a `Msg` with their English text, so
the page can show them in the user's language while helpers and logs read English. Helpers answer
in the user's language (`AgentTurnInput.locale` adds one line to their system prompt, with the
site's own Chinese words). The choice lives in the browser (`sprint-locale`); the static export is
built in English and switches after the first paint. A test lists every key the source uses and
fails on any the Chinese catalog lacks.

## Problem reports (1.1.0)

`report_problem` is a tool of every helper (not of the Optimiser). It drafts, shows the user the
draft, and sends only after the user writes again, which code enforces. The ticket goes to
`Platform.tickets` with the page, the browser's rolling record (`ClientDiagnostics`, sent with
each Ask AI message and never stored), the last action lines and, only with consent, the prompt.
Adapter steps: [handover/integration.md](handover/integration.md#problem-reports).

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
| Metrics (macro-F1 of the label, shown as "Score" with the metric name in grey; per-value one-vs-rest F1, precision and recall, accuracy, invalid rate, mix-ups as gold/predicted pairs; invalid and filtered answers left out of the scores and counted apart) and pass/fail (always at most 1% invalid, `INVALID_CAP`) | `packages/domain/src/metrics.ts` |
| Versions are major.minor and never overwritten; the catalog assigns the numbers | `packages/domain/src/versions.ts`, `apps/catalog/src/catalog.ts` |
| Gates between steps; Gold Labels is an ordinary step (R5-8) | `packages/domain/src/gates.ts` |
| The recommended next step (the best score wins; cost only breaks a tie) | `packages/domain/src/workflow.ts` |
| Agent prompts, handoffs (to known specialists only), read tools per preset | `apps/agents/src/presets.ts`, `apps/agents/src/runtime.ts` |
| What an agent sees of each page (page views) and the read tools' implementation | `apps/workflow/src/services/page-views.ts` |
| No helper reads the held-out half (`visibleToAgents`) | `packages/domain/src/gepa.ts`, used in `page-views.ts`, `starts.ts`, `agents.ts` |
| When labeling starts, reports scored on the held-out half of the eval set | `apps/workflow/src/services/evaluation.ts`, `work.ts` |
| Optimiser: Pareto front, parent, merge pair, dry-run pick and comparison | `packages/domain/src/gepa.ts` |
| Confirming a pass (second labeling of the held-out half) | `confirmScore` in `apps/workflow/src/services/evaluation.ts` |
| Mismatches between saved answers and gold labels; keep or change | `apps/workflow/src/services/mismatches.ts` |
| Halves, label balance and which examples a prune removes | `packages/domain/src/dataset.ts` |
| Adding, removing, restoring and pruning examples; the holdout lock; comments | `apps/workflow/src/services/governance.ts` |
| Optimiser loop: rounds, retries, Failed and Retry, the end of a run after a confirmed pass | `apps/optimiser/src/optimiser.ts` |
| Improve with AI (a draft with marked changes, nothing labeled) | `improveWithAi` in `apps/workflow/src/services/agents.ts` |
| The structured prompt: compiling to text, the label signature, wording-only changes | `packages/domain/src/structured.ts` |
| The fixed AI Suggestion cards on Prompt Tuning (T1 to T6) | `aiSuggestion` in `packages/domain/src/workflow.ts` |
| Project Settings (pass rule, labeling model) and their confirmation | `apps/workflow/src/services/settings.ts` |
| What starts without a click | `packages/domain/src/auto-start.ts`, `tick` in `apps/workflow/src/services/work.ts` |
| Agent start tools | `apps/workflow/src/services/starts.ts` |
| Metric and event names, labels and props | `packages/contracts/src/telemetry.ts` |

## Known limits of this version

- Services inside the workflow still pass records to each other (only the contracts are plain
  JSON).
- The progress handlers of running Ask AI turns stay in the memory of the workflow instance that
  started the turn, until the agent service (spec 6) takes them over.
- In the browser build, jobs run in the open page and its job store is that tab's memory: closing
  the page drops what was queued there, and the next page tick queues due work again. The
  Optimiser loop holds a browser lock per project and model, so a second tab cannot run it twice.
- A job whose runner lost its lease (several runners only) is not stopped mid-step: labeling's lock
  per task and the Optimiser's lock keep the runner that took it over off it until it ends.
