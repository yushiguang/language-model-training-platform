# MVP web app: architecture

The MVP produces a labeled **training set** for one task: Setup → Dataset → Gold Labels (optional)
→ Prompt Engineering → Training Set. It is a fixed-workflow website with agents built into each
page, not a chat app. Product, UI and tech decisions are in the design docs; this file is a map of
the code.

## Layers

```
web/src/
  app/          pages (Next.js App Router, static export): one folder per workflow step
  components/   shared page parts: Shell (stepper + assistant), Assistant, SchemaView, ScoreChart, prompt editor
  ui/           our wrappers around Astryx (Button, Badge, Dialog, Icon…). Pages never import Astryx directly
  services/     the app's logic: projects, setup, dataset, evaluation, optimiser, agents, training set
  data/         Postgres schema and the one class that runs SQL (repo.ts)
  core/         pure rules with no I/O: types, placeholders and checks, metrics, versions, gates
  platform/     interfaces to everything outside the app, the stand-ins, and config.ts (the integration point)
```

Dependencies point downwards only: `app → components → services → data/core/platform`. `core`
depends on nothing and has unit tests (`npm test`).

## Key rules and where they live

| Rule | File |
|---|---|
| `{{Key}}` placeholders; single braces are plain text. Checks: unknown key (with closest match), not ticked, ticked but unused, broken braces; warnings for one type only, image cost, missing values. Quick fixes | `core/template.ts` |
| Rendering: lines whose placeholders aren't ticked for the example's type are dropped; empty features become "none"; image features and `[Image N]` become image parts | `core/template.ts` |
| Metrics: macro-F1 per field, per-value F1, accuracy, invalid rate, mix-ups, cost per 1,000. Pass/fail against thresholds | `core/metrics.ts` |
| Versions are major.minor and never overwritten. Save = next minor in the edited line, Save as = next major | `core/versions.ts` |
| Gates between steps; Gold Labels is optional | `core/gates.ts` |
| The code decides the next step; agents only explain it | `services/recommend.ts` |
| A report is tied to an evaluation context (schema version + eval examples + gold labels). When any of them changes, older reports show as archived and can't be compared | `services/evaluation.ts` |
| The eval set is split into an optimiser half and a held-out half; reports score the held-out half only | `services/dataset.ts`, `services/evaluation.ts` |
| Optimiser: GEPA-style loop (best version on the optimiser half → reflection → one targeted change, same placeholders → score). Stops when a version passes, the budget is spent, it runs out of new changes, or the user stops it | `services/optimiser.ts` |
| Background work: label the newest version on every model, build reports, start the optimiser once per human-made version | `services/work.ts` |

## Storage

Postgres. Every table has key columns plus `data jsonb` with the whole record (types in
`core/types.ts`). Most records are insert-only, which keeps history (setup versions, dataset
snapshots, gold labels, prompt versions, predictions, reports). Generated SQL: `db/schema.sql`.

Today the app uses PGlite (Postgres compiled to WebAssembly, kept in the browser's IndexedDB) as a
stand-in for the hosting platform's storage runtime. Because the SQL is plain Postgres, the same
schema and queries move to the real runtime unchanged. Note that with the stand-in, each browser
has its own data.

## Running work from the page

The hosting platform has no server of ours, so labeling runs and the optimiser run in the open
page. Every step is idempotent: predictions are cached per (version, model, settings, example),
runs left "running" by a closed page show as paused, and Rerun/Resume continue from what is saved.
The training set uses `BatchJobs` (submit, then poll), so it continues when the page closes.

## Open items

- `MIN_PER_VALUE` (values with fewer train examples get a warning on the finished training set) is
  a placeholder of 5 in `services/training.ts` until the product decides it.
- With a small eval set (for example 28 examples, 14 held out) per-value scores are noisy. The
  report shows example counts next to each value so this is visible.
- See `docs/handover/integration.md` for what must be confirmed on the hosting platform.
