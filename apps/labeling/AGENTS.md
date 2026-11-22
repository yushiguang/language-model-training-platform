# labeling (`@yushiguang/sprint-labeling`)

Runs labeling tasks: one prompt version on one model over a list of examples, one prediction per
example. Contract: `LabelingContract` in `packages/contracts/src/labeling-api.ts`. Owns the
`labeling_tasks` and `predictions` collections; nothing else writes them.

- `labeling.ts`: `createLabeling({db, catalog, gateway, locks, liveElsewhere, resolveUrl, onChange, telemetry})`.
  `resolveUrl` may return a Promise (a URL signed per call); `toMessages` resolves every image of
  a prompt at once before the model call.
- `executor.ts`: `labelingExecutor(labeling)`, the `labeling.runTask` job: runs (or with `retry`,
  retries the failed examples of) one task; a cancel is Stop. `deleteProject` removes answers and
  tasks in batches (`DocRepo.deleteWhere`).
  - `runTask` takes the task's lock, rebuilds counters from saved predictions, and runs `parallel`
    (default 4) workers. Each example runs under a lock on its prediction id: if the prediction is
    saved by then (another task for the same version, model and settings), it is reused and not
    paid again; else render, `gateway.label`, parse, save the prediction, then increment counters
    with `DocFieldValue.increment`. Saving re-reads the prediction first: an answer saved meanwhile
    by a runner this one's locks cannot see is the saved one, so the store keeps one document (the
    call just made is already paid — not paying at all is the prediction lock's job, #46). Limits
    (budget, failures) are checked before every example.
  - A failed example goes into `failedExampleIds`; the task ends `needs_attention` (early when more
    than 5% or 20 in a row fail). `retryFailed` labels them again; it clears the failed list only
    once it holds the task's lock (a running task: null, nothing changed). An example another run
    saved meanwhile counts as done.
  - Budget: pauses when cost passes 120% of `budgetUsd`. `extendBudget` (the user's Resume after
    that pause) grows the budget by the share still to label. The bff no longer sets a budget
    (every task runs with no cost limit), so this applies only to tasks saved before that.
  - Stop: aborts locally, or sets `stopRequested` and `stopRequestedAt`; the runner reads them on
    a 2 s timer and aborts calls in flight. A request saved while the run was starting (its job claimed, the task not yet taken) ends the run before any model call; every end clears the request, so an old one never stops a later run.
    The run's model calls share one request id; aborting the run calls the gateway's
    `cancel(runId)`, so no signal crosses the gateway contract. `tryTemplate` passes the caller's
    `requestId`, and `cancel(requestId)` stops it.
  - `listTasks` reports a `running` task as `paused` / `closed` only when no runner holds it
    anywhere: not through the locks (shared across processes when the composition wires
    `leaseLocks` over `Platform.lockStore`, #46), and not as live job work where the composition
    supplies `liveElsewhere` (a queued or running `labeling.runTask` job, or the project's
    `optimiser.run` job for an optimiser task). A reader in another process never falsifies a live run.
  - `relabelInvalid` (the final run): an example whose only saved answer is invalid when the task
    first starts is labeled once more. The first run stores which ones in `relabelExampleIds`, so
    a resumed task never relabels its own answers (no clock comparison). `predictions` returns the
    first valid answer per example, else the first.
  - `runTask(id, trigger, {auto, budgetUsd})`: an automatic run adds its cost to `autoCostUsd`.
    With `budgetUsd` (the bff no longer passes one) it pauses (stopReason `budget`) once its own
    cost passes 120% of it.
  - `tryTemplate` labels a few examples with an unsaved template (the prompt agent's
    try_prompt tool) and saves nothing.
  - Metrics: `sprint_labeling_*` (runs started and ended, resumes, examples, durations, cost,
    cost against the estimate, lock conflicts, stop latency).
- `locks.ts`: browser Web Locks per task and per prediction; an in-memory version for tests and
  Node. Across processes the composition passes `@yushiguang/sprint-platform`'s `leaseLocks` over
  `Platform.lockStore` instead (#46); two computers on per-process locks are still not coordinated.

Rules: the bff decides when a task starts; this app only runs it. Prediction ids are deterministic
(`predictionId`), so a rerun never duplicates. Imports: contracts, domain, platform.
Tests: `labeling.test.ts` (parallelism, reuse, failures, Retry failed, budget, lock, closed runner,
Stop from another tab, two tasks on the same examples, and two processes over one store: shared
locks, disjoint locks with `liveElsewhere`, a dead runner's reaped task resumed).
