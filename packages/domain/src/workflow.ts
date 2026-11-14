import {systemConfig} from './config.ts';
import type {Actor, AgentPreset, EndpointId, EndpointInfo, Msg, ProjectState} from '@tsp/contracts';
import {msg, msgText} from './i18n.ts';
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
  /** In English (the helpers read these); `msg` holds the same lines for other languages. */
  title: string;
  text: string;
  msg: {title: Msg; text: Msg};
  actions: SuggestionAction[];
  /** The version the actions work on (improve, switch, copy), when there is one. */
  versionId: string | null;
}

/** A card from its two lines as catalog keys. */
const card = (template: AiSuggestion['template'], title: Msg, text: Msg, actions: SuggestionAction[], versionId: string | null): AiSuggestion => ({
  template,
  title: msgText(title),
  text: msgText(text),
  msg: {title, text},
  actions,
  versionId,
});

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
  const shown = rare.slice(0, 3).map(r => r.value).join(', ');
  const names = rare.length > 3 ? msg('{names} and {more} more', {names: shown, more: rare.length - 3}) : shown;
  const text =
    rare.length === 1
      ? msg('1 value ({names}) has fewer than {min} labeled examples, which can distort Macro-F1.', {names, min})
      : msg('{n} values ({names}) have fewer than {min} labeled examples, which can distort Macro-F1.', {n: rare.length, names, min});
  return card('T1', msg('Balance rare label values'), text, ['add_examples'], null);
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
      return card(
        'T5',
        msg('Switch back to {version}', {version: label(to)}),
        msg("{version} passed {passed}/{examples} dry-run examples vs {parent}'s {parentPassed}/{examples}. Continue from {to} instead.", {version: versionLabel(sel), passed: d.passed, examples: d.examples, parent: label(d.parentId), parentPassed: d.parentPassed, to: label(to)}),
        ['switch'],
        to,
      );
    }
  }

  // T2: not enough gold labels for any score.
  if (!best && s.facts.goldEvalDone < total) {
    return card('T2', msg('Finish labeling the eval set'), msg('{done} of {total} eval examples are labeled. Scores are worked out on the labeled examples.', {done: s.facts.goldEvalDone, total}), ['go_gold'], null);
  }
  if (!best) return null;

  // A rough reading (spec 1.0.0, 4.2): too few gold labels for a pass verdict, so the next step
  // is more labels, or more examples when the eval set is smaller than the minimum.
  if (best.rough && !passing) {
    const need = t.minEval;
    return total >= need
      ? card('T2', msg('Finish labeling the eval set'), msg('{done} of {total} eval examples are labeled. Scores stay a rough reading until {need} are labeled.', {done: s.facts.goldEvalDone, total, need}), ['go_gold', 'auto_optimise'], best.promptVersionId)
      : card('T2', msg('Add examples to the eval set'), msg('The eval set has {total} examples. Scores stay a rough reading until {need} examples have a gold label.', {total, need}), ['add_examples', 'auto_optimise'], best.promptVersionId);
  }

  if (passing) {
    return card(
      'T6',
      msg('Use {version} as your final prompt', {version: label(passing.promptVersionId)}),
      msg('All fields meet your thresholds (lowest field Macro-F1 {score}).', {score: passing.metrics.lowestField.macroF1.toFixed(2)}),
      ['improve', 'copy_prompt', 'finish'],
      passing.promptVersionId,
    );
  }

  const m = x.mismatches;
  const lastRun = s.optimisation[0];
  const firstScore = !!m && !lastRun && m.reviewedAll === 0 && m.open > 0;
  const afterRun = !!m && lastRun?.state === 'done' && lastRun.stopReason !== 'passes' && m.wrongEverywhere > 0;
  if (m && (firstScore || afterRun)) {
    const n = firstScore ? m.open : m.wrongEverywhere;
    return card(
      'T3',
      n === 1 ? msg('Review 1 label mismatch') : msg('Review {n} label mismatches', {n}),
      firstScore
        ? msg("The model's answers differ from {n} of your gold labels. Check them first, so the Optimiser learns from the right labels.", {n})
        : n === 1
          ? msg('1 example was wrong in every version. Check your gold label for it.')
          : msg('{n} examples were wrong in every version. Check your gold labels for them.', {n}),
      ['auto_optimise', 'review_labels'],
      best.promptVersionId,
    );
  }

  const mu = best.metrics.mixUps[0];
  const confusion: Msg | '' = !mu
    ? ''
    : mu.kind === 'confused'
      ? msg('; top confusion is {gold} -> {predicted}', {gold: mu.gold ?? '', predicted: mu.predicted ?? ''})
      : mu.kind === 'extra'
        ? msg('; {value} is often added when it does not apply', {value: mu.predicted ?? ''})
        : msg('; {value} is often missed', {value: mu.gold ?? ''});
  const lw = best.metrics.lowestField;
  // The lowest field can be at the bar while another check fails: name that check then.
  const failing = judge(best.metrics, t, s.facts.goldEvalDone).checks.find(c => !c.met);
  const why = lw.macroF1 < t.macroF1 || !failing ? msg('Current score is {score} (target {target})', {score: lw.macroF1.toFixed(2), target: t.macroF1.toFixed(2)}) : msg('{check} is {actual} (needs {need})', {check: failing.msg, actual: failing.actual, need: failing.need});
  return card('T4', msg('Improve {version} to pass {field}', {version: label(best.promptVersionId), field: lw.field}), msg('{why}{confusion}.', {why, confusion}), ['improve', 'auto_optimise'], best.promptVersionId);
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
