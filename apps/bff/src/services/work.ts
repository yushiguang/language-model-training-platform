import type {EndpointId, ProjectState, PromptVersion} from '@tsp/contracts';
import {autoSpendUsd, autoStartCheck, dueStarts, OPTIMISER_CANDIDATES, type DueStart} from '@tsp/domain';
import {busy, getApp, once, tm} from './app.ts';
import {buildReport, labelEvalSet} from './evaluation.ts';
import {optimiserActive, runOptimiser} from './optimiser.ts';
import {loadProjectState} from './projects.ts';

/**
 * Background work that runs from the open page. The bff decides when labeling starts (system
 * triggers: a new version is scored, optimiser candidates); the labeling app runs the tasks.
 * Every step is idempotent, so calling `tick` again after a reload picks up where it was.
 */

/**
 * Labels the eval set with a version on every chosen model (or just `only`), then scores it.
 * `auto`: started by code without a click (the tick, or an agent's start tool within the caps).
 */
export async function scoreVersion(projectId: string, version: PromptVersion, only?: EndpointId, opts: {auto?: boolean} = {}) {
  const state = (await loadProjectState(projectId))!;
  const models = state.setup!.models.filter(m => !only || m.endpoint === only);
  await Promise.all(
    models.map(m =>
      once(`label:${version.id}:${m.endpoint}`, async () => {
        const task = await labelEvalSet(projectId, state.setup!, version, m.endpoint, state.examples, 'eval', opts);
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

/** Starts are asked about once per page load; the metric counts each one once. */
const askedOnce = new Set<string>();

/**
 * Runs one due start without a click, after `autoStartCheck` allowed it, and records it: an
 * `auto_start` audit record and the `tsp_auto_starts_total` metric.
 */
async function autoStart(state: ProjectState, d: DueStart) {
  const {catalog} = getApp();
  const projectId = state.project.id;
  const spent = autoSpendUsd(state);
  if (d.what === 'optimiser') {
    if (busy('optimiser')) return;
    void once('optimiser', () => runOptimiser(projectId, d.endpoint, OPTIMISER_CANDIDATES, undefined, {auto: true}));
  } else {
    const v = state.versions.find(x => x.id === d.versionId);
    if (!v || busy(`label:${v.id}:${d.endpoint}`) || busy(`auto:${d.key}`)) return;
    void once(`auto:${d.key}`, () => scoreVersion(projectId, v, d.endpoint, {auto: true}));
  }
  await catalog.audit(projectId, 'system', 'auto_start', {what: d.what, version: d.versionId, endpoint: d.endpoint, estimateUsd: d.estimateUsd, autoSpendUsd: spent});
  tm().counter('tsp_auto_starts_total', {what: d.what, decision: 'started'});
  tm().event('auto_started', {what: d.what, estimate_usd: d.estimateUsd, project_auto_spend_usd: spent});
}

export async function tick(state: ProjectState) {
  const {catalog, labeling} = getApp();
  const projectId = state.project.id;

  // An optimiser loop left "running" by a closed page shows as paused.
  for (const o of state.optimisation) {
    if (o.state !== 'running' || optimiserActive(o.id) || busy('optimiser')) continue;
    const fresh = await catalog.get('optimisation_runs', o.id);
    if (fresh?.state === 'running' && !optimiserActive(o.id)) await catalog.patch('optimisation_runs', o.id, {state: 'paused'});
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

  // Paid work the workflow would start now: started here when allowed, else the page shows a
  // button with the cost (see `waitingStarts`).
  for (const d of dueStarts(state, {optimiserBusy: busy('optimiser')})) {
    const check = autoStartCheck(state, d.estimateUsd);
    if (check.allowed) {
      await autoStart(state, d);
      if (d.what === 'optimiser') return;
    } else if (!askedOnce.has(d.key)) {
      askedOnce.add(d.key);
      tm().counter('tsp_auto_starts_total', {what: d.what, decision: `asked_${check.reason}`});
    }
  }
}

/** The paid starts waiting for a click (the switch is off, or a cap applies), with their cost. */
export function waitingStarts(state: ProjectState): (DueStart & {reason: string})[] {
  return dueStarts(state, {optimiserBusy: busy('optimiser')}).flatMap(d => {
    if (d.what === 'score' && busy(`label:${d.versionId}:${d.endpoint}`)) return [];
    const c = autoStartCheck(state, d.estimateUsd);
    return c.allowed ? [] : [{...d, reason: c.reason!}];
  });
}

/** Starts (or resumes) an optimiser run for a model. A click, or an approved agent card. */
export function startOptimiser(projectId: string, endpoint: EndpointId, opts: {auto?: boolean} = {}) {
  void once('optimiser', async () => {
    const state = await loadProjectState(projectId);
    const resumable = state?.optimisation.find(o => o.endpoint === endpoint && o.state === 'paused');
    await runOptimiser(projectId, endpoint, OPTIMISER_CANDIDATES, resumable, opts);
  });
}

export const optimiserBusy = () => busy('optimiser');
