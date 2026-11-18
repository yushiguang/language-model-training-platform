import {systemConfig} from './config.ts';
import type {Answer, Example, GoldLabel, ModelSettings, Schema} from '@yushiguang/sprint-contracts';
import {hashString} from './template.ts';
import {labelBounds} from './structured.ts';

/**
 * An answer in today's shape (resilience spec, 1): a list of value names. Answers stored as a plain
 * string earlier on 2026-11-16 read as a one-item list; anything else reads as no values.
 */
export function asAnswer(raw: unknown): Answer {
  if (typeof raw === 'string') return raw ? [raw] : [];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** An answer or null in today's shape: null and empty stay null. */
export const asAnswerOrNull = (raw: unknown): Answer | null => {
  const a = asAnswer(raw);
  return a.length ? a : null;
};

/** True when two answers hold the same values (order does not matter). */
export function sameAnswer(a: Answer | null | undefined, b: Answer | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every(v => y.has(v));
}

/**
 * Why a list of values is not an answer to this label, or null when it is: every value from the
 * label and at most once, one value on a single-select label, `min` to `max` on a multi-select
 * one, and a value that stands alone never with others. In English, for a model's invalid reason.
 */
export function answerProblem(list: string[], schema: Schema): string | null {
  const bad = list.find(v => !schema.values.some(x => x.name === v));
  if (bad != null) return `"${bad}" isn't a value of ${schema.name}`;
  if (new Set(list).size !== list.length) return `${schema.name} lists a value twice`;
  if (schema.kind !== 'multi') return list.length === 1 ? null : `${schema.name} needs exactly one value`;
  const {min, max} = labelBounds(schema);
  if (list.length < min || list.length > max) return min === max ? `${schema.name} needs exactly ${min} value${min === 1 ? '' : 's'}` : `${schema.name} needs ${min} to ${max} values`;
  const alone = list.find(v => schema.values.some(x => x.name === v && x.exclusive));
  if (alone != null && list.length > 1) return `"${alone}" must be the only value of ${schema.name}`;
  return null;
}

/** The values in label order, so two equal answers are stored the same way. */
export const inLabelOrder = (list: string[], schema: Schema): Answer => schema.values.map(v => v.name).filter(v => list.includes(v));

/** Reads a model answer. Anything that isn't valid JSON with values from the schema is invalid. */
export function parseOutput(text: string, schema: Schema): {answer: Answer | null; reason: string | null; note?: string} {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {answer: null, reason: 'Not valid JSON'};
  }
  // The model's own short reason (REASON_LINE asks for it). Kept with an invalid answer too.
  const said = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, systemConfig().labeling.reasonMaxChars) : '';
  const note = said ? {note: said} : {};
  // A single-select answer may come as the value or a one-item list; a multi-select one as a list
  // (or one value on its own when one is allowed).
  const raw = obj[schema.name];
  const list = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String);
  const problem = answerProblem(list, schema);
  if (problem) return {answer: null, reason: problem, ...note};
  return {answer: inLabelOrder(list, schema), reason: null, ...note};
}

/**
 * A gold label read from an upload file or a bundled sample: `"Value"`, `["V1", "V2"]`, or
 * `{label: "Value" | ["V1", "V2"]}` (or any one key when that is unambiguous). Repeats are dropped;
 * null when the values do not make an answer to the label (see `answerProblem`).
 */
export function readGoldAnswer(raw: unknown, schema: Schema): Answer | null {
  const read = (v: unknown): Answer | null => {
    const list = typeof v === 'string' ? [v] : Array.isArray(v) && v.every(x => typeof x === 'string') ? [...new Set(v as string[])] : null;
    return list && !answerProblem(list, schema) ? inLabelOrder(list, schema) : null;
  };
  if (typeof raw === 'string' || Array.isArray(raw)) return read(raw);
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (schema.name in o) return read(o[schema.name]);
  const keys = Object.keys(o);
  return keys.length === 1 ? read(o[keys[0]]) : null;
}

/**
 * The line the site adds after every labeling prompt (decided 2026-11-11), so the Optimiser can
 * read why the model chose its answer. It is not part of the user's template and is not a label.
 */
export const REASON_LINE = 'Put a "reason" key first in the JSON: one short sentence (25 words at most) saying what in the input led to this answer.';

/** Model settings that change answers. Predictions are reused only for the same hash. */
export const settingsHash = (s: ModelSettings) => hashString(`${s.maxOutputTokens}|${s.temperature ?? 'na'}${s.pass && s.pass > 1 ? `|pass${s.pass}` : ''}`);

/** Evaluation context = schema version + eval examples + their gold labels. Thresholds re-judge without new labeling. */
/**
 * The evaluation context: what a score rests on. Only gold-labeled eval examples count, with their
 * half (spec 1.0.0, 4.4): appending examples without gold labels leaves every score current, while
 * a new, changed or removed gold label, or a half that moved, makes it stale.
 */
export function contextIdFor(schemaVersion: number, evalExamples: Example[], gold: Record<string, GoldLabel>): string {
  const parts = evalExamples
    .filter(e => !!gold[e.id])
    .map(e => `${e.id}:${e.optimiserHalf ? 'o' : 'h'}:${gold[e.id].id}`)
    .sort()
    .join(',');
  return `ctx_${hashString(`${schemaVersion}|${parts}`)}`;
}

export function estimateTokens(parts: {type: 'text' | 'image'; text?: string}[]): number {
  return Math.ceil(parts.reduce((n, p) => n + (p.type === 'text' ? (p.text?.length ?? 0) / systemConfig().gateway.charsPerTokenEstimate : systemConfig().gateway.imageTokensEstimate), 0));
}
