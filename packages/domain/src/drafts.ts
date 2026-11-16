import type {MixUp, Schema, StructuredPrompt} from '@tsp/contracts';

/** A rule aimed at one mix-up, for the stand-in optimiser. A real optimiser writes its own. */
export function ruleFor(m: MixUp, schema: Schema): string {
  const field = schema.fields.find(f => f.name === m.field);
  const def = (v: string | null) => field?.values.find(x => x.name === v)?.definition ?? '';
  if (m.kind === 'confused') return `Before choosing ${m.predicted}, check that it fits the definition (${def(m.predicted) || m.predicted}); if not, prefer ${m.gold}.`;
  if (m.kind === 'extra') return `Only add ${m.predicted} when the post clearly fits it (${def(m.predicted) || m.predicted}); tag fewer topics unless the post clearly covers more.`;
  return `Always include ${m.gold} when the post fits it (${def(m.gold) || m.gold}).`;
}

/** An id no group in the list has yet ("rg1", "rg2", ...). */
export function nextRuleGroupId(groups: {id: string}[]): string {
  let n = groups.length + 1;
  while (groups.some(g => g.id === `rg${n}`)) n++;
  return `rg${n}`;
}

/** The title of the rule group that holds rules about one field. */
export const fieldRulesTitle = (fieldName: string) => `${fieldName} rules`;

/**
 * Adds a rule, one rule per line, to the rule group for that field ("<field> rules"), made at the
 * end when there is none; an unknown field: the "General rules" group.
 */
export function addFieldRule(p: StructuredPrompt, fieldName: string, rule: string): StructuredPrompt {
  const title = p.fields.some(f => f.name === fieldName) ? fieldRulesTitle(fieldName) : 'General rules';
  const at = p.ruleGroups.findIndex(g => g.title.trim().toLowerCase() === title.toLowerCase());
  if (at < 0) {
    return {...p, ruleGroups: [...p.ruleGroups, {id: nextRuleGroupId(p.ruleGroups), title, content: rule}]};
  }
  return {...p, ruleGroups: p.ruleGroups.map((g, i) => (i === at ? {...g, content: [g.content.trim(), rule].filter(Boolean).join('\n')} : g))};
}

/** True when the prompt already says this rule somewhere. */
export const hasRule = (p: StructuredPrompt, rule: string) => p.ruleGroups.some(g => g.content.includes(rule));

export const SAMPLE_SCHEMA: Schema = {
  fields: [
    {
      name: 'primary_value',
      kind: 'single',
      values: [
        {name: 'Entertainment', definition: 'fun, emotion or story; nothing usable left afterwards'},
        {name: 'Practical', definition: 'something the viewer can act on'},
        {name: 'Discussion', definition: "the poster's own added view, inviting replies (a clip with no added comment is not Discussion)"},
        {name: 'Ecosystem issue', definition: 'spam, misleading claims, or selling something without saying it is an ad'},
      ],
    },
    {
      name: 'format',
      kind: 'single',
      values: [
        {name: 'Vlog', definition: "the poster's own day or life, on camera"},
        {name: 'Tutorial', definition: 'shows how to do something, step by step'},
        {name: 'Review', definition: 'judges a product, place or service'},
        {name: 'Skit', definition: 'a scripted, acted scene'},
        {name: 'Clip', definition: 'cut from a show, film or stream'},
        {name: 'Other', definition: 'none of the above'},
      ],
    },
    {
      name: 'topics',
      kind: 'multi',
      min: 1,
      max: 3,
      values: [
        {name: 'Food & drink', definition: 'cooking, eating out, drinks'},
        {name: 'Travel', definition: 'trips, places, getting around'},
        {name: 'Home & renting', definition: 'flats, moving, home life'},
        {name: 'Work & money', definition: 'jobs, careers, budgets'},
        {name: 'Tech', definition: 'devices, apps, the internet'},
        {name: 'Health & fitness', definition: 'exercise, diet, wellbeing'},
        {name: 'Beauty & fashion', definition: 'clothes, make-up, style'},
        {name: 'Pets & animals', definition: 'pets and wildlife'},
        {name: 'Games', definition: 'video, board and card games'},
        {name: 'News & society', definition: 'current events, public issues'},
      ],
    },
  ],
};

/** The stand-in helper's first draft: the sample labels with a task line and the usual features. */
export const SAMPLE_STRUCTURED: StructuredPrompt = {
  taskSummary: 'You are a content analyst for a short-video platform. Read the post and tag it.',
  features: {
    video: ['Description', 'OCR_Text', 'ASR', 'Creator_Nick_Name', 'Creator_Bio'],
    photo_text: ['Title', 'Description', 'OCR_Text', 'ASR', 'Creator_Nick_Name', 'Creator_Bio'],
    metadata: ['Country_Code', 'Language'],
  },
  fields: SAMPLE_SCHEMA.fields.map(f => ({...f, values: f.values.map(v => ({...v}))})),
  ruleGroups: [],
  images: [],
};
