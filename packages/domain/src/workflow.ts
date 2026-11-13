import {systemConfig} from './config.ts';
import type {Actor, AgentPreset, EndpointId, EndpointInfo, ProjectState} from '@tsp/contracts';
import {versionLabel} from './versions.ts';
import {judge} from './metrics.ts';

export const MADE_BY: Record<Actor, string> = {
  user: 'You',
  prompt_agent: 'Prompt helper',
  optimiser: 'Optimiser',
  system: 'System',
};

/** The helpers' names in Ask AI (plain words; the presets keep their technical ids). */
const AGENT_NAMES: Record<AgentPreset, string> = {
  front_desk: 'Assistant',
  prompt_agent: 'Prompt helper',
  evaluation_agent: 'Scores helper',
};

export const agentName = (preset: AgentPreset): string => AGENT_NAMES[preset];

export function costForTokens(endpoints: EndpointInfo[], endpoint: EndpointId, inputTokens: number, outputTokens: number): number {
  const ep = endpoints.find(e => e.id === endpoint);
  if (!ep) return 0;
  return (inputTokens * ep.priceIn + outputTokens * ep.priceOut) / 1e6;
}

/** The best current report: the highest lowest-field Macro-F1 (cost breaks a tie). */
export function bestReport(s: Pick<ProjectState, 'reports'>, passingOnly = false) {
  return [...s.reports.filter(r => !r.archivedNow && (!passingOnly || r.passed))].sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1 || a.metrics.costPer1000 - b.metrics.costPer1000)[0] ?? null;
}

/** What a button on an AI Suggestion card does; the page maps each to its own action. */
export type SuggestionAction = 'add_examples' | 'go_gold' | 'auto_optimise' | 'review_labels' | 'improve' | 'switch' | 'copy_prompt' | 'finish';

/**
 * One AI Suggestion card (spec 1.0.0, 6.3). Every card uses one of six fixed templates with an
 * imperative headline, so the action is clear at a glance. Code picks the template from the
 * project's records; no model writes these lines.
 */
export interface AiSuggestion {
  template: 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';
  title: string;
  text: string;
  actions: SuggestionAction[];
  /** The version the actions work on (improve, switch, copy), when there is one. */
  versionId: string | null;
}

/** Gold-labeled eval examples per value, for the rare-value check. */
export function goldValueCounts(s: Pick<ProjectState, 'examples' | 'gold' | 'setup'>): {field: string; value: string; count: number}[] {
  const out: {field: string; value: string; count: number}[] = [];
  const labeled = s.examples.filter(e => e.split === 'eval' && !!s.gold[e.id]);
  for (const f of s.setup?.schema?.fields ?? []) for (const v of f.values) out.push({field: f.name, value: v.name, count: labeled.filter(e => (s.gold[e.id]!.answer[f.name] ?? []).includes(v.name)).length});
  return out;
}

/** T1: values with too few gold-labeled examples to score fairly; null when none (or no gold yet). */
export function rareValueSuggestion(s: Pick<ProjectState, 'examples' | 'gold' | 'setup'>): AiSuggestion | null {
  const min = systemConfig().dataset.rareValueMinCount;
  if (!Object.keys(s.gold).length) return null;
  const rare = goldValueCounts(s).filter(c => c.count < min);
  if (!rare.length) return null;
  const names = rare.slice(0, 3).map(r => r.value).join(', ') + (rare.length > 3 ? ` and ${rare.length - 3} more` : '');
  return {
    template: 'T1',
    title: 'Balance rare label values',
    text: `${rare.length} ${rare.length === 1 ? 'value' : 'values'} (${names}) ${rare.length === 1 ? 'has' : 'have'} fewer than ${min} labeled examples, which can distort Macro-F1.`,
    actions: ['add_examples'],
    versionId: null,
  };
}

export interface SuggestionInput {
  /** The version selected in the list. */
  selectedId?: string | null;
  /** Counts from Gold Labels' Mismatches tab, when read. */
  mismatches?: {open: number; wrongEverywhere: number; reviewedAll: number} | null;
}

/**
 * The Prompt Tuning page's AI Suggestion: T2 until scores can exist, T5 on a version the dry run
 * dropped, T6 once a version passes, T3 when the model's answers differ from gold labels (right
 * after the first score, or after a run that ended without a pass), else T4. Null: nothing to say.
 */
