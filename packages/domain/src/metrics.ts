import {DEFAULT_SYSTEM_CONFIG, systemConfig} from './config.ts';
import type {Answer, Metrics, MixUp, Msg, Schema, Thresholds, ValueMetrics} from '@sprint/contracts';
import {fill, msg} from './i18n.ts';

export interface Scored {
  exampleId: string;
  gold: Answer;
  /** null = no answer: an invalid output, or one the safety filter stopped. */
  predicted: Answer | null;
  /** The safety filter stopped the answer. */
  filtered?: boolean;
  costUsd: number;
}

/**
 * At most this share of answers may be invalid for a version to pass (acceptance R4-6, decided
 * 2026-11-11). Applies when the project sets no invalid-rate threshold of its own.
 */

const f1 = (p: number, r: number) => (p + r === 0 ? 0 : (2 * p * r) / (p + r));
const round = (x: number) => Math.round(x * 1000) / 1000;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(v => b.includes(v));

/**
 * Scores predictions against gold labels. The project has one label (single or multi select), so
 * every answer is a set of its values. Each value is scored one-vs-rest; macro-F1 is the mean over
 * values that appear in the gold labels or the predictions, so rare values count as much as common
 * ones. Accuracy is the share of exact matches. Invalid outputs and answers the safety filter
 * stopped are left out of every score (they are a format or platform event, not a labeling
 * judgement) and counted apart; `judge` keeps a version with too many invalid answers from passing.
 */
export function computeMetrics(schema: Schema, all: Scored[]): Metrics {
  const items = all.filter(it => it.predicted != null && !it.filtered);
  const values: ValueMetrics[] = [];
  for (const v of schema.values) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const it of items) {
      const g = it.gold.includes(v.name);
      const p = it.predicted!.includes(v.name);
      if (g && p) tp++;
      else if (p) fp++;
      else if (g) fn++;
    }
    if (tp + fp + fn === 0) continue;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    values.push({value: v.name, precision: round(precision), recall: round(recall), f1: round(f1(precision, recall)), support: tp + fn});
  }
  const macro = values.length ? values.reduce((s, v) => s + v.f1, 0) / values.length : 0;
  const right = items.filter(it => sameSet(it.gold, it.predicted!)).length;

  // Single select: one value read as another. Multi select: values added or left out.
  const bucket = new Map<string, MixUp>();
  const add = (kind: MixUp['kind'], gold: string | null, predicted: string | null, id: string) => {
    const key = `${kind}|${gold}>${predicted}`;
    const cur = bucket.get(key) ?? {kind, gold, predicted, count: 0, exampleIds: []};
    cur.count++;
    cur.exampleIds.push(id);
    bucket.set(key, cur);
  };
  for (const it of items) {
    const p = it.predicted!;
    if (sameSet(it.gold, p)) continue;
    if (schema.kind !== 'multi') {
      add('confused', it.gold[0] ?? null, p[0] ?? null, it.exampleId);
      continue;
    }
    for (const v of p) if (!it.gold.includes(v)) add('extra', null, v, it.exampleId);
    for (const v of it.gold) if (!p.includes(v)) add('missed', v, null, it.exampleId);
  }
  const mixUps = [...bucket.values()].sort((a, b) => b.count - a.count);
  let lowestValue: Metrics['lowestValue'] = null;
  for (const v of values) if (v.support > 0 && (!lowestValue || v.f1 < lowestValue.f1)) lowestValue = {value: v.value, f1: v.f1};
  const filtered = all.filter(it => it.filtered).length;
  const invalid = all.filter(it => it.predicted == null && !it.filtered).length;
  const cost = all.reduce((s, it) => s + it.costUsd, 0);
  return {
    n: items.length,
    total: all.length,
    filtered,
    macroF1: round(macro),
    accuracy: round(items.length ? right / items.length : 0),
    values,
    lowestValue,
    invalid,
    invalidRate: all.length ? invalid / all.length : 0,
    mixUps: mixUps.slice(0, 12),
    costPer1000: all.length ? (cost / all.length) * 1000 : 0,
  };
}

