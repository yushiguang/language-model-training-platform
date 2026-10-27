import {FIELDS, RULES, valueOf, type FieldId} from './fields';

/** One label field as the schema's JSON form writes it. */
export interface SchemaField {
  name: FieldId;
  type: 'single_select' | 'multi_select';
  description: string;
  min_values?: number;
  max_values?: number;
  values: {name: string; definition: string; examples?: string[]; counterexamples?: string[]}[];
  default: string;
  check_order?: string[];
}

export interface Schema {
  label_fields: SchemaField[];
  teacher_only_fields: {name: string; description: string}[];
  rules: string[];
  rulings?: {case: string; [field: string]: string}[];
}

/** The schema as JSON, in English like the prompt it comes from. A ruling from the chat is added as an example. */
export function schemaJson(repostRuling?: string): Schema {
  return {
    label_fields: FIELDS.map(f => ({
      name: f.id,
      type: f.kind === 'single' ? 'single_select' : 'multi_select',
      description: f.description.en,
      ...(f.range ? {min_values: f.range[0], max_values: f.range[1]} : {}),
      values: f.values.map(v => ({
        name: v.name.en,
        definition: v.definition?.en ?? '',
        ...(v.examples?.length ? {examples: v.examples.map(e => e.en)} : {}),
        ...(v.counterexamples?.length ? {counterexamples: v.counterexamples.map(e => e.en)} : {}),
      })),
      default: valueOf(f.id, f.defaultValue).name.en,
      ...(f.order ? {check_order: f.order.map(id => valueOf(f.id, id).name.en)} : {}),
    })),
    teacher_only_fields: [
      {name: 'summary', description: 'What happens in the video, in one sentence'},
      {name: 'reasoning', description: 'Why each field has its value, in two to four sentences'},
    ],
    rules: RULES.map(r => r.en),
    ...(repostRuling
      ? {rulings: [{case: 'Reposted interview, no comment from the poster', primary_value: valueOf('primary_value', repostRuling).name.en}]}
      : {}),
  };
}
