# Specification: Service Deployment Readiness: Dual Topology, a Thin BFF, and a Generic Job Module

**Target:** Post-`1.1.0` foundation work. No product behaviour change: every user-visible flow,
default, and text stays exactly as it is. This spec prepares the codebase so the same modules can
run in the browser (as today) or as server-side services behind RPC, without callers changing.
**Date:** 2026-11-17
**Contract Impact:** Mixed. Section 2 is internal refactoring with no contract change. Sections 3
and 4 add new contracts and clean non-serialisable types out of existing ones; each is its own
`Contract change:` pull request, listed per item as additive or breaking. Section 5 changes the
model registry types and is **breaking**.

Decided with the owner on 2026-11-17:

- **Two topologies, one module set.** This repository keeps the capability contracts, every module
  implementation, the in-process composition, and all tests and browser checks. A second,
  server-side composition (RPC clients and servers, framework bootstraps, infrastructure adapters)
  is maintained outside this repository and only ever calls the modules in this one. Nothing about
  deployment enters this repository.
- **Calls follow deployment boundaries, not module boundaries.** Modules are libraries; a service
  is a deployment unit. Inside one unit, modules call each other directly in-process. Across units
  they call through the same contract implemented as an RPC client. The composition root chooses
  per dependency, so a module can move out later without its callers changing.
- **The BFF becomes a thin channel adapter.** All business logic leaves `apps/bff` for a separate
  application module (Section 2). What a different front end (a web page, a future CLI or tool
  channel) would not need is all the BFF keeps. The application module is built as a stateless
  factory, and its contract carries the caller's request context from the first version
  (Section 2), so a multi-user server never has to re-sign every method later.
- **One generic job module runs all background work** (Section 3): labeling, scoring, sampling,
  the optimiser, and future batch work are executors registered with it, not separate ad-hoc
  runners. Commands that start work create their domain record, enqueue a job, and return;
  progress is read back, never awaited inside a request (Section 3).
- **Model calls stay behind the existing gateway contract**, with rate-limit state moved out of
  process memory so several replicas share one QPM/TPM budget (Section 5).
- **Streaming is deferred.** Agent turns are request/response first; live progress is polled.
  The streaming ports stay in the contracts so streaming can be added later without a contract
  change.
- **The agent runtime may be reimplemented by the hosting platform** in another language against
  the same contract. This repository keeps the reference implementation, the prompts, the tool
  definitions, the guard rules, and the golden fixtures that any implementation must pass
  (Section 6).

## 1. Where the code stands

- Every app already sits behind a contract in `packages/contracts`, and apps never import each
  other. The composition root (`apps/web/src/backend-api/in-process.ts`) is the only place that
  knows which implementation sits behind each contract. This spec generalises that root; it does
  not introduce a new pattern.
- Three kinds of process-local coupling would change behaviour if a module moved behind RPC
  today, and Section 4 removes them: the in-process change bus (`onChange`/`emitChange`), the
  browser lock used for labeling and optimiser runs, and `AbortSignal` values inside contracts.
  The idempotency cache in `apps/bff/src/api.ts` is a process-local `Map`; a server deployment
  needs it in shared storage (adapter concern, no contract change).
- The application services also keep process-global mutable state that a multi-user,
  multi-replica server cannot have: a module-level singleton with the first signed-in user
  cached for the life of the process (`configureBff`), and in-memory maps for the running
  agent turn's live state, the sticky answering helper, problem-report drafts, per-turn
  diagnostics, and in-flight sampling. Section 2 makes the application module stateless and
  moves that short-lived state into shared storage with a TTL.
- Several commands on `BffContract` currently resolve only when the whole batch of work
  finishes (scoring awaits every labeling call; starting the optimiser awaits every round).
  Behind an HTTP gateway these time out, so Section 3 changes them to enqueue-and-return.
- `apps/bff/src/services/` holds most of the application logic today (project state, workflow
  decisions, evaluation, governance, agent orchestration). The BFF package also holds the thin
  adapter (`createBffApi`). Section 2 separates the two.
- Background work is started three different ways today: labeling tasks and the optimiser run
  under browser locks in the open page, and dataset sampling is an in-memory object in the BFF
  that is lost when the page closes. Section 3 unifies them.
