import {ALL_KEYS, FEATURES, ITEM_ROWS, featureDef, isImageKey, labelOf} from './catalogue.ts';
import type {Example, ExampleType, FeatureSelection, FeatureValue, PromptImage, Schema} from '@tsp/contracts';

/**
 * Prompt templates (tech doc §3, "Prompt templates and feature loading").
 * A placeholder is {{Key}} with no spaces. Single braces are plain text, so JSON in a prompt is safe.
 */
export const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;
const FIXED_IMAGE = /\[Image (\d+)\]/g;

export interface Placeholder {
  key: string;
  line: number;
  start: number;
  end: number;
}

export function placeholders(template: string): Placeholder[] {
  const out: Placeholder[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const start = m.index!;
    out.push({key: m[1], start, end: start + m[0].length, line: template.slice(0, start).split('\n').length});
  }
  return out;
}

export function placeholderKeys(template: string): Set<string> {
  return new Set(placeholders(template).map(p => p.key));
}

export type Fix =
  | {kind: 'replace'; from: string; to: string}
  | {kind: 'tick'; group: keyof FeatureSelection; key: string}
  | {kind: 'untick'; groups: (keyof FeatureSelection)[]; key: string}
  | {kind: 'insert'; key: string};

export interface Issue {
  severity: 'error' | 'warning';
  code: 'unknown_key' | 'not_ticked' | 'unused_feature' | 'broken_braces' | 'missing_image' | 'one_type_only' | 'image_cost' | 'value_missing';
  message: string;
  key?: string;
  line?: number;
  fixes: {label: string; fix: Fix}[];
}

export interface CheckResult {
  errors: Issue[];
  warnings: Issue[];
  /** Placeholders in the template that match ticked features. */
  matched: number;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({length: a.length + 1}, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
  return dp[a.length][b.length];
}

export function closestKey(key: string): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of ALL_KEYS) {
    const d = k.toLowerCase().startsWith(key.toLowerCase()) ? 0.5 : editDistance(key, k);
    if (d < bestD) [best, bestD] = [k, d];
  }
  return bestD <= Math.max(3, key.length / 2) ? best : null;
}

function brokenBraces(template: string): {line: number; text: string}[] {
  const stripped = template.replace(PLACEHOLDER, m => ' '.repeat(m.length));
  const out: {line: number; text: string}[] = [];
  for (const m of stripped.matchAll(/\{\{|\}\}/g)) {
    const line = stripped.slice(0, m.index).split('\n').length;
    out.push({line, text: template.split('\n')[line - 1].trim()});
  }
  return out;
}

const groupsWith = (key: string): (keyof FeatureSelection)[] =>
  (['video', 'photo_text', 'metadata'] as const).filter(g => featureDef(g, key));

const tickedAnywhere = (sel: FeatureSelection, key: string) => sel.video.includes(key) || sel.photo_text.includes(key) || sel.metadata.includes(key);

/**
 * The one check function. The editor calls it live, Save runs it again and refuses a version
 * with errors, and the optimiser runs it on every candidate.
 */
