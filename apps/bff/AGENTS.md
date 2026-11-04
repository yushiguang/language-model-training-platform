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
  optimiser) when `autoStartCheck` allows it, writing an `auto_start` audit record.
  `waitingStarts` is what waits for a click, with its cost, for the page's buttons.
  `scoreNewVersion` (Save and Create) runs the same check for a new version. Automatic starts
  reserve their estimate (`reserve`, `reservedUsd`) while they run, and pass `{auto, budgetUsd}`
  to labeling so the run's cost counts toward the $5 and pauses past 120% of its estimate.
  Tests: `work.test.ts` (real catalog and labeling over the stand-in store, fake model).
- `optimiser.ts`: GEPA-style loop; each candidate is labeled as an optimiser task.
- `training.ts`: `labelTestSet` ("Get model answers" on Gold Labels, user-started) and the final
  run: one labeling task over the train split plus, when the user ticked it, the test examples
  with no gold label and no answer from the version. `trainingRows`: train rows from the run,
  every test row labeled with gold, else the saved answer (`labelSource`). User-started tasks
  don't resume by themselves after a reload.
- `starts.ts`: the agents' start tools. Runs them within the caps, or posts an Approve card;
  `answerStartCard` runs an approved one and posts the result in the chat.
- `page-views.ts`: `getPageView(projectId, where)` builds each page as the agent sees it from saved
  data, and `agentTools(projectId)` runs the agents' read tools (each call goes to the audit log).
  `agents.ts` sends the view of the user's page with every turn and lends the tools.
- `views.ts`: task → page views (`LabelingRun`, training set counters).

Rules: imports contracts and domain only; everything else arrives through `configureBff`.