- The enterprise ports in `Platform` (`TenantConfigPort`, `AuthorizationPort`, `JobQueuePort`)
  are defined but never called. Sections 3 and 7 put the job port to work; tenant and permission
  wiring stays adapter-side for now.

## 2. A thin BFF and a separate application module (no contract change)

Move the business logic out of `apps/bff` into a new application module, `@sprint/workflow`
(the agent-facing half may be split out as `@sprint/assistant` if the module grows too large):

| Today (`apps/bff/src/services/`) | Moves to |
|---|---|
| `projects.ts`, `work.ts` (project state, `dueStarts`, automatic starts) | `@sprint/workflow` |
| `evaluation.ts`, `prompts.ts`, `settings.ts` (scoring triggers, reports, version creation, settings) | `@sprint/workflow` |
| `governance.ts`, `mismatches.ts`, `dataset.ts` (dataset governance, gold review, sampling and upload use cases) | `@sprint/workflow` (sampling execution goes to the job module, Section 3) |
| `agents.ts`, `page-views.ts`, `starts.ts`, `problems.ts` (turn orchestration, page views, agent tools, proposals, problem reports) | `@sprint/workflow` / `@sprint/assistant` |

Rules after the move:

- The BFF keeps: identity and request-context injection, request/response mapping, error
  mapping, upload signing, live-update forwarding, and per-call telemetry. It holds no records
  (as today) and makes no business decision: gates, `dueStarts`, scoring rules, and prompt
  signature checks all live in `@sprint/domain`, `@sprint/workflow`, or the owning service.
- `@sprint/workflow` is a factory (`createWorkflow(deps)`), like every other app in this
  repository. It holds **no module-level mutable state**: the configured-dependencies singleton
  and the cached signed-in user in today's `configureBff` are removed, and identity is read per
  call from the request context below. Short-lived per-turn state that lives in process memory
  today (the running turn's live view, the sticky answering helper, problem-report drafts,
  per-turn client diagnostics) moves behind a small shared-state port with TTL expiry;
  `@sprint/platform` provides an in-memory stand-in. Sampling state moves to the job module
  (Section 3).
- `@sprint/workflow` gets its own capability contract (`WorkflowContract`) so it can be deployed
  next to the BFF or behind RPC later. Defining it is a contract change (additive: a new file in
  `packages/contracts`). **Every workflow method takes `ctx: RequestContext` from the first
  version** (the type already exists in `platform-api.ts`): a server is multi-user from day
  one, and adding the parameter later would re-sign every method and its RPC mapping. Tenant
  and permission *enforcement* is still deferred (Section 7); carrying the context is not.
- Apart from the command semantics of Section 3, `BffContract` keeps its surface, so pages do
  not change.
- Test for whether logic belongs in `@sprint/workflow` or stays in the BFF: if a CLI or tool channel
  would need the same behaviour, it is workflow; if only the web pages need it, it is BFF.
  Permission checks are workflow (every channel must enforce them); the BFF only authenticates
  (who the caller is, which tenant).
- Existing tests move with the code (`apps/bff/src/services/bff.test.ts` becomes the workflow
  tests), and gain cases for two users acting in one process without seeing each other's
  identity, drafts, or live turn state. `npm run check` and the browser check must pass
  unchanged after every step; this section lands as a series of small moves, one service file
  group at a time — but the factory, context, and shared-state changes above are part of it,
  not optional follow-ups.

## 3. A generic job module for all background work

**Contract change (additive):** promote the platform's `JobQueuePort` sketch into a real job
contract in `packages/contracts` (a `jobs` section): a job has a `kind`, plain JSON arguments
(ids, never records), an optional `idempotencyKey` (the same key never enqueues the same work
twice), and a lifecycle (`queued`, `running`, `paused`, `failed`, `done`, `cancelled`) with
progress, heartbeat, and cancel. The module that runs jobs owns: the queue, leases (one runner
per job, with expiry), heartbeats, timeout recovery, retries, cancellation flags, and fair
scheduling across tenants. It understands no business rules. Its durable store is injected at
construction (a queue/store port in the job contract), so the module itself imports contracts
and domain only, like the other apps.

Domain work registers as executors, one per kind, implemented by the owning app:

