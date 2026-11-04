# bff (`@tsp/bff`)

What pages call (`BffContract` in `packages/contracts/src/bff-api.ts`). Stores nothing itself:
it reads and writes through the catalog, starts labeling tasks, and asks the agent runtime.

- `services/app.ts`: `configureBff(deps)` receives catalog, labeling, gateway, agents, identity,
  files and examples. Also the in-tab change bus and `once` (stops one tab starting the same step
  twice).
- `projects.ts`: `loadProjectState` (one read for a page), gates, approvals.
- `evaluation.ts`: `labelEvalSet` finds or creates the eval task for version + model + settings
  and runs it; `buildReport` scores the held-out half of the eval set.
- `work.ts`: `tick`, called by open pages: scores the latest version, builds missing reports,
  resumes scoring and optimiser tasks left by a closed page, starts the optimiser.
- `optimiser.ts`: GEPA-style loop; each candidate is labeled as an optimiser task.
- `training.ts`: `labelTestSet` ("Get model answers" on Gold Labels, user-started) and the final
  run, one labeling task over the train and test splits with the approved estimate as its budget;
  rows come from its predictions (test rows carry gold where it exists). User-started tasks don't
  resume by themselves after a reload.
- `page-views.ts`: `getPageView(projectId, where)` builds each page as the agent sees it from saved
  data, and `agentTools(projectId)` runs the agents' read tools (each call goes to the audit log).
  `agents.ts` sends the view of the user's page with every turn and lends the tools.
- `views.ts`: task → page views (`LabelingRun`, training set counters).

Rules: imports contracts and domain only; everything else arrives through `configureBff`.
