import {systemConfig} from './config.ts';
import {renderPrompt} from './template.ts';
import type {Actor, AgentPreset, EndpointId, EndpointInfo, FeatureSelection, ProjectState, PromptImage, PromptVersion} from '@tsp/contracts';
import {versionLabel} from './versions.ts';
import {estimateTokens} from './labels.ts';
import {judge} from './metrics.ts';
import type {Metrics, Thresholds} from '@tsp/contracts';

/** Names the check a report fails: the lowest field can be above its bar while another check is not. */
function whyBelow(m: Metrics, t: Thresholds, evalCount: number): string {
  const lw = m.lowestField;
  const failing = judge(m, t, evalCount).checks.find(c => !c.met);
  if (lw.macroF1 < t.macroF1 || !failing) return ` at ${lw.macroF1.toFixed(2)} on ${lw.field}, below ${t.macroF1.toFixed(2)}.`;
  if (failing.label === 'Lowest value F1' && m.lowestValue)
    return `: every field is at ${t.macroF1.toFixed(2)} or higher, but "${m.lowestValue.value}" of ${m.lowestValue.field} is at ${m.lowestValue.f1.toFixed(2)}, below ${t.valueF1!.toFixed(2)}.`;
  return `: every field is at ${t.macroF1.toFixed(2)} or higher, but ${failing.label.toLowerCase()} is ${failing.actual} (needs ${failing.need}).`;
}

export const MADE_BY: Record<Actor, string> = {
  user: 'You',
  prompt_agent: 'Prompt helper',
  optimiser: 'Optimiser',
  schema_agent: 'Labels helper',
  system: 'System',
};

/** The helpers' names in Ask AI (plain words; the presets keep their technical ids). */
const AGENT_NAMES: Record<AgentPreset, string> = {
  front_desk: 'Assistant',
  schema_agent: 'Labels helper',
  prompt_agent: 'Prompt helper',
  evaluation_agent: 'Scores helper',
};

export const agentName = (preset: AgentPreset): string => AGENT_NAMES[preset];

/**
 * Values with fewer labeled train examples than this get a warning on the finished training set.
 * Open question in the product design ([MIN PER VALUE]); 5 is a placeholder until it is decided.
 */
export const MIN_PER_VALUE = 5;

/** Measured labeling speed: about 30 minutes per 3,000 examples. */
export const minutesFor = (n: number) => Math.max(1, Math.round(n / 100));

export function costForTokens(endpoints: EndpointInfo[], endpoint: EndpointId, inputTokens: number, outputTokens: number): number {
  const ep = endpoints.find(e => e.id === endpoint);
  if (!ep) return 0;
  return (inputTokens * ep.priceIn + outputTokens * ep.priceOut) / 1e6;
}

/** Cost and time to label the eval set with a draft on every chosen model, from rendered prompts. */
export function estimateLabeling(state: ProjectState, draft: {template: string; features: FeatureSelection; images: PromptImage[]}) {
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const sample = evalEx.slice(0, 10);
  let costUsd = 0;
  for (const m of state.setup?.models ?? []) {
    const tokens = sample.map(ex =>
      estimateTokens(renderPrompt(draft.template, ex, draft.features, draft.images)),
    );
    const avg = tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0;
    costUsd += costForTokens(state.endpoints, m.endpoint, avg, systemConfig().gateway.evalOutputTokensEstimate) * evalEx.length;
  }
  return {count: evalEx.length, costUsd, minutes: minutesFor(evalEx.length)};
}

/**
 * Cost and time estimate for labeling splits with a version on one model. The final run labels
 * train and test together; "Get model answers" on Gold Labels labels test only. Test examples
 * that already have a prediction for this version, model and settings are free (`reused`).
 */
export function estimate(state: ProjectState, version: PromptVersion, endpoint: EndpointId, splits: ('train' | 'test')[] = ['train', 'test'], alreadyLabeled: ReadonlySet<string> = new Set()) {
  const all = state.examples.filter(e => (splits as string[]).includes(e.split ?? ''));
  const todo = all.filter(e => !alreadyLabeled.has(e.id));
  const train = all.filter(e => e.split === 'train').length;
  const test = all.length - train;
  const report = state.reports.find(r => r.promptVersionId === version.id && r.endpoint === endpoint && !r.archivedNow);
  let per1000 = report?.metrics.costPer1000;
  if (!per1000) {
    const sample = (all.length ? all : state.examples).slice(0, 20);
    const tokens = sample.map(ex => {
      const parts = renderPrompt(version.template, ex, version.features, version.images);
      return estimateTokens(parts);
    });
    per1000 = sample.length ? costForTokens(state.endpoints, endpoint, tokens.reduce((a, b) => a + b, 0) / sample.length, systemConfig().gateway.evalOutputTokensEstimate) * 1000 : 0;
  }
  return {count: all.length, train, test, reused: all.length - todo.length, costUsd: (per1000 * todo.length) / 1000, minutes: todo.length ? minutesFor(todo.length) : 0, per1000, report: report ?? null};
}

/**
 * What the final run does with the test set. A test example's label is its gold label when
 * someone gave one, else the chosen version's saved answer; only examples with neither need the
 * model, and only when the user ticks "label the rest" in the confirm.
 */
