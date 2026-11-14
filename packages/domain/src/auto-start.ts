import {systemConfig} from './config.ts';
import type {EndpointId, ProjectState, PromptVersion} from '@tsp/contracts';
import {estimateTokens} from './labels.ts';
import {renderPrompt} from './template.ts';
import {costForTokens} from './workflow.ts';
import {canScore} from './gates.ts';

/**
 * Paid work that starts without a click: scoring a new version, resuming after a closed page,
 * and agent start tools. All of it starts by itself, with no cost limit: the cost can't be
 * predicted exactly, the platform is there to make training faster, and every running task has a
 * Stop button. The Optimiser is the exception: only the user starts it (Auto Optimise, decided
 * 2026-11-09), with a number of rounds.
 */

export type AutoStartWhat = 'score' | 'resume' | 'optimiser' | 'try_prompt';

/** Cost of labeling `n` eval examples (all of them by default) with a version on one model. */
export function evalEstimate(state: ProjectState, version: Pick<PromptVersion, 'template' | 'features' | 'images'>, endpoint: EndpointId, n?: number): number {
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const sample = evalEx.slice(0, 10);
  if (!sample.length) return 0;
  const avg = sample.map(ex => estimateTokens(renderPrompt(version.template, ex, version.features, version.images))).reduce((a, b) => a + b, 0) / sample.length;
  return costForTokens(state.endpoints, endpoint, avg, systemConfig().gateway.evalOutputTokensEstimate) * (n ?? evalEx.length);
}

/** At most what one optimiser run costs (for the audit log only): every round labeled on the eval set. */
export function optimiserEstimate(state: ProjectState, endpoint: EndpointId, rounds = systemConfig().optimiser.defaultMaxRounds): number {
  const v = state.versions[0];
  return v ? evalEstimate(state, v, endpoint) * rounds : 0;
}

/**
 * What automatic starts have spent in this project, for the audit log and telemetry: every
 * labeling run started by code (scoring, resumes, optimiser parents and candidates; counted per
 * run, so an automatic resume of a task a user started counts too) plus try_prompt runs,
 * which leave no task.
 */
export function autoSpendUsd(state: ProjectState): number {
  return state.runs.reduce((n, r) => n + (r.autoCostUsd ?? 0), 0) + (state.otherAutoSpendUsd ?? 0);
}

export interface DueStart {
  what: 'score' | 'resume';
  versionId: string | null;
  endpoint: EndpointId;
  estimateUsd: number;
  /** Stable key: one start per key at a time. */
  key: string;
}

/**
 * Paid work the workflow would start now: scoring the newest version on the project's model, and
 * resuming scoring a closed page left. `tick` starts all of it. The Optimiser never starts here.
 *
 * Nothing starts by itself (spec 1.0.0, 2.5) until the eval dataset exists, enough of it has gold
 * labels to score (`canScore`), and the user has confirmed Project Settings. Prompt Design makes
 * v1 before any of that, so v1 waits here. A click on Score is the user's own start and is not
 * held back by this.
 */
export function dueStarts(state: ProjectState): DueStart[] {
  const out: DueStart[] = [];
  const setup = state.setup;
  if (!setup?.schema) return out;
  if (!state.facts.settingsConfirmed || !canScore(state.facts)) return out;
  const models = setup.models.map(m => m.endpoint);

  for (const r of state.runs) {
    if (r.state !== 'paused' || !models.includes(r.endpoint)) continue;
    // Optimiser labeling resumes with its run (Retry), not by itself.
    if (state.optimisation.some(o => (o.history ?? []).some(h => h.versionId === r.promptVersionId))) continue;
    const v = state.versions.find(x => x.id === r.promptVersionId);
    if (!v) continue;
    const left = Math.max(0, r.total - r.done);
    out.push({what: 'resume', versionId: v.id, endpoint: r.endpoint, estimateUsd: evalEstimate(state, v, r.endpoint, left), key: `resume:${r.id}`});
  }

  const latest = state.versions[0];
  if (!latest || latest.madeBy === 'optimiser') return out;
  for (const m of models) {
    if (!state.runs.some(r => r.promptVersionId === latest.id && r.endpoint === m)) out.push({what: 'score', versionId: latest.id, endpoint: m, estimateUsd: evalEstimate(state, latest, m), key: `score:${latest.id}:${m}`});
  }
  return out;
}
