import type {EndpointId, EvalReport, Example, GoldLabel, LabelingTask, ModelSettings, Prediction, PromptVersion, SetupVersion, TaskPurpose} from '@tsp/contracts';
import {computeMetrics, judge, newId, settingsHash, versionLabel, type Scored} from '@tsp/domain';
import {emitChange, getApp, now} from './app.ts';
import {postEvent} from './chat-events.ts';

/** Latest gold label per example for the current schema; older-schema labels are kept as hints. */
export async function latestGold(projectId: string, schemaVersion: number) {
  const all = await getApp().catalog.find('gold_labels', {projectId}, 'createdAt');
  const current = new Map<string, GoldLabel>();
  const stale = new Map<string, GoldLabel>();
  for (const g of all) (g.schemaVersion === schemaVersion ? current : stale).set(g.exampleId, g);
  for (const id of current.keys()) stale.delete(id);
  return {current, stale};
}

const settingsFor = (setup: SetupVersion, endpoint: EndpointId): ModelSettings => {
  const s = setup.models.find(m => m.endpoint === endpoint);
  if (!s) throw new Error(`Model ${endpoint} is not chosen in Setup.`);
  return s;
};

/** The existing task that labels these examples with this version, model and settings, if any. */
async function findTask(projectId: string, version: PromptVersion, endpoint: EndpointId, hash: string, exampleIds: string[], purposes: TaskPurpose[]): Promise<LabelingTask | null> {
  const want = new Set(exampleIds);
  const tasks = await getApp().labeling.listTasks(projectId);
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
export async function labelEvalSet(
  projectId: string,
  setup: SetupVersion,
  version: PromptVersion,
  endpoint: EndpointId,
  examples: Example[],
  purpose: 'eval' | 'optimiser' = 'eval',
  opts: {auto?: boolean; onTask?: (taskId: string) => void} = {},
): Promise<LabelingTask | null> {
  const exampleIds = examples.filter(e => e.split === 'eval').map(e => e.id);
  return labelExamples(projectId, setup, version, endpoint, exampleIds, purpose, opts);
}

/**
 * Labels some examples with one version on one model (the eval set, or the Optimiser's dry run):
 * reuses the task for the same examples when there is one, else creates one. Answers are shared
 * by version + model + settings + example, so a later task over more examples reuses them.
 */
export async function labelExamples(
  projectId: string,
  setup: SetupVersion,
  version: PromptVersion,
  endpoint: EndpointId,
  exampleIds: string[],
  purpose: 'eval' | 'optimiser',
  opts: {auto?: boolean; onTask?: (taskId: string) => void; pass?: number} = {},
): Promise<LabelingTask | null> {
  const {labeling, user} = getApp();
  // pass 2: the Optimiser's confirmation, a fresh labeling of the same examples.
  const settings = opts.pass && opts.pass > 1 ? {...settingsFor(setup, endpoint), pass: opts.pass} : settingsFor(setup, endpoint);
  let task = await findTask(projectId, version, endpoint, settingsHash(settings), exampleIds, ['eval', 'optimiser']);
  if (task?.state === 'done') return task;
  task ??= await labeling.createTask({
    projectId,
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

/** The user's Stop on scoring or on the test set's model answers; saved as an action line. */
export function stopRun(runId: string): void {
  const {labeling, catalog} = getApp();
  void labeling.stopTask(runId).then(async () => {
    const t = await labeling.getTask(runId);
    if (!t) return;
    const v = await catalog.get('prompt_versions', t.promptVersionId);
    if (t.purpose === 'eval') await postEvent(t.projectId, 'stop', 'user', `stopped scoring ${v ? versionLabel(v) : 'a version'}`, {path: '/prompt'});
    else if (t.purpose === 'test') await postEvent(t.projectId, 'stop', 'user', 'stopped the model answers for the test set', {path: '/gold'});
  });
}

export async function predictionsFor(versionId: string, endpoint: EndpointId, settings: ModelSettings): Promise<Map<string, Prediction>> {
  return getApp().labeling.predictions(versionId, endpoint, settingsHash(settings));
}

/**
 * Builds the report for a version on a model, once the eval set is fully labeled and has gold
 * labels. Scores use only the held-out half of the eval set.
 */
export async function buildReport(
  projectId: string,
  setup: SetupVersion,
  version: PromptVersion,
  endpoint: EndpointId,
  examples: Example[],
  gold: Map<string, GoldLabel>,
  contextId: string,
): Promise<EvalReport | null> {
  const {catalog} = getApp();
  const evalExamples = examples.filter(e => e.split === 'eval');
  if (!setup.schema || !evalExamples.length || evalExamples.some(e => !gold.has(e.id))) return null;
  const existing = await catalog.find('eval_reports', {projectId, promptVersionId: version.id, endpoint, contextId});
  if (existing.length) return existing[0];
  const settings = settingsFor(setup, endpoint);
  const byExample = await predictionsFor(version.id, endpoint, settings);
  const scoredOn = evalExamples.filter(e => !e.optimiserHalf);
  if (scoredOn.some(e => !byExample.has(e.id))) return null;
  const items: Scored[] = scoredOn.map(e => ({exampleId: e.id, gold: gold.get(e.id)!.answer, predicted: byExample.get(e.id)!.answer, costUsd: byExample.get(e.id)!.costUsd}));
  const report: EvalReport = {
    id: newId('er'),
    projectId,
    promptVersionId: version.id,
    endpoint,
    contextId,
    schemaVersion: setup.schemaVersion,
    settings,
    metrics: computeMetrics(setup.schema, items),
    archived: false,
    createdAt: now(),
  };
  await catalog.insert('eval_reports', report);
  emitChange();
  return report;
}

/**
 * The confirmation of a pass (decided 2026-11-10): the held-out half's score from a second,
 * fresh labeling (`pass` 2), and whether it passes the same thresholds.
 */
export async function confirmScore(setup: SetupVersion, version: PromptVersion, endpoint: EndpointId, examples: Example[], gold: Map<string, GoldLabel>): Promise<{score: number; passed: boolean}> {
  const byExample = await predictionsFor(version.id, endpoint, {...settingsFor(setup, endpoint), pass: 2});
  const evalExamples = examples.filter(e => e.split === 'eval');
  const held = evalExamples.filter(e => !e.optimiserHalf && gold.has(e.id));
  if (held.some(e => !byExample.has(e.id))) throw new Error('the second labeling is missing answers');
  const m = computeMetrics(setup.schema!, held.map(e => ({exampleId: e.id, gold: gold.get(e.id)!.answer, predicted: byExample.get(e.id)!.answer, costUsd: byExample.get(e.id)!.costUsd})));
  return {score: m.lowestField.macroF1, passed: !!setup.thresholds && judge(m, setup.thresholds, evalExamples.length).passed};
}

/** Scores a candidate on the optimiser's own half (used inside the optimiser loop only). */
export async function scoreOnOptimiserHalf(setup: SetupVersion, version: PromptVersion, endpoint: EndpointId, examples: Example[], gold: Map<string, GoldLabel>) {
  const byExample = await predictionsFor(version.id, endpoint, settingsFor(setup, endpoint));
  const half = examples.filter(e => e.split === 'eval' && e.optimiserHalf && byExample.has(e.id) && gold.has(e.id));
  return computeMetrics(
    setup.schema!,
    half.map(e => ({exampleId: e.id, gold: gold.get(e.id)!.answer, predicted: byExample.get(e.id)!.answer, costUsd: byExample.get(e.id)!.costUsd})),
  );
}
