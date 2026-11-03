# Integration handover

This is for whoever connects the MVP web app to the internal hosting platform and its runtimes.
The app runs end to end today on **stand-ins**. Connecting it means replacing each stand-in with
an adapter, in one file: `web/src/platform/config.ts`. No page or service code needs to change.

Keep this repo free of internal product names, internal URLs, keys and tokens. Map the generic
names below to real ones only inside the internal environment.

## Ground rules

- **No secrets in the bundle.** The build output is a static site that anyone who can open the page
  can read. Never put API keys, tokens or service credentials in client code, `NEXT_PUBLIC_*`
  variables, or the uploaded build. Calls that need credentials must go through the hosting
  platform's managed runtimes, or its server proxy with credentials injected on the server side.
- **No real examples in the repo.** The repo is public. The real example file goes to the file
  store and is referenced by URL at runtime (see "Examples").
- **Identity is not access control.** The SSO user is used for display and the audit log only.

## How the app is built

- Next.js 16 static export (`output: 'export'`), no server code, no API routes, no dynamic routes.
  Pages read `?p=<projectId>` and other query parameters on the client.
- `npm run build` writes `web/out/` (it has `index.html`). That folder is the artifact to upload.
- Set `NEXT_PUBLIC_BASE_PATH` at build time if the site is served under a sub-path.
- Background work (labeling runs, reports, the optimiser) runs from the open page and is
  idempotent: closing the page pauses it, and reopening resumes it. Long runs (the training set)
  are submit-then-poll through `BatchJobs`, so the page can close while they run.

## What to implement

All interfaces are in `web/src/platform/interfaces.ts`. Each stand-in is in
`web/src/platform/standins/`, and it is the reference for the expected behaviour.

| Interface | What the app uses it for | Hosting runtime (generic) | Stand-in today |
|---|---|---|---|
| `SqlRuntime` | All app data | Storage runtime (Postgres) | PGlite: Postgres in the browser, saved in IndexedDB |
| `LabelingModels` | Eval runs and optimiser runs: one call per example | Model platform's two preset endpoints, through the server proxy | Simulated models A and B |
| `BatchJobs` | The training set: submit, poll, results, cancel | Model platform's batch API, through the server proxy | Simulated time-based batch |
| `AgentModel` | Front desk, schema, prompt and evaluation agents; optimiser reflection | Managed LLM runtime | Scripted replies |
| `Identity` | Name in the header, audit log, "made by" | SSO identity helper | Fixed local user |
| `FileStore` | Prompt images, uploaded label files | File store runtime | Data URLs in the browser |
| `ExampleSource` | "Sample examples" on Dataset | Prepared file in the file store (MVP mocks sampling) | `public/sample-data/examples.json` |

When an adapter is real, remove its name from `standIns` in `config.ts`. The header shows a
"Stand-in services" badge until the list is empty.

### SqlRuntime (storage)

- Two methods: `query(sql, params)` with `$1, $2…` parameters, and `exec(script)` for migrations.
- The schema is in `db/schema.sql` (generated: run `npm run schema` in `web/` after changing
  `web/src/data/schema.ts`). On first use the app runs it with `create table if not exists`, and
  records the version in `schema_meta`.
- Every table has the columns the app filters or sorts on, plus `data jsonb` with the whole record.
  Most records are never changed after insert; tables marked "mutable" in the schema are updated
  in place (run progress, project pointers).
- All SQL is issued from one class, `web/src/data/repo.ts` (`insert`, `update`, `get`, `find`,
  training rows, `audit`). If the storage runtime turns out to be key/value rather than Postgres,
  re-implement that class over keys such as `<table>/<projectId>/<id>`; nothing else touches storage.
- The browser sends SQL. That is fine for an internal MVP, but whoever can open the page can send
  any statement the runtime accepts. Confirm what the runtime allows, and prefer a runtime account
  limited to this app's tables.

### LabelingModels (online calls)

- `endpoints()` returns the two presets with display text, prices (USD per million tokens, used for
  estimates only) and whether temperature is supported.
