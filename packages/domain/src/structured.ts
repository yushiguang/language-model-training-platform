import type {FeatureSelection, LabelSignature, Schema, StructuredFieldPrompt, StructuredPrompt} from '@tsp/contracts';
import {FEATURES, ITEM_ROWS, labelOf} from './catalogue.ts';

/**
 * Structured prompts (spec 1.0.0, section 3). A prompt is parts (task, features, label fields with
 * a definition per value, general rules, images); `compilePrompt` writes the text the model reads.
 * The label signature (names and bounds, no wording) is what gold labels and scores are tied to.
 */

/** The signature a structured prompt answers with. */
export function signatureOf(p: Pick<StructuredPrompt, 'fields'>): LabelSignature {
  return {
    fields: p.fields.map(f => ({
      name: f.name,
      kind: f.kind,
      ...(f.kind === 'multi' ? {min: f.min ?? 1, max: f.max ?? f.values.length} : {}),
      values: f.values.map(v => v.name),
    })),
  };
}

/** True when two signatures allow the same answers (wording and order of fields aside, order of values included). */
export const sameSignature = (a: LabelSignature, b: LabelSignature) => JSON.stringify(a) === JSON.stringify(b);

/** The label fields with their wording, for labeling pages, validation and scoring. */
export function schemaOf(p: Pick<StructuredPrompt, 'fields'>): Schema {
  return {fields: p.fields.map(f => ({name: f.name, kind: f.kind, ...(f.kind === 'multi' ? {min: f.min ?? 1, max: f.max ?? f.values.length} : {}), values: f.values.map(v => ({name: v.name, definition: v.definition}))}))};
}

export const emptyFeatures = (): FeatureSelection => ({video: [], photo_text: [], metadata: []});

/** A new project's starting point: nothing written, the usual text features ticked. */
export function emptyStructuredPrompt(): StructuredPrompt {
  return {
    taskSummary: '',
    features: {
      video: ['Description', 'OCR_Text', 'ASR'],
      photo_text: ['Title', 'Description', 'OCR_Text'],
      metadata: [],
    },
    fields: [],
    generalRules: '',
    images: [],
  };
}

/** Ticked feature keys in the order the prompt lists them: item features, then metadata. */
export function featureKeys(sel: FeatureSelection): string[] {
  const item = ITEM_ROWS.map(r => r.key).filter(k => sel.video.includes(k) || sel.photo_text.includes(k));
  const meta = FEATURES.metadata.map(d => d.key).filter(k => sel.metadata.includes(k));
  return [...item, ...meta];
}

const cardinality = (f: StructuredFieldPrompt) => {
  if (f.kind === 'single') return 'Choose exactly 1';
  const min = f.min ?? 1;
  const max = f.max ?? f.values.length;
  return min === max ? `Choose exactly ${min}` : `Choose ${min} to ${max}`;
};

/**
 * The text the model reads, built the same way every time:
 * task, input features (one line per ticked feature, so a placeholder can never be unticked,
 * unused or broken), a rubric per field, the general rules, reference images, the output format.
 * The site adds its reason line at labeling time.
 */
export function compilePrompt(p: StructuredPrompt, signature: LabelSignature = signatureOf(p)): string {
  const blocks: string[] = [];
  blocks.push(p.taskSummary.trim() || 'Read the post and label it.');

  const keys = featureKeys(p.features);
  blocks.push(['## Input', ...(keys.length ? keys.map(k => `${labelOf(k)}: {{${k}}}`) : ['(no features ticked)']), 'A feature shown as "none" is empty for this post.'].join('\n'));

  const fields = signature.fields.map((sf, i) => {
    const f = p.fields.find(x => x.name === sf.name);
    const def = (v: string) => f?.values.find(x => x.name === v)?.definition.trim() ?? '';
    const lines = [`### ${i + 1}. ${sf.name} (${cardinality({...sf, values: []} as unknown as StructuredFieldPrompt).toLowerCase()})`, ...sf.values.map(v => (def(v) ? `- ${v}: ${def(v)}` : `- ${v}`))];
    if (f?.note?.trim()) lines.push(`Note: ${f.note.trim()}`);
    return lines.join('\n');
  });
  blocks.push(['## Labels', ...fields].join('\n\n').replace('## Labels\n\n', '## Labels\n'));

  if (p.generalRules.trim()) blocks.push(`## Rules\n${p.generalRules.trim()}`);
  if (p.images.length) blocks.push(['## Reference images', ...p.images.map((img, i) => `${img.name}: [Image ${i + 1}]`)].join('\n'));

  const shape = signature.fields.map(f => `"${f.name}": ${f.kind === 'single' ? `"${f.values.join(' | ')}"` : `["${f.values.join('" | "')}"]`}`).join(', ');
  blocks.push(`## Output\nReturn JSON only, with exactly these keys and only the value names listed:\n{${shape}}`);
  return blocks.join('\n\n');
}