export function aiSuggestion(s: ProjectState, x: SuggestionInput = {}): AiSuggestion | null {
  const t = s.setup?.thresholds;
  if (!s.versions.length || !t) return null;
  const label = (id: string | null | undefined) => {
    const v = id ? s.versions.find(x2 => x2.id === id) : undefined;
    return v ? versionLabel(v) : '';
  };
  const total = s.facts.examples;
  const best = bestReport(s);
  const passing = bestReport(s, true);

  // T5: a version the Optimiser dropped after its dry run.
  const sel = x.selectedId ? s.versions.find(v => v.id === x.selectedId) : undefined;
  if (sel) {
    for (const run of s.optimisation) {
      const round = run.history.find(h => h.versionId === sel.id && h.outcome === 'dropped' && h.dryRun);
      if (!round?.dryRun) continue;
      const d = round.dryRun;
      const to = best?.promptVersionId ?? d.parentId;
      return {
        template: 'T5',
        title: `Switch back to ${label(to)}`,
        text: `${versionLabel(sel)} passed ${d.passed}/${d.examples} dry-run examples vs ${label(d.parentId)}'s ${d.parentPassed}/${d.examples}. Continue from ${label(to)} instead.`,
        actions: ['switch'],
        versionId: to,
      };
    }
  }

  // T2: not enough gold labels for any score.
  if (!best && s.facts.goldEvalDone < total) {
    return {
      template: 'T2',
      title: 'Finish labeling the eval set',
      text: `${s.facts.goldEvalDone} of ${total} eval examples are labeled. Scores are worked out on the labeled examples.`,
      actions: ['go_gold'],
      versionId: null,
    };
  }
  if (!best) return null;

  if (passing) {
    return {
      template: 'T6',
      title: `Use ${label(passing.promptVersionId)} as your final prompt`,
      text: `All fields meet your thresholds (lowest field Macro-F1 ${passing.metrics.lowestField.macroF1.toFixed(2)}).`,
      actions: ['improve', 'copy_prompt', 'finish'],
      versionId: passing.promptVersionId,
    };
  }

  const m = x.mismatches;
  const lastRun = s.optimisation[0];
  const firstScore = !!m && !lastRun && m.reviewedAll === 0 && m.open > 0;
  const afterRun = !!m && lastRun?.state === 'done' && lastRun.stopReason !== 'passes' && m.wrongEverywhere > 0;
  if (m && (firstScore || afterRun)) {
    const n = firstScore ? m.open : m.wrongEverywhere;
    return {
      template: 'T3',
      title: `Review ${n} label ${n === 1 ? 'mismatch' : 'mismatches'}`,
      text: firstScore ? `The model's answers differ from ${n} of your gold labels. Check them first, so the Optimiser learns from the right labels.` : `${n} ${n === 1 ? 'example was' : 'examples were'} wrong in every version. Check your gold labels for them.`,
      actions: ['auto_optimise', 'review_labels'],
      versionId: best.promptVersionId,
    };
  }

  const mu = best.metrics.mixUps[0];
  const confusion = !mu ? '' : mu.kind === 'confused' ? `; top confusion is ${mu.gold} -> ${mu.predicted}` : mu.kind === 'extra' ? `; ${mu.predicted} is often added when it does not apply` : `; ${mu.gold} is often missed`;
  const lw = best.metrics.lowestField;
  // The lowest field can be at the bar while another check fails: name that check then.
  const failing = judge(best.metrics, t, total).checks.find(c => !c.met);
  const why = lw.macroF1 < t.macroF1 || !failing ? `Current score is ${lw.macroF1.toFixed(2)} (target ${t.macroF1.toFixed(2)})` : `${failing.label} is ${failing.actual} (needs ${failing.need})`;
  return {
    template: 'T4',
    title: `Improve ${label(best.promptVersionId)} to pass ${lw.field}`,
    text: `${why}${confusion}.`,
    actions: ['improve', 'auto_optimise'],
    versionId: best.promptVersionId,
  };
}

/**
 * Scores are being rebuilt (acceptance R5-4, R5-5): a gold edit changed the evaluation context, so
 * a version that had a report has none for today's gold labels yet. The rebuild reads saved
 * answers only. False while no eval example has a gold label (nothing can be scored then), and
 * for a version whose saved answers do not cover today's eval set (`cannotBuild`: the bff's
 * record of "versionId|endpoint|contextId" it tried).
 */
export function scoresUpdating(s: Omit<ProjectState, 'scoresUpdating'>, cannotBuild: ReadonlySet<string> = new Set()): boolean {
  const evalEx = s.examples.filter(e => e.split === 'eval');
  if (!s.setup?.schema || !evalEx.length || !evalEx.some(e => !!s.gold[e.id])) return false;
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
