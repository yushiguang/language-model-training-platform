import type {EndpointId} from '../core/types';
import {versionLabel} from '../core/versions';
import type {ProjectState} from './projects';

export interface Advice {
  kind: 'make_training_set' | 'label_gold' | 'wait' | 'keep_improving' | 'score_first' | 'no_eval';
  title: string;
  reasons: string[];
  versionId: string | null;
  endpoint: EndpointId | null;
}

/**
 * The next step is chosen by code from the reports; the evaluation agent only explains it.
 * Prefers the cheaper model when both pass.
 */
export function recommend(s: ProjectState, optimiserRunning: EndpointId | null): Advice {
  const t = s.setup?.thresholds;
  const latest = s.versions[0];
  if (!latest) return {kind: 'score_first', title: 'Create the first prompt version', reasons: [], versionId: null, endpoint: null};
  if (!t) return {kind: 'no_eval', title: `Make the training set with ${versionLabel(latest)}`, reasons: ['Evaluation is off, so versions are not scored. The training set will be marked Not evaluated.'], versionId: latest.id, endpoint: s.setup!.models[0]?.endpoint ?? null};
  const evalSize = s.snapshot?.split?.eval ?? 0;
  if (s.facts.goldEvalDone < evalSize)
    return {kind: 'label_gold', title: 'Label the eval set to start scoring', reasons: [`${s.facts.goldEvalDone} of ${evalSize} eval examples have gold labels. Scores and the optimiser start when all are labeled.`], versionId: null, endpoint: null};
  const current = s.reports.filter(r => !r.archivedNow);
  const passing = current.filter(r => r.passed);
  const name = (id: string) => versionLabel(s.versions.find(v => v.id === id)!);
  if (passing.length) {
    const cheapest = [...passing].sort((a, b) => a.metrics.costPer1000 - b.metrics.costPer1000 || b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
    const m = cheapest.metrics;
    const reasons = [`All ${m.fields.length} fields are at ${t.macroF1.toFixed(2)} or higher${s.setup!.models.length > 1 ? ` on Model ${cheapest.endpoint}` : ''}${t.valueF1 != null ? `, and every value is above ${t.valueF1.toFixed(2)}` : ''}.`];
    const other = s.setup!.models.find(x => x.endpoint !== cheapest.endpoint);
    if (other) {
      const best = current.filter(r => r.endpoint === other.endpoint).sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
      if (best && !best.passed) reasons.push(`Model ${other.endpoint} is still below on ${best.metrics.lowestField.field} (${best.metrics.lowestField.macroF1.toFixed(2)}).`);
      else if (best?.passed) reasons.push(`Model ${cheapest.endpoint} costs less per 1,000 examples.`);
    }
    return {kind: 'make_training_set', title: `Make the training set with ${name(cheapest.promptVersionId)}${s.setup!.models.length > 1 ? ` on Model ${cheapest.endpoint}` : ''}`, reasons, versionId: cheapest.promptVersionId, endpoint: cheapest.endpoint};
  }
  if (optimiserRunning) return {kind: 'wait', title: `The optimiser is improving the prompt for Model ${optimiserRunning}`, reasons: ['No version passes yet. New versions appear below as they are scored.'], versionId: null, endpoint: optimiserRunning};
  const best = [...current].sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
  if (!best) return {kind: 'score_first', title: 'Score a version on the eval set', reasons: ['Labeling runs on the eval set, then scores appear here.'], versionId: latest.id, endpoint: null};
  const mu = best.metrics.mixUps[0];
  return {
    kind: 'keep_improving',
    title: 'Keep improving the prompt',
    reasons: [
      `Best so far is ${name(best.promptVersionId)} at ${best.metrics.lowestField.macroF1.toFixed(2)} on ${best.metrics.lowestField.field}, below ${t.macroF1.toFixed(2)}.`,
      ...(mu ? [`The most common mix-up: ${mu.kind === 'confused' ? `${mu.gold} tagged as ${mu.predicted}` : mu.kind === 'extra' ? `${mu.predicted} added when not needed` : `${mu.gold} missed`} (${mu.count}).`] : []),
    ],
    versionId: best.promptVersionId,
    endpoint: best.endpoint,
  };
}
