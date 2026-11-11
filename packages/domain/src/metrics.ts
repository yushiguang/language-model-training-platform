import type {Answer, FieldMetrics, Metrics, MixUp, Schema, Thresholds, ValueMetrics} from '@tsp/contracts';

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
export const INVALID_CAP = 0.01;

const f1 = (p: number, r: number) => (p + r === 0 ? 0 : (2 * p * r) / (p + r));
const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Scores predictions against gold labels. Every value is scored one-vs-rest; a field's macro-F1
 * is the mean over values that appear in the gold labels or the predictions, so rare values
 * count as much as common ones. Invalid outputs and answers the safety filter stopped are left out
 * of every score (they are a format or platform event, not a labeling judgement) and counted
 * apart; `judge` keeps a version with too many invalid answers from passing.
 */
export function computeMetrics(schema: Schema, all: Scored[]): Metrics {
  const items = all.filter(it => it.predicted && !it.filtered);
  const fields: FieldMetrics[] = [];
  const mixUps: MixUp[] = [];
  for (const field of schema.fields) {
    const values: ValueMetrics[] = [];
    for (const v of field.values) {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const it of items) {
        const g = (it.gold[field.name] ?? []).includes(v.name);
        const p = (it.predicted?.[field.name] ?? []).includes(v.name);
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
    const exact = items.filter(it => {
      const g = [...(it.gold[field.name] ?? [])].sort().join('|');
      const p = [...(it.predicted?.[field.name] ?? [])].sort().join('|');
      return it.predicted && g === p;
    }).length;
    fields.push({field: field.name, kind: field.kind, macroF1: round(macro), accuracy: round(items.length ? exact / items.length : 0), values});

    const bucket = new Map<string, MixUp>();
    const add = (key: string, m: Omit<MixUp, 'count' | 'exampleIds'>, id: string) => {
      const cur = bucket.get(key) ?? {...m, count: 0, exampleIds: []};
      cur.count++;
      cur.exampleIds.push(id);
      bucket.set(key, cur);
    };
    for (const it of items) {
      if (!it.predicted) continue;
      const g = it.gold[field.name] ?? [];
      const p = it.predicted[field.name] ?? [];
      if (field.kind === 'single') {
        if (g[0] && p[0] && g[0] !== p[0]) add(`${g[0]}>${p[0]}`, {field: field.name, kind: 'confused', gold: g[0], predicted: p[0]}, it.exampleId);
      } else {
        for (const v of p) if (!g.includes(v)) add(`+${v}`, {field: field.name, kind: 'extra', gold: null, predicted: v}, it.exampleId);
        for (const v of g) if (!p.includes(v)) add(`-${v}`, {field: field.name, kind: 'missed', gold: v, predicted: null}, it.exampleId);
      }
    }
    mixUps.push(...bucket.values());
  }
  mixUps.sort((a, b) => b.count - a.count);
  const lowestField = fields.reduce((lo, f) => (f.macroF1 < lo.macroF1 ? {field: f.field, macroF1: f.macroF1} : lo), {field: fields[0]?.field ?? '', macroF1: fields[0]?.macroF1 ?? 0});
  let lowestValue: Metrics['lowestValue'] = null;
  for (const f of fields) for (const v of f.values) if (v.support > 0 && (!lowestValue || v.f1 < lowestValue.f1)) lowestValue = {field: f.field, value: v.value, f1: v.f1};
  const filtered = all.filter(it => it.filtered).length;
  const invalid = all.filter(it => !it.predicted && !it.filtered).length;
  const cost = all.reduce((s, it) => s + it.costUsd, 0);
  return {
    n: items.length,
    total: all.length,
    filtered,
    fields,
    lowestField,
    lowestValue,
    invalid,
    invalidRate: all.length ? invalid / all.length : 0,
    mixUps: mixUps.slice(0, 12),
    costPer1000: all.length ? (cost / all.length) * 1000 : 0,
  };
}

export interface CheckLine {
  label: string;
  actual: string;
  need: string;
  met: boolean;
}

/** Pass or fail is judged against the current thresholds, so a threshold change re-judges old reports without new labeling. */
export function judge(m: Metrics, t: Thresholds, evalCount: number): {passed: boolean; checks: CheckLine[]} {
  const checks: CheckLine[] = [];
  checks.push({label: 'Lowest field macro-F1', actual: m.lowestField.macroF1.toFixed(2), need: `≥ ${t.macroF1.toFixed(2)}`, met: m.lowestField.macroF1 >= t.macroF1});
  if (t.valueF1 != null) checks.push({label: 'Lowest value F1', actual: m.lowestValue ? m.lowestValue.f1.toFixed(2) : '–', need: `≥ ${t.valueF1.toFixed(2)}`, met: !m.lowestValue || m.lowestValue.f1 >= t.valueF1});
  const values = m.fields.flatMap(f => f.values.map(v => ({...v, field: f.field})));
  const lowest = (k: 'precision' | 'recall') => (values.length ? Math.min(...values.map(v => v[k])) : 1);
  if (t.precision != null) checks.push({label: 'Lowest value precision', actual: lowest('precision').toFixed(2), need: `≥ ${t.precision.toFixed(2)}`, met: lowest('precision') >= t.precision});
  if (t.recall != null) checks.push({label: 'Lowest value recall', actual: lowest('recall').toFixed(2), need: `≥ ${t.recall.toFixed(2)}`, met: lowest('recall') >= t.recall});
  // Always checked (R4-6): invalid answers are left out of the scores, so a version must not pass
  // by giving unreadable answers on the hard examples.
  const cap = t.invalidRate ?? INVALID_CAP;
  checks.push({label: 'Invalid outputs', actual: pct(m.invalidRate), need: `≤ ${pct(cap)}`, met: m.invalidRate <= cap});
  if (t.accuracy != null) {
    const singles = m.fields.filter(f => f.kind === 'single');
    const lo = singles.length ? Math.min(...singles.map(f => f.accuracy)) : 1;
    checks.push({label: 'Accuracy, single-select fields', actual: lo.toFixed(2), need: `≥ ${t.accuracy.toFixed(2)}`, met: lo >= t.accuracy});
  }
  // The eval set's size is the setting; the score itself rests on the held-out half (m.n), said
  // in the label so the check does not read as the score's base (review finding 1).
  checks.push({label: `Eval examples (the score uses ${m.n} of the ${m.total ?? m.n} held out)`, actual: String(evalCount), need: `≥ ${t.minEval}`, met: evalCount >= t.minEval});
  return {passed: checks.every(c => c.met), checks};
}

export const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

/** Default (Setup, Evaluation settings): Macro-F1 of every field must reach 0.80 (UI design 2026-11-05). */
export const DEFAULT_THRESHOLDS: Thresholds = {mode: 'default', macroF1: 0.8, valueF1: null, precision: null, recall: null, invalidRate: null, accuracy: null, minEval: 20};
/** Custom starts from these: F1 on at 0.60, Precision and Recall off with 0.70 ready in their boxes. */
export const CUSTOM_START = {valueF1: 0.6, precision: 0.7, recall: 0.7};
