import {computeMetrics, type Scored} from '../core/metrics';
import {hashString, renderPrompt, type Part} from '../core/template';
import type {Answer, EndpointId, EvalReport, Example, GoldLabel, LabelingRun, ModelSettings, Prediction, PromptVersion, Schema, SetupVersion} from '../core/types';
import {newId} from '../data/repo';
import type {ContentPart, ModelMessage} from '../platform/interfaces';
import {emitChange, getApp, now} from './app';

/** Latest gold label per example for the current schema; older-schema labels are kept as hints. */
export async function latestGold(projectId: string, schemaVersion: number) {
  const all = await getApp().repo.find<GoldLabel>('gold_labels', {project_id: projectId}, 'created_at');
  const current = new Map<string, GoldLabel>();
  const stale = new Map<string, GoldLabel>();
  for (const g of all) (g.schemaVersion === schemaVersion ? current : stale).set(g.exampleId, g);
  for (const id of current.keys()) stale.delete(id);
  return {current, stale};
}

/** Evaluation context = schema version + eval examples + their gold labels. Thresholds re-judge without new labeling. */
export function contextIdFor(schemaVersion: number, evalExamples: Example[], gold: Map<string, GoldLabel>): string {
  const parts = evalExamples
    .map(e => `${e.id}:${gold.get(e.id)?.id ?? '-'}`)
    .sort()
    .join(',');
  return `ctx_${hashString(`${schemaVersion}|${parts}`)}`;
}

export const settingsHash = (s: ModelSettings) => hashString(`${s.maxOutputTokens}|${s.temperature ?? 'na'}`);

export function toMessages(parts: Part[]): ModelMessage[] {
  const content: ContentPart[] = parts.map(p => (p.type === 'text' ? {type: 'text', text: p.text} : {type: 'image', url: absoluteUrl(p.url)}));
  return [{role: 'user', content}];
}

function absoluteUrl(url: string): string {
  if (/^(https?:|data:)/.test(url) || typeof location === 'undefined') return url;
  return new URL(url, location.origin + (process.env.NEXT_PUBLIC_BASE_PATH ?? '') + '/').toString();
}

/** Reads a model answer. Anything that isn't valid JSON with values from the schema is invalid. */
export function parseOutput(text: string, schema: Schema): {answer: Answer | null; reason: string | null} {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {answer: null, reason: 'Not valid JSON'};
  }
  const answer: Answer = {};
  for (const f of schema.fields) {
    const raw = obj[f.name];
    const list = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String);
    const names = f.values.map(v => v.name);
    const bad = list.find(v => !names.includes(v));
    if (bad) return {answer: null, reason: `"${bad}" isn't a value of ${f.name}`};
    if (f.kind === 'single' && list.length !== 1) return {answer: null, reason: `${f.name} needs exactly one value`};
    if (f.kind === 'multi' && (list.length < (f.min ?? 1) || list.length > (f.max ?? names.length))) return {answer: null, reason: `${f.name} needs ${f.min ?? 1} to ${f.max ?? names.length} values`};
    answer[f.name] = list;
  }
  return {answer, reason: null};
}

export function costOf(endpoint: EndpointId, inputTokens: number, outputTokens: number): number {
  const ep = getApp().platform.models.endpoints().find(e => e.id === endpoint)!;
  return (inputTokens * ep.priceIn + outputTokens * ep.priceOut) / 1e6;
}

