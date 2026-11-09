import type {EndpointId, ProjectState, PromptVersion} from '@tsp/contracts';
import {autoSpendUsd, dueStarts, OPTIMISER_CANDIDATES, versionLabel, type DueStart} from '@tsp/domain';
import {busy, getApp, once, optimiserLock, tm} from './app.ts';
import {postEvent} from './chat-events.ts';
import {buildReport, labelEvalSet} from './evaluation.ts';
import {modelName} from './page-views.ts';
import {optimiserActive, runOptimiser} from './optimiser.ts';
import {approveNode, loadProjectState} from './projects.ts';

/**
 * Background work that runs from the open page. The bff decides when labeling starts (system
 * triggers: a new version is scored, optimiser candidates); the labeling app runs the tasks.
 * Every step is idempotent, so calling `tick` again after a reload picks up where it was.
 */

/**
 * Labels the eval set with a version on every chosen model (or just `only`), then scores it.
 * `auto`: started by code without a click (the tick, or an agent's start tool).
 */
export async function scoreVersion(projectId: string, version: PromptVersion, only?: EndpointId, opts: {auto?: boolean} = {}) {
  const state = (await loadProjectState(projectId))!;
  const models = state.setup!.models.filter(m => !only || m.endpoint === only);
  await Promise.all(
    models.map(m =>
      once(`label:${version.id}:${m.endpoint}`, async () => {
        const task = await labelEvalSet(projectId, state.setup!, version, m.endpoint, state.examples, 'eval', opts.auto ? {auto: true} : {});
        if (task?.state !== 'done') return;
        const fresh = (await loadProjectState(projectId))!;
        const report = await buildReport(projectId, fresh.setup!, version, m.endpoint, fresh.examples, fresh.gold, fresh.contextId);
        if (!report) return;
        const passed = (await loadProjectState(projectId))?.reports.some(r => r.id === report.id && r.passed) ?? false;
        tm().event('version_scored', {version_id: version.id, slot: m.endpoint, lowest_field_macro_f1: report.metrics.lowestField.macroF1, passed, cost_usd: task.costUsd, trigger: opts.auto ? 'auto' : 'user'});
      }),
    ),
  );
}

/** Is this due start already going in this page? */
const going = (d: DueStart) => busy(`auto:${d.key}`) || (d.what === 'optimiser' ? busy('optimiser') : busy(`label:${d.versionId}:${d.endpoint}`));

/**
 * Runs one due start without a click and records it: an `auto_start` audit record and the
 * `tsp_auto_starts_total` metric.
 */
async function autoStart(state: ProjectState, d: DueStart) {
  const {catalog} = getApp();
  const projectId = state.project.id;
  const spent = autoSpendUsd(state);
  const model = modelName(state, d.endpoint);
  if (d.what === 'optimiser') {
    void startOptimiser(projectId, d.endpoint, {auto: true});
    await postEvent(projectId, 'auto', 'workflow', `started the optimiser on ${model}`, {path: '/prompt'});
  } else {
    const v = state.versions.find(x => x.id === d.versionId);
    if (!v) return;
    void once(`auto:${d.key}`, () => scoreVersion(projectId, v, d.endpoint, {auto: true}));
    await postEvent(projectId, 'auto', 'workflow', `started scoring ${versionLabel(v)} on ${model}`, {path: '/prompt'});
  }
  await catalog.audit(projectId, 'system', 'auto_start', {what: d.what, version: d.versionId, endpoint: d.endpoint, estimateUsd: d.estimateUsd, autoSpendUsd: spent});
  tm().counter('tsp_auto_starts_total', {what: d.what, decision: 'started'});
  tm().event('auto_started', {what: d.what, estimate_usd: d.estimateUsd, project_auto_spend_usd: spent});
}

export async function tick(state: ProjectState) {
  const {catalog, labeling} = getApp();
  const projectId = state.project.id;

  // An optimiser loop left "running" by a closed page shows as paused. One still running in
  // another tab holds its lock, so it is left alone.
  for (const o of state.optimisation) {
    if (o.state !== 'running' || optimiserActive(o.id) || busy('optimiser')) continue;
    if (await getApp().locks.isHeld(optimiserLock(projectId, o.endpoint))) continue;
    const fresh = await catalog.get('optimisation_runs', o.id);
    if (fresh?.state === 'running' && !optimiserActive(o.id)) await catalog.patch('optimisation_runs', o.id, {state: 'paused'});
  }
  // The project is finished once the training set is done and the test set is done too (or there
  // is no test set): recorded once, like any step approval.
  const nTest = state.examples.filter(e => e.split === 'test').length;
  const testDone = nTest === 0 || state.testRuns[0]?.state === 'done';
  if (state.trainingSets[0]?.state === 'done' && testDone && !state.project.approvedNodes.includes('training')) {
    void once(`finish:${projectId}`, () => approveNode(projectId, 'training'));
  }

  // A task left running by a closed page shows as paused (listTasks marks it).
  await labeling.listTasks(projectId);

  // Reports for scoring that finished while no page built them cost nothing: always built.
  if (state.setup?.schema) {
    for (const r of state.runs.filter(r => r.state === 'done')) {
      if (state.reports.some(x => x.promptVersionId === r.promptVersionId && x.endpoint === r.endpoint && !x.archivedNow)) continue;
      const v = state.versions.find(v => v.id === r.promptVersionId);
      if (v) void once(`report:${v.id}:${r.endpoint}`, () => buildReport(projectId, state.setup!, v, r.endpoint, state.examples, state.gold, state.contextId));
    }
  }

  // Paid work the workflow would start now: all of it starts here, with no cost limit (the user
  // stops a costly run with its Stop button).
  const fresh = (await loadProjectState(projectId)) ?? state;
  for (const d of dueStarts(fresh, {optimiserBusy: busy('optimiser')})) {
    if (going(d)) continue;
    await autoStart(fresh, d);
    if (d.what === 'optimiser') return;
  }
}

/** Starts (or resumes) an optimiser run for a model: a click, an agent's start tool, or `tick`. */
export async function startOptimiser(projectId: string, endpoint: EndpointId, opts: {auto?: boolean} = {}): Promise<void> {
  await once('optimiser', async () => {
    // The lock covers every tab of this browser: a second tab asking for the same model's
    // optimiser gets nothing, so the same work is never paid for twice.
    await getApp().locks.run(optimiserLock(projectId, endpoint), async () => {
      const state = await loadProjectState(projectId);
      const resumable = state?.optimisation.find(o => o.endpoint === endpoint && (o.state === 'paused' || o.state === 'running'));
      await runOptimiser(projectId, endpoint, OPTIMISER_CANDIDATES, resumable, opts);
    });
  });
}

export const optimiserBusy = () => busy('optimiser');
