'use client';

import {useState, type ReactNode} from 'react';
import type {Thresholds} from '@yushiguang/sprint-contracts';
import {macroPrecisionRecall, valueMistakes, type MistakeSlice} from '@yushiguang/sprint-domain';
import {ChevronRightIcon} from '@heroicons/react/24/outline';
import {Badge, Button, Card, Grid, HStack, Icon, InfoTip, StackItem, Text, VStack} from '@/ui/astryx';
import {SectionTitle} from '@/components/shell/Page';
import {num} from '@/ui';
import {t} from '@/i18n';
import type {ProjectState} from '@/backend-api';
import {Change, pct, pct0} from './VersionRow';

type Report = ProjectState['reports'][number];

const COLORS = ['orange', 'blue', 'green', 'purple', 'teal', 'pink', 'cyan', 'brown', 'red', 'indigo'];
/** A categorical chart colour; the last slice ("No other value", "Other") is neutral. */
export const sliceColor = (i: number) => `var(--color-data-categorical-${COLORS[i % COLORS.length]})`;

const TIPS = {
  'Macro-F1': 'The average of every value’s F1. F1 is high only when a value is both found (recall) and given correctly (precision)',
  Precision: 'Of the answers that gave a value, how many a person labeled with it. The average over values',
  Recall: 'Of the examples a person labeled with a value, how many got it in the model’s answer. The average over values',
};

/** One score card (round 15): the name with its tip and tag, then the number and its threshold. */
function ScoreCard({name, value, threshold, rough}: {name: keyof typeof TIPS; value: number; threshold: number | null | undefined; rough: boolean}) {
  const tag = threshold == null || rough ? null : value >= threshold ? <Badge label={t('Passed')} variant="success" /> : <Badge label={t('Below')} variant="warning" />;
  return (
    <Card>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" minHeight={24}>
          <Text type="label" color="secondary">
            {t(name)}
          </Text>
          <InfoTip content={t(TIPS[name])} label={t('About {name}', {name: t(name)})} />
          {tag}
        </HStack>
        <HStack gap={2} vAlign="end" hAlign="between">
          <span className="sp-pt-score">{pct(value)}</span>
          {threshold != null && (
            <Text type="supporting" color="secondary">
              {t('Threshold {pct}', {pct: pct0(threshold)})}
            </Text>
          )}
        </HStack>
      </VStack>
    </Card>
  );
}

/** Scores: Macro-F1, then Precision and Recall averaged over the values (round 12). */
export function ScoreCards({report, thr, label}: {report: Report; thr: Thresholds; label: string}) {
  const m = report.metrics;
  const pr = macroPrecisionRecall(m);
  return (
    <section aria-label={t('Scores')}>
      <VStack gap={4}>
        <SectionTitle title={t('Scores')} action={<Text type="supporting" color="secondary">{report.rough ? t('{version} · a rough reading', {version: label}) : label}</Text>} />
        <Grid columns={3} gap={4}>
          <ScoreCard name="Macro-F1" value={m.macroF1} threshold={thr.macroF1} rough={report.rough} />
          <ScoreCard name="Precision" value={pr.precision} threshold={thr.precision} rough={report.rough} />
          <ScoreCard name="Recall" value={pr.recall} threshold={thr.recall} rough={report.rough} />
        </Grid>
      </VStack>
    </section>
  );
}

/** A number green when it meets its threshold, red when below; plain when there is none (round 20). */
function Num({x, thr, whole}: {x: number; thr: number | null | undefined; whole?: boolean}) {
  const cls = thr == null ? 'sp-pt-num' : x >= thr ? 'sp-pt-num ok' : 'sp-pt-num bad';
  return <span className={cls}>{whole ? pct0(x) : pct(x)}</span>;
}

/** A donut of slices with its total in the middle. */
export function Ring({slices, size = 96, label}: {slices: {n: number; color: string}[]; size?: number; label: string}) {
  const total = slices.reduce((s, x) => s + x.n, 0);
  const r = 15.915;
  let at = 25;
  return (
    <svg width={size} height={size} viewBox="0 0 42 42" role="img" aria-label={label} className="sp-pt-ring">
      <circle cx="21" cy="21" r={r} fill="none" stroke="var(--color-border)" strokeWidth="5" />
      {total > 0 &&
        slices.map((s, i) => {
          const part = (100 * s.n) / total;
          const el = <circle key={i} cx="21" cy="21" r={r} fill="none" stroke={s.color} strokeWidth="5" strokeDasharray={`${part} ${100 - part}`} strokeDashoffset={at} />;
          at -= part;
          return el;
        })}
      <text x="21" y="21" textAnchor="middle" dominantBaseline="central" className="sp-pt-ring-n">
        {num(total)}
      </text>
    </svg>
  );
}

/** A ring and its legend: what the model answered instead, or what a person gave instead. */
function Mistakes({title, tip, slices, colorOf}: {title: string; tip: string; slices: MistakeSlice[]; colorOf: (other: string | null) => string}) {
  const name = (o: string | null) => o ?? t('No other value');
  return (
    <HStack gap={4} vAlign="center">
      <Ring slices={slices.map(s => ({n: s.n, color: colorOf(s.other)}))} size={88} label={title} />
      <VStack gap={1}>
        <HStack gap={1} vAlign="center">
          <Text type="body">{title}</Text>
          <InfoTip content={tip} label={t('About {name}', {name: title})} />
        </HStack>
        {slices.length ? (
          slices.slice(0, 5).map(s => (
            <HStack key={s.other ?? ''} gap={2} vAlign="center">
              <span className="sp-pt-swatch" style={{background: colorOf(s.other)}} />
              <Text type="supporting" color="secondary">
                {name(s.other)} {num(s.n)}
              </Text>
            </HStack>
          ))
        ) : (
          <Text type="supporting" color="secondary">
            {t('None')}
          </Text>
        )}
      </VStack>
    </HStack>
  );
}