const active = new Map<string, AbortController>();
export const isActive = (runId: string) => active.has(runId);
export function stopRun(runId: string) {
  active.get(runId)?.abort();
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
    try {
      return await fn();
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      last = e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

/**
 * Labels every eval example with one prompt version on one model, from the open page.
 * Predictions are cached per (version, model, settings, example), so a rerun only labels
 * what is missing. Closing the page pauses the run; Rerun picks it up.
 */
export async function runLabeling(projectId: string, setup: SetupVersion, version: PromptVersion, endpoint: EndpointId, examples: Example[], existing?: LabelingRun): Promise<LabelingRun> {
  const {repo, platform} = getApp();
  const settings = setup.models.find(m => m.endpoint === endpoint)!;
  const sh = settingsHash(settings);
  const evalExamples = examples.filter(e => e.split === 'eval');
  const run: LabelingRun = existing
    ? {...existing, state: 'running', error: null}
    : {id: newId('lr'), projectId, promptVersionId: version.id, endpoint, state: 'running', done: 0, total: evalExamples.length, costUsd: 0, error: null, startedAt: now(), finishedAt: null};
  if (existing) await repo.update('labeling_runs', run);
  else await repo.insert('labeling_runs', run);
  const ctrl = new AbortController();
  active.set(run.id, ctrl);
  emitChange();
  try {
    const cached = new Set((await repo.find<Prediction>('predictions', {prompt_version_id: version.id, endpoint, settings_hash: sh})).map(p => p.exampleId));
    run.done = cached.size;
    for (const ex of evalExamples) {
      if (cached.has(ex.id)) continue;
      const parts = renderPrompt(version.template, ex, version.features, version.images);
      const res = await withRetry(
        () => platform.models.chat({endpoint, messages: toMessages(parts), maxOutputTokens: settings.maxOutputTokens, temperature: settings.temperature, traceId: ex.externalId, signal: ctrl.signal}),
        ctrl.signal,
      );
      const parsed = parseOutput(res.text, setup.schema!);
      const cost = costOf(endpoint, res.inputTokens, res.outputTokens);
      const pred: Prediction = {id: newId('pd'), promptVersionId: version.id, endpoint, settingsHash: sh, exampleId: ex.id, output: res.text, answer: parsed.answer, invalidReason: parsed.reason, costUsd: cost, createdAt: now()};
      await repo.insert('predictions', pred);
      run.done++;
      run.costUsd += cost;
      if (run.done % 5 === 0) {
        await repo.update('labeling_runs', run);
        emitChange();
      }
    }
    run.state = 'done';
    run.finishedAt = now();
  } catch (e) {
    run.state = (e as Error).name === 'AbortError' ? 'stopped' : 'failed';
    run.error = run.state === 'failed' ? `Model ${endpoint} didn't respond after 3 tries. Last error: ${(e as Error).message}` : null;
  } finally {
    // Save the end state before leaving `active`, so `tick` never mistakes it for a closed page's run.
    await repo.update('labeling_runs', run);
    active.delete(run.id);
    emitChange();
  }
  return run;
}

/**
 * Builds the report for a version on a model, once the eval set is fully labeled with gold
 * labels and the run is done. Scores use only the held-out half of the eval set.
 */
export async function buildReport(projectId: string, setup: SetupVersion, version: PromptVersion, endpoint: EndpointId, examples: Example[], gold: Map<string, GoldLabel>, contextId: string): Promise<EvalReport | null> {
  const {repo} = getApp();
  const evalExamples = examples.filter(e => e.split === 'eval');
  if (!setup.schema || !evalExamples.length || evalExamples.some(e => !gold.has(e.id))) return null;
  const existing = await repo.find<EvalReport>('eval_reports', {project_id: projectId, prompt_version_id: version.id, endpoint, context_id: contextId});
  if (existing.length) return existing[0];
  const settings = setup.models.find(m => m.endpoint === endpoint)!;
  const preds = await repo.find<Prediction>('predictions', {prompt_version_id: version.id, endpoint, settings_hash: settingsHash(settings)});
  const byExample = new Map(preds.map(p => [p.exampleId, p]));
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
  await repo.insert('eval_reports', report);
  emitChange();
  return report;
}

/** Scores a candidate on the optimiser's own half (used inside the optimiser loop only). */
export async function scoreOnOptimiserHalf(setup: SetupVersion, version: PromptVersion, endpoint: EndpointId, examples: Example[], gold: Map<string, GoldLabel>) {
  const {repo} = getApp();
  const settings = setup.models.find(m => m.endpoint === endpoint)!;
  const preds = await repo.find<Prediction>('predictions', {prompt_version_id: version.id, endpoint, settings_hash: settingsHash(settings)});
  const byExample = new Map(preds.map(p => [p.exampleId, p]));
  const half = examples.filter(e => e.split === 'eval' && e.optimiserHalf && byExample.has(e.id) && gold.has(e.id));
  return computeMetrics(
    setup.schema!,
    half.map(e => ({exampleId: e.id, gold: gold.get(e.id)!.answer, predicted: byExample.get(e.id)!.answer, costUsd: byExample.get(e.id)!.costUsd})),
  );
}

export async function predictionsFor(versionId: string, endpoint: EndpointId, settings: ModelSettings): Promise<Map<string, Prediction>> {
  const preds = await getApp().repo.find<Prediction>('predictions', {prompt_version_id: versionId, endpoint, settings_hash: settingsHash(settings)});
  return new Map(preds.map(p => [p.exampleId, p]));
}
