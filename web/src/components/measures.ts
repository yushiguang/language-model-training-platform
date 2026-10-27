import {t, type T} from '@/i18n/text';
import {FIELD_BY_ID, valueOf} from '@/mock/fields';
import {invalidRate, macroF1, PROMPT_RUNS, valueScores, type EvalRun} from '@/mock/metrics';
import {fmt2, pct} from '@/mock/numbers';
import type {Measure} from '@/story/types';

function read(m: Measure, run: EvalRun): string {
  switch (m.kind) {
    case 'macro':
      return fmt2(macroF1(run, m.field));
    case 'value':
      return fmt2(valueScores(run, m.field).find(s => s.id === m.value)!.f1);
    case 'invalid':
      return pct(invalidRate(run), 1);
  }
}

function name(m: Measure): T {
  switch (m.kind) {
    case 'macro': {
      const field = FIELD_BY_ID[m.field].name;
      return t(`${field.en} macro-F1`, `${field.zh}宏平均 F1`);
    }
    case 'value': {
      const value = valueOf(m.field, m.value).name;
      return t(`${value.en} F1`, `${value.zh} F1`);
    }
    case 'invalid':
      return t('Invalid outputs', '无效输出');
  }
}

/** One before → after row per measure, for a prompt change measured on the eval split. */
export function measureRows(measures: Measure[], from: keyof typeof PROMPT_RUNS, to: keyof typeof PROMPT_RUNS): {label: T; value: string}[] {
  return measures.map(m => ({label: name(m), value: `${read(m, PROMPT_RUNS[from])} → ${read(m, PROMPT_RUNS[to])}`}));
}
