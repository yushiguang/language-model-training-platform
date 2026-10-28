'use client';

import {ValueList} from '@/components/ValueChip';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import {FIELDS, type FieldId} from '@/mock/fields';
import type {Labels} from '@/mock/posts';

export function sameAnswer(a: string | string[], b: string | string[]): boolean {
  const x = Array.isArray(a) ? [...a].sort() : [a];
  const y = Array.isArray(b) ? [...b].sort() : [b];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** A post's three label fields as rows. With `compareTo`, rows that differ say so in words. */
export function PostLabels({labels, compareTo, differsNote}: {labels: Labels; compareTo?: Labels; differsNote?: string}) {
  const {tr} = useLocale();
  return (
    <dl className="post-labels">
      {FIELDS.map(field => {
        const id = field.id as FieldId;
        const differs = compareTo && !sameAnswer(labels[id], compareTo[id]);
        return (
          <div key={id} className="post-labels-row">
            <dt>{tr(field.name)}</dt>
            <dd>
              <ValueList field={id} ids={labels[id]} />
              {differs && <span className="differs">{differsNote ?? tr(t('differs', '不一致'))}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
