import type {WorkflowFacts} from './gates.ts';
import {renderPrompt} from './template.ts';
import type {
  Actor,
  AgentPreset,
  DatasetSnapshot,
  EndpointId,
  EndpointInfo,
  EvalReport,
  Example,
  FeatureSelection,
  GoldLabel,
  LabelingRun,
  OptimisationRun,
  Project,
  PromptImage,
  PromptVersion,
  SamplingTask,
  SetupVersion,
  TrainingSet,
} from './types.ts';
import {versionLabel} from './versions.ts';

/** Everything a page needs about one project, read in one go. */
export interface ProjectState {
  project: Project;
  setup: SetupVersion | null;
  snapshot: DatasetSnapshot | null;
  examples: Example[];
  gold: Map<string, GoldLabel>;
  staleGold: Map<string, GoldLabel>;
  versions: PromptVersion[];
  reports: (EvalReport & {passed: boolean; archivedNow: boolean})[];
  runs: LabelingRun[];
  optimisation: OptimisationRun[];
  trainingSets: TrainingSet[];
  facts: WorkflowFacts;
  contextId: string;
  /** Available preset endpoints from the model runtime. */
  endpoints: EndpointInfo[];
  /** Active or recently finished sampling task, if any. */
  samplingTask: SamplingTask | null;
}

export const MADE_BY: Record<Actor, string> = {
  user: 'You',
  prompt_agent: 'Prompt agent',
  optimiser: 'Optimiser',
  schema_agent: 'Schema agent',
  system: 'System',
};

const AGENT_NAMES: Record<AgentPreset, string> = {
  front_desk: 'Front desk',
  schema_agent: 'Schema agent',
  prompt_agent: 'Prompt agent',
  evaluation_agent: 'Evaluation agent',
};

export const agentName = (preset: AgentPreset): string => AGENT_NAMES[preset];

/**
 * Values with fewer labeled train examples than this get a warning on the finished training set.
 * Open question in the product design ([MIN PER VALUE]); 5 is a placeholder until it is decided.
 */
export const MIN_PER_VALUE = 5;

/** Measured labeling speed: about 30 minutes per 3,000 examples. */
export const minutesFor = (n: number) => Math.max(1, Math.round(n / 100));

const DEFAULT_PRICE: Record<EndpointId, {priceIn: number; priceOut: number}> = {
  A: {priceIn: 1.2, priceOut: 4.8},
  B: {priceIn: 0.7, priceOut: 2.8},
};

export function costForTokens(endpoints: EndpointInfo[], endpoint: EndpointId, inputTokens: number, outputTokens: number): number {
  const ep = endpoints.find(e => e.id === endpoint) ?? DEFAULT_PRICE[endpoint];
  return (inputTokens * ep.priceIn + outputTokens * ep.priceOut) / 1e6;
}

/** Cost and time to label the eval set with a draft on every chosen model, from rendered prompts. */
export function estimateLabeling(state: ProjectState, draft: {template: string; features: FeatureSelection; images: PromptImage[]}) {
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const sample = evalEx.slice(0, 10);
  let costUsd = 0;
  for (const m of state.setup?.models ?? []) {
    const tokens = sample.map(ex =>
      renderPrompt(draft.template, ex, draft.features, draft.images).reduce((n, p) => n + (p.type === 'text' ? p.text.length / 4 : 258), 0),
    );
    const avg = tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0;
    costUsd += costForTokens(state.endpoints, m.endpoint, avg, 150) * evalEx.length;
  }
  return {count: evalEx.length, costUsd, minutes: minutesFor(evalEx.length)};
}

