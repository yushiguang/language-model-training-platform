'use client';

import type {ReactNode} from 'react';
import {Heading} from '@astryxdesign/core/Heading';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/Layout';
import {useLocale} from '@/i18n/LocaleProvider';
import type {T} from '@/i18n/text';

export const fmt2 = (v: number) => v.toFixed(2);
export const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;

export function useNumber() {
  const {locale} = useLocale();
  const format = new Intl.NumberFormat(locale);
  return (v: number) => format.format(v);
}

/** One titled block inside a workspace panel. */
export function PanelSection({title, description, children}: {title: T; description?: T; children: ReactNode}) {
  const {tr} = useLocale();
  return (
    <section className="panel-section">
      <VStack gap={2}>
        <VStack gap={0.5}>
          <Heading level={3}>{tr(title)}</Heading>
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
