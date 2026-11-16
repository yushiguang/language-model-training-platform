import type {FeatureSelection, LabelSignature, Msg, RuleGroup, Schema, StructuredFieldPrompt, StructuredPrompt} from '@tsp/contracts';
import {msg, msgText} from './i18n.ts';
import {FEATURES, ITEM_ROWS, labelOf} from './catalogue.ts';

/**
 * Structured prompts (spec 1.0.0, section 3). A prompt is parts (task, features, label fields with
 * a definition per value, the user's named rule groups, images); `compilePrompt` writes the text
 * the model reads, in XML-tagged sections (2026-11-16 refinements, 2.4).
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

/**
 * A new project's starting point: nothing written and nothing ticked (2026-11-16 refinements,
 * 2.1). Features are ticked by the user or by the Prompt helper's draft.
 */
export function emptyStructuredPrompt(): StructuredPrompt {
  return {taskSummary: '', features: emptyFeatures(), fields: [], ruleGroups: [], images: []};
}

/** Ids for rule groups that came without one (a model's answer, an import): unique in the prompt. */
function withIds(groups: RuleGroup[]): RuleGroup[] {
  const seen = new Set<string>();
  return groups.map((g, i) => {
    let id = g.id && !seen.has(g.id) ? g.id : `rg${i + 1}`;
    for (let n = i + 1; seen.has(id); n++) id = `rg${n + 1}`;
    seen.add(id);
    return {...g, id};
  });
}

/** Rule groups read from untyped JSON: objects with a title or content; anything else is skipped. */
export function readRuleGroups(x: unknown): RuleGroup[] | null {
  if (!Array.isArray(x)) return null;
  const out: RuleGroup[] = [];
  for (const g of x) {
    if (!g || typeof g !== 'object') continue;
    const o = g as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title : '';
    const content = typeof o.content === 'string' ? o.content : '';
    if (title.trim() || content.trim()) out.push({id: typeof o.id === 'string' ? o.id : '', title, content});
  }
  return withIds(out);
}

/**
 * A stored prompt in today's shape. Prompts saved before 2026-11-16 had one "generalRules" text
 * and a "note" per field: they become rule groups ("General rules", and "<field> rules").
 */