/**
 * Values (rounds 18 to 20): one row per value of the label. Closed, a row shows F1, Precision and
 * Recall, each green or red against its threshold. Open, each number shows its change against the
 * previous version, and two rings show the false negatives and false positives.
 */
export function ValueRows({report, previous, thr, values}: {report: Report; previous: Report | null; thr: Thresholds; values: string[]}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const rows = report.metrics.values;
  const all = rows.length > 0 && rows.every(r => open.has(r.value));
  const toggle = (v: string) => {
    const next = new Set(open);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setOpen(next);
  };
  const colorOf = (other: string | null) => (other == null ? 'var(--color-data-neutral)' : sliceColor(Math.max(0, values.indexOf(other))));
  const before = (v: string) => previous?.metrics.values.find(x => x.value === v);
  return (
    <section aria-label={t('Values')}>
      <VStack gap={4}>
        <SectionTitle title={t('Values')} action={<Button label={all ? t('Collapse all') : t('Expand all')} variant="ghost" size="sm" onClick={() => setOpen(all ? new Set() : new Set(rows.map(r => r.value)))} />} />
        <Card padding={0}>
          <div className="sp-pt-values">
            {rows.map(r => {
              const isOpen = open.has(r.value);
              const was = before(r.value);
              const mk = valueMistakes(report.metrics, r.value);
              return (
                <div key={r.value} className={isOpen ? 'sp-pt-vrow open' : 'sp-pt-vrow'}>
                  <button type="button" className="sp-pt-vhead" aria-expanded={isOpen} onClick={() => toggle(r.value)}>
                    <Icon icon={ChevronRightIcon} size="sm" color="secondary" />
                    <StackItem size="fill">
                      <Text type="body" weight="semibold">
                        {r.value}
                      </Text>
                    </StackItem>
                    <span className="sp-pt-vnums">
                      <span>
                        {t('F1')} <Num x={r.f1} thr={thr.valueF1} whole />
                      </span>
                      <span>
                        {t('Precision')} <Num x={r.precision} thr={thr.precision} whole />
                      </span>
                      <span>
                        {t('Recall')} <Num x={r.recall} thr={thr.recall} whole />
                      </span>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="sp-pt-vbody">
                      <div className="sp-pt-vtable">
                        {(
                          [
                            ['F1', r.f1, thr.valueF1, was?.f1],
                            ['Precision', r.precision, thr.precision, was?.precision],
                            ['Recall', r.recall, thr.recall, was?.recall],
                          ] as const
                        ).map(([name, x, th, w]) => (
                          <div key={name} className="sp-pt-vline">
                            <Text type="supporting" color="secondary">
                              {t(name)}
                            </Text>
                            <Num x={x} thr={th} whole />
                            <Change by={w == null ? null : x - w} />
                          </div>
                        ))}
                        <Text type="supporting" color="secondary">
                          {t('{n} examples', {n: num(r.support)})}
                        </Text>
                      </div>
                      <Mistakes title={t('False negatives')} tip={t('A person labeled {value}, the model did not answer it. What the model answered instead', {value: r.value})} slices={mk.missed} colorOf={colorOf} />
                      <Mistakes title={t('False positives')} tip={t('The model answered {value}, a person did not label it. What the person labeled instead', {value: r.value})} slices={mk.wrong} colorOf={colorOf} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </VStack>
    </section>
  );
}

/** Before scores (round 18): how the model's answers spread over the values. */
export function AnswerSpread({counts, label, total}: {counts: {name: string; n: number}[]; label: string; total: number}) {
  const sum = counts.reduce((s, c) => s + c.n, 0);
  return (
    <section aria-label={t('Values')}>
      <VStack gap={4}>
        <SectionTitle title={t('Values')} action={<Text type="supporting" color="secondary">{t('{version} · {n} examples', {version: label, n: num(total)})}</Text>} />
        <Card>
          <HStack gap={8} vAlign="center">
            <Ring slices={counts.map((c, i) => ({n: c.n, color: sliceColor(i)}))} size={160} label={t('Model answers')} />
            <StackItem size="fill">
              <VStack gap={2}>
                {counts.map((c, i) => (
                  <HStack key={c.name} gap={2} vAlign="center" hAlign="between">
                    <HStack gap={2} vAlign="center">
                      <span className="sp-pt-swatch" style={{background: sliceColor(i)}} />
                      <Text type="body">{c.name}</Text>
                    </HStack>
                    <Text type="body" color="secondary">
                      {num(c.n)} · {sum ? Math.round((100 * c.n) / sum) : 0}%
                    </Text>
                  </HStack>
                ))}
              </VStack>
            </StackItem>
          </HStack>
        </Card>
      </VStack>
    </section>
  );
}

/** Scores' place while a version is queued, labeling, failed or stopped: one line on where it stands. */
export function ScoresWait({label, title, text, children}: {label: string; title: string; text: string; children?: ReactNode}) {
  return (
    <section aria-label={t('Scores')}>
      <VStack gap={4}>
        <SectionTitle title={t('Scores')} action={<Text type="supporting" color="secondary">{label}</Text>} />
        <Card>
          <VStack gap={2}>
            <Text type="body" weight="semibold">
              {title}
            </Text>
            <Text type="body" color="secondary">
              {text}
            </Text>
            {children}
          </VStack>
        </Card>
      </VStack>
    </section>
  );
}
