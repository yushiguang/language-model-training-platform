'use client';

import type {Answer, Schema} from '@tsp/contracts';
import {Card, Code, Hov} from '@/ui';

export interface LabelCount {
  field: string;
  values: {name: string; n: number}[];
}

/** How many answers use each value of each field, most used first. */
export function labelCounts(schema: Schema, answers: (Answer | null | undefined)[]): LabelCount[] {
  return schema.fields.map(f => ({
    field: f.name,
    values: f.values.map(v => ({name: v.name, n: answers.filter(a => a?.[f.name]?.includes(v.name)).length})).sort((a, b) => b.n - a.n),
  }));
}

/**
 * Label distribution (design: Training Set and Prompt versions): every value of the schema in two
 * columns. With a minimum (`min`), under it is yellow and none is red, with a legend.
 */
export function LabelDistribution({data, min}: {data: LabelCount[]; min?: number}) {
  const thr = min ?? 0;
  const legend = min != null && (
    <div className="row" style={{gap: 16, fontSize: 12}}>
      <span className="row" style={{gap: 6}}>
        <i style={{width: 8, height: 8, borderRadius: '50%', background: '#e0a800'}} />
        <span className="t-3">
          <Hov text={`Fewer than ${thr}`} tip={`Values with fewer than ${thr} examples may be learned poorly`} />
        </span>
      </span>
      <span className="row" style={{gap: 6}}>
        <i style={{width: 8, height: 8, borderRadius: '50%', background: 'var(--err)'}} />
        <span className="t-3">None</span>
      </span>
    </div>
  );
  return (
    <Card title="Label distribution" actions={legend || undefined}>
      <div className="col" style={{gap: 24}}>
        {data.map((f, i) => {
          const mx = Math.max(1, ...f.values.map(x => x.n));
          return (
            <div key={f.field} className="col" style={{gap: 24}}>
              {i > 0 && <div style={{height: 1, background: 'var(--border)'}} />}
              <div className="col" style={{gap: 8, alignItems: 'flex-start'}}>
                <span>
                  <Code>{f.field}</Code>
                </span>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 40, rowGap: 4, alignSelf: 'stretch'}}>
                  {f.values.map(x => {
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
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
