import {t, type T} from '@/i18n/text';
import {FIELD_BY_ID, valueOf} from '@/mock/fields';
import {invalidRate, macroF1, PROMPT_RUNS, valueScores, type EvalRun} from '@/mock/metrics';
import {fmt2, pct} from '@/mock/numbers';
import type {Measure} from '@/story/types';
import {trendOf, type Trend} from './trend';

function read(m: Measure, run: EvalRun): number {
  switch (m.kind) {
    case 'macro':
      return macroF1(run, m.field);
    case 'value':
      return valueScores(run, m.field).find(s => s.id === m.value)!.f1;
    case 'invalid':
      return invalidRate(run);
  }
}

function show(m: Measure, v: number): string {
  return m.kind === 'invalid' ? pct(v, 1) : fmt2(v);
}

function name(m: Measure): T {
  switch (m.kind) {
    case 'macro': {
      const field = FIELD_BY_ID[m.field].name;
      return t(`${field.en} macro-F1`, `${field.zh} macro-F1`);
    }
    case 'value': {
      const value = valueOf(m.field, m.value).name;
      return t(`${value.en} F1`, `${value.zh} F1`);
    }
    case 'invalid':
      return t('Invalid outputs', 'Invalid outputs');
  }
}

export type MeasureRow = {label: T; before: string; after: string; trend: Trend};

/**
 * One before → after row per measure, for a prompt change measured on the eval split.
 * Trend says whether the change is good news: fewer invalid outputs is better, higher F1 is better.
 */
export function measureRows(measures: Measure[], from: keyof typeof PROMPT_RUNS, to: keyof typeof PROMPT_RUNS): MeasureRow[] {
  return measures.map(m => {
    const before = read(m, PROMPT_RUNS[from]);
    const after = read(m, PROMPT_RUNS[to]);
    return {label: name(m), before: show(m, before), after: show(m, after), trend: trendOf(after - before, m.kind === 'invalid' ? 'lower' : 'higher')};
  });
}
