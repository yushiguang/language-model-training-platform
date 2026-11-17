import type {EndpointId, ProjectState, PromptVersion} from '@sprint/contracts';
import {autoSpendUsd, dueStarts, versionLabel, type DueStart, systemConfig, msg} from '@sprint/domain';
import type {Scope} from './app.ts';
import {postEvent} from './chat-events.ts';
import {buildReport, labelEvalSet} from './evaluation.ts';
import {modelName} from './page-views.ts';
import {loadProjectState} from './projects.ts';
import {lockHoldout} from './governance.ts';

/**
 * Background work that runs from the open page. The workflow decides when labeling starts (system
 * triggers: a new version is scored); the labeling app runs the tasks. The Optimiser starts
 * only on the user's Auto Optimise (or an agent's start tool after the user asked).
 * Every step is idempotent, so calling `tick` again after a reload picks up where it was.
 */

/**
 * Labels the eval set with a version on every chosen model (or just `only`), then scores it.
 * `auto`: started by code without a click (the tick, or an agent's start tool).
 */
export async function scoreVersion(w: Scope, projectId: string, version: PromptVersion, only?: EndpointId, opts: {auto?: boolean} = {}) {
  const state = (await loadProjectState(w, projectId))!;
  const models = state.setup!.models.filter(m => !only || m.endpoint === only);
  await Promise.all(
    models.map(m =>
      w.once(`label:${version.id}:${m.endpoint}`, async () => {
        const task = await labelEvalSet(w, projectId, state.setup!, version, m.endpoint, state.examples, 'eval', opts.auto ? {auto: true} : {});
        if (task?.state !== 'done') return;
        const fresh = (await loadProjectState(w, projectId))!;
        const report = await buildReport(w, projectId, fresh.setup!, version, m.endpoint, fresh.examples, fresh.gold, fresh.contextId);
        if (!report) return;
        const passed = (await loadProjectState(w, projectId))?.reports.some(r => r.id === report.id && r.passed) ?? false;
        w.tm.event('version_scored', {version_id: version.id, slot: m.endpoint, lowest_field_macro_f1: report.metrics.macroF1, passed, cost_usd: task.costUsd, trigger: opts.auto ? 'auto' : 'user'});
      }),
    ),
  );
}

/** Is this due start already going in this page? */
const going = (w: Scope, d: DueStart) => w.busy(`auto:${d.key}`) || w.busy(`label:${d.versionId}:${d.endpoint}`);

/**
 * Runs one due start without a click and records it: an `auto_start` audit record and the
 * `sprint_auto_starts_total` metric.
 */
async function autoStart(w: Scope, state: ProjectState, d: DueStart) {
  const {catalog} = w;
  const projectId = state.project.id;
  const spent = autoSpendUsd(state);
  const model = modelName(state, d.endpoint);
  const v = state.versions.find(x => x.id === d.versionId);
  if (!v) return;
  void w.once(`auto:${d.key}`, () => scoreVersion(w, projectId, v, d.endpoint, {auto: true}));
  await postEvent(w, projectId, 'auto', 'workflow', msg('started scoring {version} on {model}', {version: versionLabel(v), model}), {path: '/prompt'});
  await catalog.audit(projectId, 'system', 'auto_start', {what: d.what, version: d.versionId, endpoint: d.endpoint, estimateUsd: d.estimateUsd, autoSpendUsd: spent});
  w.tm.counter('sprint_auto_starts_total', {what: d.what, decision: 'started'});
  w.tm.event('auto_started', {what: d.what, estimate_usd: d.estimateUsd, project_auto_spend_usd: spent});
}

export async function tick(w: Scope, state: ProjectState) {
  const {catalog, labeling} = w;
  const projectId = state.project.id;

  // An optimiser loop left "running" by a closed page shows as paused. One still running in
  // another tab holds its lock, so it is left alone.
  const {optimiser} = w;
  for (const o of state.optimisation) {
    if (o.state !== 'running' || !optimiser || (await optimiser.isRunning(o.id))) continue;
    if (await w.locks.isHeld(optimiserLock(projectId, o.endpoint))) continue;
    const fresh = await optimiser.getRun(o.id);
    if (fresh?.state === 'running' && !(await optimiser.isRunning(o.id))) await catalog.patch('optimisation_runs', o.id, {state: 'paused'});
  }
  // A task left running by a closed page shows as paused (listTasks marks it).
  await labeling.listTasks(projectId);

  // Reports for scoring that finished while no page built them cost nothing: always built.
  if (state.setup?.schema) {
    for (const r of state.runs.filter(r => r.state === 'done')) {
      // Only a first report: one a gold edit archived is rebuilt by the next reader of scores (lazy).
      if (state.reports.some(x => x.promptVersionId === r.promptVersionId && x.endpoint === r.endpoint)) continue;
      const v = state.versions.find(v => v.id === r.promptVersionId);
      if (v) void w.once(`report:${v.id}:${r.endpoint}`, () => buildReport(w, projectId, state.setup!, v, r.endpoint, state.examples, state.gold, state.contextId));
    }
  }

  // Paid work the workflow would start now: all of it starts here, with no cost limit (the user
  // stops a costly run with its Stop button).
  const fresh = (await loadProjectState(w, projectId)) ?? state;
  for (const d of dueStarts(fresh)) {
    if (going(w, d)) continue;
    await autoStart(w, fresh, d);
  }
}

/**
 * Auto Optimise: starts a run of up to `maxRounds` changes on the project's model (one model per
 * project), from `startVersionId` (the version selected in the list; left out: the best scored
 * version). `auto`: an agent's start tool, after the user asked in Ask AI.
 */
export async function startOptimiser(w: Scope, projectId: string, maxRounds = systemConfig().optimiser.defaultMaxRounds, startVersionId?: string, opts: {auto?: boolean} = {}): Promise<void> {
  const state = await loadProjectState(w, projectId);
  const endpoint = state?.setup?.models[0]?.endpoint;
  if (!state || !endpoint) throw new Error('Pick a labeling model in Project Settings first.');
  // The Optimiser reads examples: the halves are fixed from here on (spec 1.0.0, 4.2).
  await lockHoldout(w, projectId);
  await optimiserService(w).startRun({projectId, endpoint, maxRounds, startVersionId, auto: opts.auto});
}

/** The user's Stop on a run. */
export function stopOptimiser(w: Scope, runId: string): void {
  void optimiserService(w).stopRun(runId);
}

/** Retry on a Failed run, or Resume on a paused one: goes on from the step it stopped at. */
export async function retryOptimiser(w: Scope, runId: string): Promise<void> {
  await optimiserService(w).retryRun(runId);
}

function optimiserService(w: Scope) {
  const {optimiser} = w;
  if (!optimiser) throw new Error('The Optimiser is not available here.');
  return optimiser;
}

/** The lock an optimiser run on one model holds for as long as it runs, in any tab (the name `@sprint/optimiser` uses). */
const optimiserLock = (projectId: string, endpoint: string) => `optimiser:${projectId}:${endpoint}`;
