# Handover: connecting the hosting platform

This repo is public and runs end to end on stand-ins. The internal build swaps the stand-ins for
adapters over the hosting platform's runtimes, without changing any file in this repo. This guide
says who changes what, where the swap happens, what each adapter must do, and how to ask for a
contract change.

Keep this repo free of internal product names, internal URLs, package scopes, keys and tokens.

## Who changes what

| | External agents (this repo) | Internal agent (overlay outside this repo) |
|---|---|---|
| Apps, packages, pages, tests | yes | through a pull request here, like anyone |
| Contracts (`packages/contracts`) | yes, as a marked contract change | requests changes (below) |
| Stand-ins (`packages/platform/src/standins`) | yes | no |
| Adapters over the platform runtimes | no | yes |
| Registered endpoints with real QPM/TPM | no (only assumed defaults) | yes |
| Build settings, deployment | documents them | yes |

## Where the swap happens: `@sprint/platform-impl`

Only the composition root (`apps/web/src/backend-api/in-process.ts`) imports `@sprint/platform-impl`,
and only its `createPlatform(): Platform`. It resolves to:

- the stand-ins, `packages/platform/src/config.ts`, by default (`tsconfig.base.json` paths and
  `apps/web/next.config.mjs`);
- the internal module when the build sets `SPRINT_PLATFORM_IMPL` to its path, relative to the repo
  root, for example `SPRINT_PLATFORM_IMPL=internal/platform.ts npm run build`. `/internal/` is
  ignored by git, so the overlay can sit there.

The internal module exports `createPlatform()` returning the `Platform` object from
`packages/contracts/src/platform-api.ts`:

| Field | What it must do | Stand-in |
|---|---|---|
| `db: DocRuntime` | Document collections: add, get, set, partial update with `DocFieldValue` (increment, arrayUnion, arrayRemove, delete), delete, find, query with filters and offset paging, polling subscribe, batch writes. `createdAt` is server time | `localDocRuntime('sprint-doc')` (`localStorage`) |
| `models: LabelingModels` | One labeling call per example (`chat`, `chatStream`) on a labeling endpoint (`endpoints()` lists them; ids are opaque strings, the stand-ins use `A` and `B`); returns text and token usage. Throw `LlmCallError` (or an error with an HTTP `status`) so the gateway can tell busy from rejected; throw `LlmCallError('filtered', …)` when the endpoint's safety filter stops the answer (Prompt versions shows it as Filtered) | `simulatedModels` |
| `agent: AgentModel` | Agent chat (`chat`, `complete` with usage and thinking, `chatStream`), and `models()`: the model registry (opaque ids, capabilities, prices, active flag; spec 5) | `scriptedAgent`, `STAND_IN_MODELS` |
| `identity: Identity` | The signed-in user (id, name, email, organization); `currentUser()` rejects when nobody is signed in, and the site then shows a sign-in error with Retry. Optional `signOut()` ends the single sign-on session: when it is there, the avatar menu shows Sign out and the page reloads after it (2026-11-16) | `localIdentity` (no sign-out) |
| `files: FileStore` | Uploads for prompt images and chat attachments; returns a URL the model can fetch. When stored URLs must be signed per call, the composition root passes labeling a `resolveUrl` that returns a Promise (next section) | `browserFiles` (data URLs) |
| `examples: ExampleSource` | The prepared examples file (50 to 100 examples with features) and id lookup | `sampleExamples` |
| `media?: MediaSource` | The player page and still images of one example by item id, for people to look at on Gold Labels (see "Media") | `sampleMedia` (made-up pictures, no player) |
| `endpoints?: EndpointConfig[]` | Registered endpoints with real limits (next section) | not set: assumed limits |
| `telemetry?: TelemetrySink` | Takes product events (`pushEvents`, batches of `TelemetryEvent`) and metrics as Prometheus text (`pushMetrics`) and forwards them to the company's telemetry system. Must not throw; slow is fine (the app buffers) | `localTelemetrySink` (`localStorage`); not set: kept in memory only |
| `tickets?: TicketPort` | Files a problem report and returns its ticket id (see "Problem reports") | `localTickets` (`localStorage`, `sprint-tickets`); not set: helpers say reports cannot be sent |
| `sharedState?: SharedStatePort` | Short-lived keys every server instance must see, with a TTL (`get`, `set(key, value, ttlMs)`, `delete`; values are plain JSON): the live Ask AI turn, the helper that keeps answering on a page, the running turn's caller and page, problem-report drafts. A shared store such as Redis in a server deployment | `memorySharedState` (a map in the page); not set: the composition root uses the same |
| `jobStore?: JobStorePort` | Where background jobs are kept (`packages/contracts/src/jobs-api.ts`), as whole atomic operations so several runners never take the same job: enqueue once per idempotency key among queued and running jobs, claim the next job with a lease (fair across tenants), heartbeat, finish, requeue, cancel, and recover expired leases. Redis (SET NX PX and a script per operation) or SQL with conditional updates | `memoryJobStore` (memory of one process); not set: the composition root uses the same |
| `standIns: string[]` | Names shown in the header while any stand-in is in use; empty in production | all |

## The page client: `@sprint/client-impl`

