import {renderPrompt} from '../../../../packages/contracts/src/template';
import type {EndpointId, EvalReport, PromptVersion, TrainingRow, TrainingSet} from '../../../../packages/contracts/src/types';
import {estimate, MIN_PER_VALUE, minutesFor} from '../../../../packages/contracts/src/workflow';
import {newId} from '../data/repo';
import {emitChange, getApp, now} from './app';
import {costOf, parseOutput, toMessages, withRetry} from './evaluation';
import {once} from './locks';
import {loadProjectState} from './projects';

export {estimate, MIN_PER_VALUE, minutesFor};

const active = new Map<string, AbortController>();
export const isTrainingActive = (tsId: string) => active.has(tsId);
export function stopTrainingSet(tsId: string) {
  active.get(tsId)?.abort();
}

/**
 * Generates the training set using sequential online calls from the open page (MVP has no batch API).
 * Completed rows are saved incrementally in `training_rows`, so a paused or stopped run can resume
 * without re-labeling examples that already finished.
 */
export async function startTrainingSet(
  projectId: string,
  version: PromptVersion,
  endpoint: EndpointId,
  report: EvalReport | null,
  estimateUsd: number,
  existing?: TrainingSet,
): Promise<TrainingSet> {
  const {repo, platform, user} = getApp();
  const state = (await loadProjectState(projectId))!;
  const settings = state.setup!.models.find(m => m.endpoint === endpoint)!;
  const train = state.examples.filter(e => e.split === 'train');
  const existingRows = existing ? await repo.trainingRows<TrainingRow>(existing.id) : [];
  const doneIds = new Set(existingRows.map(r => r.exampleId));

  const ts: TrainingSet = existing
    ? {
        ...existing,
        state: 'running',
        error: null,
        done: existingRows.length,
        labeled: existingRows.filter(r => r.answer).length,
        invalid: existingRows.filter(r => !r.answer).length,
        finishedAt: null,
      }
    : {
        id: newId('ts'),
        projectId,
        promptVersionId: version.id,
        endpoint,
        snapshotId: state.snapshot!.id,
        evaluated: !!report,
        reportId: report?.id ?? null,
        batchJobId: null,
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

  if (existing) await repo.update('training_sets', ts);
  else {
    await repo.insert('training_sets', ts);
    await repo.audit(projectId, (await user()).name, 'training_set.start', {version: version.id, endpoint, estimateUsd});
  }
  emitChange();

  void once(`training:${ts.id}`, async () => {
    const ctrl = new AbortController();
    active.set(ts.id, ctrl);
    try {
      for (const ex of train) {
        if (doneIds.has(ex.id)) continue;
        const parts = renderPrompt(version.template, ex, version.features, version.images);
        const res = await withRetry(
          () =>
            platform.models.chat({
              endpoint,
              messages: toMessages(parts),
              maxOutputTokens: settings.maxOutputTokens,
              temperature: settings.temperature,
              traceId: ex.externalId,
              signal: ctrl.signal,
            }),
          ctrl.signal,
        );
        const parsed = parseOutput(res.text, state.setup!.schema!);
        const cost = costOf(endpoint, res.inputTokens, res.outputTokens);
        const row: TrainingRow = {trainingSetId: ts.id, exampleId: ex.id, answer: parsed.answer, invalidReason: parsed.reason};
        await repo.insertTrainingRows([row]);
        doneIds.add(ex.id);
        ts.done++;
        if (parsed.answer) ts.labeled++;
        else ts.invalid++;
        ts.costUsd += cost;
        await repo.update('training_sets', ts);
        emitChange();
      }
      ts.state = 'done';
      ts.finishedAt = now();
    } catch (e) {
      const stopped = (e as Error).name === 'AbortError';
      ts.state = stopped ? 'stopped' : 'failed';
      ts.error = stopped ? null : `Model ${endpoint} failed after 3 tries: ${(e as Error).message}`;
      ts.finishedAt = now();
    } finally {
      await repo.update('training_sets', ts);
      active.delete(ts.id);
      emitChange();
    }
  });

  return ts;
}

export async function trainingRows(tsId: string): Promise<TrainingRow[]> {
  return getApp().repo.trainingRows<TrainingRow>(tsId);
}
