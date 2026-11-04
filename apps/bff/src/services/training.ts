import type {EndpointId, EvalReport, PromptVersion, TrainingRow, TrainingSet} from '@tsp/contracts';
import {estimate, MIN_PER_VALUE, minutesFor, newId} from '@tsp/domain';
import {emitChange, getApp, now} from './app.ts';
import {loadProjectState} from './projects.ts';
import {trainingView} from './views.ts';

export {estimate, MIN_PER_VALUE, minutesFor};

/**
 * Generates the training set as a labeling task over the train split (no batch job: the labeling
 * app runs it from the open page, 4 examples at a time). The task pauses if the cost passes 120%
 * of the estimate the user accepted. Passing `existing` resumes it: examples already labeled are
 * kept, and examples that failed are tried again.
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
  const task = await labeling.createTask({
    projectId,
    purpose: 'training',
    promptVersionId: version.id,
    setupVersionId: setup.id,
    endpoint,
    settings,
    exampleIds: train.map(e => e.id),
    budgetUsd: estimateUsd,
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
    total: train.length,
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

/** The training set's rows: one saved prediction per train example. */
export async function trainingRows(tsId: string): Promise<TrainingRow[]> {
  const {catalog, labeling} = getApp();
  const ts = await catalog.get('training_sets', tsId);
  if (!ts) return [];
  const task = await labeling.getTask(ts.taskId);
  if (!task) return [];
  const preds = await labeling.predictions(task.promptVersionId, task.endpoint, task.settingsHash);
  return task.exampleIds.flatMap(id => {
    const p = preds.get(id);
    return p ? [{trainingSetId: ts.id, exampleId: id, answer: p.answer, invalidReason: p.invalidReason}] : [];
  });
}

export async function getTrainingSet(tsId: string): Promise<TrainingSet | null> {
  const {catalog, labeling} = getApp();
  const ts = await catalog.get('training_sets', tsId);
  if (!ts) return null;
  return trainingView(ts, (await labeling.getTask(ts.taskId)) ?? undefined);
}
