'use client';

import type {ReactNode} from 'react';
import {ArrowDownIcon, ArrowUpIcon, CheckCircleIcon, ClockIcon, SparklesIcon, StopCircleIcon, XCircleIcon} from '@heroicons/react/24/outline';
import {Badge, HStack, Icon, InfoTip, SegmentedControl, SegmentedControlItem, Spinner, Text} from '@/ui/astryx';
import {SectionTitle} from '@/components/shell/Page';
import {t} from '@/i18n';
import type {SortBy, TuningItem} from './items';

/** 0.863 → "86.3%". */
export const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
/** A whole percent for value rows: 0.92 → "92%". */
export const pct0 = (x: number) => `${Math.round(100 * x)}%`;

/** A score's change against the previous version: a green up or red down arrow and the points. */
export function Change({by, digits = 1}: {by: number | null; digits?: number}) {
  if (by == null || Math.abs(by) < 0.0005) return null;
  const up = by > 0;
  return (
    <span className={up ? 'sp-pt-change up' : 'sp-pt-change down'}>
      <Icon icon={up ? ArrowUpIcon : ArrowDownIcon} size="xsm" />
      {Math.abs(100 * by).toFixed(digits)}
    </span>
  );
}

/** A pushpin, tilted 45 degrees (round 11); solid when pinned. */
function Pin({on}: {on: boolean}) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="sp-pt-pin-svg">
      <path d="M15 3l6 6-3 1-4 4 1 5-2 2-5-5-5 5-1-1 5-5-5-5 2-2 5 1 4-4z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function Status({icon, text, tone, tip}: {icon: ReactNode; text: string; tone?: 'error'; tip?: string}) {
  return (
    <HStack gap={2} vAlign="center">
      {icon}
      <span className={tone === 'error' ? 'sp-pt-status err' : 'sp-pt-status'}>{text}</span>
      {tip && <InfoTip content={tip} label={t('Why it failed')} />}
    </HStack>
  );
}

/** The second row of a card: the score and its change, or where the work stands. */
function Body({item}: {item: TuningItem}) {
  const s = item.state;
  switch (s.kind) {
    case 'scored':
      return (
        <HStack gap={3} vAlign="center">
          <span className="sp-pt-score">{pct(s.report.metrics.macroF1)}</span>
          <Change by={item.change} />
        </HStack>
      );
    case 'optimiser':
      return (
        <HStack gap={3} vAlign="center">
          {s.best != null ? <span className="sp-pt-score">{pct(s.best)}</span> : <Spinner size="sm" aria-label={t('Running')} />}
          <Text type="supporting" color="secondary">
            {t('Round {n} of {max}', {n: Math.max(1, s.run.round), max: s.run.maxRounds})}
          </Text>
        </HStack>
      );
    case 'labeling':
      return <Status icon={<Spinner size="sm" aria-label={t('Labeling')} />} text={t('Labeling {pct}%', {pct: s.total ? Math.floor((100 * s.done) / s.total) : 0})} />;
    case 'queued':
      return <Status icon={<Icon icon={ClockIcon} size="sm" color="secondary" />} text={s.ahead ? t('Queued · {n} ahead', {n: s.ahead}) : t('Queued')} />;
    case 'failed':
      return <Status icon={<Icon icon={XCircleIcon} size="sm" color="error" />} text={t('Failed')} tone="error" tip={s.run.error ? t(s.run.error) : t('Labeling stopped with an error')} />;
    case 'stopped':
      return <Status icon={<Icon icon={StopCircleIcon} size="sm" color="secondary" />} text={t('Stopped')} />;
    case 'labeled':
      return <Status icon={<Icon icon={CheckCircleIcon} size="sm" color="secondary" />} text={t('Labeled')} />;
    case 'new':
      return <Status icon={<Icon icon={ClockIcon} size="sm" color="secondary" />} text={t('Not labeled yet')} />;
  }
}

/**
 * Versions (wireframes v346, rounds 10 to 14): one row of cards, 200 wide, that scrolls sideways.
 * A card shows its version, Best and Passed tags, a pin (on hover until pinned), and its score with
 * the change against the previous version, or where its labeling stands. An orange dot marks a
 * score the person has not opened yet.
 */
export function VersionRow({items, selected, onSelect, sort, onSort, pinned, onPin, best, unread}: {
  items: TuningItem[];
  selected: number | null;
  onSelect: (major: number) => void;
  sort: SortBy;
  onSort: (s: SortBy) => void;
  pinned: number | null;
  onPin: (major: number | null) => void;
  best: number | null;
  unread: (i: TuningItem) => boolean;
}) {
  return (
    <section aria-label={t('Versions')}>
      <SectionTitle
        title={t('Versions')}
        action={
          <SegmentedControl label={t('Sort versions')} value={sort} onChange={v => onSort(v as SortBy)}>
            <SegmentedControlItem value="score" label={t('Score')} />
            <SegmentedControlItem value="newest" label={t('Newest')} />
          </SegmentedControl>
        }
      />
      <div className="sp-pt-row" role="list">
        {items.map(i => {
          const on = i.major === pinned;
          const passed = i.state.kind === 'scored' && i.state.report.passed && !i.state.report.rough;
          return (
            <div key={i.major} role="listitem" className={`sp-pt-vcard${i.major === selected ? ' selected' : ''}${on ? ' pinned' : ''}`}>
              <button type="button" className="sp-pt-vbtn" aria-pressed={i.major === selected} aria-label={t('Version {version}', {version: i.label})} onClick={() => onSelect(i.major)}>
                <HStack gap={2} vAlign="center" minHeight={24}>
                  <Text type="label" color="secondary">
                    {i.label}
                  </Text>
                  {i.state.kind === 'optimiser' && <Icon icon={SparklesIcon} size="sm" color="accent" />}
                  {i.major === best && <Badge label={t('Best')} />}
                  {passed && <Badge label={t('Passed')} variant="success" />}
                </HStack>
                <Body item={i} />
              </button>
              {unread(i) && <span className="sp-pt-dot" aria-label={t('New score')} />}
              <button type="button" className="sp-pt-pin" aria-pressed={on} aria-label={on ? t('Unpin {version}', {version: i.label}) : t('Pin {version}', {version: i.label})} onClick={() => onPin(on ? null : i.major)}>
                <Pin on={on} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