export interface StructuredIssue {
  /** Where the problem is, for the editor to point at. */
  where: 'task' | 'features' | 'field' | 'value' | 'rules';
  field?: string;
  value?: string;
  message: string;
}

/** What stops a structured prompt from being saved, in the user's words. Empty: it can be saved. */
export function checkStructured(p: StructuredPrompt): StructuredIssue[] {
  const out: StructuredIssue[] = [];
  if (!featureKeys(p.features).length) out.push({where: 'features', message: 'Tick at least one input feature'});
  if (!p.fields.length) out.push({where: 'field', message: 'Add at least one label field'});
  const names = new Set<string>();
  for (const f of p.fields) {
    const name = f.name.trim();
    if (!name) out.push({where: 'field', field: f.name, message: 'A field has no name'});
    else if (names.has(name)) out.push({where: 'field', field: f.name, message: `Two fields are named ${name}`});
    names.add(name);
    if (f.values.length < 2) out.push({where: 'field', field: f.name, message: `${name || 'A field'} needs at least 2 values`});
    const values = new Set<string>();
    for (const v of f.values) {
      const vn = v.name.trim();
      if (!vn) out.push({where: 'value', field: f.name, value: v.name, message: `A value of ${name || 'a field'} has no name`});
      else if (values.has(vn)) out.push({where: 'value', field: f.name, value: v.name, message: `${name} has the value ${vn} twice`});
      values.add(vn);
    }
    if (f.kind === 'multi') {
      const min = f.min ?? 1;
      const max = f.max ?? f.values.length;
      if (min < 0 || max < 1 || min > max || max > f.values.length) out.push({where: 'field', field: f.name, message: `${name}: choose ${min} to ${max} does not fit ${f.values.length} values`});
    }
  }
  return out;
}

/** Names and text trimmed, so two prompts that read the same are the same. */
export function tidyStructured(p: StructuredPrompt): StructuredPrompt {
  return {
    taskSummary: p.taskSummary.trim(),
    features: {video: [...p.features.video], photo_text: [...p.features.photo_text], metadata: [...p.features.metadata]},
    fields: p.fields.map(f => ({
      name: f.name.trim(),
      kind: f.kind,
      ...(f.kind === 'multi' ? {min: f.min ?? 1, max: f.max ?? f.values.length} : {}),
      values: f.values.map(v => ({name: v.name.trim(), definition: v.definition.trim()})),
      ...(f.note?.trim() ? {note: f.note.trim()} : {}),
    })),
    generalRules: p.generalRules.trim(),
    images: [...p.images],
  };
}

/** A structured prompt from label fields alone (tests, and the stand-in helper's first draft). */
export function structuredFromSchema(schema: Schema, taskSummary = '', features?: FeatureSelection): StructuredPrompt {
  return {...emptyStructuredPrompt(), taskSummary, ...(features ? {features} : {}), fields: schema.fields.map(f => ({...f, values: f.values.map(v => ({...v}))}))};
}

/** One line saying what changed between two structured prompts, for a version's change note. */
export function structuredChangeSummary(a: StructuredPrompt, b: StructuredPrompt): string {
  const parts: string[] = [];
  if (a.taskSummary !== b.taskSummary) parts.push('task summary');
  let defs = 0;
  for (const f of b.fields) {
    const was = a.fields.find(x => x.name === f.name);
    for (const v of f.values) if ((was?.values.find(x => x.name === v.name)?.definition ?? '') !== v.definition) defs++;
    if ((was?.note ?? '') !== (f.note ?? '')) defs++;
  }
  if (defs) parts.push(`${defs} definition${defs === 1 ? '' : 's'}`);
  if (!sameSignature(signatureOf(a), signatureOf(b))) parts.push('label fields');
  if (a.generalRules !== b.generalRules) parts.push('general rules');
  if (JSON.stringify(a.features) !== JSON.stringify(b.features)) parts.push('features');
  if (JSON.stringify(a.images) !== JSON.stringify(b.images)) parts.push('images');
  return parts.length ? `Changed ${parts.join(', ')}` : 'No changes';
}

