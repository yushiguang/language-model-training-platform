# Telemetry design: metrics and product events

Status: built in 0.x (as of 2026-11-12). The catalogue itself lives in code:
`packages/contracts/src/telemetry.ts` declares every metric, label, event and prop, and
`apps/telemetry` enforces it. This doc holds the conventions and the rules for changing it.

Sprint reports two streams, so a company monitoring system can be plugged in later without
changing the apps.

| | Service metrics | Product events |
| --- | --- | --- |
| Answers | How the services behave: speed, errors, limits, cost | What people do: where they go, what they approve, where they stop |
| Shape | Prometheus counters, gauges and histograms | One structured record per event, with ids |
| Labels or ids | Labels with a small fixed set of values only | Project id, user id, session id, page |
| Lost data | Fine | A few lost events are fine |
| Goes to | A Prometheus-compatible backend | An event or log pipeline |

## Conventions

- **Names.** Every metric starts with `tsp_`, then the app (`llm_`, `labeling_`, `agent_`,
  `catalog_`, `bff_`, `web_`), then what is measured. Units are spelled out at the end in base
  units (`_seconds`, `_bytes`, `_usd`, `_ratio`); counters end in `_total`. Snake case only.
  (`tsp` is the repo's first working name, "Training Set Platform"; the prefix stays through
  1.0.0.)
- **Labels.** `app` and `env` are added by the port. Allowed values are listed per metric, and a
  value outside the list is reported as `other`. Never a label: project, user, example, version
  or session id, free text, or anything unbounded. Those go in events only.
- **Histogram buckets** are shared (`BUCKETS` in the contract) so dashboards line up.
- **Events** are `snake_case`, past tense. The port fills the envelope: `event`, `ts`,
  `event_id` (for de-duplication), `session_id` (one per tab, new after 30 idle minutes),
  `user_id` (the sign-in id, never a name or email), `project_id`, `page`, `app_version`. `props`
  hold ids, counts, enums, booleans and numbers only.
- **1.1.0 events.** `project_renamed` (no name), `locale_changed` (`locale`),
  `problem_report_drafted` (`page`), `problem_reported` (`page`, `has_content`, `failed_calls`,
  `errors`). The ticket itself goes to `Platform.tickets`, never to telemetry.
- **No content, ever.** No example content, prompt text, label text, chat text, file names,
  names or emails, in metrics or events. `apps/telemetry` allowlists label values and event props.

## The port

Every app gets one `TelemetryPort` through its create function, and the composition root wires
it. Apps import only the contract. The port never throws and never blocks: it buffers and sends in
batches, and telemetry may be dropped rather than slow the product down. Each browser tab keeps its own
registry and pushes its own totals, so the receiving system sums across tabs as it would across
server instances.

- **Stand-in:** nothing leaves the browser. Metrics stay in memory (`render()` gives the
  Prometheus text), and the last 1,000 events are kept in local storage.
- **Real adapter:** implemented behind `@tsp/platform-impl` as `Platform.telemetry`. A static
  site cannot be scraped, so the adapter pushes. Server-side apps, once they exist, can also
  serve `render()` for scraping. See [../handover/integration.md](../handover/integration.md).

## Audit log and telemetry are different things

The audit log stays in the catalog. It records decisions (who approved which gate, every
automatic start, every gold-label review) and is never dropped or sampled. Telemetry is
analytics. Some moments go to both.

## Changing the catalogue

- Add a metric or event to `packages/contracts/src/telemetry.ts`, with its labels or props; a
  name that is not declared there does not compile.
- Renaming is a breaking change for dashboards: add the new name, keep the old one for a
  release, then remove it.
- A new label needs a fixed list of values. If the list cannot be written, it belongs in an
  event, not a label.
- Remove entries when the feature they measure is removed. The 1.0.0 spec lists the 0.x entries
  to prune (section 1.3).

Not built: an in-product usage dashboard, sampling, and alert rules. Good first alerts once real
traffic exists: `tsp_llm_calls_total{outcome="gave_up"}` rising, and `tsp_llm_limiter_wait_seconds`
p95 above 60 s.