export function normalizeStructured(p: StructuredPrompt): StructuredPrompt {
  type Legacy = Omit<StructuredPrompt, 'fields'> & {generalRules?: unknown; fields: (StructuredFieldPrompt & {note?: unknown})[]};
  const legacy = p as Legacy;
  const hasNotes = legacy.fields.some(f => 'note' in f);
  if (Array.isArray(legacy.ruleGroups) && !('generalRules' in legacy) && !hasNotes) return p;
  const groups: RuleGroup[] = [...(Array.isArray(legacy.ruleGroups) ? legacy.ruleGroups : [])];
  if (typeof legacy.generalRules === 'string' && legacy.generalRules.trim()) groups.push({id: '', title: 'General rules', content: legacy.generalRules.trim()});
  for (const f of legacy.fields) if (typeof f.note === 'string' && f.note.trim()) groups.push({id: '', title: `${f.name} rules`, content: f.note.trim()});
  const {generalRules: _g, ...rest} = legacy;
  return {...rest, fields: legacy.fields.map(({note: _n, ...f}) => f as StructuredFieldPrompt), ruleGroups: withIds(groups)};
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

/** An XML attribute value: quotes, ampersands and angle brackets escaped. */
const attr = (x: string) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The text the model reads, built the same way every time, in XML-tagged sections so the model
 * sees clear boundaries and text inside an item's features cannot pass for an instruction
 * (2026-11-16 refinements, 2.4): persona and task, input features (one line per ticked feature, so
 * a placeholder can never be unticked, unused or broken), the label fields with a definition per
 * value, the rule groups, reference images, the output format. The site adds its reason line after
 * it at labeling time.
 */
export function compilePrompt(p0: StructuredPrompt, signature?: LabelSignature): string {
  const p = normalizeStructured(p0);
  const sig = signature ?? signatureOf(p);
  const blocks: string[] = [];
  blocks.push(`<persona_and_task>\n${p.taskSummary.trim() || 'Read the post and label it.'}\n</persona_and_task>`);

  const keys = featureKeys(p.features);
  blocks.push(
    [
      '<input_features>',
      ...(keys.length ? keys.map(k => `  <feature name="${attr(labelOf(k))}">{{${k}}}</feature>`) : ['  (no features ticked)']),
      '</input_features>',
      'A feature shown as "none" is empty for this post.',
    ].join('\n'),
  );

  const fields = sig.fields.map(sf => {
    const f = p.fields.find(x => x.name === sf.name);
    const def = (v: string) => f?.values.find(x => x.name === v)?.definition.trim() ?? '';
    const bounds = sf.kind === 'multi' ? ` min="${sf.min ?? 1}" max="${sf.max ?? sf.values.length}"` : '';
    return [
      `  <field name="${attr(sf.name)}" selection="${sf.kind}"${bounds}>`,
      ...sf.values.map(v => (def(v) ? `    <label value="${attr(v)}">${def(v)}</label>` : `    <label value="${attr(v)}"/>`)),
      '  </field>',
    ].join('\n');
  });
  blocks.push(['<output_labels>', ...fields, '</output_labels>'].join('\n'));

  const groups = p.ruleGroups.filter(g => g.content.trim());
  if (groups.length) blocks.push(['<rules>', ...groups.map(g => `  <rule_group name="${attr(g.title.trim())}">\n${g.content.trim()}\n  </rule_group>`), '</rules>'].join('\n'));
  if (p.images.length) blocks.push(['<reference_images>', ...p.images.map((img, i) => `  <image name="${attr(img.name)}">[Image ${i + 1}]</image>`), '</reference_images>'].join('\n'));

  const shape = sig.fields.map(f => `"${f.name}": ${f.kind === 'single' ? `"${f.values.join(' | ')}"` : `["${f.values.join('" | "')}"]`}`).join(', ');
  const choose = sig.fields.filter(f => f.kind === 'multi').map(f => `${f.name}: ${cardinality({...f, values: f.values.map(name => ({name, definition: ''}))}).toLowerCase()}`);
  blocks.push(
    [
      '<output_format>',
      'Return one JSON object only, with exactly these field keys and only the label values allowed in <output_labels>:',
      `{${shape}}`,
      ...(choose.length ? [`For multi-select fields, ${choose.join('; ')}.`] : []),
      '</output_format>',
    ].join('\n'),
  );
  return blocks.join('\n\n');
}

export interface StructuredIssue {
  /** Where the problem is, for the editor to point at. */
  where: 'task' | 'features' | 'field' | 'value' | 'rules';
  field?: string;
  value?: string;
  /** The rule group's id, when `where` is 'rules'. */
  group?: string;
  /** In English. */
  message: string;
  /** The same as a catalog key and params, for the page (spec 1.1.0, 2.3). */
  msg: Msg;
}

/** What stops a structured prompt from being saved, in the user's words. Empty: it can be saved. */
export function checkStructured(p: StructuredPrompt): StructuredIssue[] {
  const out: StructuredIssue[] = [];
  const add = (i: Omit<StructuredIssue, 'message' | 'msg'>, m: Msg) => out.push({...i, message: msgText(m), msg: m});
  if (!featureKeys(p.features).length) add({where: 'features'}, msg('Tick at least one input feature'));
  for (const g of p.ruleGroups ?? []) if (!g.title.trim() && g.content.trim()) add({where: 'rules', group: g.id}, msg('A rule group has rules but no title'));
  if (!p.fields.length) add({where: 'field'}, msg('Add at least one label field'));
  const names = new Set<string>();
  for (const f of p.fields) {
    const name = f.name.trim();
    if (!name) add({where: 'field', field: f.name}, msg('A field has no name'));
    else if (names.has(name)) add({where: 'field', field: f.name}, msg('Two fields are named {name}', {name}));
    names.add(name);
    if (f.values.length < 2) add({where: 'field', field: f.name}, name ? msg('{name} needs at least 2 values', {name}) : msg('A field needs at least 2 values'));
    const values = new Set<string>();
    for (const v of f.values) {
      const vn = v.name.trim();
      if (!vn) add({where: 'value', field: f.name, value: v.name}, name ? msg('A value of {name} has no name', {name}) : msg('A value of a field has no name'));
      else if (values.has(vn)) add({where: 'value', field: f.name, value: v.name}, msg('{name} has the value {value} twice', {name, value: vn}));
      values.add(vn);
    }
    if (f.kind === 'multi') {
      const min = f.min ?? 1;
      const max = f.max ?? f.values.length;
      if (min < 0 || max < 1 || min > max || max > f.values.length) add({where: 'field', field: f.name}, msg('{name}: choose {min} to {max} does not fit {n} values', {name, min, max, n: f.values.length}));
    }
  }
  return out;
}

/** Names and text trimmed and empty rule groups dropped, so two prompts that read the same are the same. */
export function tidyStructured(p0: StructuredPrompt): StructuredPrompt {
  const p = normalizeStructured(p0);
  return {
    taskSummary: p.taskSummary.trim(),
    features: {video: [...p.features.video], photo_text: [...p.features.photo_text], metadata: [...p.features.metadata]},
    fields: p.fields.map(f => ({
      name: f.name.trim(),
      kind: f.kind,
      ...(f.kind === 'multi' ? {min: f.min ?? 1, max: f.max ?? f.values.length} : {}),
      values: f.values.map(v => ({name: v.name.trim(), definition: v.definition.trim()})),
    })),
    ruleGroups: p.ruleGroups.map(g => ({id: g.id, title: g.title.trim(), content: g.content.trim()})).filter(g => g.title || g.content),
    images: [...p.images],
  };
}

/** A structured prompt from label fields alone (tests, and the stand-in helper's first draft). */
export function structuredFromSchema(schema: Schema, taskSummary = '', features?: FeatureSelection): StructuredPrompt {
  return {...emptyStructuredPrompt(), taskSummary, ...(features ? {features} : {}), fields: schema.fields.map(f => ({...f, values: f.values.map(v => ({...v}))}))};
}

/**
 * The group in `base` that `g` continues: the same id, else the same title (a helper may write
 * groups without ids). Used by change marks and change summaries.
 */
export function matchRuleGroup(g: RuleGroup, base: RuleGroup[]): RuleGroup | undefined {
  return base.find(x => x.id === g.id) ?? base.find(x => x.title.trim().toLowerCase() === g.title.trim().toLowerCase() && x.title.trim() !== '');
}

/** How many rule groups were added, removed or changed between two lists. */
export function ruleGroupChanges(a: RuleGroup[], b: RuleGroup[]): number {
  let n = 0;
  const used = new Set<RuleGroup>();
  for (const g of b) {
    const was = matchRuleGroup(g, a.filter(x => !used.has(x)));
    if (!was) n++;
    else {
      used.add(was);
      if (was.title.trim() !== g.title.trim() || was.content.trim() !== g.content.trim()) n++;
    }
  }
  return n + a.filter(x => !used.has(x)).length;
}

/** One line saying what changed between two structured prompts, for a version's change note. */
export function structuredChangeSummary(a: StructuredPrompt, b: StructuredPrompt): string {
  const parts: string[] = [];
  if (a.taskSummary !== b.taskSummary) parts.push('task summary');
  let defs = 0;
  for (const f of b.fields) {
    const was = a.fields.find(x => x.name === f.name);
    for (const v of f.values) if ((was?.values.find(x => x.name === v.name)?.definition ?? '') !== v.definition) defs++;
  }
  if (defs) parts.push(`${defs} definition${defs === 1 ? '' : 's'}`);
  if (!sameSignature(signatureOf(a), signatureOf(b))) parts.push('label fields');
  const rules = ruleGroupChanges(a.ruleGroups, b.ruleGroups);
  if (rules) parts.push(`${rules} rule group${rules === 1 ? '' : 's'}`);
  if (JSON.stringify(a.features) !== JSON.stringify(b.features)) parts.push('features');
  if (JSON.stringify(a.images) !== JSON.stringify(b.images)) parts.push('images');
  return parts.length ? `Changed ${parts.join(', ')}` : 'No changes';
}

/**
 * A helper's rewording laid over the prompt it started from: the task, features, rule groups and
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
      return {...f, values: f.values.map(v => ({name: v.name, definition: str(Array.isArray(nx?.values) ? nx.values.find(y => y && y.name === v.name)?.definition : undefined, v.definition)}))};
    }),
    ruleGroups: keepIds(readRuleGroups(next.ruleGroups) ?? base.ruleGroups, base.ruleGroups),
    images: base.images,
  };
}

/** Groups a helper wrote get the id of the group they continue, so change marks line up. */
function keepIds(groups: RuleGroup[], base: RuleGroup[]): RuleGroup[] {
  const left = [...base];
  return withIds(
    groups.map(g => {
      const was = matchRuleGroup(g, left);
      if (was) left.splice(left.indexOf(was), 1);
      return was ? {...g, id: was.id} : {...g, id: base.some(x => x.id === g.id) ? '' : g.id};
    }),
  );
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
    fields.push({name: f.name, kind, ...(kind === 'multi' ? {min: typeof f.min === 'number' ? f.min : 1, max: typeof f.max === 'number' ? f.max : values.length} : {}), values});
  }
  if (!fields.length) return null;
  const nf = o.features as Partial<FeatureSelection> | undefined;
  const group = (g: unknown, d: string[]) => (Array.isArray(g) ? g.filter((k): k is string => typeof k === 'string') : d);
  return tidyStructured({
    taskSummary: typeof o.taskSummary === 'string' ? o.taskSummary : base.taskSummary,
    features: nf && typeof nf === 'object' ? {video: group(nf.video, base.features.video), photo_text: group(nf.photo_text, base.features.photo_text), metadata: group(nf.metadata, base.features.metadata)} : base.features,
    fields,
    ruleGroups: keepIds(readRuleGroups(o.ruleGroups) ?? base.ruleGroups, base.ruleGroups),
    images: base.images,
  });
}

/** The features a structured prompt reads, as a version's `features` (the compiled text lists the same keys). */
export const structuredEquals = (a: StructuredPrompt, b: StructuredPrompt) => JSON.stringify(tidyStructured(a)) === JSON.stringify(tidyStructured(b));
