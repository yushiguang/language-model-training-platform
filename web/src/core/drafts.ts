import type {FeatureSelection, MixUp, Schema} from './types.ts';

/** The default first prompt, built from the schema (the prompt agent can start from it too). */
export function draftTemplate(schema: Schema, task: string): {template: string; features: FeatureSelection} {
  const fields = schema.fields
    .map((f, i) => {
      const how = f.kind === 'single' ? 'pick exactly one' : `pick ${f.min ?? 1} to ${f.max ?? f.values.length}`;
      return [`### ${i + 1}. ${f.name} (${how})`, ...f.values.map(v => `- ${v.name}: ${v.definition}`)].join('\n');
    })
    .join('\n\n');
  const output = schema.fields
    .map(f => `"${f.name}": ${f.kind === 'single' ? `"${f.values.map(v => v.name).join(' | ')}"` : `["${f.values.map(v => v.name).join('" | "')}"]`}`)
    .join(', ');
  const template = `You are a content analyst for a short-video platform. ${task ? task.trim().replace(/\.?$/, '.') : 'Read the post and tag it.'}

## Policy
${schema.policy}

## Input
Title: {{Title}}
Description: {{Description}}
On-screen text: {{OCR_Text}}
Speech: {{ASR}}
Frames: {{Frame}}
Images: {{Images}}
Creator: {{Creator_Nick_Name}} · {{Creator_Bio}}
Country and language: {{Country_Code}} · {{Language}}

## Fields
${fields}

## Output
Return JSON only:
{"summary": "...", "reasoning": "...", ${output}}`;
  return {
    template,
    features: {
      video: ['Description', 'OCR_Text', 'Frame', 'ASR', 'Creator_Nick_Name', 'Creator_Bio'],
      photo_text: ['Title', 'Description', 'OCR_Text', 'Images', 'ASR', 'Creator_Nick_Name', 'Creator_Bio'],
      metadata: ['Country_Code', 'Language'],
    },
  };
}

/** A rule aimed at one mix-up, for the stand-in optimiser. A real optimiser writes its own. */
export function ruleFor(m: MixUp, schema: Schema): string {
  const field = schema.fields.find(f => f.name === m.field);
  const def = (v: string | null) => field?.values.find(x => x.name === v)?.definition ?? '';
  if (m.kind === 'confused') return `Before choosing ${m.predicted}, check that it fits the definition (${def(m.predicted) || m.predicted}); if not, prefer ${m.gold}.`;
  if (m.kind === 'extra') return `Only add ${m.predicted} when the post clearly fits it (${def(m.predicted) || m.predicted}); tag fewer topics unless the post clearly covers more.`;
  return `Always include ${m.gold} when the post fits it (${def(m.gold) || m.gold}).`;
}

/** Inserts a rule line at the end of a field's section. */
export function insertRule(template: string, fieldName: string, rule: string): string {
  const lines = template.split('\n');
  const start = lines.findIndex(l => new RegExp(`^###\\s*\\d+\\.\\s*${fieldName}\\b`).test(l));
  if (start === -1) return template.replace('## Output', `${rule}\n\n## Output`);
  let end = start + 1;
  while (end < lines.length && !/^##/.test(lines[end]) && lines[end].trim() !== '') end++;
  lines.splice(end, 0, `  ${rule}`);
  return lines.join('\n');
}

export const SAMPLE_SCHEMA: Schema = {
  policy:
    "Judge the poster's own contribution. Words spoken by guests in a clip are not the poster's view. Before choosing Discussion, check that the poster added their own view. A Clip with no added comment is not Discussion. If the post sells something without saying it is an ad, primary_value is Ecosystem issue.",
  fields: [
    {
      name: 'primary_value',
      kind: 'single',
      values: [
        {name: 'Entertainment', definition: 'fun, emotion or story; nothing usable left afterwards'},
        {name: 'Practical', definition: 'something the viewer can act on'},
        {name: 'Discussion', definition: "the poster's own view, inviting replies"},
        {name: 'Ecosystem issue', definition: 'spam, misleading claims, undisclosed ads'},
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
