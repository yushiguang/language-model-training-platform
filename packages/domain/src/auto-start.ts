import type {EndpointId, ProjectState, PromptVersion} from '@tsp/contracts';
import {estimateTokens} from './labels.ts';
import {renderPrompt} from './template.ts';
import {costForTokens} from './workflow.ts';

/**
 * Paid work that starts without a click: scoring a new version, the optimiser, resuming after
 * a closed page, and agent start tools. Setup's "Start paid labeling automatically" switch turns
 * it on or off; these fixed caps always ask, whatever the switch says.
 */
export const AUTO_START_SINGLE_CAP_USD = 1;
/** Automatic starts in a project may spend this much in all; a start that would pass it asks. */
export const AUTO_START_PROJECT_CAP_USD = 5;
/** Optimiser candidates per run. */
export const OPTIMISER_CANDIDATES = 6;
/** The prompt agent's try_template labels at most this many eval examples. */
export const TRY_TEMPLATE_MAX = 5;

export type AutoStartWhat = 'score' | 'resume' | 'optimiser' | 'try_template';

/** Cost of labeling `n` eval examples (all of them by default) with a version on one model. */
export function evalEstimate(state: ProjectState, version: Pick<PromptVersion, 'template' | 'features' | 'images'>, endpoint: EndpointId, n?: number): number {
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const sample = evalEx.slice(0, 10);
  if (!sample.length) return 0;
  const avg = sample.map(ex => estimateTokens(renderPrompt(version.template, ex, version.features, version.images))).reduce((a, b) => a + b, 0) / sample.length;
  return costForTokens(state.endpoints, endpoint, avg, 150) * (n ?? evalEx.length);
}

/** About what one optimiser run costs: each candidate is labeled on the eval set. */
export function optimiserEstimate(state: ProjectState, endpoint: EndpointId, candidates = OPTIMISER_CANDIDATES): number {
  const v = state.versions[0];
  return v ? evalEstimate(state, v, endpoint) * candidates : 0;
}

/**
 * What automatic starts have spent in this project: every labeling run started by code (scoring,
 * resumes, optimiser parents and candidates; counted per run, so an automatic resume of a task a
 * user started counts too) plus try_template runs, which leave no task.
 */
export function autoSpendUsd(state: ProjectState): number {
  return state.runs.reduce((n, r) => n + (r.autoCostUsd ?? 0), 0) + (state.otherAutoSpendUsd ?? 0);
}

export type AutoStartReason = 'off' | 'over_single_cap' | 'over_project_cap' | 'paused_over_budget';

/**
 * May this start go ahead without asking? `reservedUsd`: estimates of automatic starts already
 * going whose cost is not saved yet, so starts made one after another can't pass the $5 together.
 */
export function autoStartCheck(state: ProjectState, estimateUsd: number, reservedUsd = 0): {allowed: boolean; reason: AutoStartReason | null} {
  if (state.setup?.autoStart === false) return {allowed: false, reason: 'off'};
  if (estimateUsd > AUTO_START_SINGLE_CAP_USD) return {allowed: false, reason: 'over_single_cap'};
  if (autoSpendUsd(state) + reservedUsd + estimateUsd > AUTO_START_PROJECT_CAP_USD) return {allowed: false, reason: 'over_project_cap'};
  return {allowed: true, reason: null};
}

export interface DueStart {
  what: 'score' | 'resume' | 'optimiser';
  versionId: string | null;
  endpoint: EndpointId;
  estimateUsd: number;
  /** Stable key, for "asked once" bookkeeping. */
  key: string;
  /** A resume of scoring that paused because it cost more than 120% of its estimate. */
  overBudget?: boolean;
}

/** `autoStartCheck` for a due start: a resume after an over-budget pause always asks. */
export function dueStartCheck(state: ProjectState, d: DueStart, reservedUsd = 0): {allowed: boolean; reason: AutoStartReason | null} {
  if (d.overBudget) return {allowed: false, reason: 'paused_over_budget'};
  return autoStartCheck(state, d.estimateUsd, reservedUsd);
}

/**
 * Paid work the workflow would start now: scoring the newest version on each chosen model,
 * resuming scoring a closed page left, and an optimiser run for a model with no passing version
 * once the eval set is gold-labeled. `tick` starts what `autoStartCheck` allows; pages show a
 * button with the cost for the rest.
 */
export function dueStarts(state: ProjectState, opts: {optimiserBusy?: boolean} = {}): DueStart[] {
  const out: DueStart[] = [];
  const setup = state.setup;
  if (!setup?.schema) return out;
  const models = setup.models.map(m => m.endpoint);

  for (const r of state.runs) {
    if (r.state !== 'paused' || !models.includes(r.endpoint)) continue;
    const v = state.versions.find(x => x.id === r.promptVersionId);
    if (!v) continue;
    const left = Math.max(0, r.total - r.done);
    out.push({what: 'resume', versionId: v.id, endpoint: r.endpoint, estimateUsd: evalEstimate(state, v, r.endpoint, left), key: `resume:${r.id}`, ...(r.overBudget ? {overBudget: true} : {})});
  }

  const latest = state.versions[0];
  if (!latest) return out;
  for (const m of models) {
    if (!state.runs.some(r => r.promptVersionId === latest.id && r.endpoint === m)) out.push({what: 'score', versionId: latest.id, endpoint: m, estimateUsd: evalEstimate(state, latest, m), key: `score:${latest.id}:${m}`});
  }

  if (!setup.thresholds) return out;
  const evalSize = state.snapshot?.split?.eval ?? 0;
  if (state.facts.goldEvalDone < evalSize || opts.optimiserBusy || state.optimisation.some(o => o.state === 'running')) return out;
  for (const m of models) {
    const current = state.reports.filter(r => r.endpoint === m && !r.archivedNow);
    if (current.some(r => r.passed)) continue;
    if (!current.find(r => r.promptVersionId === latest.id) && !current[0]) continue;
    const anchor = state.versions.find(v => v.madeBy !== 'optimiser') ?? latest;
    if (state.optimisation.some(o => o.endpoint === m && o.startedAt >= anchor.createdAt)) continue;
    if (state.optimisation.some(o => o.endpoint === m && (o.state === 'paused' || o.state === 'failed'))) continue;
    out.push({what: 'optimiser', versionId: null, endpoint: m, estimateUsd: optimiserEstimate(state, m), key: `optimiser:${m}:${anchor.id}`});
    break; // one optimiser at a time
  }
  return out;
}
