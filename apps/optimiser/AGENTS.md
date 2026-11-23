# optimiser (`@yushiguang/sprint-optimiser`)

Auto Optimise: the GEPA loop ported to TypeScript (design: `docs/design/optimiser.md`). Implements
`OptimiserContract` (`packages/contracts/src/optimiser-api.ts`): `startRun` (saves a run, or
returns the open one), `execute` (runs or resumes it until it ends), `stopRun`, `getRun`,
`listRuns`, `isRunning`. Owns the `optimisation_runs` records. `optimiserExecutor` (`executor.ts`)
is the `optimiser.run` job: it calls `execute` with the job's context (and, for a follow-up, the
position in its args), and a cancel is the user's Stop. A run is a chain of jobs
(docs/design/server.md, 4.4): each labeling step asks `OptimiserHost.label`, which queues a
labeling job of its own; the loop then saves its position and this call ends (`Waiting`), and the
labeling job's `finally` queues the `optimiser.run` that goes on from there. A run goes on as that context (the person who started it, and the tenant): every
`OptimiserHost` call and the helper's `reflectPrompt` carry it (#63), so the workflow checks them
like any other call. There is no Optimiser identity of its own.

- `src/optimiser.ts`: `createOptimiser(deps)`. One round picks a parent from the Pareto front,
  asks the agent runtime for a change (or a merge), checks it, dry-runs it, labels the eval set,
  scores it, and confirms a pass on a second labeling of the held-out half.
- It decides what to try. Saving a version, labeling examples and building a score are asked of
  the project's owner through `OptimiserHost` (the workflow implements it), so those rules live in
  one place.
- Limits (rounds, retries, dry-run size) come from `systemConfig().optimiser`.
- Shared locks (#46): `execute` runs the loop under the injected `LockPort` lock. Across
  processes it must be the same `leaseLocks` over `Platform.lockStore` the composition gives
  labeling and the workflow; on per-process locks two worker replicas can run the same run.

Rules: imports contracts and domain only. The catalog, labeling, the agent runtime, locks,
telemetry and the host arrive through `createOptimiser`. Tests: the Auto Optimise tests in
`apps/workflow/src/services/workflow.test.ts` run this loop over the real catalog and labeling apps.
