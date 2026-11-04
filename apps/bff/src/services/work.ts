import type {EndpointId, ProjectState, PromptVersion} from '@tsp/contracts';
import {autoSpendUsd, dueStartCheck, dueStarts, evalEstimate, OPTIMISER_CANDIDATES, type DueStart} from '@tsp/domain';
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
        const budget = opts.auto ? {auto: true, budgetUsd: evalEstimate(state, version, m.endpoint)} : {};
        const task = await labelEvalSet(projectId, state.setup!, version, m.endpoint, state.examples, 'eval', budget);
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
 * Estimates of automatic starts still going. Their cost is saved as it is spent, so until they
 * end the cap check counts their estimate on top (at most $1 each, on the safe side): starts
 * made one after another can't pass the $5 together.
 */
const reservations = new Map<string, number>();
export const reservedUsd = () => [...reservations.values()].reduce((a, b) => a + b, 0);
export function reserve(key: string, usd: number, work: Promise<unknown>): void {
  reservations.set(key, usd);
  const done = () => void reservations.delete(key);
  work.then(done, done);
}

/** Is this due start already going in this page? */
const going = (d: DueStart) => busy(`auto:${d.key}`) || (d.what === 'optimiser' ? busy('optimiser') : busy(`label:${d.versionId}:${d.endpoint}`));

/**
 * Runs one due start without a click, after `dueStartCheck` allowed it, and records it: an
 * `auto_start` audit record and the `tsp_auto_starts_total` metric.
 */
async function autoStart(state: ProjectState, d: DueStart) {
  const {catalog} = getApp();
  const projectId = state.project.id;
  const spent = autoSpendUsd(state);
  if (d.what === 'optimiser') {
    reserve(d.key, d.estimateUsd, startOptimiser(projectId, d.endpoint, {auto: true}));
  } else {
    const v = state.versions.find(x => x.id === d.versionId);
    if (!v) return;
    reserve(d.key, d.estimateUsd, once(`auto:${d.key}`, () => scoreVersion(projectId, v, d.endpoint, {auto: true})));
  }
  await catalog.audit(projectId, 'system', 'auto_start', {what: d.what, version: d.versionId, endpoint: d.endpoint, estimateUsd: d.estimateUsd, autoSpendUsd: spent, reservedUsd: reservedUsd() - d.estimateUsd});
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
  // button with the cost (see `waitingStarts`). Checked against fresh spend, one start at a
  // time: each start's estimate is reserved before the next one is checked.
  const fresh = (await loadProjectState(projectId)) ?? state;
  for (const d of dueStarts(fresh, {optimiserBusy: busy('optimiser')})) {
    if (going(d)) continue;
    const check = dueStartCheck(fresh, d, reservedUsd());
    if (check.allowed) {
      await autoStart(fresh, d);
      if (d.what === 'optimiser') return;
    } else if (!askedOnce.has(d.key)) {
      askedOnce.add(d.key);
      tm().counter('tsp_auto_starts_total', {what: d.what, decision: `asked_${check.reason}`});
    }
  }
}

/**
 * After Save or Create on Prompt Engineering: scores the new version where an automatic start
 * is allowed (the same path as `tick`), and says which models wait for a click.
 */
export async function scoreNewVersion(projectId: string): Promise<{started: EndpointId[]; waiting: EndpointId[]}> {
  const state = await loadProjectState(projectId);
  if (!state?.setup) return {started: [], waiting: []};
  await tick(state);
  const latest = state.versions[0];
  const waiting = waitingStarts(state)
    .filter(w => w.what === 'score' && w.versionId === latest?.id)
    .map(w => w.endpoint);
  return {started: state.setup.models.map(m => m.endpoint).filter(e => !waiting.includes(e)), waiting};
}

/** The paid starts waiting for a click (the switch is off, or a cap applies), with their cost. */
export function waitingStarts(state: ProjectState): (DueStart & {reason: string})[] {
  return dueStarts(state, {optimiserBusy: busy('optimiser')}).flatMap(d => {
    if (going(d)) return [];
    const c = dueStartCheck(state, d, reservedUsd());
    return c.allowed ? [] : [{...d, reason: c.reason!}];
  });
}

/** Starts (or resumes) an optimiser run for a model: a click, an approved agent card, or `tick`. */
export async function startOptimiser(projectId: string, endpoint: EndpointId, opts: {auto?: boolean} = {}): Promise<void> {
  await once('optimiser', async () => {
    const state = await loadProjectState(projectId);
    const resumable = state?.optimisation.find(o => o.endpoint === endpoint && o.state === 'paused');
    await runOptimiser(projectId, endpoint, OPTIMISER_CANDIDATES, resumable, opts);
  });
}

export const optimiserBusy = () => busy('optimiser');
