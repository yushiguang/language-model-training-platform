# config (`@yushiguang/sprint-config`)

The config module (`docs/design/server.md`, 7). Contract: `ConfigPort`, `ConfigReader`,
`TenantConfig` and `JobLimitTarget` in `packages/contracts/src/platform-api.ts`. The key rules
(one dotted key per `SystemConfig` leaf, how a value parses, the job-limit lookup order) are pure
functions in `packages/domain/src/config.ts`; this app does the I/O around them.

- `config.ts`: `createConfig({port, base, ttlMs, refreshMs, clock, onProblem})`.
  - `refresh()` reads every process-level key (`getMany` when the port has it), parses it, and
    applies `base` plus the values with `configureSystem`. A failed read keeps the values in
    force; an invalid value is left out and reported to `onProblem`.
  - `start()` refreshes now, then every `refreshMs` (default 30 s) and on the port's pushes;
    `stop()` ends both.
  - `reader.forTenant(tenantId)`: `get(key)` reads `tenant.<tenantId>.<key>`, cached per key for
    `ttlMs` (default 30 s), one read per key at a time; in an outage the last value read is used
    and the platform is not asked again for `retryMs` (default 5 s). A push marks the cache stale
    but keeps the values, and a read or refresh that started before a newer one never overwrites
    it. `jobLimit(target)` walks the lookup order and never throws.

Who calls it: the composition root builds one per process when `Platform.configStore` is set and
passes `reader` to the job module and the workflow.
