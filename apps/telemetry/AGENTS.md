# telemetry (`@tsp/telemetry`)

Metrics and product events. Contract: `TelemetryPort` and the catalogues `METRICS` and
`EventProps` in `packages/contracts/src/telemetry.ts`; the full list with meanings is in the
"Telemetry: events and metrics" design doc. This app keeps them and sends them to a
`TelemetrySink`; it decides nothing about the product.

- `telemetry.ts`: `createTelemetry({sink, appVersion, env, flushMs, maxBuffered})` returns a
  `TelemetryPort`.
  - Metrics are Prometheus style (`tsp_*`): counters, gauges and cumulative histograms kept in
    memory; `render()` gives the text exposition. The port adds `app` (from the name prefix) and
    `env`. Only declared labels are kept; a value that looks like an id, is empty or is longer
    than 48 characters becomes `other`, so label sets stay small.
  - Events carry an envelope: event, ts, event_id, session_id (renewed after 30 min idle),
    user_id, project_id, page, app_version, props. The newest 500 are buffered while the sink is
    slow.
  - `flush()` runs every 10 s, when the page hides, and on demand; it never throws.
- The browser cannot be scraped, so metrics are pushed with events. A server-side app later
  exposes `render()` on `/metrics` instead.

Who calls it: the composition root builds one port and passes it to the llm-gateway, catalog,
labeling and bff (`telemetry` option); pages use `pageViewed` and `track` from `@/backend-api`.
The sink is `Platform.telemetry` (stand-in: `localTelemetrySink`, events in `localStorage`
under `tsp-telemetry-events`, metrics text on `globalThis.__tspMetrics`).

Rules: never collect content: no prompt text, chat text, example features, names or emails.
Props are counts, ids, enums and durations. The audit log stays in the catalog. Imports:
contracts only. Tests: `telemetry.test.ts`.