/** Cost and time estimate for generating a training set on one model. */
export function estimate(state: ProjectState, version: PromptVersion, endpoint: EndpointId) {
  const train = state.examples.filter(e => e.split === 'train');
  const report = state.reports.find(r => r.promptVersionId === version.id && r.endpoint === endpoint && !r.archivedNow);
  let per1000 = report?.metrics.costPer1000;
  if (!per1000) {
    const sample = train.slice(0, 20);
    const tokens = sample.map(ex => {
      const parts = renderPrompt(version.template, ex, version.features, version.images);
      return parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length / 4 : 258), 0);
    });
    per1000 = sample.length ? costForTokens(state.endpoints, endpoint, tokens.reduce((a, b) => a + b, 0) / sample.length, 150) * 1000 : 0;
  }
  return {count: train.length, costUsd: (per1000 * train.length) / 1000, minutes: minutesFor(train.length), per1000, report: report ?? null};
}

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
  if (!t)
    return {
      kind: 'no_eval',
      title: `Make the training set with ${versionLabel(latest)}`,
      reasons: ['Evaluation is off, so versions are not scored. The training set will be marked Not evaluated.'],
      versionId: latest.id,
      endpoint: s.setup!.models[0]?.endpoint ?? null,
    };
  const evalSize = s.snapshot?.split?.eval ?? 0;
  if (s.facts.goldEvalDone < evalSize)
    return {
      kind: 'label_gold',
      title: 'Label the eval set to start scoring',
      reasons: [`${s.facts.goldEvalDone} of ${evalSize} eval examples have gold labels. Scores and the optimiser start when all are labeled.`],
      versionId: null,
      endpoint: null,
    };
  const current = s.reports.filter(r => !r.archivedNow);
  const passing = current.filter(r => r.passed);
  const name = (id: string) => versionLabel(s.versions.find(v => v.id === id)!);
  if (passing.length) {
    const cheapest = [...passing].sort((a, b) => a.metrics.costPer1000 - b.metrics.costPer1000 || b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
    const m = cheapest.metrics;
    const reasons = [
      `All ${m.fields.length} fields are at ${t.macroF1.toFixed(2)} or higher${s.setup!.models.length > 1 ? ` on Model ${cheapest.endpoint}` : ''}${t.valueF1 != null ? `, and every value is above ${t.valueF1.toFixed(2)}` : ''}.`,
    ];
    const other = s.setup!.models.find(x => x.endpoint !== cheapest.endpoint);
    if (other) {
      const best = current.filter(r => r.endpoint === other.endpoint).sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
      if (best && !best.passed) reasons.push(`Model ${other.endpoint} is still below on ${best.metrics.lowestField.field} (${best.metrics.lowestField.macroF1.toFixed(2)}).`);
      else if (best?.passed) reasons.push(`Model ${cheapest.endpoint} costs less per 1,000 examples.`);
    }
    return {
      kind: 'make_training_set',
      title: `Make the training set with ${name(cheapest.promptVersionId)}${s.setup!.models.length > 1 ? ` on Model ${cheapest.endpoint}` : ''}`,
      reasons,
      versionId: cheapest.promptVersionId,
      endpoint: cheapest.endpoint,
    };
  }
  if (optimiserRunning)
    return {
      kind: 'wait',
      title: `The optimiser is improving the prompt for Model ${optimiserRunning}`,
      reasons: ['No version passes yet. New versions appear below as they are scored.'],
      versionId: null,
      endpoint: optimiserRunning,
    };
  const best = [...current].sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
  if (!best) return {kind: 'score_first', title: 'Score a version on the eval set', reasons: ['Labeling runs on the eval set, then scores appear here.'], versionId: latest.id, endpoint: null};
  const mu = best.metrics.mixUps[0];
  return {
    kind: 'keep_improving',
    title: 'Keep improving the prompt',
    reasons: [
      `Best so far is ${name(best.promptVersionId)} at ${best.metrics.lowestField.macroF1.toFixed(2)} on ${best.metrics.lowestField.field}, below ${t.macroF1.toFixed(2)}.`,
      ...(mu
        ? [`The most common mix-up: ${mu.kind === 'confused' ? `${mu.gold} tagged as ${mu.predicted}` : mu.kind === 'extra' ? `${mu.predicted} added when not needed` : `${mu.gold} missed`} (${mu.count}).`]
        : []),
    ],
    versionId: best.promptVersionId,
    endpoint: best.endpoint,
  };
}
