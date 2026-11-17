import type {MixUp, Schema, StructuredPrompt} from '@sprint/contracts';

/**
 * A fix aimed at one mix-up, for the stand-in helpers (a real model writes its own). It goes into
 * the definition of the value `fixTarget` names (2026-11-16): an exclusion for a value chosen
 * wrongly (a confusion, or a value added on a multi-select label), or a reminder for a value left
 * out.
 */
export function ruleFor(m: MixUp, schema: Schema): string {
  const def = (v: string | null) => (v == null ? '' : (schema.values.find(x => x.name === v)?.definition.split('\n')[0].replace(/^[-*\d.)\s]+/, '').trim() ?? ''));
  if (m.kind === 'extra') return `- Leave ${m.predicted} out unless the post clearly shows it.`;
  if (m.kind === 'missed') return `- Also choose ${m.gold} when the post shows it next to other values (${def(m.gold) || m.gold}).`;
  return `- Does not apply when the post fits ${m.gold} better (${def(m.gold) || m.gold}).`;
}

/** The value whose definition `ruleFor`'s line belongs in. */
export const fixTarget = (m: MixUp): string => (m.kind === 'missed' ? m.gold : m.predicted) ?? '';

/**
 * Adds one line to a value's definition (a criterion, exclusion or exemption, as a list item).
 * A one-line definition without a list marker becomes the first item of the list.
 */
export function addToDefinition(p: StructuredPrompt, value: string, line: string): StructuredPrompt {
  return {
    ...p,
    label: {
      ...p.label,
      values: p.label.values.map(v => {
        if (v.name !== value) return v;
        const cur = v.definition.trim();
        const listed = !cur || /^\s*([-*]|\d+[.)])\s/m.test(cur) ? cur : `- ${cur}`;
        return {...v, definition: [listed, line].filter(Boolean).join('\n')};
      }),
    },
  };
}

/** An id no group in the list has yet ("rg1", "rg2", ...). */
export function nextRuleGroupId(groups: {id: string}[]): string {
  let n = groups.length + 1;
  while (groups.some(g => g.id === `rg${n}`)) n++;
  return `rg${n}`;
}

/**
 * Adds a cross-value rule, one rule per line, to the rule group with that title (made at the end
 * when there is none). Rules about one value belong in that value's definition (2026-11-16).
 */
export function addRule(p: StructuredPrompt, title: string, rule: string): StructuredPrompt {
  const at = p.ruleGroups.findIndex(g => g.title.trim().toLowerCase() === title.trim().toLowerCase());
  if (at < 0) {
    return {...p, ruleGroups: [...p.ruleGroups, {id: nextRuleGroupId(p.ruleGroups), title, content: rule}]};
  }
  return {...p, ruleGroups: p.ruleGroups.map((g, i) => (i === at ? {...g, content: [g.content.trim(), rule].filter(Boolean).join('\n')} : g))};
}

/** True when the prompt already says this rule somewhere: a rule group or a definition. */
export const hasRule = (p: StructuredPrompt, rule: string) => p.ruleGroups.some(g => g.content.includes(rule)) || p.label.values.some(v => v.definition.includes(rule));

export const SAMPLE_SCHEMA: Schema = {
  name: 'primary_value',
  kind: 'single',
  values: [
    {name: 'Entertainment', definition: 'fun, emotion or story; nothing usable left afterwards'},
    {name: 'Practical', definition: 'something the viewer can act on'},
    {name: 'Discussion', definition: "the poster's own added view, inviting replies (a clip with no added comment is not Discussion)"},
    {name: 'Ecosystem issue', definition: 'spam, misleading claims, or selling something without saying it is an ad'},
  ],
};

/** The stand-in helper's first draft: the sample label with a task line and the usual features. */
export const SAMPLE_STRUCTURED: StructuredPrompt = {
  taskSummary: 'You are a content analyst for a short-video platform. Read the post and tag it.',
  features: {
    video: ['Description', 'OCR_Text', 'ASR', 'Creator_Nick_Name', 'Creator_Bio'],
    photo_text: ['Title', 'Description', 'OCR_Text', 'ASR', 'Creator_Nick_Name', 'Creator_Bio'],
    metadata: ['Country_Code', 'Language'],
  },
  label: {...SAMPLE_SCHEMA, values: SAMPLE_SCHEMA.values.map(v => ({...v}))},
  ruleGroups: [],
  images: [],
};