- `chat()` sends one request: messages with text and image parts, `maxOutputTokens`, `temperature`
  (null when the endpoint has none). Return the text and token counts. Throw on failure; the caller
  tries 3 times, then marks the run failed. Rerun continues from the predictions already saved.
- Calls go one at a time per model (both models run side by side). Add concurrency in the adapter
  only if the proxy's rate limit allows it.
- `traceId` is the example id. Log it if useful; never put it in the prompt.
- Image parts carry URLs. They must be URLs the model platform can fetch (file store URLs, or the
  example's own image URLs).

### BatchJobs (training set)

- `submit` takes all train examples in one job and returns a job id straight away.
- `status` returns done/total and a state; the page polls it every 1.5 s while open.
- `results` returns one result per request id once the state is `done`.
- `cancel` stops the job. Work already done may be kept.
- If the proxy has a request timeout or size cap, split the job into chunks inside the adapter;
  the app only sees one job.

### AgentModel

- `chat(messages, {json})` returns the model's text. With `json: true` the app expects one JSON
  object; the shapes per agent and intent are in `web/src/services/agentPresets.ts` (each preset
  lists its intents and answer shape) and the reflection shape is in `web/src/services/optimiser.ts`.
- The user message is `{preset, intent, page, userText, context}` as JSON. The system prompt comes
  from the preset. The scripted stand-in (`standins/scripted-agent.ts`) shows a valid answer for
  every intent, which is a good test fixture for the real model.
- Prompts are visible in the browser. Do not put secrets in them.

### Identity and FileStore

- `currentUser()` returns `{id, name}`.
- `upload(blob, name)` returns `{url}`. The app stores the URL and shows it in `<img>` tags and in
  prompts. Confirm who can open these URLs before uploading anything sensitive.

### Examples

For the MVP, sampling is mocked: Dataset "picks" examples at random from one prepared file.

1. Prepare the file (50 to 100 examples with features) in this format:

   ```json
   {
     "note": "free text",
     "examples": [
       {"externalId": "123", "type": "video", "title": "…",
        "features": {"Description": "…", "OCR_Text": "…", "Frame": ["https://…/f1.jpg"], "…": "…"}}
     ],
     "labels": [
       {"externalId": "123", "answer": {"primary_value": ["Practical"], "topics": ["Travel"]}}
     ]
   }
   ```

   `type` is `video` or `photo_text`. Feature keys are the placeholder keys in
   `web/src/core/catalogue.ts` (for example `Description`, `OCR_Text`, `ASR`, `Frame`, `Images`,
   `Cover`, `Creator_Nick_Name`). Image features hold URLs (a list for `Frame` and `Images`).
   An empty or missing feature is shown to the model as "none". `labels` is optional; it powers
   "Use the answers that came with the examples" on Gold Labels, and value names must match the
   approved schema.
2. Upload it to the file store and build with `NEXT_PUBLIC_EXAMPLES_URL=<file url>`. That URL is
   not a secret, but the file's contents are readable by anyone who can open it.
3. Without the variable the app uses the made-up sample in `web/public/sample-data/`.

## Things to confirm on the hosting platform

- The storage runtime accepts Postgres SQL with parameters, and what limits it has (statement size,
  rows per query, connections from many browsers).
- The server proxy can inject credentials server side for the model platform. If credentials would
  have to ship in the bundle, the model calls are blocked until that is solved.
- Proxy rate limit, timeout and response-size cap, against eval runs (one call at a time per model,
  tens of calls per version) and a training-set job of a few thousand requests.
- Whether the managed LLM supports JSON output and how big a context it takes (the prompt agent
  sends the whole template and schema).
- Who can open file store URLs, and how long files are kept.
- Whether client-side navigation works on the static host (the app uses Next.js links; a full page
  reload also works because every page loads its state from storage).

## Checking it works

```
cd web
npm ci
npm run typecheck && npm test && npm run build
npx serve out      # then open the printed URL
```

Walk the flow: create a project, describe the task, approve the labels, pick thresholds and
models, sample examples, set the split, use the bundled answers as gold labels, ask the assistant
to draft a prompt, create it, wait for scores and the optimiser, open the report, generate the
training set, export it.
