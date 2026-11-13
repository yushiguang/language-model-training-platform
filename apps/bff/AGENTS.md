# bff (`@tsp/bff`)

What pages call (`BffContract` in `packages/contracts/src/bff-api.ts`). Stores nothing itself:
it reads and writes through the catalog, starts labeling tasks, and asks the agent runtime.

- `services/app.ts`: `configureBff(deps)` receives catalog, labeling, gateway, agents, identity,
  files, examples and the telemetry port (`tm()` for metrics and events). Also the in-tab change bus and `once` (stops one tab starting the same step
  twice).
- `projects.ts`: `loadProjectState` (one read for a page), gates, approvals.
- `evaluation.ts`: `labelEvalSet` finds or creates the eval task for version + model + settings
  and runs it; `buildReport` scores the held-out half of the eval set.
- `work.ts`: `tick`, called by open pages: builds missing reports, then starts the paid work
  `dueStarts` lists (score the latest version, resume scoring left by a closed page, the
  optimiser), all of it, with no cost limit, writing an `auto_start` audit record. Automatic
  starts pass `{auto}` to labeling so the run's cost is recorded as automatic spend; no run gets
  a budget, so nothing pauses for cost (the user stops a costly run with Stop).
  Tests: `work.test.ts` (real catalog and labeling over the stand-in store, fake model).
- `api.ts`: `createBffApi()`, the bff as `BffContract` (ids and plain JSON in, records read here).
- `optimiser-host.ts`: what the bff does for `@tsp/optimiser` (`OptimiserHost`): labels, scores and
  saves a version through the same code as every other path, and what follows a pass.
- `settings.ts`: Project Settings (pass rule, labeling model) and their one-time confirmation
  before the first paid run. `prompts.ts`: saving a version from a structured prompt (compiles the
  text, bumps the schema version when the label signature changes).
- `starts.ts`: the agents' start tools. Runs them at once and audits them.
- `page-views.ts`: `getPageView(projectId, where)` builds each page as the agent sees it from saved
  data, and `agentTools(projectId)` runs the agents' read tools (each call goes to the audit log).
  `agents.ts` sends the view of the user's page with every turn and lends the tools.
- `views.ts`: task → page views (`LabelingRun`).

Rules: imports contracts and domain only; everything else arrives through `configureBff`.
