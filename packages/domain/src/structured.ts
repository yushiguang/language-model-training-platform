import type {FeatureSelection, LabelSignature, LabelValue, Msg, RuleGroup, Schema, StructuredPrompt} from '@tsp/contracts';
import {msg, msgText} from './i18n.ts';
import {FEATURES, ITEM_ROWS, labelOf} from './catalogue.ts';

/**
 * Structured prompts (spec 1.0.0, section 3). A prompt is parts (task, features, the project's one
 * mutually-exclusive label with a definition per value, the user's named rule groups, images);
 * `compilePrompt` writes the text the model reads, in XML-tagged sections (2026-11-16 refinements,
 * 2.4). Every project classifies exactly one label (2026-11-16, single-label projects).
 * The label signature (key and value names, no wording) is what gold labels and scores are tied to.
 */

/** The signature a structured prompt answers with. */
export function signatureOf(p: Pick<StructuredPrompt, 'label'>): LabelSignature {
  return {name: p.label.name, values: p.label.values.map(v => v.name)};
}

/** True when two signatures allow the same answers (order of values included). */
export const sameSignature = (a: LabelSignature, b: LabelSignature) => a.name === b.name && JSON.stringify(a.values) === JSON.stringify(b.values);

/** The label with its wording, for labeling pages, validation and scoring. */
export function schemaOf(p: Pick<StructuredPrompt, 'label'>): Schema {
  return {name: p.label.name, values: p.label.values.map(v => ({name: v.name, definition: v.definition}))};
}

export const emptyFeatures = (): FeatureSelection => ({video: [], photo_text: [], metadata: []});

/**
 * A new project's starting point: nothing written and nothing ticked (2026-11-16 refinements,
 * 2.1). Features are ticked by the user or by the Prompt helper's draft.
 */
export function emptyStructuredPrompt(): StructuredPrompt {
  return {taskSummary: '', features: emptyFeatures(), label: {name: '', values: []}, ruleGroups: [], images: []};
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

/** Label values read from untyped JSON: names as strings or objects with a name and definition. */
function readValues(x: unknown): LabelValue[] {
  if (!Array.isArray(x)) return [];
  return x.flatMap(v => {
    if (typeof v === 'string') return [{name: v, definition: ''}];
    if (!v || typeof v !== 'object' || typeof (v as {name?: unknown}).name !== 'string') return [];
    const d = (v as {definition?: unknown}).definition;
    return [{name: (v as {name: string}).name, definition: typeof d === 'string' ? d : ''}];
  });
}

/**
 * A stored prompt in today's shape. Prompts saved before 2026-11-16 had one "generalRules" text,
 * a "note" per field, and a list of label fields: the rules become rule groups ("General rules",
 * "<field> rules") and the first field becomes the label. Such projects are test data and are
 * started fresh; this only keeps an old record from breaking a page.
 */
export function normalizeStructured(p: StructuredPrompt): StructuredPrompt {
  type Legacy = StructuredPrompt & {generalRules?: unknown; fields?: {name?: unknown; note?: unknown; values?: unknown}[]};
  const legacy = p as Legacy;
  const fields = Array.isArray(legacy.fields) ? legacy.fields : null;
  const hasLabel = !!legacy.label && typeof legacy.label === 'object';
  if (hasLabel && !fields && Array.isArray(legacy.ruleGroups) && !('generalRules' in legacy)) return p;
  const groups: RuleGroup[] = [...(Array.isArray(legacy.ruleGroups) ? legacy.ruleGroups : [])];
  if (typeof legacy.generalRules === 'string' && legacy.generalRules.trim()) groups.push({id: '', title: 'General rules', content: legacy.generalRules.trim()});
  for (const f of fields ?? []) if (typeof f.note === 'string' && f.note.trim() && typeof f.name === 'string') groups.push({id: '', title: `${f.name} rules`, content: f.note.trim()});
  const first = fields?.[0];
  const label: Schema = hasLabel ? legacy.label : {name: typeof first?.name === 'string' ? first.name : '', values: readValues(first?.values)};
  const {generalRules: _g, fields: _f, ...rest} = legacy;
  return {...rest, label, ruleGroups: withIds(groups)};
}

/** Ticked feature keys in the order the prompt lists them: item features, then metadata. */
export function featureKeys(sel: FeatureSelection): string[] {
  const item = ITEM_ROWS.map(r => r.key).filter(k => sel.video.includes(k) || sel.photo_text.includes(k));
  const meta = FEATURES.metadata.map(d => d.key).filter(k => sel.metadata.includes(k));
  return [...item, ...meta];
}

/** An XML attribute value: quotes, ampersands and angle brackets escaped. */
const attr = (x: string) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The text the model reads, built the same way every time, in XML-tagged sections so the model
 * sees clear boundaries and text inside an item's features cannot pass for an instruction
 * (2026-11-16 refinements, 2.4): persona and task, input features (one line per ticked feature, so
 * a placeholder can never be unticked, unused or broken), the label with a multi-line definition
 * per value, the rule groups, reference images, the output format. The site adds its reason line after
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

  const def = (v: string) => p.label.values.find(x => x.name === v)?.definition.trim() ?? '';
  blocks.push(
    [
      `<output_labels name="${attr(sig.name)}" selection="single">`,
      ...sig.values.map(v => (def(v) ? `  <label value="${attr(v)}">\n${def(v)}\n  </label>` : `  <label value="${attr(v)}"/>`)),
      '</output_labels>',
    ].join('\n'),
  );

  const groups = p.ruleGroups.filter(g => g.content.trim());
  if (groups.length) blocks.push(['<rules>', ...groups.map(g => `  <rule_group name="${attr(g.title.trim())}">\n${g.content.trim()}\n  </rule_group>`), '</rules>'].join('\n'));
  if (p.images.length) blocks.push(['<reference_images>', ...p.images.map((img, i) => `  <image name="${attr(img.name)}">[Image ${i + 1}]</image>`), '</reference_images>'].join('\n'));

  blocks.push(
    [
      '<output_format>',
      `Return one JSON object only, with the exact key "${sig.name}" and exactly one allowed value from <output_labels>:`,
      `{"${sig.name}": "${sig.values.join(' | ')}"}`,
      '</output_format>',
    ].join('\n'),
  );
  return blocks.join('\n\n');
}

