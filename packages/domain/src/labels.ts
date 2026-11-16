import {systemConfig} from './config.ts';
import type {Answer, Example, GoldLabel, ModelSettings, Schema} from '@tsp/contracts';
import {hashString} from './template.ts';

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
  // One value of the project's label (2026-11-16). A one-item list is read as that value.
  const raw = obj[schema.name];
  const list = [...new Set((Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String))];
  if (list.length !== 1) return {answer: null, reason: `${schema.name} needs exactly one value`, ...note};
  const answer: Answer = list[0];
  if (!schema.values.some(v => v.name === answer)) return {answer: null, reason: `"${answer}" isn't a value of ${schema.name}`, ...note};
  return {answer, reason: null, ...note};
}


/**
 * A gold label read from an upload file: the value itself, or an older file's
 * `{label: ["Value"]}` (or a one-key `{anyKey: ["Value"]}` when that is unambiguous). Null when it
 * is not exactly one of the label's values.
 */
export function readGoldAnswer(raw: unknown, schema: Schema): Answer | null {
  const ok = (v: unknown) => (typeof v === 'string' && schema.values.some(x => x.name === v) ? v : null);
  const one = (v: unknown) => (Array.isArray(v) ? (v.length === 1 ? ok(v[0]) : null) : ok(v));
  if (typeof raw === 'string') return ok(raw);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (schema.name in o) return one(o[schema.name]);
  const keys = Object.keys(o);
  return keys.length === 1 ? one(o[keys[0]]) : null;
}

/**
 * The line the site adds after every labeling prompt (decided 2026-11-11), so the Optimiser can
 * read why the model chose its answer. It is not part of the user's template and is not a label.
 */
export const REASON_LINE = 'Put a "reason" key first in the JSON: one short sentence (25 words at most) saying what in the input led to this value.';

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