export function finalRunPlan(state: ProjectState, version: PromptVersion, endpoint: EndpointId, answered: ReadonlySet<string> = new Set()) {
  const train = estimate(state, version, endpoint, ['train'], answered);
  const test = state.examples.filter(e => e.split === 'test');
  const withGold = test.filter(e => !!state.gold[e.id]).map(e => e.id);
  const withAnswer = test.filter(e => !state.gold[e.id] && answered.has(e.id)).map(e => e.id);
  const toLabel = test.filter(e => !state.gold[e.id] && !answered.has(e.id)).map(e => e.id);
  const testCostUsd = (train.per1000 * toLabel.length) / 1000;
  return {
    train,
    test: {total: test.length, withGold, withAnswer, toLabel, costUsd: testCostUsd},
    per1000: train.per1000,
    report: train.report,
    /** Cost and minutes for the train set plus, if `labelTest`, the test examples with no label. */
    total(labelTest: boolean) {
      const n = train.count - train.reused + (labelTest ? toLabel.length : 0);
      return {costUsd: train.costUsd + (labelTest ? testCostUsd : 0), minutes: n ? minutesFor(n) : 0, count: n};
    },
  };
}

/** Per chosen model: its best passing version (else its best scored, else the newest version). */
export function outputCandidates(state: ProjectState) {
  return (state.setup?.models ?? []).map(m => {
    const mine = state.reports.filter(r => r.endpoint === m.endpoint && !r.archivedNow);
    const passing = mine.filter(r => r.passed).sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
    const best = [...mine].sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
    const version = state.versions.find(v => v.id === (passing ?? best)?.promptVersionId) ?? state.versions[0];
    return {endpoint: m.endpoint, version, passing: passing ?? null, best: best ?? null};
  });
}

/** The version and model the outputs would use now: the first passing candidate, else the first model's. */
export function defaultOutputPick(state: ProjectState): {endpoint: EndpointId; version: PromptVersion} | null {
  const cands = outputCandidates(state).filter(c => c.version);
  const c = cands.find(x => x.passing) ?? cands[0];
  return c ? {endpoint: c.endpoint, version: c.version!} : null;
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
      title: `Make the training and test sets with ${versionLabel(latest)}`,
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
    // The best score wins, as on Training Set (review finding 11); cost only breaks a tie.
    const pick = [...passing].sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1 || a.metrics.costPer1000 - b.metrics.costPer1000)[0];
    const m = pick.metrics;
    const reasons = [
      `All ${m.fields.length} fields are at ${t.macroF1.toFixed(2)} or higher${s.setup!.models.length > 1 ? ` on Model ${pick.endpoint}` : ''}${t.valueF1 != null ? `, and every value is above ${t.valueF1.toFixed(2)}` : ''}.`,
    ];
    const other = s.setup!.models.find(x => x.endpoint !== pick.endpoint);
    if (other) {
      const best = current.filter(r => r.endpoint === other.endpoint).sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
      if (best && !best.passed) reasons.push(`Model ${other.endpoint} is not there yet: its best${whyBelow(best.metrics, t, evalSize)}`);
    }
    return {
      kind: 'make_training_set',
      title: `Make the training and test sets with ${name(pick.promptVersionId)}${s.setup!.models.length > 1 ? ` on Model ${pick.endpoint}` : ''}`,
      reasons,
      versionId: pick.promptVersionId,
      endpoint: pick.endpoint,
    };
  }
  if (optimiserRunning)
    return {
      kind: 'wait',
      title: 'The Optimiser is improving the prompt',
      reasons: ['No version passes yet. Each change it tries appears in the versions list.'],
      versionId: null,
      endpoint: optimiserRunning,
    };
  const best = [...current].sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
  if (!best) return {kind: 'score_first', title: 'Score a version on the eval set', reasons: ['Labeling runs on the eval set, then scores appear here.'], versionId: latest.id, endpoint: null};
  const mu = best.metrics.mixUps[0];
  // The card's title names what holds the best version back; its one line names the top mix-up.
  return {
    kind: 'keep_improving',
    title: `${best.metrics.lowestField.field} holds ${name(best.promptVersionId)} back`,
    reasons: [
      mu
        ? mu.kind === 'confused'
          ? `${mu.gold} is often read as ${mu.predicted}`
          : mu.kind === 'extra'
            ? `${mu.predicted} is often added when it does not apply`
            : `${mu.gold} is often missed`
        : `Best so far is ${name(best.promptVersionId)}${whyBelow(best.metrics, t, evalSize)}`,
      `Best so far is ${name(best.promptVersionId)}${whyBelow(best.metrics, t, evalSize)}`,
    ],
    versionId: best.promptVersionId,
    endpoint: best.endpoint,
  };
}

/**
 * Scores are being rebuilt (acceptance R5-4, R5-5): a gold edit changed the evaluation context, so
 * a version that had a report has none for today's gold labels yet. The rebuild reads saved
 * answers only. False while some eval example has no gold label (nothing can be scored then), and
 * for a version whose saved answers do not cover today's eval set (`cannotBuild`: the bff's
 * record of "versionId|endpoint|contextId" it tried).
 */
export function scoresUpdating(s: Omit<ProjectState, 'scoresUpdating'>, cannotBuild: ReadonlySet<string> = new Set()): boolean {
  const evalEx = s.examples.filter(e => e.split === 'eval');
  if (!s.setup?.schema || !evalEx.length || evalEx.some(e => !s.gold[e.id])) return false;
  const current = new Set(s.reports.filter(r => !r.archivedNow).map(r => `${r.promptVersionId}|${r.endpoint}`));
  return s.reports.some(
    r =>
      r.archivedNow &&
      r.schemaVersion === s.setup!.schemaVersion &&
      !current.has(`${r.promptVersionId}|${r.endpoint}`) &&
      !cannotBuild.has(`${r.promptVersionId}|${r.endpoint}|${s.contextId}`) &&
      s.versions.some(v => v.id === r.promptVersionId),
  );
}
