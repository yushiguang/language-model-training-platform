# Integrating Sprint

Sprint runs end to end on stand-ins in this repository. To run it on your own platform, you
provide adapters for the platform ports in `packages/contracts/src/platform-api.ts` and compose
the modules, either in a server of your own (with the npm packages below) or in the static site
(with the build switches). Nothing in this repository needs to change; if something does, ask in
an issue (`CONTRIBUTING.md`).

## The npm packages

Every module except the agent runtime and the web site is published to GitHub Packages, all at one
version, by the `Release packages` workflow:

| Package | What it is |
|---|---|
| `@yushiguang/sprint-contracts` | Types and every service and platform contract |
| `@yushiguang/sprint-domain` | Pure rules |
| `@yushiguang/sprint-platform` | Stand-ins, `DocRepo`, `loopback` |
| `@yushiguang/sprint-llm-gateway` | `createGateway` |
| `@yushiguang/sprint-catalog` | `createCatalog` |
| `@yushiguang/sprint-labeling` | `createLabeling`, `labelingExecutor`, locks |
| `@yushiguang/sprint-optimiser` | `createOptimiser`, `optimiserExecutor` |
| `@yushiguang/sprint-jobs` | `createJobs` |
| `@yushiguang/sprint-workflow` | `createWorkflow`, `systemContext` |
| `@yushiguang/sprint-bff` | `createBffApi` |
| `@yushiguang/sprint-telemetry` | `createTelemetry` |

Each package is compiled JavaScript (ES modules) with type declarations, and depends on the exact
same version of the others it uses. To install, point the scope at GitHub Packages with a token
that can read packages (GitHub asks for one even for public packages), in your project's `.npmrc`:

