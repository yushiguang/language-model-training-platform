'use client';

import {FEATURES, TYPE_LABEL} from '@tsp/domain';
import type {Example} from '@tsp/contracts';
import {Badge} from '@/ui';

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
/** Example image URLs are relative to the site root (base path aware). */
export const src = (u: string) => (/^(https?:|data:|\/)/.test(u) ? u : `${base}/${u}`);

/** One example with the features of its own type: video and photo&text show different rows. */
export function ExampleView({ex}: {ex: Example}) {
  const imgs = ([] as string[]).concat(ex.type === 'video' ? (ex.features.Frame ?? []) : (ex.features.Images ?? ex.features.Cover ?? [])).slice(0, 4);
  const textRows = FEATURES[ex.type].filter(f => !f.isImage);
  const meta = FEATURES.metadata.filter(f => {
    const v = ex.features[f.key];
    return Array.isArray(v) ? v.length : !!v;
  });
  return (
    <div className="example">
      <div className="thumbs">
        <div className="row" style={{gap: 6}}>
          <Badge label={TYPE_LABEL[ex.type]} />
          <span className="small muted">{ex.externalId}</span>
        </div>
        {imgs.length ? imgs.map((u, i) => <img key={i} src={src(u)} alt={`${ex.type === 'video' ? 'Frame' : 'Image'} ${i + 1}`} />) : <div className="note small">No images</div>}
      </div>
      <div className="col" style={{gap: 12}}>
        <h2>{ex.title}</h2>
        <dl className="kv">
          {textRows.map(f => {
            const v = ex.features[f.key];
            const s = Array.isArray(v) ? v.join(', ') : v;
            return [
              <dt key={`${f.key}-k`}>{f.label}</dt>,
              <dd key={`${f.key}-v`} className={s ? '' : 'muted'}>
                {s || 'none'}
              </dd>,
            ];
          })}
          {meta.map(f => [
            <dt key={`${f.key}-k`}>{f.label}</dt>,
            <dd key={`${f.key}-v`}>{String(ex.features[f.key])}</dd>,
          ])}
        </dl>
      </div>
    </div>
  );
}
