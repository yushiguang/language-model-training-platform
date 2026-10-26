'use client';

import {useLocale} from '@/i18n/LocaleProvider';
import {LABEL_BY_ID, type LabelId} from '@/mock/labels';

/** A label's name with its fixed series color beside it; the name always carries the identity. */
export function LabelChip({id}: {id: LabelId}) {
  const {tr} = useLocale();
  const label = LABEL_BY_ID[id];
  return (
    <span className="label-chip">
      <span className="viz-swatch" style={{background: label.color}} />
      {tr(label.name)}
    </span>
  );
}
