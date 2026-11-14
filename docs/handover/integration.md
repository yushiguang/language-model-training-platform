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

## Where the swap happens: `@tsp/platform-impl`

Only the composition root (`apps/web/src/backend-api/in-process.ts`) imports `@tsp/platform-impl`,
and only its `createPlatform(): Platform`. It resolves to:

- the stand-ins, `packages/platform/src/config.ts`, by default (`tsconfig.base.json` paths and
  `apps/web/next.config.mjs`);
- the internal module when the build sets `TSP_PLATFORM_IMPL` to its path, relative to the repo
  root, for example `TSP_PLATFORM_IMPL=internal/platform.ts npm run build`. `/internal/` is
  ignored by git, so the overlay can sit there.

The internal module exports `createPlatform()` returning the `Platform` object from
`packages/contracts/src/platform-api.ts`:

| Field | What it must do | Stand-in |
|---|---|---|
| `db: DocRuntime` | Document collections: add, get, set, partial update with `DocFieldValue` (increment, arrayUnion, arrayRemove, delete), delete, find, query with filters and offset paging, polling subscribe, batch writes. `createdAt` is server time | `localDocRuntime` (`localStorage`) |
| `models: LabelingModels` | One labeling call per example (`chat`, `chatStream`) on slot A or B; returns text and token usage. Throw `LlmCallError` (or an error with an HTTP `status`) so the gateway can tell busy from rejected; throw `LlmCallError('filtered', …)` when the endpoint's safety filter stops the answer (Prompt versions shows it as Filtered) | `simulatedModels` |
| `agent: AgentModel` | Agent chat (`chat`, `complete` with usage and thinking, `chatStream`, `models()`) | `scriptedAgent` |
| `identity: Identity` | The signed-in user (id, name, email, organization) | `localIdentity` |
| `files: FileStore` | Uploads for prompt images and chat attachments; returns a URL the model can fetch | `browserFiles` (data URLs) |
| `examples: ExampleSource` | The prepared examples file (50 to 100 examples with features) and id lookup | `sampleExamples` |
| `media?: MediaSource` | The player page and still images of one example by item id, for people to look at on Gold Labels (see "Media") | `sampleMedia` (made-up pictures, no player) |
| `endpoints?: EndpointConfig[]` | Registered endpoints with real limits (next section) | not set: assumed limits |
| `telemetry?: TelemetrySink` | Takes product events (`pushEvents`, batches of `TelemetryEvent`) and metrics as Prometheus text (`pushMetrics`) and forwards them to the company's telemetry system. Must not throw; slow is fine (the app buffers) | `localTelemetrySink` (`localStorage`); not set: kept in memory only |
| `tickets?: TicketPort` | Files a problem report and returns its ticket id (see "Problem reports") | `localTickets` (`localStorage`, `tsp-tickets`); not set: helpers say reports cannot be sent |
| `standIns: string[]` | Names shown in the header while any stand-in is in use; empty in production | all |

## Endpoints and limits

The llm-gateway keeps every call under its endpoint's QPM and TPM, and retries busy, server and
timeout errors. It needs one `EndpointConfig` per registered endpoint:

- `purpose: 'labeling'` with `slot: 'A'` or `'B'` for the two labeling models, and
  `purpose: 'chat'` per agent model. Chat and labeling never share an endpoint.
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
`@tsp/domain`; prompts read features only through `featureText` and `featureItems`.

## Media

`MediaSource` (`packages/contracts/src/platform-api.ts`) feeds the player and still images on
Gold Labels. Playback is an embedded player page, never a direct video file:

1. Implement `media(externalId, type)` in the internal module: return an `ExampleMedia` with a
   `playerUrl` the Gold Labels page loads in an iframe (the item's official embed player, or a
   fallback viewer when the item is no longer publicly playable — the adapter may probe
   availability first), a `coverUrl`, still `imageUrls` (key frames, or a photo-and-text post's
   images) and `durationSec` when known; return `null` when the item has no media. Set `media`
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
the bff passes it to `Platform.documents` and cuts the text at 20,000 characters. The stand-in
(`packages/platform/src/standins/documents.ts`) opens nothing, and the helper asks for the text.

1. Implement `read(url)` in the internal module: for a link to the internal document service,
   return a `LinkedDocument` with its `title` and its `text` (plain text or Markdown; tables as
   text), read as the signed-in user so a person never sees a document they can't open. Return
   `null` for a link it can't read (another host, no access, deleted).
2. Set `documents` on the `Platform` object and drop `'document links'` from `standIns`.
3. Images in a document are not read in this version; say so in the text if they matter.

## Problem reports

Any helper can call `report_problem` when the user says something is wrong (spec 1.1.0, 3). The
helper drafts first and shows the user what it would send; code refuses to send until the user
has written again, so a report never goes without a yes. The bff then builds a
`TicketSubmission` (`packages/contracts/src/platform-api.ts`) and calls `Platform.tickets.submit`:

- the user's account of it (summary, expected, actual, steps), the reporter, the language and the
  helper that filed it;
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
The bff contract still needs a fully serialisable version first (planned); see "Known limits" in
`docs/architecture.md`.

## Verify

```bash
npm ci
npm run check        # typecheck, unit tests, boundary check
npm run build        # static site in apps/web/out/
node apps/web/scripts/e2e-check.cjs http://localhost:4173   # with apps/web/out served on :4173
```
