# labeling (`@tsp/labeling`)

Runs labeling tasks: one prompt version on one model over a list of examples, one prediction per
example. Contract: `LabelingContract` in `packages/contracts/src/labeling-api.ts`. Owns the
`labeling_tasks` and `predictions` collections; nothing else writes them.

- `labeling.ts`: `createLabeling({db, catalog, gateway, locks, resolveUrl, onChange, telemetry})`.
  - `runTask` takes the task's lock, rebuilds counters from saved predictions, and runs `parallel`
    (default 4) workers. Each example: render, `gateway.label`, parse, save the prediction, then
    increment counters with `DocFieldValue.increment`.
  - A failed example goes into `failedExampleIds`; the task ends `needs_attention` (early when more
    than 5% or 20 in a row fail). `retryFailed` labels them again.
  - Budget: pauses when cost passes 120% of `budgetUsd`.
  - Stop: aborts locally, or sets `stopRequested`, which the runner checks every 2 s.
  - `listTasks` reports a `running` task whose lock nobody holds as `paused` / `closed`.
  - `relabelInvalid` (the final run): an example whose only saved answer is invalid is labeled
    once more; `predictions` returns the first valid answer per example, else the first.
  - `runTask(id, trigger, {auto, budgetUsd})`: an automatic run adds its cost to `autoCostUsd`
    and pauses (stopReason `budget`) once its own cost passes 120% of `budgetUsd`.
  - `tryTemplate` labels a few examples with an unsaved template (the prompt agent's
    try_template tool) and saves nothing.
  - Metrics: `tsp_labeling_*` (runs started and ended, resumes, examples, durations, cost,
    cost against the estimate, lock conflicts, stop latency).
- `locks.ts`: browser Web Locks per task; an in-memory version for tests and Node.

Rules: the bff decides when a task starts; this app only runs it. Prediction ids are deterministic
(`predictionId`), so a rerun never duplicates. Imports: contracts, domain, platform.
Tests: `labeling.test.ts` (parallelism, reuse, failures, Retry failed, budget, lock, closed runner).