| Job kind | Executor owner | Replaces |
|---|---|---|
| `labeling.runTask` | `@sprint/labeling` | the browser-locked runner in the open page |
| `report.build` | `@sprint/workflow` | report building piggybacked on page ticks |
| `dataset.sample` | `@sprint/workflow` | the in-memory sampling task in the BFF (lost on page close) |
| `optimiser.run` | `@sprint/optimiser` | the browser-locked optimiser loop |
| `project.delete` | `@sprint/catalog` with `@sprint/labeling` | deleting a project's records one document at a time inside a request |
| `batch_labeling.run`, `export.run` | future apps | reserved kinds, no code yet |

Rules:

- **Commands enqueue and return (breaking contract change).** `scoreVersion`, `startOptimiser`,
  `retryOptimiser`, `startSampleDataset`, and `appendSample` on `BffContract` stop awaiting the
  work: they create the domain record (task, run, snapshot), enqueue the job, and resolve with
  what was created. Progress and results are read back through `loadProjectState` and the event
  stream, as the pages already do while work runs. This lands with the job module, before any
  server deployment, so the semantics never depend on which topology is live.
- **Sampling state is persisted.** `ProjectState.samplingTask` is projected from the
  `dataset.sample` job's stored progress (state, fetched count, failure), never from a
  process-local map, so progress stays visible whichever process executes the job.
- **Deletion is bulk and asynchronous.** The catalog and labeling layers gain a bulk delete
  (many records per call, batched by the store) and `deleteProject` becomes accept-and-enqueue:
  the request stops running work and returns; the `project.delete` job removes the records.
  Deleting a project with a full set of saved predictions must not iterate one document per
  awaited call inside a request.

- Domain state stays with the domain: a labeling job points at its `LabelingTask` record (failed
  lists, counters), an optimiser job at its run record. The job record is only the execution
  lease and lifecycle around them.
- A job executor must be resumable from saved records at any point (labeling already is: counters
  are rebuilt from saved predictions). Starting a job that is already running returns the
  existing job; cancelling sets a flag the executor polls, the same shape as `stopRequested`
  on labeling tasks today.
- The server-side workflow driver replaces the page `tick`: writes enqueue due work directly,
  and a periodic sweep recovers expired leases and builds reports nobody built. Both paths use
  the same idempotency keys, so running both is safe. Every automatic start still writes its
  `auto_start` audit record.
- In this repository the job module runs in-process (an in-memory queue is a valid adapter for
  tests and the browser build); the hosting platform supplies the durable queue. The in-browser
  behaviour of every flow is unchanged.

## 4. Contracts that survive RPC (contract changes, per item)

Each item is its own `Contract change:` pull request.

1. **No signals or callbacks across contracts (breaking, internal).** Remove `signal` from
   `TryTemplateInput` (`labeling-api.ts`), from the platform model requests
   (`ChatRequest`, `AgentChatOptions` in `platform-api.ts`), from `LabelCallRequest`
   (`gateway-api.ts`), and from `OptimiserReflectInput` (`agent-api.ts`). Replace
   `ExampleSource.sample(n, onProgress, signal)`'s progress callback and signal: sampling runs
   as a `dataset.sample` job (Section 3) and reports progress through the job record; callers
   that still sample directly get the final result only. Cancellation is expressed as data:
   a caller passes a `requestId` when it starts cancellable work and calls the existing
   `cancel(requestId)` to stop it (the agent runtime already works this way; labeling and the
   optimiser get the same treatment). Construction-time injected ports (for example
   `AgentProgressPort`, injected once when the runtime is built) are not per-call callbacks and
   stay; a server implementation backs them with shared storage (Section 6).
2. **Locks behind the existing port (no contract change).** `LockPort` already abstracts the
   browser lock. Every module that takes a lock takes it through the injected port; the hosting
   platform supplies a distributed lease implementation. The browser implementation stays the
   default in this repository.
3. **Events stay data-free (no contract change).** `EventStreamPort` already carries no payload;
   listeners re-read through the contract. A server deployment may back it with polling or a
   message channel; the browser bus stays as is. Agent live progress (`AgentLive`) is read by
   polling `getAgentLive` until streaming is scheduled (Section 7).