/**
 * A helper's rewording laid over the prompt it started from: the task, features, rules, notes and
 * definitions come from `next`; the fields, their kind and bounds and the value names stay as in
 * `base`. The Optimiser and Improve with AI change wording only, so gold labels and scores stand.
 */
export function rewordOnly(base: StructuredPrompt, next: Partial<StructuredPrompt> | null | undefined): StructuredPrompt {
  if (!next || typeof next !== 'object') return base;
  const str = (x: unknown, d: string) => (typeof x === 'string' ? x : d);
  const group = (x: unknown, d: string[]) => (Array.isArray(x) ? x.filter(k => typeof k === 'string') : d);
  const nf = next.features as Partial<FeatureSelection> | undefined;
  return {
    taskSummary: str(next.taskSummary, base.taskSummary),
    features: nf && typeof nf === 'object' ? {video: group(nf.video, base.features.video), photo_text: group(nf.photo_text, base.features.photo_text), metadata: group(nf.metadata, base.features.metadata)} : base.features,
    fields: base.fields.map(f => {
      const nx = Array.isArray(next.fields) ? next.fields.find(y => y && y.name === f.name) : undefined;
      const note = str(nx?.note, f.note ?? '').trim();
      const {note: _old, ...rest} = f;
      return {
        ...rest,
        values: f.values.map(v => ({name: v.name, definition: str(Array.isArray(nx?.values) ? nx.values.find(y => y && y.name === v.name)?.definition : undefined, v.definition)})),
        ...(note ? {note} : {}),
      };
    }),
    generalRules: str(next.generalRules, base.generalRules),
    images: base.images,
  };
}

/** A structured prompt read from untyped JSON (a model's answer): null when it has no usable fields. */
export function readStructured(x: unknown, fallback?: StructuredPrompt): StructuredPrompt | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.fields)) return null;
  const base = fallback ?? emptyStructuredPrompt();
  const fields: StructuredFieldPrompt[] = [];
  for (const f of o.fields as Record<string, unknown>[]) {
    if (!f || typeof f.name !== 'string' || !Array.isArray(f.values)) continue;
    const kind = f.kind === 'multi' ? 'multi' : 'single';
    const values = (f.values as unknown[]).flatMap(v => (typeof v === 'string' ? [{name: v, definition: ''}] : v && typeof (v as {name?: unknown}).name === 'string' ? [{name: (v as {name: string}).name, definition: typeof (v as {definition?: unknown}).definition === 'string' ? (v as {definition: string}).definition : ''}] : []));
    fields.push({name: f.name, kind, ...(kind === 'multi' ? {min: typeof f.min === 'number' ? f.min : 1, max: typeof f.max === 'number' ? f.max : values.length} : {}), values, ...(typeof f.note === 'string' && f.note.trim() ? {note: f.note} : {})});
  }
  if (!fields.length) return null;
  const nf = o.features as Partial<FeatureSelection> | undefined;
  const group = (g: unknown, d: string[]) => (Array.isArray(g) ? g.filter((k): k is string => typeof k === 'string') : d);
  return tidyStructured({
    taskSummary: typeof o.taskSummary === 'string' ? o.taskSummary : base.taskSummary,
    features: nf && typeof nf === 'object' ? {video: group(nf.video, base.features.video), photo_text: group(nf.photo_text, base.features.photo_text), metadata: group(nf.metadata, base.features.metadata)} : base.features,
    fields,
    generalRules: typeof o.generalRules === 'string' ? o.generalRules : base.generalRules,
    images: base.images,
  });
}

/** The features a structured prompt reads, as a version's `features` (the compiled text lists the same keys). */
export const structuredEquals = (a: StructuredPrompt, b: StructuredPrompt) => JSON.stringify(tidyStructured(a)) === JSON.stringify(tidyStructured(b));
