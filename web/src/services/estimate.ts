import {renderPrompt} from '../core/template';
import type {FeatureSelection, PromptImage} from '../core/types';
import {costOf} from './evaluation';
import type {ProjectState} from './projects';
import {minutesFor} from './training';

/** Cost and time to label the eval set with a draft on every chosen model, from rendered prompts. */
export function estimateLabeling(state: ProjectState, draft: {template: string; features: FeatureSelection; images: PromptImage[]}) {
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const sample = evalEx.slice(0, 10);
  let costUsd = 0;
  for (const m of state.setup?.models ?? []) {
    const tokens = sample.map(ex => renderPrompt(draft.template, ex, draft.features, draft.images).reduce((n, p) => n + (p.type === 'text' ? p.text.length / 4 : 258), 0));
    const avg = tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0;
    costUsd += costOf(m.endpoint, avg, 150) * evalEx.length;
  }
  return {count: evalEx.length, costUsd, minutes: minutesFor(evalEx.length)};
}
