# jobs (`@yushiguang/sprint-jobs`)

The job module (deployment readiness spec, 3): one way to run background work. Contract:
`JobsContract`, `JobExecutor` and `JobStorePort` in `packages/contracts/src/jobs-api.ts`.

- `jobs.ts`: `createJobs({store, owner, leaseMs, heartbeatMs, maxAttempts, concurrency,
  retryDelayMs, runOnEnqueue, telemetry, clock})` returns `{api, register, drain, sweep, poll,
  idle, onChange}`.
  - `api.enqueue(ctx, req)`: saves a job with the caller's context (ids and names only). While a
    job with the same `idempotencyKey` is queued or running, the same job comes back. With
    `runOnEnqueue` (the browser, tests) this process starts it at once.
  - A runner takes a job with a lease (`claimNext`), extends it on every heartbeat and saves the
    executor's progress with it. A lost lease or a cancel aborts the executor's `signal`.
  - An executor that throws is tried again `retries` times (default 0), after
    `retryDelayMs` x attempt; then the job fails with the error's message.
  - Every job has a `concurrencyKey` (`model:<tenantId>:<endpointId>` or `compute:<tenantId>`,
    built with `jobConcurrencyKey` from `@yushiguang/sprint-domain`; enqueue refuses anything
    else). The store claims a job only while its key runs fewer than its limit, which this
    module reads as `config.forTenant(tenant).jobLimit(target)`. `concurrency` is still this
    runner's own cap. `api.ahead(ctx, jobId)` is a queued job's place in its key's queue.
  - A job that ends `done` enqueues its `then` with the same context (a chain). A job that ends
    in any way (done, failed, cancelled; also by the sweep or a cancel before it started)
    enqueues its `finally`, once (idempotency key `finally:<jobId>`).
  - `sweep()` (a cron job on a server) puts running jobs whose lease ended back in the queue, or
    fails them after `maxAttempts`. `poll(ms)` is a server worker's loop. `idle()` waits until
    nothing runs or can start (tests).
- It knows no business rule and stores nothing itself: executors come from the apps that own the
  work, and jobs live in the injected store (`memoryJobStore` in `@yushiguang/sprint-platform` for one
  process; a shared store such as Redis on a server).

Rules: imports contracts and domain only. Tests (`jobs.test.ts`) cover the lifecycle: enqueue once
per key, progress, cancel (queued, running, from another runner), lease expiry and takeover, a
lost lease, retries, chains, `finally` on every end, per-key limits from configuration across
runners, keys taking turns across tenants. The store's own rules are tested in
`packages/platform/src/standins/job-store.test.ts`.
