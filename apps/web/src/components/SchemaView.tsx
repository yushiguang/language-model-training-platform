'use client';

import type {LabelField, Schema} from '@/core/types';
import {Badge} from '@/ui';

/** Same field type = same format everywhere: Setup, Gold Labels and reports. */
export function FieldCard({field, before, picked, onPick, isNew}: {field: LabelField; before?: LabelField; picked?: string[]; onPick?: (value: string) => void; isNew?: (value: string) => boolean}) {
  const many = field.kind === 'multi';
  return (
    <div className="field">
      <div className="field-head">
        <span className="field-name">{field.name}</span>
        <Badge label={many ? 'Multi-select' : 'Single-select'} />
        {many && <span className="small muted">choose {field.min ?? 1} to {field.max ?? field.values.length}</span>}
      </div>
      <div className="vals" role={onPick ? (many ? 'group' : 'radiogroup') : undefined} aria-label={field.name}>
        {field.values.map((v, i) => {
          const old = before?.values[i];
          const added = before && !before.values.some(b => b.name === v.name);
          const isPicked = picked?.includes(v.name);
          const content = (
            <>
              <span className={`glyph ${many ? 'g-many' : 'g-one'}`} aria-hidden="true">
                {many && isPicked ? <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg> : null}
              </span>
              <span>
                <b>
                  {before && old && old.name !== v.name && !added ? (
                    <>
                      <span className="del">{old.name}</span> <span className="add">{v.name}</span>
                    </>
                  ) : added ? (
                    <span className="add">{v.name}</span>
                  ) : (
                    v.name
                  )}
                  {isNew?.(v.name) && (
                    <>
                      {' '}
                      <Badge label="New" />
                    </>
                  )}
                </b>
                <span className="muted">{v.definition}</span>
              </span>
            </>
          );
          return onPick ? (
            <button
              key={v.name}
              type="button"
              role={many ? 'checkbox' : 'radio'}
              aria-checked={!!isPicked}
              className={`vrow pickable${isPicked ? ' picked' : ''}`}
              style={{border: 0, background: isPicked ? undefined : 'none', textAlign: 'left', width: 'calc(100% + 16px)'}}
              onClick={() => onPick(v.name)}
            >
              {content}
            </button>
          ) : (
            <div key={v.name} className="vrow">
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Word diff for the policy paragraph. */
export function PolicyDiff({before, after}: {before?: string; after: string}) {
  if (!before || before === after) return <p>{after}</p>;
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  const dp = Array.from({length: a.length + 1}, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: {t: string; k: 'same' | 'add' | 'del'}[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({t: a[i++], k: 'same'}), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({t: a[i++], k: 'del'});
    else out.push({t: b[j++], k: 'add'});
  }
  while (i < a.length) out.push({t: a[i++], k: 'del'});
  while (j < b.length) out.push({t: b[j++], k: 'add'});
  return (
    <p>
      {out.map((x, n) => (x.k === 'same' ? x.t : <span key={n} className={x.k}>{x.t}</span>))}
    </p>
  );
}

export function SchemaView({schema, before}: {schema: Schema; before?: Schema | null}) {
  return (
    <div className="col" style={{gap: 16}}>
      <div className="col">
        <h2>Policy</h2>
        <PolicyDiff before={before?.policy} after={schema.policy} />
      </div>
      <div className="col" style={{gap: 10}}>
        <div className="row">
          <h2>Label fields</h2>
          <span className="small muted row" style={{gap: 6}}>
            <span className="glyph g-one" aria-hidden="true" style={{marginTop: 0}} /> Single-select: one value
          </span>
          <span className="small muted row" style={{gap: 6}}>
            <span className="glyph g-many" aria-hidden="true" style={{marginTop: 0}} /> Multi-select: several values
          </span>
        </div>
        {schema.fields.map(f => (
          <FieldCard key={f.name} field={f} before={before?.fields.find(b => b.name === f.name)} />
        ))}
      </div>
    </div>
  );
}
