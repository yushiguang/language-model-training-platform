import type {EndpointId, EvalReport, Example, GoldLabel, LabelingTask, ModelSettings, Prediction, PromptVersion, SetupVersion, TaskPurpose} from '@yushiguang/sprint-contracts';
import {asAnswer, toMap, computeMetrics, judge, newId, settingsHash, versionLabel, type Scored, msg} from '@yushiguang/sprint-domain';
import {now, type Scope} from './app.ts';
import {tenantOf} from './sources.ts';
import {postEvent} from './chat-events.ts';

/** Latest gold label per example for the current schema; older-schema labels are kept as hints. */
export async function latestGold(w: Scope, projectId: string, schemaVersion: number) {
  const all = await w.catalog.find('gold_labels', {projectId}, 'createdAt');
  const current: Record<string, GoldLabel> = {};
  const stale: Record<string, GoldLabel> = {};
  // Answers stored as a plain string earlier on 2026-11-16 read as a one-item list.
  for (const g of all) (g.schemaVersion === schemaVersion ? current : stale)[g.exampleId] = {...g, answer: asAnswer(g.answer)};
  for (const id of Object.keys(current)) delete stale[id];
  return {current, stale};
}

export const settingsFor = (setup: SetupVersion, endpoint: EndpointId): ModelSettings => {
  const s = setup.models.find(m => m.endpoint === endpoint);
  if (!s) throw new Error(`Model ${endpoint} is not the project's labeling model.`);
  return s;
};

/** The existing task that labels these examples with this version, model and settings, if any. */
export async function findTask(w: Scope, projectId: string, version: PromptVersion, endpoint: EndpointId, hash: string, exampleIds: string[], purposes: TaskPurpose[]): Promise<LabelingTask | null> {
  const want = new Set(exampleIds);
  const tasks = await w.labeling.listTasks(projectId);
  return (
    tasks.find(
      t =>
        purposes.includes(t.purpose) &&
        t.promptVersionId === version.id &&
        t.endpoint === endpoint &&
        t.settingsHash === hash &&
        t.exampleIds.length === want.size &&
        t.exampleIds.every(id => want.has(id)),
    ) ?? null
  );
}

/**
 * Labels the eval set with one version on one model as a labeling task: reuses the task for the
 * same version + model + settings + examples when there is one (so a reload resumes it), and
 * creates one otherwise. Returns null when another tab is running it.
 *
 * `auto`: this run was started by code without a click, so its cost is recorded as automatic
 * spend (on the task, per run: an automatic resume of a task a user started counts too).
 */
export async function labelEvalSet(w: Scope,
  projectId: string,
  setup: SetupVersion,
  version: PromptVersion,
  endpoint: EndpointId,
  examples: Example[],
  purpose: 'eval' | 'optimiser' = 'eval',
  opts: {auto?: boolean; onTask?: (taskId: string) => void} = {},
): Promise<LabelingTask | null> {
  const exampleIds = examples.filter(e => e.split === 'eval').map(e => e.id);
  return labelExamples(w, projectId, setup, version, endpoint, exampleIds, purpose, opts);
}

/**
 * Labels some examples with one version on one model (the eval set, or the Optimiser's dry run):
 * reuses the task for the same examples when there is one, else creates one. Answers are shared
 * by version + model + settings + example, so a later task over more examples reuses them.
 */
export async function labelExamples(w: Scope,
  projectId: string,
  setup: SetupVersion,
  version: PromptVersion,
  endpoint: EndpointId,
  exampleIds: string[],
  purpose: 'eval' | 'optimiser',
  opts: {auto?: boolean; onTask?: (taskId: string) => void; pass?: number} = {},
): Promise<LabelingTask | null> {
  const {labeling, user} = w;
  // pass 2: the Optimiser's confirmation, a fresh labeling of the same examples.
  const settings = opts.pass && opts.pass > 1 ? {...settingsFor(setup, endpoint), pass: opts.pass} : settingsFor(setup, endpoint);
  let task = await findTask(w, projectId, version, endpoint, settingsHash(settings), exampleIds, ['eval', 'optimiser']);
  if (task?.state === 'done') return task;
  task ??= await labeling.createTask({
    projectId,
    tenantId: tenantOf(w),
    purpose,
    promptVersionId: version.id,
    setupVersionId: setup.id,
    endpoint,
    settings,
    exampleIds,
    // 'auto' marks scoring code started without a click.
    createdBy: purpose === 'optimiser' ? 'optimiser' : opts.auto ? 'auto' : (await user()).name,
  });
  opts.onTask?.(task.id);
  const trigger = opts.auto || purpose === 'optimiser' ? 'system' : 'user';
  const run = opts.auto ? {auto: true} : {};
  if (task.state === 'needs_attention') return labeling.retryFailed(task.id, trigger, run);
  return labeling.runTask(task.id, trigger, run);
}

/**
 * The user's Stop on scoring or on the test set's model answers; saved as an action line. The
 * task's own stop flag reaches a runner in any process; a job still queued is cancelled too.
 */