The pages call one `BffClient` (`apps/web/src/backend-api/client.ts`). `index.ts` takes it from
`@sprint/client-impl`, the second build-time switch next to `@sprint/platform-impl`:

- by default it is `apps/web/src/backend-api/in-process.ts`, where every service runs in the page;
- a server deployment sets `SPRINT_CLIENT_IMPL` to its own module, relative to the repo root (for
  example `SPRINT_CLIENT_IMPL=internal/http-client.ts npm run build`). The module exports
  `client: BffClient`, usually an HTTP client of the server's bff. The in-process module is then
  never imported, so no backend app is bundled into the static site.

The boundary check allows only these two aliases in `next.config.mjs`, and refuses any file that
imports the in-process client directly instead of through the alias.

## Building the server's own composition

Each module's factory is its package's entry point (`exports` `"."`), so a server composition
imports it and wraps it without reaching into `src/` paths: `createGateway` (`@sprint/llm-gateway`),
`createCatalog` (`@sprint/catalog`), `createLabeling` with `memoryLocks` and `browserLocks`
(`@sprint/labeling`), `createAgentRuntime` (`@sprint/agents`), `createOptimiser`
(`@sprint/optimiser`), `createWorkflow` and `systemContext` (`@sprint/workflow`), `createBffApi`
(`@sprint/bff`), `createTelemetry` (`@sprint/telemetry`), and the stand-ins plus `loopback`
(`@sprint/platform`). `in-process.ts` is the worked example of wiring them.

`createLabeling`'s `resolveUrl` turns a stored image URL into one the model can fetch. It may
return a Promise, so a server can sign a URL per call; every image of a prompt is resolved at once
before the call.

## Endpoints and limits

The llm-gateway keeps every call under its endpoint's QPM and TPM, and retries busy, server and
timeout errors. It needs one `EndpointConfig` per registered endpoint:

- `purpose: 'labeling'` with `slot` set to the labeling endpoint's id (`EndpointId`, any string
  the registry uses), and `purpose: 'chat'` per agent model (`model` = its registry id). Chat and
  labeling never share an endpoint or a quota. The gateway registers these ids as the allowed
  values of the `endpoint`, `model` and `slot` telemetry labels at startup.
- `qpm`, `tpm`: the registered limits. TPM counts input, output and reasoning tokens.
- `maxConcurrency`: our own cap on calls in flight (start with 8 for reasoning models).
- `assumed: false`.

Anything not supplied falls back to the assumed defaults in `apps/llm-gateway/src/registry.ts`
(shown as assumed). Still to confirm on the platform: the real QPM/TPM per endpoint, whether busy
replies carry `Retry-After`, and that uploaded image URLs are reachable by the labeling models.

## Examples

The MVP dataset is a prepared file in the format of `apps/web/public/sample-data/examples.json`.
Upload it to the file store and build with `NEXT_PUBLIC_EXAMPLES_URL` set to its URL. Real
examples never go in this repo.

Since 1.0.0 each feature on a `RawExample` is a `FeatureValue` (`packages/contracts/src/types.ts`):
`{text}` for text features and `{items}` for lists such as image URLs, never a plain string. An
`ExampleSource` adapter that still returns plain strings can wrap them with `toFeatures` from
`@sprint/domain`; prompts read features only through `featureText` and `featureItems`.

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

1. Implement `media(externalId, type)` in the internal module: return an `ExampleMedia` with a
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

1. Implement `describe(keys)` in the internal module: for each feature key (the placeholder name,
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

1. Implement `read(ctx, url)` in the internal module: for a link to the internal document
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

1. Implement `submit(ticket)` in the internal module: file the ticket wherever developers or the
   developer agent pick work up, and return `{ticketId}` (any short string the user can quote).
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

A contract is any type or interface in `packages/contracts`. Changing one can break the internal
adapters, so:

1. Open an issue or pull request titled `Contract change: <what>`, saying which interface changes,
   why, and whether the change is additive (new optional field or method) or breaking.
2. Additive changes can merge once the stand-ins and tests are updated.
3. Breaking changes merge after the internal agent confirms the adapters are ready; the PR lists
   what the adapters must do.

## Moving a service behind HTTP later

Each app already sits behind a contract. To move one out, implement its contract as an HTTP
client and pass that to the composition root instead of the in-process app; callers do not change.

The workflow is ready for this first: `WorkflowContract` (`packages/contracts/src/workflow-api.ts`)
takes the caller's `RequestContext` first on every method, and one call crosses as
`RpcRequest {method, ctx, args}` and comes back as `RpcResponse` (`{result}` or
`{error: {code, message}}`). In the browser the bff already calls it through `loopback`
(`packages/platform/src/standins/loopback.ts`), which puts every call through JSON the same way,
so a server only has to carry those envelopes. The browser then calls the server through the
module behind `@sprint/client-impl` (above). Give the server's workflow a shared
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

Until the agent service (spec 6) lands, an Ask AI turn's progress stays with the instance that
started it. See "Known limits" in `docs/architecture.md`.

## Verify

```bash
npm ci
npm run check        # typecheck, unit tests, boundary check
npm run build        # static site in apps/web/out/
node apps/web/scripts/e2e-check.cjs http://localhost:4173   # with apps/web/out served on :4173
```
