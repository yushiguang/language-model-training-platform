import {FIELDS, valueOf, type Field, type FieldId} from './fields';

/** The JSON Schema the platform uses to parse and validate the teacher's output. */
export interface OutputSchema {
  $schema: string;
  title: string;
  type: 'object';
  required: string[];
  properties: Record<string, Record<string, unknown>>;
  additionalProperties: false;
}

/** Default labels by field, as value ids; a field without one has no entry. */
export type Defaults = Partial<Record<FieldId, string>>;

function fieldSchema(field: Field, defaultId?: string): Record<string, unknown> {
  const names = field.values.map(v => v.name.en);
  const fallback = defaultId ? valueOf(field.id, defaultId).name.en : undefined;
  if (field.kind === 'single')
    return {
      type: 'string',
      enum: names,
      ...(fallback ? {default: fallback} : {}),
    };
  return {
    type: 'array',
    items: {type: 'string', enum: names},
    minItems: field.range?.[0] ?? 1,
    maxItems: field.range?.[1] ?? names.length,
    uniqueItems: true,
    ...(fallback ? {default: [fallback]} : {}),
  };
}

/** The teacher's output as JSON Schema: the teacher-only fields, then every label field with its allowed values. */
export function outputSchema(defaults: Defaults): OutputSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Video tags · teacher output',
    type: 'object',
    required: ['summary', 'reasoning', ...FIELDS.map(f => f.id)],
    properties: {
      summary: {
        type: 'string',
        description: 'What happens in the video, in one sentence',
      },
      reasoning: {
        type: 'string',
        description: 'Why each field has its value, in two to four sentences',
      },
      ...Object.fromEntries(FIELDS.map(f => [f.id, fieldSchema(f, defaults[f.id])])),
    },
    additionalProperties: false,
  };
}

/** The default label of a field as written in the JSON, as a value id. */
export function defaultIn(schema: OutputSchema, field: Field): string | undefined {
  const raw = schema.properties[field.id]?.default;
  const name = Array.isArray(raw) ? raw[0] : raw;
  return field.values.find(v => v.name.en === name)?.id;
}

export function withDefault(schema: OutputSchema, field: Field, id: string | undefined): OutputSchema {
  const {default: _old, ...rest} = schema.properties[field.id] ?? {};
  const name = id ? valueOf(field.id, id).name.en : undefined;
  const next = name ? {...rest, default: field.kind === 'single' ? name : [name]} : rest;
  return {...schema, properties: {...schema.properties, [field.id]: next}};
}