export function checkTemplate(template: string, sel: FeatureSelection, opts: {schema?: Schema | null; types?: ExampleType[]; costNote?: string; images?: PromptImage[]} = {}): CheckResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const used = placeholders(template);
  const usedKeys = new Set(used.map(p => p.key));
  let matched = 0;

  for (const key of usedKeys) {
    const line = used.find(p => p.key === key)!.line;
    if (!ALL_KEYS.includes(key)) {
      const near = closestKey(key);
      errors.push({
        severity: 'error',
        code: 'unknown_key',
        key,
        line,
        message: near ? `{{${key}}} is not a feature. Did you mean ${labelOf(near)}?` : `{{${key}}} is not a feature`,
        fixes: near ? [{label: 'Replace', fix: {kind: 'replace', from: `{{${key}}}`, to: `{{${near}}}`}}] : [],
      });
    } else if (!tickedAnywhere(sel, key)) {
      const groups = groupsWith(key);
      errors.push({
        severity: 'error',
        code: 'not_ticked',
        key,
        line,
        message: `{{${key}}} is in the template but not ticked`,
        fixes: groups.map(g => ({label: groups.length > 1 ? `Tick for ${g === 'video' ? 'video' : g === 'photo_text' ? 'photo&text' : 'metadata'}` : 'Tick', fix: {kind: 'tick', group: g, key}})),
      });
    } else matched++;
  }

  const tickedKeys = [...new Set([...sel.video, ...sel.photo_text, ...sel.metadata])];
  for (const key of tickedKeys) {
    if (usedKeys.has(key)) continue;
    const groups = (['video', 'photo_text', 'metadata'] as const).filter(g => sel[g].includes(key));
    const label = Object.values(FEATURES).flat().find(d => d.key === key)?.label ?? key;
    const where = groups.length === 1 && groups[0] !== 'metadata' ? ` for ${groups[0] === 'video' ? 'video' : 'photo&text'}` : '';
    errors.push({
      severity: 'error',
      code: 'unused_feature',
      key,
      message: `${label} is ticked${where} but not in the template`,
      fixes: [
        {label: 'Insert', fix: {kind: 'insert', key}},
        {label: 'Untick', fix: {kind: 'untick', groups: [...groups], key}},
      ],
    });
  }

  for (const b of brokenBraces(template)) {
    errors.push({severity: 'error', code: 'broken_braces', line: b.line, message: `Line ${b.line} has an unmatched {{ or }}: "${b.text.slice(0, 48)}"`, fixes: []});
  }

  // [Image N] needs prompt image N; otherwise the text "[Image N]" would go to the model.
  if (opts.images) {
    for (const n of new Set(fixedImageRefs(template))) {
      if (n >= 1 && n <= opts.images.length) continue;
      const line = template.slice(0, template.indexOf(`[Image ${n}]`)).split('\n').length;
      errors.push({
        severity: 'error',
        code: 'missing_image',
        line,
        message: `[Image ${n}] is in the prompt, but the prompt has ${opts.images.length ? `only ${opts.images.length} image${opts.images.length === 1 ? '' : 's'}` : 'no images'}.`,
        fixes: [],
      });
    }
  }

  const types = opts.types ?? ['video', 'photo_text'];
  if (types.length > 1) {
    const onlyPhoto = [...usedKeys].filter(k => sel.photo_text.includes(k) && !sel.video.includes(k));
    const onlyVideo = [...usedKeys].filter(k => sel.video.includes(k) && !sel.photo_text.includes(k));
    if (onlyPhoto.length || onlyVideo.length) {
      const list = (ks: string[]) => ks.map(k => `{{${k}}}`).join(' and ');
      const parts = [onlyPhoto.length ? `${list(onlyPhoto)} load only for photo&text` : '', onlyVideo.length ? `${list(onlyVideo)} only for video` : ''].filter(Boolean);
      warnings.push({severity: 'warning', code: 'one_type_only', message: `${parts.join(', and ')}. Examples of the other type leave those lines out.`, fixes: []});
    }
  }
  const imageKeys = [...usedKeys].filter(k => isImageKey(k) && tickedAnywhere(sel, k));
  if (imageKeys.length) {
    warnings.push({
      severity: 'warning',
      code: 'image_cost',
      message: opts.costNote ?? `Image features (${imageKeys.join(', ')}) make up most of the cost.`,
      fixes: [],
    });
  }
  if (opts.schema) {
    for (const field of opts.schema.fields)
      for (const v of field.values)
        if (!template.includes(v.name))
          warnings.push({severity: 'warning', code: 'value_missing', message: `The value "${v.name}" of ${field.name} isn't named in the prompt, so the model may not use it.`, fixes: []});
  }
  return {errors, warnings, matched};
}

export function applyFix(template: string, sel: FeatureSelection, fix: Fix, cursor?: number): {template: string; features: FeatureSelection} {
  const features: FeatureSelection = {video: [...sel.video], photo_text: [...sel.photo_text], metadata: [...sel.metadata]};
  switch (fix.kind) {
    case 'replace':
      return {template: template.split(fix.from).join(fix.to), features};
    case 'tick':
      if (!features[fix.group].includes(fix.key)) features[fix.group].push(fix.key);
      return {template, features};
    case 'untick':
      for (const g of fix.groups) features[g] = features[g].filter(k => k !== fix.key);
      return {template, features};
    case 'insert': {
      const label = ITEM_ROWS.find(r => r.key === fix.key)?.label ?? FEATURES.metadata.find(d => d.key === fix.key)?.label ?? fix.key;
      const at = cursor ?? insertionPoint(template);
      const text = `${label}: {{${fix.key}}}\n`;
      return {template: template.slice(0, at) + text + template.slice(at), features};
    }
  }
}

