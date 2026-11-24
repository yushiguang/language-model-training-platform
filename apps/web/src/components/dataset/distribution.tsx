'use client';

import type {LabelBalance} from '@yushiguang/sprint-domain';
import {Card, Heading, HStack, StackItem, Text, VStack} from '@/ui/astryx';
import {t} from '@/i18n';

/**
 * Series colours (the data-viz reference palette, light mode): one per label value in the order
 * the label lists its values, so a value keeps its colour whatever its count. Past eight, the rest
 * are folded into one grey slice.
 */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const REST = '#8a8984';

interface Slice {
  key: string;
  label: string;
  count: number;
  color: string;
}

/** The label values as slices: the first seven of the label, then the rest in one (or the eighth itself). */
export function slicesOf(values: {value: string; count: number}[]): Slice[] {
  const head = values.length > SERIES.length ? values.slice(0, SERIES.length - 1) : values;
  const out = head.map((v, i) => ({key: v.value, label: v.value, count: v.count, color: SERIES[i]}));
  const rest = values.slice(head.length);
  if (rest.length) out.push({key: '__rest', label: t('{n} more values', {n: rest.length}), count: rest.reduce((n, v) => n + v.count, 0), color: REST});
  return out;
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

/**
 * Label Distribution (W-EvalDataset): how the gold labels spread over the label's values, as a
 * ring and a legend with each value's count and share of the labeled samples. Values with too few
 * gold labels to score fairly are counted under the legend.
 */
export function DistributionCard({balance}: {balance: LabelBalance}) {
  const slices = slicesOf(balance.values);
  const labeled = balance.labeled;
  const rare = balance.values.filter(v => v.rare).length;
  return (
    <Card padding={6} style={{height: '100%'}}>
      <VStack gap={5}>
        <HStack gap={3} vAlign="center" hAlign="between">
          <Heading level={3}>{t('Label Distribution')}</Heading>
          <Text type="supporting" color="secondary" hasTabularNumbers>
            {t('{n} labeled', {n: labeled.toLocaleString('en-US')})}
          </Text>
        </HStack>
        {labeled === 0 ? (
          <Text type="body" color="secondary">
            {t('No gold labels yet. Label samples on Gold Labels to see how the values spread.')}
          </Text>
        ) : (
          <HStack gap={8} vAlign="center">
            <Ring slices={slices} />
            <StackItem size="fill" style={{minWidth: 0}}>
              <VStack gap={3}>
                {slices.map(s => (
                  <HStack key={s.key} gap={2} vAlign="center">
                    <span aria-hidden style={{width: 10, height: 10, borderRadius: 2, background: s.color, flex: 'none'}} />
                    <StackItem size="fill" style={{minWidth: 0}}>
                      <Text type="body" maxLines={1}>
                        {s.label}
                      </Text>
                    </StackItem>
                    <Text type="body" color="secondary" hasTabularNumbers>
                      {s.count.toLocaleString('en-US')} · {pct(s.count, labeled)}%
                    </Text>
                  </HStack>
                ))}
                {rare > 0 && (
                  <Text type="supporting" color="secondary">
                    {rare === 1 ? t('1 value has too few gold labels to score fairly.') : t('{n} values have too few gold labels to score fairly.', {n: rare})}
                  </Text>
                )}
              </VStack>
            </StackItem>
          </HStack>
        )}
      </VStack>
    </Card>
  );
}

const SIZE = 168;
const STROKE = 30;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;
/** The surface gap between two slices, along the ring. */
const GAP = 2;

/** The ring: one arc per slice, in legend order from the top, clockwise; each says its value on hover. */
function Ring({slices}: {slices: Slice[]}) {
  const total = slices.reduce((n, s) => n + s.count, 0);
  const shown = slices.filter(s => s.count > 0);
  let at = 0;
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={t('Label Distribution')} style={{flex: 'none'}}>
      <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--color-background-muted, #f1f1ef)" strokeWidth={STROKE} />
      {shown.map(s => {
        const len = (s.count / total) * C;
        const dash = shown.length > 1 ? Math.max(0, len - GAP) : len;
        const arc = (
          <circle
              key={s.key}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke={s.color}
              strokeWidth={STROKE}
              strokeDasharray={`${dash} ${C - dash}`}
              strokeDashoffset={-at}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            >
              <title>{`${s.label}: ${s.count.toLocaleString('en-US')}`}</title>
            </circle>
        );
        at += len;
        return arc;
      })}
    </svg>
  );
}