4. **Package entry points (no contract change).** Each app package exposes stable subpath exports
   for its factory functions, so an external composition can import a module and wrap it without
   reaching into `src/` paths. The web app gains a build-time switch for the `BffClient`
   implementation module, mirroring the existing platform-implementation switch, defaulting to
   the in-process client. Landing this requires updating the boundary checker in the same PR:
   `scripts/check-boundaries.mjs` hard-codes the single allowed config alias today, so the new
   client-implementation alias joins its alias table and the web config's allowed alias list,
   and `apps/web/src/backend-api/index.ts` must import the client through that alias (never a
   static import of the in-process module), or a server build would still bundle every backend
   app into the static site.
5. **Async URL resolution in labeling (no contract change).** `LabelingDeps.resolveUrl` is
   synchronous today. Stored file URLs may need a signed URL generated per call, which is
   asynchronous work, so the type widens to `(url: string) => string | Promise<string>` and
   its two call sites await it.
6. **Contract conformance fixtures (no contract change).** The golden fixtures used by the agent
   and BFF tests (fixed inputs, expected messages, proposals, and tool-call sequences) are kept
   in a form an implementation in any language can consume (plain JSON in, plain JSON out), so
   the hosting platform's implementations can be verified against the same cases this
   repository's tests use.

## 5. Model registry and the gateway (breaking contract change)

- **Model ids stop being a closed enum.** `LlmModelId` and `AVAILABLE_LLM_MODELS`
  (`platform-api.ts`) are replaced by a registry the hosting platform supplies: each entry has
  an opaque model id, a display name, capability flags (vision input, tool calling, reasoning
  effort levels, context length), per-million-token prices, and an active flag. Agent presets
  name the model they want by registry id; an unknown or inactive id falls back as the gateway
  does today. This is breaking: the enum type and the constant are removed.
