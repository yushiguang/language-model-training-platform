import {renderPrompt} from '../core/template';
import type {EndpointId, EvalReport, PromptVersion, TrainingRow, TrainingSet} from '../core/types';
import {newId} from '../data/repo';
import {emitChange, getApp, now} from './app';
import {costOf, parseOutput, toMessages} from './evaluation';
import type {ProjectState} from './projects';

/**
 * Values with fewer labeled train examples than this get a warning on the finished training set.
 * Open question in the product design ([MIN PER VALUE]); 5 is a placeholder until it is decided.
 */
export const MIN_PER_VALUE = 5;

/** Measured labeling speed: about 30 minutes per 3,000 examples. */
export const minutesFor = (n: number) => Math.max(1, Math.round(n / 100));

export function estimate(state: ProjectState, version: PromptVersion, endpoint: EndpointId) {
  const train = state.examples.filter(e => e.split === 'train');
  const report = state.reports.find(r => r.promptVersionId === version.id && r.endpoint === endpoint && !r.archivedNow);
  let per1000 = report?.metrics.costPer1000;
  if (!per1000) {
    // No report (no evaluation): estimate from rendered prompts of a sample.
    const sample = train.slice(0, 20);
    const tokens = sample.map(ex => {
      const parts = renderPrompt(version.template, ex, version.features, version.images);
      return parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length / 4 : 258), 0);
    });
    per1000 = sample.length ? (costOf(endpoint, tokens.reduce((a, b) => a + b, 0) / sample.length, 150) * 1000) : 0;
  }
  return {count: train.length, costUsd: (per1000 * train.length) / 1000, minutes: minutesFor(train.length), per1000, report: report ?? null};
}

export async function startTrainingSet(state: ProjectState, version: PromptVersion, endpoint: EndpointId, report: EvalReport | null, estimateUsd: number): Promise<TrainingSet> {
  const {repo, platform, user} = getApp();
  const settings = state.setup!.models.find(m => m.endpoint === endpoint)!;
  const train = state.examples.filter(e => e.split === 'train');
  const {jobId} = await platform.batch.submit({
    endpoint,
    maxOutputTokens: settings.maxOutputTokens,
    temperature: settings.temperature,
    requests: train.map(ex => ({id: ex.externalId, messages: toMessages(renderPrompt(version.template, ex, version.features, version.images))})),
  });
  const ts: TrainingSet = {
    id: newId('ts'),
    projectId: state.project.id,
    promptVersionId: version.id,
    endpoint,
    snapshotId: state.snapshot!.id,
    evaluated: !!report,
    reportId: report?.id ?? null,
    batchJobId: jobId,
    state: 'running',
    total: train.length,
    done: 0,
    labeled: 0,
    invalid: 0,
    costUsd: 0,
    estimateUsd,
    error: null,
    startedAt: now(),
    finishedAt: null,
  };
  await repo.insert('training_sets', ts);
  await repo.audit(state.project.id, (await user()).name, 'training_set.start', {version: version.id, endpoint, estimateUsd});
  emitChange();
  return ts;
}

/** Submit, then poll: the page can close while the batch job runs. */
export async function pollTrainingSet(state: ProjectState, ts: TrainingSet): Promise<TrainingSet> {
  const {repo, platform} = getApp();
  if (ts.state !== 'running' || !ts.batchJobId) return ts;
  const st = await platform.batch.status(ts.batchJobId);
  const next: TrainingSet = {...ts, done: st.done};
  if (st.state === 'failed') Object.assign(next, {state: 'failed', error: st.error ?? 'The batch job failed.'});
  if (st.state === 'done') {
    const results = await platform.batch.results(ts.batchJobId);
    const byExt = new Map(state.examples.map(e => [e.externalId, e]));
    const rows: TrainingRow[] = [];
    let cost = 0;
    for (const r of results) {
      const ex = byExt.get(r.id);
      if (!ex) continue;
      if (!r.ok) {
        rows.push({trainingSetId: ts.id, exampleId: ex.id, answer: null, invalidReason: r.error});
        continue;
      }
      cost += costOf(ts.endpoint, r.result.inputTokens, r.result.outputTokens);
      const parsed = parseOutput(r.result.text, state.setup!.schema!);
      rows.push({trainingSetId: ts.id, exampleId: ex.id, answer: parsed.answer, invalidReason: parsed.reason});
    }
    await insertRows(rows);
    Object.assign(next, {state: 'done', labeled: rows.filter(r => r.answer).length, invalid: rows.filter(r => !r.answer).length, costUsd: cost, finishedAt: now()});
  }
  if (JSON.stringify(next) !== JSON.stringify(ts)) {
    await repo.update('training_sets', next);
    emitChange();
  }
  return next;
}

async function insertRows(rows: TrainingRow[]) {
  const {repo} = getApp();
  await repo.insertTrainingRows(rows);
}

export async function stopTrainingSet(ts: TrainingSet) {
  const {repo, platform} = getApp();
  if (ts.batchJobId) await platform.batch.cancel(ts.batchJobId);
  await repo.update('training_sets', {...ts, state: 'stopped', finishedAt: now()});
  emitChange();
}

export async function trainingRows(tsId: string): Promise<TrainingRow[]> {
  return getApp().repo.trainingRows<TrainingRow>(tsId);
}