export interface CheckLine {
  /** In English; `msg` is the same line for other languages. */
  label: string;
  msg: Msg;
  actual: string;
  need: string;
  met: boolean;
}

/** Pass or fail is judged against the current thresholds, so a threshold change re-judges old reports without new labeling. */
/**
 * Whether a report passes the thresholds. `labeledCount` is the number of gold-labeled eval
 * examples (both halves): under `t.minEval` the score is a rough reading (spec 1.0.0, 4.2) and
 * never passes, however high it is.
 */
/** A check's label, in English and as a catalog key. */
const lab = (key: string, params?: Msg['params']) => ({label: fill(key, params), msg: msg(key, params)});

export function judge(m: Metrics, t: Thresholds, labeledCount: number): {passed: boolean; rough: boolean; checks: CheckLine[]} {
  const checks: CheckLine[] = [];
  checks.push({...lab('Macro-F1'), actual: m.macroF1.toFixed(2), need: `≥ ${t.macroF1.toFixed(2)}`, met: m.macroF1 >= t.macroF1});
  if (t.valueF1 != null) checks.push({...lab('Lowest value F1'), actual: m.lowestValue ? m.lowestValue.f1.toFixed(2) : '–', need: `≥ ${t.valueF1.toFixed(2)}`, met: !m.lowestValue || m.lowestValue.f1 >= t.valueF1});
  const values = m.values;
  const lowest = (k: 'precision' | 'recall') => (values.length ? Math.min(...values.map(v => v[k])) : 1);
  if (t.precision != null) checks.push({...lab('Lowest value precision'), actual: lowest('precision').toFixed(2), need: `≥ ${t.precision.toFixed(2)}`, met: lowest('precision') >= t.precision});
  if (t.recall != null) checks.push({...lab('Lowest value recall'), actual: lowest('recall').toFixed(2), need: `≥ ${t.recall.toFixed(2)}`, met: lowest('recall') >= t.recall});
  // Always checked (R4-6): invalid answers are left out of the scores, so a version must not pass
  // by giving unreadable answers on the hard examples.
  const cap = t.invalidRate ?? systemConfig().evaluation.invalidRateCap;
  checks.push({...lab('Invalid outputs'), actual: pct(m.invalidRate), need: `≤ ${pct(cap)}`, met: m.invalidRate <= cap});
  if (t.accuracy != null) checks.push({...lab('Accuracy'), actual: m.accuracy.toFixed(2), need: `≥ ${t.accuracy.toFixed(2)}`, met: m.accuracy >= t.accuracy});
  // Gold-labeled eval examples, not the dataset's size (review 2026-11-13): 90 sampled examples
  // with 4 gold labels are still a rough reading. The score itself rests on the held-out half.
  const rough = labeledCount < t.minEval;
  checks.push({...lab('Gold-labeled eval examples (the score uses {n} of the {total} held out)', {n: m.n, total: m.total ?? m.n}), actual: String(labeledCount), need: `≥ ${t.minEval}`, met: !rough});
  return {passed: checks.every(c => c.met), rough, checks};
}

export const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

/** Default (Setup, Evaluation settings): the label's macro-F1 must reach 0.80 (UI design 2026-11-05). */
export const DEFAULT_THRESHOLDS: Thresholds = {mode: 'default', macroF1: DEFAULT_SYSTEM_CONFIG.evaluation.defaultMacroF1, valueF1: null, precision: null, recall: null, invalidRate: null, accuracy: null, minEval: DEFAULT_SYSTEM_CONFIG.dataset.minEvalRecommended};
/** Custom starts from these: F1 on at 0.60, Precision and Recall off with 0.70 ready in their boxes. */
export const CUSTOM_START = {valueF1: DEFAULT_SYSTEM_CONFIG.evaluation.customStartValueF1, precision: DEFAULT_SYSTEM_CONFIG.evaluation.customStartPrecision, recall: DEFAULT_SYSTEM_CONFIG.evaluation.customStartRecall};
