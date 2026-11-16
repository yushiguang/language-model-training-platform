'use client';

import type {Answer, Schema} from '@tsp/contracts';
import {Card, Hov} from '@/ui';
import {t} from '@/i18n';

export interface LabelCount {
  name: string;
  n: number;
}

/** How many answers use each value of the label, most used first. */
export function labelCounts(schema: Schema, answers: (Answer | null | undefined)[]): LabelCount[] {
  return schema.values.map(v => ({name: v.name, n: answers.filter(a => a === v.name).length})).sort((a, b) => b.n - a.n);
}

/**
 * Label distribution (design: Training Set and Prompt versions): every value of the label in two
 * columns. With a minimum (`min`), under it is yellow and none is red, with a legend.
 */
export function LabelDistribution({data, min, bare}: {data: LabelCount[]; min?: number; bare?: boolean}) {
  const thr = min ?? 0;
  const legend = min != null && (
    <div className="row" style={{gap: 16, fontSize: 12}}>
      <span className="row" style={{gap: 6}}>
        <i style={{width: 8, height: 8, borderRadius: '50%', background: '#e0a800'}} />
        <span className="t-3">
          <Hov text={t('Fewer than {n}', {n: thr})} tip={t('Values with fewer than {n} examples may be learned poorly', {n: thr})} />
        </span>
      </span>
      <span className="row" style={{gap: 6}}>
        <i style={{width: 8, height: 8, borderRadius: '50%', background: 'var(--err)'}} />
        <span className="t-3">{t('None')}</span>
      </span>
    </div>
  );
  const mx = Math.max(1, ...data.map(x => x.n));
  const body = (
    <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 40, rowGap: 4}}>
      {data.map(x => {
        const tone = min == null ? '' : x.n === 0 ? 'err' : x.n < thr ? 'warn' : '';
        const col = tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : 'var(--text)';
        const fill = tone === 'warn' ? '#e0a800' : '#1b1b1b';
        const bold = tone ? 600 : undefined;
        return (
          <div key={x.name} style={{display: 'grid', gridTemplateColumns: '140px 1fr 32px', alignItems: 'center', gap: 12, height: 28, fontSize: 13}}>
            <span className="one" title={x.name} style={{color: col, fontWeight: bold}}>
              {x.name}
            </span>
            <span style={{height: 6, borderRadius: 3, background: 'var(--bg-muted)', overflow: 'hidden'}}>
              <span style={{display: 'block', height: '100%', width: `${Math.round((x.n / mx) * 100)}%`, background: fill, borderRadius: 3}} />
            </span>
            <span style={{textAlign: 'right', color: tone ? col : 'var(--text-2)', fontWeight: bold}}>{x.n}</span>
          </div>
        );
      })}
    </div>
  );
  // bare: only the values, for a card that has its own heading (Prompt versions, no gold labels yet).
  if (bare) return body;
  return (
    <Card title={t('Label distribution')} actions={legend || undefined}>
      {body}
    </Card>
  );
}
