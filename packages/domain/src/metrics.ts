import type {Answer, FieldMetrics, Metrics, MixUp, Schema, Thresholds, ValueMetrics} from '@tsp/contracts';

export interface Scored {
  exampleId: string;
  gold: Answer;
  /** null = invalid output. */
  predicted: Answer | null;
  costUsd: number;
}

const f1 = (p: number, r: number) => (p + r === 0 ? 0 : (2 * p * r) / (p + r));
const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Scores predictions against gold labels. Every value is scored one-vs-rest; a field's macro-F1
 * is the mean over values that appear in the gold labels or the predictions, so rare values
 * count as much as common ones. An invalid output counts as wrong on every field.
 */
export function computeMetrics(schema: Schema, items: Scored[]): Metrics {
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
  const invalid = items.filter(it => !it.predicted).length;
  const cost = items.reduce((s, it) => s + it.costUsd, 0);
  return {
    n: items.length,
    fields,
    lowestField,
    lowestValue,
    invalid,
    invalidRate: items.length ? invalid / items.length : 0,
    mixUps: mixUps.slice(0, 12),
    costPer1000: items.length ? (cost / items.length) * 1000 : 0,
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
  if (t.invalidRate != null) checks.push({label: 'Invalid outputs', actual: pct(m.invalidRate), need: `≤ ${pct(t.invalidRate)}`, met: m.invalidRate <= t.invalidRate});
  if (t.accuracy != null) {
    const singles = m.fields.filter(f => f.kind === 'single');
    const lo = singles.length ? Math.min(...singles.map(f => f.accuracy)) : 1;
    checks.push({label: 'Accuracy, single-select fields', actual: lo.toFixed(2), need: `≥ ${t.accuracy.toFixed(2)}`, met: lo >= t.accuracy});
  }
  checks.push({label: 'Eval examples', actual: String(evalCount), need: `≥ ${t.minEval}`, met: evalCount >= t.minEval});
  return {passed: checks.every(c => c.met), checks};
}

export const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

export const DEFAULT_THRESHOLDS: Thresholds = {mode: 'default', macroF1: 0.8, valueF1: 0.6, invalidRate: 0.01, accuracy: null, minEval: 20};
