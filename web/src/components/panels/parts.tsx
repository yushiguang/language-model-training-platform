'use client';

import {titleCase} from '@/i18n/titleCase';
import type {ReactNode} from 'react';
import {Heading} from '@astryxdesign/core/Heading';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/Layout';
import {useLocale} from '@/i18n/LocaleProvider';
import {t, type T} from '@/i18n/text';
import {FIELDS, type Field, type FieldId} from '@/mock/fields';

export {fmt2, pct} from '@/mock/numbers';

export function useNumber() {
  const {locale} = useLocale();
  const format = new Intl.NumberFormat(locale);
  return (v: number) => format.format(v);
}

/** One titled block inside an artifact page. */
export function PanelSection({title, description, aside, children}: {title: T; description?: T; aside?: ReactNode; children: ReactNode}) {
  const {tr} = useLocale();
  return (
    <section className="panel-section">
      <VStack gap={3}>
        <VStack gap={0.5}>
          <div className="panel-section-head">
            <Heading level={3}>{titleCase(tr(title))}</Heading>
            {aside}
          </div>
          {description && (
            <Text type="supporting" color="secondary">
              {tr(description)}
            </Text>
          )}
        </VStack>
        {children}
      </VStack>
    </section>
  );
}

/** Headline numbers as tiles: the value large, its label under it. */
export function StatGrid({stats}: {stats: {label: string; value: string; note?: string}[]}) {
  return (
    <div className="stat-grid">
      {stats.map(s => (
        <div key={s.label} className="stat">
          <div className="stat-value">{s.value}</div>
          <div className="stat-label">{s.label}</div>
          {s.note && <div className="stat-note">{s.note}</div>}
        </div>
      ))}
    </div>
  );
}

/** How many values a field takes, in words. */
export function fieldKind(field: Field): T {
  if (field.kind === 'single') return t('Pick one', '单选');
  const [min, max] = field.range ?? [1, field.values.length];
  return t(`Pick ${min} to ${max}`, `选 ${min} 到 ${max} 个`);
}

/** Switches a page between the label fields. */
export function FieldSwitch({value, onChange, counts}: {value: FieldId; onChange: (field: FieldId) => void; counts?: Record<FieldId, number>}) {
  const {tr} = useLocale();
  return (
    <SegmentedControl label={tr(t('Label field', '标签字段'))} size="sm" value={value} onChange={v => onChange(v as FieldId)}>
      {FIELDS.map(f => (
        <SegmentedControlItem key={f.id} value={f.id} label={counts ? `${tr(f.name)} · ${counts[f.id]}` : tr(f.name)} />
      ))}
    </SegmentedControl>
  );
}