export async function stopRun(w: Scope, projectId: string, runId: string): Promise<void> {
  const {labeling, catalog} = w;
  const t = await labeling.getTask(runId);
  if (!t || t.projectId !== projectId) throw new Error('This run does not exist.');
  for (const job of await w.jobs.list(w.ctx, {projectId, kinds: ['labeling.runTask'], states: ['queued', 'running']})) if (job.args.taskId === runId) await w.jobs.cancel(w.ctx, job.id);
  // Awaited: a task that was only waiting is stopped before the page's next check reads it.
  await labeling.stopTask(runId);
  void (async () => {
    const v = await catalog.get('prompt_versions', t.promptVersionId);
    if (t.purpose === 'eval') await postEvent(w, t.projectId, 'stop', 'user', v ? msg('stopped scoring {version}', {version: versionLabel(v)}) : msg('stopped scoring a version'), {path: '/prompt'});
  })();
}

export async function predictionsFor(w: Scope, versionId: string, endpoint: EndpointId, settings: ModelSettings): Promise<Map<string, Prediction>> {
  return toMap(await w.labeling.predictions(versionId, endpoint, settingsHash(settings)));
}

/**
 * Builds the report for a version on a model from its saved answers. Scores use only the
 * held-out half of the eval set, and of it the examples with a gold label.
 */
export async function buildReport(w: Scope,
  projectId: string,
  setup: SetupVersion,
  version: PromptVersion,
  endpoint: EndpointId,
  examples: Example[],
  gold: Record<string, GoldLabel>,
  contextId: string,
  opts: {replace?: boolean} = {},
): Promise<EvalReport | null> {
  const {catalog} = w;
  const evalExamples = examples.filter(e => e.split === 'eval');
  // Scored on the held-out examples that have a gold label now (spec 1.0.0, 2.5 and 4.4): scoring
  // never waits for every example. It needs 2 gold labels in each half.
  const labeled = evalExamples.filter(e => !!gold[e.id]);
  if (!setup.schema || labeled.filter(e => !e.optimiserHalf).length < 2 || labeled.filter(e => e.optimiserHalf).length < 2) return null;
  const existing = (await catalog.find('eval_reports', {projectId, promptVersionId: version.id, endpoint, contextId})).filter(r => !r.archived);
  if (existing.length && !opts.replace) return existing[0];
  const settings = settingsFor(setup, endpoint);
  const byExample = await predictionsFor(w, version.id, endpoint, settings);
  const scoredOn = labeled.filter(e => !e.optimiserHalf);
  if (scoredOn.some(e => !byExample.has(e.id))) {
    w.local.cannotBuild.add(`${version.id}|${endpoint}|${contextId}`);
    return null;
  }
  const items: Scored[] = scoredOn.map(e => ({exampleId: e.id, gold: gold[e.id].answer, predicted: byExample.get(e.id)!.answer, filtered: byExample.get(e.id)!.filtered, costUsd: byExample.get(e.id)!.costUsd}));
  const snapshotId = scoredOn[0]?.snapshotId;
  const report: EvalReport = {
    id: newId('er'),
    projectId,
    promptVersionId: version.id,
    endpoint,
    contextId,
    schemaVersion: setup.schemaVersion,
    ...(snapshotId ? {snapshotId} : {}),
    settings,
    metrics: computeMetrics(setup.schema, items),
    archived: false,
    createdAt: now(),
  };
  await catalog.insert('eval_reports', report);
  // Rebuild scores (2026-11-12): the new report replaces the one for the same context.
  for (const old of existing) await catalog.patch('eval_reports', old.id, {archived: true});
  w.emitChange(projectId);
  return report;
}

/**
 * The confirmation of a pass (decided 2026-11-10): the held-out half's score from a second,
 * fresh labeling (`pass` 2), and whether it passes the same thresholds.
 */
export async function confirmScore(w: Scope, setup: SetupVersion, version: PromptVersion, endpoint: EndpointId, examples: Example[], gold: Record<string, GoldLabel>): Promise<{score: number; passed: boolean}> {
  const byExample = await predictionsFor(w, version.id, endpoint, {...settingsFor(setup, endpoint), pass: 2});
  const evalExamples = examples.filter(e => e.split === 'eval');
  const held = evalExamples.filter(e => !e.optimiserHalf && !!gold[e.id]);
  if (held.some(e => !byExample.has(e.id))) throw new Error('the second labeling is missing answers');
  const m = computeMetrics(setup.schema!, held.map(e => ({exampleId: e.id, gold: gold[e.id].answer, predicted: byExample.get(e.id)!.answer, filtered: byExample.get(e.id)!.filtered, costUsd: byExample.get(e.id)!.costUsd})));
  return {score: m.macroF1, passed: !!setup.thresholds && judge(m, setup.thresholds, evalExamples.filter(e => !!gold[e.id]).length).passed};
}

/** Scores a candidate on the optimiser's own half (used inside the optimiser loop only). */
export async function scoreOnOptimiserHalf(w: Scope, setup: SetupVersion, version: PromptVersion, endpoint: EndpointId, examples: Example[], gold: Record<string, GoldLabel>) {
  const byExample = await predictionsFor(w, version.id, endpoint, settingsFor(setup, endpoint));
  const half = examples.filter(e => e.split === 'eval' && e.optimiserHalf && byExample.has(e.id) && !!gold[e.id]);
  return computeMetrics(
    setup.schema!,
    half.map(e => ({exampleId: e.id, gold: gold[e.id].answer, predicted: byExample.get(e.id)!.answer, filtered: byExample.get(e.id)!.filtered, costUsd: byExample.get(e.id)!.costUsd})),
  );
}
