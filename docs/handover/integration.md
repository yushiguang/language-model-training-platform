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

Only the composition root (`apps/web/src/backend-api/index.ts`) imports `@tsp/platform-impl`,
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
