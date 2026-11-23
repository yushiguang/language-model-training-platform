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
                 └── @yushiguang/sprint-platform-impl (stand-ins, or a deployment's adapters)
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
also need is in `@yushiguang/sprint-workflow`, whose every method takes that context first. The workflow is a
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
| `labeling` | Tasks and answers through `LabelingStorePort`: collections `labeling_tasks`, `predictions` (`docLabelingStore`), or answers in object-storage segment files with `prediction_segments` pointers (`objectLabelingStore`, #72). Runs tasks | `LabelingContract` (`labeling-api.ts`) |
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
  The agent runtime is built once with `createAgentRuntime({llm, tools, progress})`: the model,
  the workflow's one tool host (`Workflow.toolHost`) and an `AgentProgressPort` for Ask AI's live
  line are injected, so `runTurn` and `reflectPrompt` take and return plain data (Improve with AI
  is a turn that runs a skill, #39). Each request carries the caller's `ctx`, and every tool call the runtime makes carries
  `projectId`, `turnId` (null outside an Ask AI turn) and that `ctx` (`AgentToolCall`), so a tool
  host in another process gets all it needs from the call (deployment readiness spec, 6). A turn's
  record (project, caller, page, language, browser record) is in shared state under `turn:{turnId}`
  while it runs; progress events are written to the chat and to the live line in shared state by
  whichever instance receives them, and the runtime answers a turn only after its last event
  landed. `sendUserMessage` returns `{turnId}` once the message is saved and the turn started; the
  turn runs on in the instance that accepted it (not as a job), and the page follows it with
  `getAgentLive` and the chat. A failed turn ends its live line and says so in the chat. Work is stopped by id: the
  caller passes a `requestId` and calls `cancel(requestId)` on the agent runtime (an Optimiser
  change), the gateway (`label`; a labeling run gives all its calls one id, so Stop cancels them
  together) or labeling (`tryTemplate`). Signals stay inside the process that owns the work.
  Platform ports (`ChatRequest`, `AgentChatOptions`) keep their `signal`: they are called
  in-process by the gateway and never cross our RPC, and without it a stopped call would keep its
  request to the model open.
- Example features are `FeatureValue {text?, items?}` (text, or a list such as image URLs), read
  with `featureText` and `featureItems` (`packages/domain/src/template.ts`). Files and older
  records with plain strings and arrays are read through `toFeatures`.

`apps/web/src/backend-api` has three files: `client.ts` (the `BffClient` interface pages use:
the contract plus live listeners, file uploads and page telemetry), `in-process.ts` (the default
client and composition root: every service runs in the page on `@yushiguang/sprint-platform-impl`) and
`index.ts` (takes the client from `@yushiguang/sprint-client-impl`). That alias is a build-time switch like
`@yushiguang/sprint-platform-impl`: the in-process client by default, or the module `SPRINT_CLIENT_IMPL`
names, such as an HTTP client for a server deployment, which bundles no backend app. No page
changes either way.

### One place for every tunable number

`SystemConfig` (`packages/contracts/src/config.ts`) holds every threshold, limit and estimate,
grouped by area; the defaults are `DEFAULT_SYSTEM_CONFIG` in `packages/domain/src/config.ts`.
Code reads `systemConfig()` at the time of use; it stays synchronous and pure. Values come in
three layers: the defaults, `Platform.config` (fixed overrides), and the configuration platform
(`Platform.configStore`, a `ConfigPort`), one string key per leaf such as
`labeling.maxFailedShare`. The config module (`@yushiguang/sprint-config`) reads the platform,
refreshes the process-level values every 30 s and applies them with `configureSystem`; when the
platform fails it keeps what it had. Tenant overrides are read explicitly, never through a
global: workflow services call `w.config.forTenant(w.ctx.tenantId)` and job executors
`ctl.config.forTenant(job.ctx.tenantId)`. Today only the job concurrency limits have tenant
keys (`TenantConfig.jobLimit`, lookup order in `docs/design/server.md`, 7). `Platform` also has
optional permission ports (`AuthorizationPort` asks whether a caller holds a permission point,
stand-in `allowAll`; `PermissionAdminPort` writes members, roles and project write grants,
stand-in `memoryPermissionAdmin`) and a job store (`JobStorePort`, stand-in `memoryJobStore`).
Every project carries its `tenantId`. The workflow checks the tenant and the permission point of
every call, agent tool, job and Optimiser step (`services/access.ts`, by `WORKFLOW_PERMISSIONS`).

### Background work is jobs (deployment readiness spec, 3)

Every piece of work that outlives a request is a job of `@yushiguang/sprint-jobs`: `labeling.runTask`
(executor in `@yushiguang/sprint-labeling`), `optimiser.run` (`@yushiguang/sprint-optimiser`), and `report.build`,
`dataset.sample` and `project.delete` (`@yushiguang/sprint-workflow`). The workflow decides what should run
and queues it with the caller's context; the job module runs it with a lease per job, heartbeats,
recovery of a dead runner's jobs, retries and cancel. A job holds ids only; the domain record
(the labeling task, the Optimiser run) keeps the state, so an executor resumes from it.

- **Commands return once queued.** `scoreVersion` returns the tasks it queued (each labeling job
  is followed by `report.build`), `startOptimiser` and `retryOptimiser` the run's id,
  `takeExamples` the work as the Dataset page shows it, `createDataSource` and `addSourceFile`
  the file (imported by a `source.ingest` job), and
  `deleteProject` returns once the project is marked `deleting`. Pages read progress back through
  `loadProjectState`, as they did while work ran.
- **Concurrency keys** (docs/design/server.md, 5). Every job names the resource it waits for:
  `model:<tenantId>:<endpointId>` (`labeling.runTask`, and `optimiser.run` while the Optimiser
  labels inside its job) or `compute:<tenantId>` (everything else), worked out by whoever queues
  it (`apps/workflow/src/services/queue.ts`). At most the key's limit
  (`config.forTenant(tenant).jobLimit(target)`: 1 per endpoint and 10 for compute by default) run
  at once across every runner; the store counts them at the claim. Keys take turns, so a long
  queue on one key never holds up another, and a key's jobs go oldest first. A runner's own cap
  (`concurrency`, 16) still applies. `jobs.api.ahead(jobId)` is a queued job's place; the page
  views (`loadProjectState`, `projectStatus`) carry it as `queue.ahead` on a waiting labeling
  task or Optimiser run, and Prompt Tuning shows "Queued · 2 ahead".
- **`then` and `finally`.** `then` is queued when a job ends done (a labeling task's report);
  `finally` when it ends in any way, done, failed or cancelled, also when the sweep fails it or a
  cancel ends it before it started. A labeling job and an Optimiser job each carry a `finally`
  `notify.send` job (`apps/workflow/src/services/notify.ts`): it reads how the task or run ended
  and tells the person who started it through `Platform.notifications` (finished or failed; a
  Stop sends nothing; work Sprint queued itself goes to the project's creator). Best effort: a
  failed send is counted, never fails anything.
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
- On a server the locks are shared too (#46): the composition passes one `leaseLocks` over
  `Platform.lockStore` to labeling, the workflow and the Optimiser in every unit, so two units
  never run the same task or Optimiser run, and a BFF unit's read never calls a worker's live task
  abandoned. Labeling also asks the job queue before reaping (`liveElsewhere`: a queued or running
  `labeling.runTask` job, or the project's `optimiser.run` job), so live job work is not falsified
  even by a unit whose locks cannot see the runner.

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

- **Registry.** The platform's default models are registered once (`Platform.endpoints`) and open
  to every tenant. Each tenant adds its own models (name, Endpoint, QPM, TPM) in tenant settings;
  the gateway reads them per tenant from the catalog's `tenant_models`, keeps them 30 s, and reads
  again at once for a model id it does not hold, so a new model works without a restart
  (docs/design/server.md, 9). Tenant admins manage them through the workflow (`listModels`,
  `addModel`, `updateModel`, `removeModel`, `setDefaultModel`); new projects use the tenant's
  default model, and a model a project uses cannot be removed. Chat (agents) and labeling use separate endpoints, so they never
  share a quota. Until the platform supplies registered endpoints, the gateway assumes
  conservative limits per model (`apps/llm-gateway/src/registry.ts`) and marks them `assumed`.
- **Limiter.** Per tenant and endpoint (key `<tenantId>:<endpointId>`): a 60-second sliding window for requests (QPM) and tokens (TPM), a cap
  on calls in flight, and a first-in first-out queue. A call waits until it fits; it is never sent
  over the limit. Tokens are estimated before the call (text / 4, 800 per image, plus the output
  cap) and corrected with the real usage after. Reasoning tokens count toward TPM. After a 429 the
  limiter halves its rate and recovers after a quiet window. The counts live in a
  `LimiterStorePort` (spec 5): with a shared store every replica of every caller shares one budget
  per tenant and endpoint; a busy reply slows down only the tenant that got it. A call's slot is leased and renewed while it runs, so a process that dies frees
  its slots when the lease ends; a waiter's place in the queue expires when it stops asking.
- **Models.** Chat models come from the registry the platform supplies (`AgentModel.models()`):
  opaque ids, capabilities, prices, an active flag. Requests may set a reasoning effort (dropped
  when the model does not list it), a response format, native tools (refused on a model without
  them) and a timeout per try (a late try is retried as timed out). Reasoning tokens are counted
  apart and billed at the output price.
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
createTask ──► runTask (lock "labeling:<task>"; a second runner anywhere gets null)
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
  Saving re-reads first, so an answer another runner saved while this call was in flight is the
  one document kept (that call is already paid; not paying at all is the prediction lock's job).
- **Resume.** A task runs as a `labeling.runTask` job; in the browser the open page is the
  runner. Closing the page stops the runner; the task stays `running` with no lock held anywhere
  and no live job behind it, and the next read reports it as `paused` with reason `closed` (on a
  server, a dead worker's task reaps once its lock lease ends). Scoring and optimiser tasks resume by
  themselves on the next page tick (which queues a new job). Retry failed clears the failed list
  and runs again.
- **Other tabs and units.** Writes are announced to other tabs of the site, and pages re-read every 5 s
  while something runs, so a second tab follows a run and sees it pause. Across server units the
  shared lock store does the same job (#46): one runner per task, and reads in any unit see it.
- **Workers.** A worker outside the browser is a job runner (`@yushiguang/sprint-jobs` with a shared
  `JobStorePort`), and several of them coordinate through the shared lock store above.

## The Optimiser and the helpers

Both have their own design docs, which hold the design and the as-built detail:

- [design/optimiser.md](design/optimiser.md): Auto Optimise (GEPA ported to TypeScript) and
  Improve with AI. Pure parts in `packages/domain/src/gepa.ts`, the loop in
  `apps/optimiser/src/optimiser.ts`.
- [design/helpers.md](design/helpers.md): the helpers in Ask AI (agent presets, page views, read
  and start tools, what they may never see). Presets and runtime in `apps/agents`, page views and
  tools in `apps/workflow/src/services/page-views.ts`.

### Where each agent guard lives (review P4)

The rules that protect data hold in the tool host (`agentToolHost` in
`apps/workflow/src/services/page-views.ts`), so they hold whatever runtime sends the call; the
runtime and the golden fixtures hold the rules about what a helper answers. The fixtures
(`apps/agents/fixtures/*.json`, format in its README) are plain JSON cases: request, model
replies, tool answers and the expected output. Any agent runtime is accepted against them, and
`apps/agents/src/fixtures.test.ts` replays them on the reference runtime.

The bff has golden fixtures of its own (`apps/bff/fixtures/*.json`, format in its README): a
small world (users and their tenants, items, item checks, the model's reply, stored records) and
a sequence of `BffContract` calls with the result each must give, generated ids and times
normalized. `apps/bff/src/fixtures.test.ts` replays them on the bff over the reference workflow.

| Guard | Where it is enforced |
|---|---|
| A helper calls only the tools its preset lists (`PRESET_TOOLS`, `mayCallTool` in `packages/domain/src/agent-guards.ts`) | Tool host (refuses); the runtime also offers each helper its own tools only |
| The project exists and is not being deleted | Tool host |
| A call for a turn runs as that turn's user and only on that turn's project; an ended turn lends no one | Tool host (`turnOf` in `services/turns.ts`) |
| No helper reads the held-out half (`visibleToAgents`); the first read of examples locks the halves | Tool host; the Ask AI workspace snapshot (`services/agents.ts`) for examples named in attachments, which it resolves from the project's own dataset only |
| Start tools start work at once and say so in the chat | Tool host (`services/starts.ts`) |
| A problem report is sent only after the user answered its draft | Tool host (`services/problems.ts`) |
| Proposals never save themselves: a draft is saved as a version only by the user | Workflow (`sendUserMessage` stores a proposal; no tool saves a version) |
| Reads for the agent abilities (#39) give counts and labels only; refused upload rows lose their item ids | Tool host (`services/agent-reads.ts`) |
| A helper runs only the skills its preset lists (`PRESET_SKILLS`); a skill's brief and tools go through the tool host | Runtime (`src/skills.ts`); tool host |
| Handoffs go only to known specialists with a known intent (`HANDOFF_TARGETS`) | Runtime; fixtures (`apps/agents/fixtures`) |
| Improve with AI and the Optimiser change wording only (`rewordOnly`) | Runtime and the Optimiser; fixtures |
| Nothing is carried over silently on prompt import (unmapped parts are listed) | Runtime; fixtures |
| An answer that is not JSON is retried once, then shown as plain text or a short apology | Runtime; fixtures |

## Scores, gold labels and what starts by itself

**Scores and Rescore** (Evelyn, 2026-11-12: worked out again by hand only; docs/design/server.md
4.3). A score rests on a basis (`ScoreBasis`, `packages/domain/src/scoring.ts`): the samples scored
on with their halves, their gold labels, and the thresholds, each a hash; `contextId` is all of it
with the label's schema version, and every report carries both. The samples are the eval samples
inside label sets and not removed, and scores are made only once every label set is finished (every
live sample in each range has a gold label). A project with no label set yet keeps the rule from before
label sets (scores on the samples with a gold label), until the label set pages ship. `ProjectState.scoring` (`ScoringState`) carries
that for the pages: whether scoring is ready, the ranges and counts, today's basis, the versions
whose scores are out of date (`staleVersionIds`, so Prompt Tuning shows the Rescore banner), what
changed (gold labels, samples or thresholds), and whether a Rescore is queued or running.

Nothing is worked out again by itself: gold edits, changed thresholds, new samples and new code all
move scores, and sensing each one is fragile. A report whose basis is not today's is `archivedNow`:
shown, never passing. A new report replaces the one on the same basis (`archived`, hidden); reports
on other bases stay, and an out-of-date one never hides a current one. One build per version and
model runs at a time (shared lock `report:<projectId>:<versionId>:<endpoint>`). Rescore (`rescore`)
queues one `report.rescore` job on the tenant's compute key, keyed by today's `contextId`, so a
second press adds nothing. One Rescore per project runs at a time (shared lock), and it goes again
if the basis moved while it ran. It gives every version of the current label on the project's
model, with saved answers for today's samples, a fresh report (nothing labeled); a version missing
answers is skipped and recorded in shared state for that basis, so no process lists it as out of
date again (scoring it again fills in the answers). The old in-request `rebuildReports` stays for
the current Prompt versions page, where Edit prompt, Improve with AI and Auto Optimise ask "Rebuild
scores first?" and the AI Suggestion reads each version's newest score (`withNewestReports`).
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
- *Adding.* Add examples takes more from one or more data sources (#29): ids already in the
  dataset (removed ones too) are skipped, and nothing there changes. Items with zero non-empty
  features are excluded and counted (`checks.noFeatures`, `featureMissingness.zeroFeatureExcluded`,
  #48); `featureMissingness` merges across appends (while legacy snapshots without it stay
  `undefined`). The evaluation context counts gold-labeled examples
  only, so an unlabeled example is *pending*: it is left out of scores, does not make them stale,
  and is counted on Eval Dataset and next to the score. Its gold label does make scores stale
  (Rebuild scores).
- *Removing.* Remove example on Gold Labels, Remove unlabeled and Downsample on Eval Dataset
  (`pickToPrune`: evenly from both halves) soft-delete examples (`Example.removed`). Each removal
  writes a `DatasetRemoval` with the half and gold label at the time, why, who and when; Restore
  puts the example back in its half. Removals and restores live-adjust `DatasetSnapshot.featureMissingness.byType`
  via batched by-id `featuresOf` reads (best-effort so stats failures never block removal or
  restore). The score line names how many gold-labeled examples were
  removed before the score was worked out.
- *Numbers.* Every example has a sample number (`Example.number`, from 1, in the order added,
  never changed; docs/design/server.md 4.2), and an explicit `removed`. Datasets made before
  numbers are numbered on first read (`DatasetSnapshot.numbered`). `listSamples` reads one page
  of live or removed samples in number order, filtered in the store (`CatalogContract.page`).
- *Label sets.* `LabelSet` records (`label_sets`): fixed, non-overlapping ranges of sample
  numbers, cut from the samples not yet in a set (one, or a batch by number of sets or samples
  per set) under the project's `label-sets` lock. Adding a labeler grants project write through
  `PermissionAdminPort` and sends `label_set_created` / `labeler_added`. A label signature change
  carries the gold labels that still answer the label to the new schema version
  (`goldLabelsCleared` counts the others for the confirm dialog).
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
Adapter steps: [integration.md](integration.md#problem-reports).

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

Frozen features (#32) live apart from the product records, behind `FeatureStorePort` (#72): with
object storage (`Platform.objectStore`), each batch of a take (`dataset.featureBatch`) is one
segment file of JSON lines, `features/<snapshotId>/<segment>.jsonl`, and each example record keeps
its line's byte range (`Example.featureRef`); a batch read takes one range per segment file.
Without object storage, and for examples saved before, they are one `example_features` document
per example, read by id only. Either way they are read a batch at a time
(`CatalogContract.exampleFeatures`) and deleted with their dataset's index. Project state
carries the examples' index and no features; the labeling run, Gold Labels, the helpers and the
Optimiser each read the features of the examples they use. `DatasetSnapshot` stores `featureSizes`
and exact integer `featureMissingness` counts (#48) over its live examples so estimates, pages and
helpers never scan `example_features`; `EvalReport.snapshotId` records which snapshot was scored.

## Where the rules live

| Rule | File |
|---|---|
| `{{Key}}` placeholders, checks and quick fixes; rendering to text and image parts | `packages/domain/src/template.ts` |
| Reading a model answer against the schema; settings hash; evaluation context id; token estimate | `packages/domain/src/labels.ts` |
| Metrics (macro-F1 of the label, shown as "Score" with the metric name in grey; per-value one-vs-rest F1, precision and recall, accuracy, invalid rate, mix-ups as gold/predicted pairs; invalid and filtered answers left out of the scores and counted apart) and pass/fail (always at most 1% invalid, `INVALID_CAP`) | `packages/domain/src/metrics.ts` |
| Versions are major.minor and never overwritten; the catalog assigns the numbers | `packages/domain/src/versions.ts`, `apps/catalog/src/catalog.ts` |
| Gates between steps; Gold Labels is an ordinary step (R5-8) | `packages/domain/src/gates.ts` |
| The recommended next step (the best score wins; cost only breaks a tie) | `packages/domain/src/workflow.ts` |
| Agent prompts and handoffs (to known specialists only) | `apps/agents/src/presets.ts`, `apps/agents/src/runtime.ts` |
| Tools per preset, start tools, handoff targets | `packages/domain/src/agent-guards.ts` |
| What an agent sees of each page (page views) and the read tools' implementation | `apps/workflow/src/services/page-views.ts` |
| No helper reads the held-out half (`visibleToAgents`) | `packages/domain/src/gepa.ts`, used in `page-views.ts`, `starts.ts`, `agents.ts` |
| When labeling starts, reports scored on the held-out half of the eval set | `apps/workflow/src/services/evaluation.ts`, `work.ts` |
| Optimiser: Pareto front, parent, merge pair, dry-run pick and comparison | `packages/domain/src/gepa.ts` |
| Confirming a pass (second labeling of the held-out half) | `confirmScore` in `apps/workflow/src/services/evaluation.ts` |
| Mismatches between saved answers and gold labels; keep or change | `apps/workflow/src/services/mismatches.ts` |
| Halves, label balance and which examples a prune removes | `packages/domain/src/dataset.ts` |
| Adding, removing, restoring and pruning examples; the holdout lock; comments | `apps/workflow/src/services/governance.ts` |
| Optimiser loop: rounds, retries, Failed and Retry, the end of a run after a confirmed pass | `apps/optimiser/src/optimiser.ts` |
| Improve with AI (a draft with marked changes, nothing labeled) | `improveWithAi` in `apps/workflow/src/services/agents.ts` starts the turn; the skill `improve_from_mistakes` in `apps/agents/src/skills.ts` |
| Helper skills and which helper runs which | `apps/agents/src/skills.ts`, `PRESET_SKILLS` in `packages/domain/src/agent-guards.ts` |
| The structured prompt: compiling to text, the label signature, wording-only changes | `packages/domain/src/structured.ts` |
| The fixed AI Suggestion cards on Prompt Tuning (T1 to T6) | `aiSuggestion` in `packages/domain/src/workflow.ts` |
| Project Settings (pass rule, labeling model) and their confirmation | `apps/workflow/src/services/settings.ts` |
| What starts without a click | `packages/domain/src/auto-start.ts`, `tick` in `apps/workflow/src/services/work.ts` |
| Agent start tools | `apps/workflow/src/services/starts.ts` |
| Metric and event names, labels and props | `packages/contracts/src/telemetry.ts` |

## Known limits of this version

- Services inside the workflow still pass records to each other (only the contracts are plain
  JSON).
- An Ask AI turn runs to its end in the instance that accepted it (it is not a job): if that
  instance stops, the turn is lost, and its live line clears when its time to live ends.
- In the browser build, jobs run in the open page and its job store is that tab's memory: closing
  the page drops what was queued there, and the next page tick queues due work again. The
  Optimiser loop holds a browser lock per project and model, so a second tab cannot run it twice.
- A job whose runner lost its lease (several runners only) is not stopped mid-step: with shared
  locks (`leaseLocks` over `Platform.lockStore`, #46), labeling's lock per task and the Optimiser's
  lock keep the runner that took it over off it until it ends; on per-process locks that holds only
  within one process. A runner frozen longer than its lock lease can still duplicate an in-flight
  model call (the fencing limit every lease here accepts); the saved-prediction re-check then keeps
  the store to one document, and the next run recounts from saved answers.
