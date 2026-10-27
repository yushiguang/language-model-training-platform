'use client';

import {useLocale} from '@/i18n/LocaleProvider';
import {valueOf, type FieldId} from '@/mock/fields';

/**
 * A field value's name. Primary values carry their fixed series color as a swatch;
 * the name always carries the identity, so color is never the only cue.
 */
export function ValueChip({field, id}: {field: FieldId; id: string}) {
  const {tr} = useLocale();
  const value = valueOf(field, id);
  return (
    <span className={value.color ? 'value-chip' : 'value-chip value-chip-plain'}>
      {value.color && <span className="viz-swatch" style={{background: value.color}} />}
      {tr(value.name)}
    </span>
  );
}

/** Any field's answer: one chip for a single-select field, a wrapped row of chips for a multi-select one. */
export function ValueList({field, ids}: {field: FieldId; ids: string | string[]}) {
  const list = Array.isArray(ids) ? ids : [ids];
  return (
    <span className="value-list">
      {list.map(id => (
        <ValueChip key={id} field={field} id={id} />
      ))}
    </span>
  );
}