/** Where a new input line goes: after the last placeholder line, else at the end. */
function insertionPoint(template: string): number {
  const ps = placeholders(template);
  if (!ps.length) return template.length;
  const last = ps[ps.length - 1];
  const nl = template.indexOf('\n', last.end);
  return nl === -1 ? template.length : nl + 1;
}

/**
 * One piece of a rendered prompt. The model gets the parts in order as one message's content
 * list, so each image sits exactly where its placeholder was. `caption` and `source` are for the
 * UI preview only and are never sent to the model.
 */
export type Part =
  | {type: 'text'; text: string}
  | {type: 'image'; url: string; caption: string; source: 'example' | 'prompt'; key: string};

/**
 * Renders a template for one example. A line whose placeholder isn't ticked for the example's
 * type is left out. Empty text features become "none". Image features and fixed prompt images
 * become image parts in template order.
 */
export function renderPrompt(template: string, example: Pick<Example, 'type' | 'features'>, sel: FeatureSelection, images: PromptImage[] = []): Part[] {
  const loaded = new Set([...sel[example.type], ...sel.metadata]);
  const lines = template.split('\n').filter(line => {
    const keys = [...line.matchAll(PLACEHOLDER)].map(m => m[1]);
    return keys.every(k => loaded.has(k));
  });
  const text = lines.join('\n');
  const parts: Part[] = [];
  let buf = '';
  const flush = () => {
    if (buf) parts.push({type: 'text', text: buf});
    buf = '';
  };
  const token = /\{\{([A-Za-z0-9_]+)\}\}|\[Image (\d+)\]/g;
  let last = 0;
  for (const m of text.matchAll(token)) {
    buf += text.slice(last, m.index);
    last = m.index! + m[0].length;
    if (m[2]) {
      const img = images[Number(m[2]) - 1];
      if (img) {
        flush();
        parts.push({type: 'image', url: img.url, caption: `Image ${m[2]} · part of the prompt`, source: 'prompt', key: `Image ${m[2]}`});
      } else buf += m[0];
      continue;
    }
    const key = m[1];
    const value = example.features[key];
    if (isImageKey(key)) {
      const urls = featureItems(value);
      if (!urls.length) buf += 'none';
      else {
        flush();
        urls.forEach((url, i) => parts.push({type: 'image', url, caption: `${labelOf(key)} ${i + 1} of ${urls.length} · from the example`, source: 'example', key}));
      }
    } else {
      const s = featureText(value);
      buf += s.trim() ? s : 'none';
    }
  }
  buf += text.slice(last);
  flush();
  return parts;
}

/** Text of a rendered prompt with each image shown as its UI caption, for logs and tests. */
export function partsToText(parts: Part[]): string {
  return parts.map(p => (p.type === 'text' ? p.text : `[${p.caption}]`)).join('');
}

export function hashString(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
}

export function fixedImageRefs(template: string): number[] {
  return [...template.matchAll(FIXED_IMAGE)].map(m => Number(m[1]));
}

export type DiffLine = {kind: 'same' | 'add' | 'del'; text: string};

/** Line diff (LCS), for unsaved edits and version compare. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const dp = Array.from({length: x.length + 1}, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) out.push({kind: 'same', text: x[i++]}), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({kind: 'del', text: x[i++]});
    else out.push({kind: 'add', text: y[j++]});
  }
  while (i < x.length) out.push({kind: 'del', text: x[i++]});
  while (j < y.length) out.push({kind: 'add', text: y[j++]});
  return out;
}

/**
 * Change marks in the prompt editor (design 2026-11-10): a word-level diff, so a change inside a
 * line is marked where it is. Placeholders stay whole. Very long prompts fall back to lines.
 */
export type MarkSeg = {kind: 'same' | 'add' | 'del'; text: string; reason?: string};

const TOKEN = /\{\{[A-Za-z0-9_]+\}\}|[\p{L}\p{N}_']+|[^\s\p{L}\p{N}_']|[ \t]+|\n/gu;

