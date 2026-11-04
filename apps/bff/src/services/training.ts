import type {EndpointId, EvalReport, LabelingTask, PromptVersion, TrainingRow, TrainingSet} from '@tsp/contracts';
import {estimate, finalRunPlan, MIN_PER_VALUE, minutesFor, newId, settingsHash} from '@tsp/domain';
import {emitChange, getApp, now, tm} from './app.ts';
import {latestGold} from './evaluation.ts';
import {loadProjectState} from './projects.ts';
import {trainingView} from './views.ts';

export {estimate, finalRunPlan, MIN_PER_VALUE, minutesFor};

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
    if (same.state !== 'done' && same.state !== 'running') void (same.failed ? labeling.retryFailed(same.id, 'user') : labeling.runTask(same.id, 'user'));
    return same;
  }
  const task = await labeling.createTask({projectId, purpose: 'test', promptVersionId: version.id, setupVersionId: setup.id, endpoint, settings, exampleIds, budgetUsd: estimateUsd, createdBy: u.name});
  await catalog.audit(projectId, u.name, 'test_set.label', {version: version.id, endpoint, estimateUsd});
  tm().counter('tsp_cost_confirms_total', {what: 'test_answers', outcome: 'accepted'});
  tm().event('test_answers_requested', {estimate_usd: estimateUsd, examples: exampleIds.length});
  void labeling.runTask(task.id, 'user');
  emitChange();
  return task;
}

/**
 * The final run, "Generate training and test sets": one labeling task over the train split, plus
 * (when the user ticked it) the test examples that have neither a gold label nor an answer from
 * this version, model and settings. Test examples with a gold label or a saved answer are never
 * labeled again. No batch job: the labeling app runs it from the open page, 4 examples at a time.
 * The task pauses if the cost passes 120% of the estimate the user accepted. Passing `existing`
 * resumes it: examples already labeled are kept, and examples that failed are tried again.
 */
export async function startTrainingSet(
  projectId: string,
  version: PromptVersion,
  endpoint: EndpointId,
  report: EvalReport | null,
  estimateUsd: number,
  opts: {labelTest?: boolean; existing?: TrainingSet} = {},
): Promise<TrainingSet> {
  const {catalog, labeling, user} = getApp();
  const {existing} = opts;
  if (existing) {
    void labeling.retryFailed(existing.taskId, 'user');
    tm().event('final_run_resumed', {after: existing.state, done: existing.done, total: existing.total});
    emitChange();
    return existing;
  }
  const labelTest = !!opts.labelTest;
  const state = (await loadProjectState(projectId))!;
  const setup = state.setup!;
  const settings = setup.models.find(m => m.endpoint === endpoint);
  if (!settings) throw new Error(`Model ${endpoint} is not chosen in Setup.`);
  const u = await user();
  const saved = await labeling.predictions(version.id, endpoint, settingsHash(settings));
  const train = state.examples.filter(e => e.split === 'train');
  const test = state.examples.filter(e => e.split === 'test');
  const withGold = test.filter(e => state.gold.has(e.id));
  const withAnswer = test.filter(e => !state.gold.has(e.id) && saved.has(e.id));
  const toLabel = test.filter(e => !state.gold.has(e.id) && !saved.has(e.id));
  const ids = [...train, ...(labelTest ? toLabel : [])].map(e => e.id);
  if (!ids.length) throw new Error('Nothing to label: there are no train examples, and every test example already has a label.');
  // Answers already saved for these examples are reused for free. The task's cost counts them,
  // so the budget adds what they cost: the 120% check then applies to new calls only.
  const reusedUsd = ids.reduce((n, id) => n + (saved.get(id)?.costUsd ?? 0), 0);
  const task = await labeling.createTask({
    projectId,
    purpose: 'training',
    promptVersionId: version.id,
    setupVersionId: setup.id,
    endpoint,
    settings,
    exampleIds: ids,
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
    total: ids.length,
    trainTotal: train.length,
    testTotal: test.length,
    labelTest,
    testWithGold: withGold.length,
    testWithAnswers: withAnswer.length,
    testToLabel: toLabel.length,
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
  await catalog.audit(projectId, u.name, 'training_set.start', {version: version.id, endpoint, estimateUsd, labelTest, testToLabel: toLabel.length});
  tm().counter('tsp_cost_confirms_total', {what: 'final_run', outcome: 'accepted'});
  tm().event('final_run_started', {version_id: version.id, slot: endpoint, label_test: labelTest, estimate_usd: estimateUsd});
  void labeling.runTask(task.id, 'user');
  emitChange();
  return ts;
}

export async function stopTrainingSet(tsId: string): Promise<void> {
  const {catalog, labeling} = getApp();
  const ts = await catalog.get('training_sets', tsId);
  if (!ts) return;
  await labeling.stopTask(ts.taskId);
  const task = await labeling.getTask(ts.taskId);
  tm().event('final_run_stopped_by_user', {done: task?.done ?? ts.done, total: task?.total ?? ts.total});
}

/**
 * The output rows: every train example the run labeled, and every test example. A test row's
 * label is its gold label when someone gave one, else this version's saved answer (from the run,
 * or from "Get model answers" on Gold Labels); a test example with neither has no label.
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
  const inTask = new Set(task.exampleIds);
  const rows: TrainingRow[] = [];
  for (const e of examples) {
    const p = preds.get(e.id);
    if (e.split === 'train') {
      if (!inTask.has(e.id) || !p) continue;
      rows.push({trainingSetId: ts.id, exampleId: e.id, split: 'train', answer: p.answer, labelSource: p.answer ? 'model' : null, model: p.answer, invalidReason: p.invalidReason, gold: null});
    } else if (e.split === 'test') {
      const g = gold.get(e.id)?.answer ?? null;
      const answer = g ?? p?.answer ?? null;
      rows.push({trainingSetId: ts.id, exampleId: e.id, split: 'test', answer, labelSource: g ? 'gold' : answer ? 'model' : null, model: p?.answer ?? null, invalidReason: p?.invalidReason ?? null, gold: g});
    }
  }
  return rows;
}

export async function getTrainingSet(tsId: string): Promise<TrainingSet | null> {
  const {catalog, labeling} = getApp();
  const ts = await catalog.get('training_sets', tsId);
  if (!ts) return null;
  return trainingView(ts, (await labeling.getTask(ts.taskId)) ?? undefined);
}
