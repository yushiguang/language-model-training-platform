'use client';

import {Fragment, useState} from 'react';
import {CUSTOM_START} from '@yushiguang/sprint-domain';
import type {NewProjectThresholds} from '@/backend-api';
import {Card, Divider, HStack, InfoTip, NumberInput, StackItem, Switch, Text, VStack} from '@/ui/astryx';
import {t} from '@/i18n';

type Key = keyof NewProjectThresholds;

const ROWS: {key: Key; name: string; tip: string}[] = [
  {key: 'macroF1', name: 'Macro-F1', tip: 'The main score. Every project has a threshold for it.'},
  {key: 'precision', name: 'Precision', tip: 'Of the answers the model gave, how many were right.'},
  {key: 'recall', name: 'Recall', tip: "Of the person's labels, how many the model found."},
];

/** Percent shown, fraction kept: 0.85 is 85. Rounded, so 0.7 shows 70, not 70.00000000000001. */
const pct = (x: number) => Math.round(x * 1000) / 10;

/**
 * The three thresholds (W-Projects-Create, and Project Settings): Macro-F1 always on, Precision and
 * Recall each with a switch. A switch turned on fills its box with the last value it had, else the
 * usual starting value; values are whole percents from 0 to 100.
 */
export function ThresholdFields({value, onChange}: {value: NewProjectThresholds; onChange: (v: NewProjectThresholds) => void}) {
  const [kept, setKept] = useState<Record<Key, number>>({macroF1: value.macroF1, precision: value.precision ?? CUSTOM_START.precision, recall: value.recall ?? CUSTOM_START.recall});
  const set = (key: Key, v: number | null) => {
    if (v != null) setKept({...kept, [key]: v});
    onChange({...value, [key]: v});
  };
  return (
    <VStack gap={1.5}>
      <Text type="supporting" color="secondary">
        {t('Thresholds')}
      </Text>
      <Card variant="muted" padding={0}>
        <VStack gap={0}>
          {ROWS.map((r, i) => {
            const on = value[r.key] != null;
            const always = r.key === 'macroF1';
            const label = t('{check} threshold', {check: t(r.name)});
            return (
              <Fragment key={r.key}>
                {i > 0 && <Divider variant="subtle" />}
                <HStack gap={3} vAlign="center" className="sp-threshold">
                  <StackItem size="fill">
                    <HStack gap={1} vAlign="center">
                      <Text type="label">{t(r.name)}</Text>
                      <InfoTip content={t(r.tip)} />
                    </HStack>
                  </StackItem>
                  <HStack gap={3} vAlign="center">
                    <Switch label={label} isLabelHidden size="sm" value={on} isDisabled={always} disabledMessage={always ? t('Macro-F1 always has a threshold') : undefined} onChange={v => set(r.key, v ? kept[r.key] : null)} />
                    <NumberInput
                      label={label}
                      isLabelHidden
                      width={96}
                      units="%"
                      min={0}
                      max={100}
                      isIntegerOnly
                      value={on ? pct(value[r.key]!) : null}
                      isDisabled={!on}
                      onChange={v => set(r.key, Math.min(100, Math.max(0, v)) / 100)}
                    />
                  </HStack>
                </HStack>
              </Fragment>
            );
          })}
        </VStack>
      </Card>
    </VStack>
  );
}
