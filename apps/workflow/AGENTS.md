# workflow (`@sprint/workflow`)

The application module (`WorkflowContract` in `packages/contracts/src/workflow-api.ts`): what any
channel (the web pages' bff today, a CLI or tool channel later) needs. Stores nothing itself: it
reads and writes through the catalog, starts labeling tasks, and asks the agent runtime.

- `workflow.ts`: `createWorkflow(deps)` returns `{api, events, changed, agentTools, agentProgress,
  optimiserHost, connect}`. Every `api` method takes the caller's `RequestContext` first; who did
  something (audit records, `createdBy`, gold labels, comments, problem reports) comes from it.
  `connect({agents, optimiser})` hands over the services built after the workflow, since they call
  back into it (`agentTools`, `agentProgress`, `optimiserHost`).
- `services/app.ts`: the `Instance` (the dependencies, the telemetry port, the change bus, `once`,
  the shared-state port and the instance-local maps) and the per-call `Scope` (instance plus
  context). **No module-level mutable state**: two workflows in one process share nothing. Every
  service function takes `w: Scope` first.
- Shared short-lived state (`deps.sharedState`, `SharedStatePort`, with TTL): the live turn
  (`live:{projectId}`), the helper that keeps answering on a page (`stay:{projectId}`), the turn
  running now with its caller's context, page, language and browser record (`turn:{projectId}`,
  `services/turns.ts`), and problem-report drafts (`report-draft:{projectId}`). The stand-in is
  `memorySharedState` in `@sprint/platform`.
- Instance-local (`Instance.local`): progress handlers of running turns (until the agent service,
  spec 6), the reports that cannot be built from saved answers, and saved answers on the whole
  eval set (a cache).
- Background work goes to the job module (`deps.jobs`, `JobsContract`): `scoreVersion`,
  `startOptimiser`, `retryOptimiser`, sampling and `deleteProject` queue jobs and return.
  `services/executors.ts` (`workflowExecutors`, also `Workflow.executors`): `report.build`
  (`work.runReport`), `dataset.sample` (`dataset.runSample`), `project.delete`
  (`projects.runDelete`). Labeling's and the Optimiser's executors come from their packages.
- Events (`changes`, `agent_live`) carry no data; a client reads again through the contract
  (`getAgentLive` for the live turn).
- A helper's tool runs as the user whose turn it is (`turn:{projectId}`), or as the helper with a
  system context when no turn runs. The Optimiser's host runs with a system context (`optimiser`).
- `services/projects.ts`: `loadProjectState` (one read for a page), `projectStatus` (the light
  read, review G9), gates, approvals. `emitChange(projectId)` also gives the project a new
  revision (`app.ts`, `projectRevisions`): pass the project whenever there is one.
- `services/evaluation.ts`: `labelEvalSet` finds or creates the eval task for version + model +
  settings and runs it; `buildReport` scores the held-out half of the eval set.
- `services/work.ts`: `drive` queues missing reports, then the paid work `dueStarts` lists, all of
  it, with no cost limit, writing an `auto_start` audit record. `tick` (the pages) calls it unless
  `tickFromPages` is false; `Workflow.sweep()` (a server's cron job) calls it for every project.
- `services/optimiser-host.ts`: what the workflow does for `@sprint/optimiser` (`OptimiserHost`).
- `services/settings.ts`, `services/prompts.ts`: Project Settings; saving a version from a
  structured prompt.
- `services/starts.ts`: the agents' start tools. `services/page-views.ts`: page views and the
  agents' read tools. `services/agents.ts`: Ask AI turns, proposals, Improve with AI.
  `services/problems.ts`: `report_problem`. `services/governance.ts`, `services/mismatches.ts`,
  `services/dataset.ts`: the eval dataset, gold review, sampling and upload.
- Tests: `services/workflow.test.ts` (the services over the real catalog, labeling and optimiser,
  stand-in store, fake model) and `workflow.test.ts` (the contract through the loopback: two users
  in one process, two instances, the loopback itself).

Rules: imports contracts and domain only; everything else arrives through `createWorkflow` and
`connect`. Its tests may import platform, catalog, labeling, optimiser and jobs.
