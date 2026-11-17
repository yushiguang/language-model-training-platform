# optimiser (`@tsp/optimiser`)

Auto Optimise: the GEPA loop ported to TypeScript (design: `docs/design/optimiser.md`). Implements
`OptimiserContract` (`packages/contracts/src/optimiser-api.ts`): `startRun`, `stopRun`,
`retryRun`, `getRun`, `listRuns`, `isRunning`. Owns the `optimisation_runs` records.

- `src/optimiser.ts`: `createOptimiser(deps)`. One round picks a parent from the Pareto front,
  asks the agent runtime for a change (or a merge), checks it, dry-runs it, labels the eval set,
  scores it, and confirms a pass on a second labeling of the held-out half.
- It decides what to try. Saving a version, labeling examples and building a score are asked of
  the project's owner through `OptimiserHost` (the bff implements it), so those rules live in
  one place.
- Limits (rounds, retries, dry-run size) come from `systemConfig().optimiser`.

Rules: imports contracts and domain only. The catalog, labeling, the agent runtime, locks,
telemetry and the host arrive through `createOptimiser`. Tests: the Auto Optimise tests in
`apps/bff/src/services/bff.test.ts` run this loop over the real catalog and labeling apps.
