import type {Answer, Example, GoldLabel, ModelSettings, Schema} from '@tsp/contracts';
import {hashString} from './template.ts';

/** Reads a model answer. Anything that isn't valid JSON with values from the schema is invalid. */
export function parseOutput(text: string, schema: Schema): {answer: Answer | null; reason: string | null} {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {answer: null, reason: 'Not valid JSON'};
  }
  const answer: Answer = {};
  for (const f of schema.fields) {
    const raw = obj[f.name];
    // The same value twice counts once.
    const list = [...new Set((Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String))];
    const names = f.values.map(v => v.name);
    const bad = list.find(v => !names.includes(v));
    if (bad) return {answer: null, reason: `"${bad}" isn't a value of ${f.name}`};
    if (f.kind === 'single' && list.length !== 1) return {answer: null, reason: `${f.name} needs exactly one value`};
    if (f.kind === 'multi' && (list.length < (f.min ?? 1) || list.length > (f.max ?? names.length)))
      return {answer: null, reason: `${f.name} needs ${f.min ?? 1} to ${f.max ?? names.length} values`};
    answer[f.name] = list;
  }
  return {answer, reason: null};
}

/** Model settings that change answers. Predictions are reused only for the same hash. */
export const settingsHash = (s: ModelSettings) => hashString(`${s.maxOutputTokens}|${s.temperature ?? 'na'}${s.pass && s.pass > 1 ? `|pass${s.pass}` : ''}`);

/** Evaluation context = schema version + eval examples + their gold labels. Thresholds re-judge without new labeling. */
export function contextIdFor(schemaVersion: number, evalExamples: Example[], gold: Map<string, GoldLabel>): string {
  const parts = evalExamples
    .map(e => `${e.id}:${gold.get(e.id)?.id ?? '-'}`)
    .sort()
    .join(',');
  return `ctx_${hashString(`${schemaVersion}|${parts}`)}`;
}

/** Rough token estimate for one call: text / 4 plus a fixed amount per image. */
export const IMAGE_TOKENS = 800;
export function estimateTokens(parts: {type: 'text' | 'image'; text?: string}[]): number {
  return Math.ceil(parts.reduce((n, p) => n + (p.type === 'text' ? (p.text?.length ?? 0) / 4 : IMAGE_TOKENS), 0));
}
