import type {EndpointId, EvalReport, LabelingTask, PromptVersion, TrainingRow, TrainingSet} from '@tsp/contracts';
import {estimate, MIN_PER_VALUE, minutesFor, newId, settingsHash} from '@tsp/domain';
import {emitChange, getApp, now} from './app.ts';
import {latestGold} from './evaluation.ts';
import {loadProjectState} from './projects.ts';
import {trainingView} from './views.ts';

export {estimate, MIN_PER_VALUE, minutesFor};

/**
 * "Get model answers" on Gold Labels: labels the test set with one version on one model, so
 * people can gold-label with the model's answer as a hint. Started by the user with a cost
 * confirm; it does not resume by itself after a reload. Running it again with the same version,
 * model and settings resumes the same task (and retries failed examples).
 */
export async function labelTestSet(projectId: string, version: PromptVersion, endpoint: EndpointId, estimateUsd: number): Promise<LabelingTask> {
  const {labeling, catalog, user} = getApp();
  const state = (await loadProjectState(projectId))!;
  const setup = state.setup!;
  const settings = setup.models.find(m => m.endpoint === endpoint);
  if (!settings) throw new Error(`Model ${endpoint} is not chosen in Setup.`);
  const exampleIds = state.examples.filter(e => e.split === 'test').map(e => e.id);
  if (!exampleIds.length) throw new Error('There are no test examples. Change the split on Dataset.');
  const hash = settingsHash(settings);
  const tasks = await labeling.listTasks(projectId);
  const same = tasks.find(t => t.purpose === 'test' && t.promptVersionId === version.id && t.endpoint === endpoint && t.settingsHash === hash && t.exampleIds.length === exampleIds.length);
  const u = await user();
  if (same) {
    if (same.state !== 'done' && same.state !== 'running') void (same.failed ? labeling.retryFailed(same.id) : labeling.runTask(same.id));
    return same;
  }
  const task = await labeling.createTask({projectId, purpose: 'test', promptVersionId: version.id, setupVersionId: setup.id, endpoint, settings, exampleIds, budgetUsd: estimateUsd, createdBy: u.name});
  await catalog.audit(projectId, u.name, 'test_set.label', {version: version.id, endpoint, estimateUsd});
  void labeling.runTask(task.id);
  emitChange();
  return task;
}

/**
 * The final run, "Generate training and test sets": one labeling task over the train and test
 * splits (no batch job: the labeling app runs it from the open page, 4 examples at a time). Test
 * examples already labeled with the same version, model and settings are reused. The task pauses
 * if the cost passes 120% of the estimate the user accepted. Passing `existing` resumes it:
 * examples already labeled are kept, and examples that failed are tried again.
 */
export async function startTrainingSet(
  projectId: string,
  version: PromptVersion,
  endpoint: EndpointId,
  report: EvalReport | null,
  estimateUsd: number,
  existing?: TrainingSet,
): Promise<TrainingSet> {
  const {catalog, labeling, user} = getApp();
  if (existing) {
    void labeling.retryFailed(existing.taskId);
    emitChange();
    return existing;
  }
  const state = (await loadProjectState(projectId))!;
  const setup = state.setup!;
  const settings = setup.models.find(m => m.endpoint === endpoint);
  if (!settings) throw new Error(`Model ${endpoint} is not chosen in Setup.`);
  const u = await user();
  const train = state.examples.filter(e => e.split === 'train');
  const test = state.examples.filter(e => e.split === 'test');
  // Answers already saved (test answers from Gold Labels) are reused for free. The task's cost
  // counts them, so the budget adds what they cost: the 120% check then applies to new calls.
  const saved = await labeling.predictions(version.id, endpoint, settingsHash(settings));
  const reusedUsd = [...train, ...test].reduce((n, e) => n + (saved.get(e.id)?.costUsd ?? 0), 0);
  const task = await labeling.createTask({
    projectId,
    purpose: 'training',
    promptVersionId: version.id,
    setupVersionId: setup.id,
    endpoint,
    settings,
    exampleIds: [...train, ...test].map(e => e.id),
    budgetUsd: estimateUsd + reusedUsd,
    createdBy: u.name,
  });
  const ts: TrainingSet = {
    id: newId('ts'),
    projectId,
    promptVersionId: version.id,
    endpoint,
    snapshotId: state.snapshot!.id,
    evaluated: !!report,
    reportId: report?.id ?? null,
    taskId: task.id,
    setupVersionId: setup.id,
    state: 'running',
    total: train.length + test.length,
    trainTotal: train.length,
    testTotal: test.length,
    done: 0,
    labeled: 0,
    invalid: 0,
    failed: 0,
    costUsd: 0,
    estimateUsd,
    error: null,
    startedAt: now(),
    finishedAt: null,
  };
  await catalog.insert('training_sets', ts);
  await catalog.audit(projectId, u.name, 'training_set.start', {version: version.id, endpoint, estimateUsd});
  void labeling.runTask(task.id);
  emitChange();
  return ts;
}

export async function stopTrainingSet(tsId: string): Promise<void> {
  const {catalog, labeling} = getApp();
  const ts = await catalog.get('training_sets', tsId);
  if (ts) await labeling.stopTask(ts.taskId);
}

/**
 * The output rows: one per train and test example with a saved prediction. Test rows carry the
 * gold label for the current schema when someone gave one.
 */
export async function trainingRows(tsId: string): Promise<TrainingRow[]> {
  const {catalog, labeling} = getApp();
  const ts = await catalog.get('training_sets', tsId);
  if (!ts) return [];
  const task = await labeling.getTask(ts.taskId);
  if (!task) return [];
  const [preds, examples, setup] = await Promise.all([
    labeling.predictions(task.promptVersionId, task.endpoint, task.settingsHash),
    catalog.find('examples', {snapshotId: ts.snapshotId}),
    catalog.get('setup_versions', ts.setupVersionId),
  ]);
  const {current: gold} = await latestGold(ts.projectId, setup?.schemaVersion ?? 0);
  const split = new Map(examples.map(e => [e.id, e.split]));
  return task.exampleIds.flatMap(id => {
    const p = preds.get(id);
    if (!p) return [];
    const s = split.get(id) === 'test' ? 'test' : 'train';
    return [{trainingSetId: ts.id, exampleId: id, split: s, answer: p.answer, invalidReason: p.invalidReason, gold: s === 'test' ? (gold.get(id)?.answer ?? null) : null}];
  });
}

export async function getTrainingSet(tsId: string): Promise<TrainingSet | null> {
  const {catalog, labeling} = getApp();
  const ts = await catalog.get('training_sets', tsId);
  if (!ts) return null;
  return trainingView(ts, (await labeling.getTask(ts.taskId)) ?? undefined);
}