export function diffWords(a: string, b: string): MarkSeg[] {
  let x: string[] = a.match(TOKEN) ?? [];
  let y: string[] = b.match(TOKEN) ?? [];
  if (x.length * y.length > 4_000_000) {
    x = a.split(/(?<=\n)/);
    y = b.split(/(?<=\n)/);
  }
  // Common prefix and suffix first: most edits are small.
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  const xs = x.slice(p, x.length - q);
  const ys = y.slice(p, y.length - q);
  const dp = Array.from({length: xs.length + 1}, () => new Uint32Array(ys.length + 1));
  for (let i = xs.length - 1; i >= 0; i--) for (let j = ys.length - 1; j >= 0; j--) dp[i][j] = xs[i] === ys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: MarkSeg[] = [];
  const push = (kind: MarkSeg['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({kind, text});
  };
  if (p) push('same', x.slice(0, p).join(''));
  let i = 0;
  let j = 0;
  while (i < xs.length && j < ys.length) {
    if (xs[i] === ys[j]) push('same', xs[i++]), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', xs[i++]);
    else push('add', ys[j++]);
  }
  while (i < xs.length) push('del', xs[i++]);
  while (j < ys.length) push('add', ys[j++]);
  if (q) push('same', x.slice(x.length - q).join(''));
  // Within one change, removed text comes before added text.
  const final: MarkSeg[] = [];
  for (let k = 0; k < out.length; ) {
    if (out[k].kind === 'same') {
      final.push(out[k++]);
      continue;
    }
    let del = '';
    let add = '';
    for (; k < out.length; k++) {
      const seg = out[k];
      // A space kept between two changed words belongs to the change.
      if (seg.kind === 'same') {
        if (/^[ \t]+$/.test(seg.text) && out[k + 1] && out[k + 1].kind !== 'same') (del += seg.text), (add += seg.text);
        else break;
      } else if (seg.kind === 'del') del += seg.text;
      else add += seg.text;
    }
    if (del) final.push({kind: 'del', text: del});
    if (add) final.push({kind: 'add', text: add});
  }
  return final;
}

/**
 * Gives each change (a run of added and removed text) a reason: the helper's change whose words
 * overlap it most, else the change in the same position when the counts match. Changes the user
 * made by hand get none.
 */
export function withReasons(segs: MarkSeg[], changes: {text: string; reason: string}[], prefix = ''): MarkSeg[] {
  if (!changes.length) return segs;
  const words = (t: string) => new Set((t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length > 2));
  const hunks: number[][] = [];
  segs.forEach((s, k) => {
    if (s.kind === 'same') return;
    const prev = segs[k - 1];
    if (prev && prev.kind !== 'same' && hunks.length) hunks[hunks.length - 1].push(k);
    else hunks.push([k]);
  });
  const out = segs.map(s => ({...s}));
  hunks.forEach((h, n) => {
    const w = words(h.map(k => segs[k].text).join(' '));
    let best = -1;
    let score = 0;
    changes.forEach((c, ci) => {
      const cw = words(c.text);
      const hit = [...cw].filter(x => w.has(x)).length / Math.max(1, Math.min(cw.size, w.size));
      if (hit > score) (score = hit), (best = ci);
    });
    if (score < 0.5) best = hunks.length === changes.length ? n : -1;
    if (best >= 0 && changes[best].reason) for (const k of h) out[k].reason = prefix + changes[best].reason;
  });
  return out;
}

export function diffSummary(d: DiffLine[]): {added: number; removed: number} {
  return {added: d.filter(l => l.kind === 'add').length, removed: d.filter(l => l.kind === 'del').length};
}

/**
 * A feature value as one line of text: the text, or the list joined with commas. Tolerates the
 * `string | string[]` shape stored before 1.0.0 (spec 7.1), so old records still read.
 */
export function featureText(v: FeatureValue | string | string[] | undefined | null): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  return v.items ? v.items.join(', ') : (v.text ?? '');
}

/** A feature value as a list (image URLs): the items, or the text as one item when it is not empty. */
export function featureItems(v: FeatureValue | string | string[] | undefined | null): string[] {
  if (v == null) return [];
  if (typeof v === 'string') return v.trim() ? [v] : [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return v.items ? v.items.filter(Boolean) : v.text?.trim() ? [v.text] : [];
}

/** Features from a file or an older record (`string | string[]` per key) as `FeatureValue`s. */
export function toFeatures(raw: Record<string, unknown> | undefined | null): Record<string, FeatureValue> {
  const out: Record<string, FeatureValue> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (Array.isArray(v)) out[k] = {items: v.map(String)};
    else if (v && typeof v === 'object') out[k] = v as FeatureValue;
    else out[k] = {text: v == null ? '' : String(v)};
  }
  return out;
}