- **Endpoint ids stop being a two-value union in the same change.** `EndpointId = 'A' | 'B'`
  (`types.ts`, and the platform labeling request's endpoint field) widens to `string`: a
  registered endpoint's id is whatever the registry says. The stand-ins keep registering `A`
  and `B`, so pages and saved records are untouched. The telemetry catalogue's hard-coded
  slot label values (`['A', 'B']`) are removed with it; the gateway registers the registry's
  own ids as the allowed label values at startup, as it already does for endpoint and model.
  Doing this later would repeat the same breaking change across every contract that names a
  slot.
- **Requests gain the fields real model services need (additive on top of the breaking change):**
  a reasoning effort level, native tool definitions as an alternative to the current
  JSON-in-the-answer tool protocol, a response-format constraint, and a per-call timeout.
  Results gain a reasoning-token count next to input and output tokens, so cost accounting never
  has to estimate from characters.
- **The gateway's limiter state moves to shared storage, behind a new platform port.** The
  per-endpoint sliding window (QPM, TPM, in-flight cap, FIFO queue, slow-down after a busy
  reply) keeps its exact semantics but is implemented over a shared atomic store, so every
  replica of every caller shares one budget per endpoint. The port (working name
  `LimiterStorePort`, on `Platform` next to the other optional ports) offers the atomic
  operations the limiter needs; `@sprint/platform` provides the in-memory implementation the
  gateway uses by default, so `apps/llm-gateway` still imports contracts and domain only.
  In-flight slots are leased with an expiry: a process that dies without releasing must not
  leak its slots and wedge the endpoint. Concurrency tests run several limiter instances
  against one store and assert the endpoint's QPM/TPM is never exceeded in aggregate.
- **Two model roles stay separate**, as today: labeling endpoints (slots chosen in Project
  Settings) and chat endpoints (agent presets) never share a quota. A fast, narrow model may be
  registered for mechanical sub-tasks (pre-filtering, high-confidence routing) only after it
  passes the same gold-set evaluation as the main models; no agent preset may be pointed at one
  by default. Which physical models sit behind the registry is the hosting platform's decision
  and never appears in this repository beyond the public model names already in use.

## 6. The agent runtime as a reference implementation

- `AgentRuntimeContract` is already framework-neutral (plain JSON in and out, tools and progress
  injected at construction, cancellation by request id). It stays the single definition of what
  an agent runtime does; this repository's `@sprint/agents` remains the reference implementation
  used by every test and the browser check.
- The prompts (`presets.ts`), the tool definitions (names, argument schemas, what a tool may
  return, per-preset permissions), and the guard rules in `@sprint/domain` (no held-out examples to
  any helper, wording-only optimiser changes, nothing carried over silently on prompt import,
  handoffs only to known specialists, proposals never save themselves) are the specification any
  other implementation must satisfy. The golden fixtures of Section 4.5 are its acceptance test.
- Tool implementations split by what they touch, and the split is by contract, not by deployment:
  tools that read project data run as part of `@sprint/workflow`/`@sprint/assistant` behind the same
  permission and held-out rules as the pages; tools that read outside documents or file tickets
  stay behind the existing `DocumentSource` and `TicketPort` platform ports. An agent runtime,
  wherever it runs, only ever sees `AgentToolHost` and those ports.
- **Tool calls carry their execution context explicitly (contract change, additive).** Today a
  tool host is built per project by closure (`tools(projectId)`), so the project, the turn, and
  the caller are ambient. `AgentToolCall` gains `projectId`, `turnId`, and `ctx: RequestContext`:
  a tool implementation in another process must receive everything it needs to check
  permissions, enforce the held-out rule, and write its audit record from the call itself.
  Per-turn data the tools rely on (the page the user is on, their language, the client
  diagnostics a problem report attaches) is stored against the `turnId` in the shared-state
  port of Section 2 when the turn begins — never reconstructed from another process's memory.
- **Live progress has a write-back path.** While streaming is deferred (Section 7), the pages
  poll `getAgentLive`. The progress a runtime publishes through `AgentProgressPort` must land
  in that same shared state, keyed by project and turn, whichever process the runtime runs in,
  so a polled read sees the turn advance exactly as it does in-process today.

## 7. What does not change, and what is explicitly deferred

- **No product behaviour changes.** Pages, flows, defaults, texts, gates, and the stand-in data
  are untouched. `npm run check`, `npm run build`, and the browser check pass exactly as before
  each step, and the whole product remains acceptable end-to-end in a local browser before any
  server deployment exists.
- **Deferred: streaming agent replies.** Turns return complete replies; progress is polled.
  The ports (`AgentProgressPort`, streaming model calls) stay in the contracts unused by the
  default path. Streaming is scheduled as its own experience change once the server deployment
  is stable, and needs no contract change when it comes.
- **Deferred: tenant and permission enforcement — but not the context itself.** Every workflow
  and tool call carries `RequestContext` from the first server-ready version (Sections 2 and
  6); what is deferred is *enforcing* tenancy and permissions on it. Wiring `TenantConfigPort`
  and `AuthorizationPort` into those checks is the hosting platform's deployment work,
  sequenced after the topology stands up, and by then it changes checks, not signatures. The
  one requirement this spec adds now: permission checks live in `@sprint/workflow` (Section 2),
  never only in the BFF, so no future channel can bypass them.
- **Scale work owned before real datasets arrive.** `loadProjectState` reads whole collections
  today; at a few thousand examples a single response is several megabytes and the pages poll
  it every few seconds while work runs. Before server deployments meet datasets of that size,
  the BFF gains a light status read (counts and task states only, no example bodies) for
  polling, and example bodies are read paged. This is scheduled with the job module (Section 3),
  and the bulk deletion there is part of the same item.
- **Deferred: the example source.** `ExampleSource` remains the seam for prepared examples; how
  real examples are sampled and delivered is specified separately and does not affect the
  modules in this spec beyond the `dataset.sample` executor's payload.
- **Out of scope:** the batch labeling project's screens and services (contracts already reserve
  the project kind), student-model training, and any change to how scores are computed.

## 8. Delivery order

1. Section 2 (thin BFF, `@sprint/workflow`): moves plus the factory, per-call request context,
   and shared short-lived state. No contract change except the additive `WorkflowContract`
   (with `RequestContext` from the start). Proof: full check suite and browser check unchanged,
   plus two-users-one-process tests.
   **Status (2026-11-17): built** on branch `refactor/workflow-module`. `createWorkflow(deps)`
   with no module-level state; every `WorkflowContract` method takes `ctx: RequestContext`
   (fields: request id, user, tenant, locale, time zone, caller, deadline, app version, trace
   parent); `SharedStatePort` (`Platform.sharedState`, stand-in `memorySharedState`) holds the
   live turn, the sticky helper, the running turn's context and problem-report drafts; the bff
   builds the context per call and keeps the idempotency cache in its closure. The web
   composition root calls the workflow through a JSON `loopback`, so the browser check runs the
   RPC-shaped path. Sampling and turn progress handlers stay instance-local until items 3 and 5.
   Events stay data-free; the client reads the live turn again on `agent_live`. `BffClient`
   lost its unused synchronous `answeringAgent` (pages never called it; `getAnsweringAgent`
   stays).