```
@yushiguang:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The agent runtime is not published: implement `AgentRuntimeContract`
(`packages/contracts/src/agent-api.ts`) in any language, and hold it to the golden fixtures in
`apps/agents/fixtures/` (format in their README). `@yushiguang/sprint-agents` in this repository
is the reference implementation.

A bff written for another server (a Go service, say) is held to the golden BFF fixtures in
`apps/bff/fixtures/` (format in their README): sequences of `BffContract` calls over a small
world, with the result each call must give. `apps/bff/src/fixtures.test.ts` replays them on this
repository's bff and workflow.

A version's contract changes are listed in its pull requests (titles start with `Contract change:`).
Before 1.0.0 of the packages, a minor version may break a contract.

## Where the swap happens: `@yushiguang/sprint-platform-impl`

Only the composition root (`apps/web/src/backend-api/in-process.ts`) imports `@yushiguang/sprint-platform-impl`,
and only its `createPlatform(): Platform`. It resolves to:

- the stand-ins, `packages/platform/src/config.ts`, by default (`tsconfig.base.json` paths and
  `apps/web/next.config.mjs`);
- your module when the build sets `SPRINT_PLATFORM_IMPL` to its path, relative to the repo root,
  for example `SPRINT_PLATFORM_IMPL=local/platform.ts npm run build`. `/local/` is ignored by
  git, so your modules can sit there in a checkout.

Your module exports `createPlatform()` returning the `Platform` object from
`packages/contracts/src/platform-api.ts`:

| Field | What it must do | Stand-in |
|---|---|---|
| `db: DocRuntime` | Document collections: add, get, set, partial update with `DocFieldValue` (increment, arrayUnion, arrayRemove, delete), delete, find, query with filters and offset paging, polling subscribe, batch writes. `createdAt` is server time | `localDocRuntime('sprint-doc')` (`localStorage`) |
| `models: LabelingModels` | One labeling call per example (`chat`, `chatStream`) on a labeling endpoint (`endpoints()` lists them; ids are opaque strings, the stand-ins use `A` and `B`); returns text and token usage. Throw `LlmCallError` (or an error with an HTTP `status`) so the gateway can tell busy from rejected; throw `LlmCallError('filtered', …)` when the endpoint's safety filter stops the answer (Prompt versions shows it as Filtered) | `simulatedModels` |
| `agent: AgentModel` | Agent chat (`chat`, `complete` with usage and thinking, `chatStream`), and `models()`: the model registry (opaque ids, capabilities, prices, active flag; spec 5) | `scriptedAgent`, `STAND_IN_MODELS` |
| `identity: Identity` | The signed-in user (id, name, email, organization); `currentUser()` rejects when nobody is signed in, and the site then shows a sign-in error with Retry. Optional `signOut()` ends the single sign-on session: when it is there, the avatar menu shows Sign out and the page reloads after it (2026-11-16) | `localIdentity` (no sign-out) |
| `files: FileStore` | Uploads for prompt images and chat attachments; returns a URL the model can fetch. When stored URLs must be signed per call, the composition root passes labeling a `resolveUrl` that returns a Promise (next section) | `browserFiles` (data URLs) |
| `examples: ExampleSource` | An item's features by its id (`lookup`), and optionally the item ids of the sample data that every tenant gets as a built-in data source (`builtIn`) | `sampleExamples` |
| `media?: MediaSource` | The player page and still images of one example by item id, for people to look at on Gold Labels (see "Media") | `sampleMedia` (made-up pictures, no player) |
| `endpoints?: EndpointConfig[]` | Registered endpoints with real limits (next section) | not set: assumed limits |
| `telemetry?: TelemetrySink` | Takes product events (`pushEvents`, batches of `TelemetryEvent`) and metrics as Prometheus text (`pushMetrics`) and forwards them to your telemetry system. Must not throw; slow is fine (the app buffers) | `localTelemetrySink` (`localStorage`); not set: kept in memory only |
| `tickets?: TicketPort` | Files a problem report and returns its ticket id (see "Problem reports") | `localTickets` (`localStorage`, `sprint-tickets`); not set: helpers say reports cannot be sent |
| `sharedState?: SharedStatePort` | Short-lived keys every server instance must see, with a TTL (`get`, `set(key, value, ttlMs)`, `delete`; values are plain JSON): the live Ask AI turn, the helper that keeps answering on a page, the running turn's caller and page, problem-report drafts. A shared store such as Redis in a server deployment | `memorySharedState` (a map in the page); not set: the composition root uses the same |
| `limiterStore?: LimiterStorePort` | The gateway's rate-limit counts for every endpoint (`platform-api.ts`, spec 5), as whole atomic operations per endpoint: try to acquire (sliding QPM/TPM window, calls in flight, one FIFO queue of expiring tickets, hold after a busy reply), release, renew a permit's lease, leave the queue, penalize, stats. A Redis script per operation on one key per endpoint; prefer the store's own clock over the caller's `now` | `memoryLimiterStore` (memory of one process); not set: the composition root uses the same |
| `jobStore?: JobStorePort` | Where background jobs are kept (`packages/contracts/src/jobs-api.ts`), as whole atomic operations so several runners never take the same job: enqueue once per idempotency key among queued and running jobs, claim the next job with a lease (fair across tenants), heartbeat, finish, requeue, cancel, and recover expired leases. Redis (SET NX PX and a script per operation) or SQL with conditional updates | `memoryJobStore` (memory of one process); not set: the composition root uses the same |
| `lockStore?: LockStorePort` | Where named locks are kept (`platform-api.ts`), as whole atomic operations per lock name so one labeling task, one prediction and one Optimiser run have one runner in every process: acquire for an owner until its lease ends, renew and release only for that owner, `isHeld` only while a lease lasts. Redis (acquire as `SET NX PX`, the rest as a script per operation) or SQL with conditional updates; prefer the store's own clock over the caller's `now`. **Required for any deployment with more than one process** (BFF replicas plus a worker unit, a second worker unit): without it each process locks only for itself, a BFF replica reads a worker's running task as abandoned, and two runners can pay for the same example (issue #46). The composition root turns it into the apps' locks with `leaseLocks` (below) | `memoryLockStore` (memory of one process); not set: the composition root locks in one process (`browserLocks` / `memoryLocks`), right for the browser build and one server process |
| `standIns: string[]` | Names shown in the header while any stand-in is in use; empty in production | all |

## The page client: `@yushiguang/sprint-client-impl`

The pages call one `BffClient` (`apps/web/src/backend-api/client.ts`). `index.ts` takes it from
`@yushiguang/sprint-client-impl`, the second build-time switch next to `@yushiguang/sprint-platform-impl`:

- by default it is `apps/web/src/backend-api/in-process.ts`, where every service runs in the page;
- a server deployment sets `SPRINT_CLIENT_IMPL` to its own module, relative to the repo root (for
  example `SPRINT_CLIENT_IMPL=local/http-client.ts npm run build`). The module exports
  `client: BffClient`, usually an HTTP client of the server's bff. The in-process module is then
  never imported, so no backend app is bundled into the static site.

The boundary check allows only these two aliases in `next.config.mjs`, and refuses any file that
imports the in-process client directly instead of through the alias.

## Building the server's own composition

Each module's factory is its package's entry point (`exports` `"."`), so a server composition
imports it and wraps it without reaching into `src/` paths: `createGateway` (`@yushiguang/sprint-llm-gateway`),
`createCatalog` (`@yushiguang/sprint-catalog`), `createLabeling` with `memoryLocks` and `browserLocks`
(`@yushiguang/sprint-labeling`), `createAgentRuntime` (`@yushiguang/sprint-agents`), `createOptimiser`
(`@yushiguang/sprint-optimiser`), `createWorkflow` and `systemContext` (`@yushiguang/sprint-workflow`), `createBffApi`
(`@yushiguang/sprint-bff`), `createTelemetry` (`@yushiguang/sprint-telemetry`), and the stand-ins plus `loopback`
(`@yushiguang/sprint-platform`). `in-process.ts` is the worked example of wiring them.

`createLabeling`'s `resolveUrl` turns a stored image URL into one the model can fetch. It may
return a Promise, so a server can sign a URL per call; every image of a prompt is resolved at once
before the call.

Locks in a server composition: build one locks object per process and pass that same object as
`locks` to `createLabeling`, `createWorkflow` and `createOptimiser`, in the BFF units and the
worker unit alike — `leaseLocks(platform.lockStore)` from `@yushiguang/sprint-platform` when the
platform supplies a `lockStore`, else `browserLocks()` in the browser or `memoryLocks()` in a
single server process. Every process must lock over the **same** store: the BFF units only read
and enqueue, but their reads ask whether a task is running, so a lock store they cannot see makes
a live worker run look abandoned. One process-wide lock object matters inside a unit too: the
workflow's and the Optimiser's own lock checks (`isHeld`) only agree with labeling's runs when all
three share it.

## Endpoints and limits

The llm-gateway keeps every call under its endpoint's QPM and TPM, and retries busy, server and
timeout errors. It needs one `EndpointConfig` per registered endpoint:

- `purpose: 'labeling'` with `slot` set to the labeling endpoint's id (`EndpointId`, any string
  the registry uses), and `purpose: 'chat'` per agent model (`model` = its registry id). Chat and
  labeling never share an endpoint or a quota. The gateway registers these ids as the allowed
  values of the `endpoint`, `model` and `slot` telemetry labels at startup.
- Requests may carry `reasoningEffort`, `responseFormat` (text, one JSON object, or JSON to a
  schema) and `timeoutMs`; agent calls may also carry native `tools` (answers then hold
  `toolCalls`). Pass them on to the model service. Return `reasoningTokens` apart from
  `outputTokens`: they count toward TPM and are billed at the output price, so cost is never
  estimated from characters. The gateway drops a reasoning effort the model's registry entry does
  not list, refuses tools on a model without them, and retries a try that runs past `timeoutMs` as
  timed out even if the service ignores the abort.
- `qpm`, `tpm`: the registered limits. TPM counts input, output and reasoning tokens.
- `maxConcurrency`: our own cap on calls in flight (start with 8 for reasoning models).
- `assumed: false`.

Anything not supplied falls back to the assumed defaults in `apps/llm-gateway/src/registry.ts`
(shown as assumed). Still to confirm on the platform: the real QPM/TPM per endpoint, whether busy
replies carry `Retry-After`, and that uploaded image URLs are reachable by the labeling models.

## Examples

Which items a project uses comes from the tenant's data sources (#29): files of item ids that
people upload on the Data Source page. The example service only looks an item's features up by
its id (`ExampleSource.lookup`); an id it does not know is counted, not added. The stand-in looks
items up in a prepared file in the format of `apps/web/public/sample-data/examples.json`, whose
items are also every tenant's built-in "Sample data" source (`builtIn`). Upload such a file to the
file store and build with `NEXT_PUBLIC_EXAMPLES_URL` set to its URL. Real examples never go in
this repo.

Since 1.0.0 each feature on a `RawExample` is a `FeatureValue` (`packages/contracts/src/types.ts`):
`{text}` for text features and `{items}` for lists such as image URLs, never a plain string. An
`ExampleSource` adapter that still returns plain strings can wrap them with `toFeatures` from
`@yushiguang/sprint-domain`; prompts read features only through `featureText` and `featureItems`.

Since #32 the features are fetched once when items are taken and frozen in the document store,
one `example_features` document per example (id `snapshotId:externalId`), read only by id in
batches. A server store wants:

- the documents in their own collection, sharded by the id hash; no query scans it;
- `ExampleSource.check(ids)` (optional) giving each item's kind or why it cannot be used
  (`missing`, `minor_creator`, `not_recommendable`); without it, an id `lookup` does not return
  counts as not found;
- fields above `dataset.overflowFieldBytes` moved to object storage by the document adapter, the
  document keeping the object's URI, with signed URLs made at the moment of use and never stored.
  Run `node scripts/feature-size-report.mjs sample.jsonl` over a real sample to set the threshold
  (it prints the median, p90, p99 and the share above it).

Since 2026-11-16 a project has one label, single or multi select (`Schema {name, kind, min?, max?,
values}`, a value may be `exclusive`), and an answer is a list of its values in label order
(`Answer = string[]`, one value long for single select). Bundled labels and gold upload files may
give the answer as `"Practical"`, `["Practical", "Food"]` or `{"primary_value": ...}` with either;
`readGoldAnswer` reads all of them and checks the label's bounds. The stand-in
store keeps documents under the `sprint-doc` prefix and drops the older `tsp-doc` and `tsp-doc-v2` keys, so
projects made before this change start fresh (they were test data).

## Media

`MediaSource` (`packages/contracts/src/platform-api.ts`) feeds the player and still images on
Gold Labels. Playback is an embedded player page, never a direct video file:

1. Implement `media(externalId, type)` in your platform module: return an `ExampleMedia` with a
   `playerUrl` the Gold Labels page loads in an iframe (the item's official embed player, or a
   fallback viewer when the item is no longer publicly playable — the adapter may probe
   availability first), a `coverUrl`, still `imageUrls` (key frames, or a photo-and-text post's
   images) and `durationSec` when known, and an `externalUrl` where a person can open the item in
   a new tab (Gold Labels shows "Open item" with it, for when the site will not embed); return
   `null` when the item has no media. The iframe sends `referrerPolicy="strict-origin"` and
   allows `autoplay; encrypted-media; picture-in-picture; fullscreen`. Set `media`
   on the `Platform` object and drop `'media'` from `standIns`.
2. If the real interface needs more than this (signed URLs that expire, several renditions,
   access checks), ask for a contract change (next section) instead of working around the type.
3. `exampleMedia(exampleId)` in `apps/web/src/backend-api` returns what the source gives; the
   Gold Labels page embeds `playerUrl` and shows the still images under it.

Media is for people only. The labeling models receive image features through the prompt
template, and the URLs there must be reachable by the models (see "Endpoints and limits").

## Feature descriptions

`FeatureInfoSource` (`packages/contracts/src/platform-api.ts`) says what each feature holds. The
Optimiser and the Prompt helper read it with the `read_feature_info` tool before they tick or
untick a feature, and the prompt editor shows it on hover over a feature name.

1. Implement `describe(keys)` in your platform module: for each feature key (the placeholder name,
   for example `OCR_Text`) return a `FeatureInfo` with a one-line `description` of what the
   feature holds, and optionally `goodFor` (when it helps labeling) and `caveats` (often empty,
   cut, noisy, costly as an image). Leave out keys with no description.
2. Set `featureInfo` on the `Platform` object and drop `'feature descriptions'` from `standIns`.
   The stand-in (`packages/platform/src/standins/feature-info.ts`) has made-up descriptions for
   every catalogue key.

## Document links

`DocumentSource` (`packages/contracts/src/platform-api.ts`) lets the helpers read a document the
user links in Ask AI (for example a labeling guide). They call the `read_doc` tool with the link;
the workflow passes it to `Platform.documents` with the request context of the Ask AI turn
(`ctx.user` is the person the helper answers) and cuts the text at 20,000 characters. The stand-in
(`packages/platform/src/standins/documents.ts`) opens nothing, and the helper asks for the text.

1. Implement `read(ctx, url)` in your platform module: for a link to your document
   service, return a `LinkedDocument` with its `title` and its `text` (plain text or Markdown;
   tables as text), read as `ctx.user` (never as a service account) so a person never sees a
   document they can't open. Return
   `null` for a link it can't read (another host, no access, deleted).
2. Set `documents` on the `Platform` object and drop `'document links'` from `standIns`.
3. Images in a document are not read in this version; say so in the text if they matter.

## Problem reports

Any helper can call `report_problem` when the user says something is wrong (spec 1.1.0, 3). The
helper drafts first and shows the user what it would send; code refuses to send until the user
has written again, so a report never goes without a yes. The workflow then builds a
`TicketSubmission` (`packages/contracts/src/platform-api.ts`) and calls `Platform.tickets.submit`:

- the user's account of it (summary, expected, actual, steps), the reporter (the user whose Ask AI
  turn it is, from that turn's request context), the language and the helper that filed it;
- where: app version, project, page and its ids, the steps approved, the settings in short;
- `diagnostics: ClientDiagnostics`: the browser's rolling record (path, browser, viewport, time
  zone, the last 10 pages, failed backend calls with their call ids, script errors), sent with
  each Ask AI message and kept for that turn only;
- the last Ask AI action lines;
- `content`: the compiled prompt of the version in question, only when the user agreed; never
  examples or gold labels.

1. Implement `submit(ticket)` in your platform module: file the ticket wherever developers pick
   work up, and return `{ticketId}` (any short string the user can quote).
2. Set `tickets` on the `Platform` object and drop `'problem reports'` from `standIns`.
3. Once the bff runs behind HTTP, send each call's id (`callId()` in
   `apps/web/src/backend-api/diagnostics.ts`) as the `X-Request-Id` header and log it on the
   server, so a ticket's failed calls lead straight to the server logs.

## Languages

The site speaks English and Chinese (spec 1.1.0, 2). Texts are looked up by their English words
in `packages/domain/src/locales/<language>.ts`; texts the services make travel as `Msg`
(`{key, params}`) next to their English text, and helpers get the user's language as
`AgentTurnInput.locale`. Nothing here needs an adapter. To add a language, add a catalog file, list
it in `packages/domain/src/i18n.ts`, and run `npm test` (a test fails on any text the catalog
lacks).

## Asking for a contract change

A contract is any type or interface in `packages/contracts`. Changing one can break a deployment's
adapters, so:

1. Open an issue titled `Contract change: <what>`, saying which interface changes, why, and
   whether the change is additive (new optional field or method) or breaking.
2. Additive changes merge once the stand-ins and tests are updated.
3. A breaking change says in its pull request what every adapter must do, and merges when the
   maintainers agree; it ships in the next released version.

## Moving a service behind HTTP later

Each app already sits behind a contract. To move one out, implement its contract as an HTTP
client and pass that to the composition root instead of the in-process app; callers do not change.

The workflow is ready for this first: `WorkflowContract` (`packages/contracts/src/workflow-api.ts`)
takes the caller's `RequestContext` first on every method, and one call crosses as
`RpcRequest {method, ctx, args}` and comes back as `RpcResponse` (`{result}` or
`{error: {code, message}}`). In the browser the bff already calls it through `loopback`
(`packages/platform/src/standins/loopback.ts`), which puts every call through JSON the same way,
so a server only has to carry those envelopes. The browser then calls the server through the
module behind `@yushiguang/sprint-client-impl` (above). Give the server's workflow a shared
`Platform.sharedState`, so every instance sees the same live turn and drafts.

Background work is jobs (`docs/architecture.md`, "Background work is jobs"). A server deployment:

- builds one `createJobs({store})` per process over a shared `JobStorePort` (`Platform.jobStore`),
  passes its `api` to `createWorkflow({jobs})`, and sets `tickFromPages: false`;
- in the worker unit only: registers the executors (`labelingExecutor(labeling)`,
  `optimiserExecutor(optimiser)`, and `workflow.executors`) with `runOnEnqueue: false`, and calls
  `jobs.poll(ms)`; the bff units only enqueue;
- runs a cron job that calls `jobs.sweep()` (expired leases back to the queue) and
  `workflow.sweep()` (due work for every project), as the pages' tick does in the browser.

A browser talking to a server polls `projectStatus(projectId)` (no examples or reports in it) and
calls `loadProjectState` again only when its `revision` is not the one it holds, or listens on the
`changes` event where the server streams it. Revisions live in `Platform.sharedState`, so it must
be shared by every bff and worker unit.

An Ask AI turn runs in the instance that accepted it; its record and live progress are in
`Platform.sharedState` (`turn:{turnId}`, `live:{projectId}`), so any instance can serve the page's
reads and the turn's tool calls. A remote agent runtime calls the workflow's tool host
(`Workflow.toolHost`) with each call's project, turn and caller, and publishes progress to
`Workflow.agentProgress`.

## Verify

```bash
npm ci
npm run check        # typecheck, unit tests, boundary check
npm run build        # static site in apps/web/out/
node apps/web/scripts/e2e-check.cjs http://localhost:4173   # with apps/web/out served on :4173
```