export interface StructuredIssue {
  /** Where the problem is, for the editor to point at. */
  where: 'task' | 'features' | 'label' | 'value' | 'rules';
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
  const label = p.label;
  if (!label.name.trim()) add({where: 'label'}, msg('Name the label'));
  if (label.values.length < 2) add({where: 'label'}, msg('The label needs at least 2 values'));
  const values = new Set<string>();
  for (const v of label.values) {
    const vn = v.name.trim();
    if (!vn) add({where: 'value', value: v.name}, msg('A value has no name'));
    else if (values.has(vn)) add({where: 'value', value: v.name}, msg('The value {value} is there twice', {value: vn}));
    values.add(vn);
  }
  return out;
}

/** Names and text trimmed and empty rule groups dropped, so two prompts that read the same are the same. */
export function tidyStructured(p0: StructuredPrompt): StructuredPrompt {
  const p = normalizeStructured(p0);
  return {
    taskSummary: p.taskSummary.trim(),
    features: {video: [...p.features.video], photo_text: [...p.features.photo_text], metadata: [...p.features.metadata]},
    label: {name: p.label.name.trim(), values: p.label.values.map(v => ({name: v.name.trim(), definition: v.definition.trim()}))},
    ruleGroups: p.ruleGroups.map(g => ({id: g.id, title: g.title.trim(), content: g.content.trim()})).filter(g => g.title || g.content),
    images: [...p.images],
  };
}

/** A structured prompt from a label alone (tests, and the stand-in helper's first draft). */
export function structuredFromSchema(schema: Schema, taskSummary = '', features?: FeatureSelection): StructuredPrompt {
  return {...emptyStructuredPrompt(), taskSummary, ...(features ? {features} : {}), label: {name: schema.name, values: schema.values.map(v => ({...v}))}};
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
  for (const v of b.label.values) if ((a.label.values.find(x => x.name === v.name)?.definition ?? '') !== v.definition) defs++;
  if (defs) parts.push(`${defs} definition${defs === 1 ? '' : 's'}`);
  if (!sameSignature(signatureOf(a), signatureOf(b))) parts.push('label values');
  const rules = ruleGroupChanges(a.ruleGroups, b.ruleGroups);
  if (rules) parts.push(`${rules} rule group${rules === 1 ? '' : 's'}`);
  if (JSON.stringify(a.features) !== JSON.stringify(b.features)) parts.push('features');
  if (JSON.stringify(a.images) !== JSON.stringify(b.images)) parts.push('images');
  return parts.length ? `Changed ${parts.join(', ')}` : 'No changes';
}

/**
 * A helper's rewording laid over the prompt it started from: the task, features, rule groups and
 * definitions come from `next`; the label's key and value names stay as in
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
    label: {
      name: base.label.name,
      values: base.label.values.map(v => {
        const nv = next.label && typeof next.label === 'object' ? readValues(next.label.values).find(y => y.name === v.name) : undefined;
        return {name: v.name, definition: nv ? nv.definition : v.definition};
      }),
    },
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

/**
 * A structured prompt read from untyped JSON (a model's answer): null when it has no usable label.
 * A model that still writes a list of fields gets its first field read as the label.
 */
export function readStructured(x: unknown, fallback?: StructuredPrompt): StructuredPrompt | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const raw = (o.label && typeof o.label === 'object' ? o.label : Array.isArray(o.fields) ? o.fields[0] : null) as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const values = readValues(raw.values);
  if (!values.length) return null;
  const base = fallback ?? emptyStructuredPrompt();
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : base.label.name;
  const nf = o.features as Partial<FeatureSelection> | undefined;
  const group = (g: unknown, d: string[]) => (Array.isArray(g) ? g.filter((k): k is string => typeof k === 'string') : d);
  return tidyStructured({
    taskSummary: typeof o.taskSummary === 'string' ? o.taskSummary : base.taskSummary,
    features: nf && typeof nf === 'object' ? {video: group(nf.video, base.features.video), photo_text: group(nf.photo_text, base.features.photo_text), metadata: group(nf.metadata, base.features.metadata)} : base.features,
    label: {name, values},
    ruleGroups: keepIds(readRuleGroups(o.ruleGroups) ?? base.ruleGroups, base.ruleGroups),
    images: base.images,
  });
}

/** The features a structured prompt reads, as a version's `features` (the compiled text lists the same keys). */
export const structuredEquals = (a: StructuredPrompt, b: StructuredPrompt) => JSON.stringify(tidyStructured(a)) === JSON.stringify(tidyStructured(b));