2. Section 4 items 1–5 (serialisable contracts, package entry points and the boundary-checker
   update, async URL resolution): each its own contract-change PR. Proof: a serialization
   round-trip test over every contract type, and `check:boundaries` passing with the new
   client alias in place.
   **Status (2026-11-17): item 1 built** on branch `refactor/no-signals-in-contracts`.
   `LabelCallRequest`, `TryTemplateInput` and `OptimiserReflectInput` carry no signal; callers
   pass a `requestId` and call `cancel(requestId)` on the gateway, labeling or the agent runtime.
   Platform ports keep `signal` (review gap G6). `ExampleSource.sample` keeps its progress
   callback and signal until sampling runs as a job (Section 3), so the Dataset page keeps its
   progress meanwhile.
   **Review gap G3 built (2026-11-17)** on branch `feat/caller-documents`:
   `DocumentSource.read(ctx, url)` reads a linked document as the person the helper answers.
   Gap G4 (`createUpload`) is not built: no page uploads a binary file today (chat takes text
   and document links, decided 2026-11-06; datasets and gold labels go as text), so there is
   nothing for it to serve yet. It comes back with the first page that uploads an image.
   **Items 4 and 5 built (2026-11-17)** on branch `build/client-switch-and-entry-points`:
   `@sprint/client-impl` (set by `SPRINT_CLIENT_IMPL`, default the in-process client) in the web
   tsconfig, `next.config.mjs` and the boundary checker, which also refuses a direct import of
   the in-process module; every app's factory is its package entry point (they already were,
   now listed in the handover guide); `LabelingDeps.resolveUrl` may return a Promise and both
   call sites await it. Items 2, 3 and 6 need no code now (2: the lease port comes with the job
   module; 3: events already carry no data; 6: the fixtures come with the Go agent runtime).
3. Section 3 (job module, enqueue-and-return commands, persisted sampling state, bulk
   asynchronous deletion, the light status read of Section 7): additive job contract plus the
   breaking command-semantics change. Proof: job lifecycle tests (lease expiry, resume, cancel,
   idempotent enqueue) plus the existing labeling and optimiser tests running through the job
   module in-process.
   **Status (2026-11-17): the job module built** on branch `feat/job-module`: `jobs-api.ts`
   (`JobsContract`, `JobExecutor`, `JobStorePort` with whole atomic operations, review P1; it
   replaces the unused `JobQueuePort` sketch, now `Platform.jobStore`), `@sprint/jobs`
   (`createJobs`: leases, heartbeats, the sweep, retries, cancel, chains, fair order across
   tenants) and `memoryJobStore` in `@sprint/platform`, with lifecycle tests. The job record's
   status type is `JobStatus`, since `JobState` already names a run's state on the pages.
4. Section 5 (model registry, endpoint id widening, limiter store port): breaking contract
   change, coordinated with the hosting platform's adapters per the handover guide. Proof:
   gateway tests over the shared-store limiter (concurrent instances never exceed an endpoint's
   QPM/TPM, and a dead instance's in-flight slots expire), and the registry fallback tests.
5. Section 6 fixtures and tool context: golden agent fixtures published as data, `AgentToolCall`
   carrying its context. Proof: the reference implementation passes them; they are the
   acceptance bar for any reimplementation.

## 9. Verification

- `npm run check:boundaries` — the new modules obey the same import table (`@sprint/workflow` and
  the job module may import contracts and domain only, and receive storage and queues through
  injected ports; the BFF keeps importing contracts and domain only, receiving everything else
  through configuration). The checker itself is updated in Section 4.4 to allow the
  client-implementation alias next to the platform-implementation one.
- `npm run typecheck` and `npm test` — zero errors; the moved workflow tests and the new job
  tests included.
- `npm run build` — static export unchanged in behaviour.
- `node apps/web/scripts/e2e-check.cjs` against the served build — the four-step flow passes
  exactly as before, proving the dual topology's local half is intact.
