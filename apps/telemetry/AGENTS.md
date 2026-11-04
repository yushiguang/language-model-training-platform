# telemetry (`@tsp/telemetry`)

Metrics and product events. Contract: `TelemetryPort` and the catalogues `METRICS` and
`EventProps` in `packages/contracts/src/telemetry.ts`; the full list with meanings is in the
"Telemetry: events and metrics" design doc. This app keeps them and sends them to a
`TelemetrySink`; it decides nothing about the product.

- `telemetry.ts`: `createTelemetry({sink, appVersion, env, flushMs, maxBuffered})` returns a
  `TelemetryPort`.
  - Metrics are Prometheus style (`tsp_*`): counters, gauges and cumulative histograms kept in
    memory; `render()` gives the text exposition. The port adds `app` (from the name prefix) and
    `env`. Only declared labels are kept, and only values listed for that label in
    `LABEL_VALUES`; anything else becomes `other`, so label sets stay small and an id or email
    can never be a label value. Values known only at startup are added with
    `allowLabelValues` (endpoints and models by the llm-gateway, catalog ops, bff methods); ids,
    emails and text are refused there too. A counter ignores negative, NaN and infinite amounts.
  - Events carry an envelope: event, ts, event_id, session_id (renewed after 30 min idle),
    user_id, project_id, page, app_version, props. Props are checked against `EVENT_PROP_KEYS`:
    other keys are dropped, a string must be a short token (no spaces, no `@`) or it becomes
    `other`, numbers must be finite. The newest 500 are buffered while the sink is slow.
  - `flush()` runs every 10 s, when the page hides, and on demand; it never throws. A flush asked
    for during another one runs after it, so what it awaits includes everything buffered.
- The browser cannot be scraped, so metrics are pushed with events. A server-side app later
  exposes `render()` on `/metrics` instead.

Who calls it: the composition root builds one port and passes it to the llm-gateway, catalog,
labeling and bff (`telemetry` option); pages use `pageViewed` and `track` from `@/backend-api`.
The sink is `Platform.telemetry` (stand-in: `localTelemetrySink`, events in `localStorage`
under `tsp-telemetry-events`, metrics text on `globalThis.__tspMetrics`).

Rules: never collect content: no prompt text, chat text, example features, names or emails.
Props are counts, ids, enums and durations. The audit log stays in the catalog. Imports:
contracts only. Tests: `telemetry.test.ts`.
