'use client';

import {useEffect, useRef, useState} from 'react';
import {FEATURES, ITEM_ROWS} from '@tsp/domain';
import type {FeatureSelection} from '@tsp/contracts';
import {Icon} from '@/ui';

type Group = keyof FeatureSelection;

/** Features panel: tick per example type, copy a placeholder, select or clear a whole column. */
export function FeaturesPanel({features, onChange, readOnly}: {features: FeatureSelection; onChange: (f: FeatureSelection) => void; readOnly?: boolean}) {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const toggle = (g: Group, key: string) => {
    const has = features[g].includes(key);
    onChange({...features, [g]: has ? features[g].filter(k => k !== key) : [...features[g], key]});
  };
  const all = (g: Group) => (g === 'metadata' ? FEATURES.metadata.map(f => f.key) : ITEM_ROWS.filter(r => r[g]).map(r => r.key));
  const setAll = (g: Group, on: boolean) => onChange({...features, [g]: on ? all(g) : []});
  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(`{{${key}}}`);
    } catch {
      /* clipboard blocked: the toast still shows the text to type */
    }
    setCopied(`{{${key}}}`);
  };

  return (
    <div className="card features" aria-label="Features">
      <div className="row">
        <h2>Features</h2>
        <span className="small muted right">type {'{{'} in the template</span>
      </div>
      <table className="t">
        <thead>
          <tr>
            <th>Item</th>
            <th>Video</th>
            <th>Photo&amp;text</th>
            <th aria-label="Copy" />
          </tr>
        </thead>
        <tbody>
          {!readOnly && (
            <tr>
              <td className="small muted">Select all</td>
              <td>
                <TriState group="video" features={features} all={all('video')} onSet={setAll} />
              </td>
              <td>
                <TriState group="photo_text" features={features} all={all('photo_text')} onSet={setAll} />
              </td>
              <td />
            </tr>
          )}
          {ITEM_ROWS.map(r => (
            <tr key={r.key} className="feat-row">
              <td>{r.label}</td>
              {(['video', 'photo_text'] as const).map(g => (
                <td key={g}>{r[g] ? <input type="checkbox" aria-label={`${r.label} for ${g === 'video' ? 'video' : 'photo&text'}`} checked={features[g].includes(r.key)} disabled={readOnly} onChange={() => toggle(g, r.key)} /> : <span className="muted">–</span>}</td>
              ))}
              <td>
                <button className="copy" aria-label={`Copy {{${r.key}}}`} onClick={() => void copy(r.key)}>
                  <Icon name="copy" size={14} />
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={4} style={{paddingTop: 14}}>
              <span className="row" style={{gap: 8}}>
                <b>Metadata</b>
                {!readOnly && <TriState group="metadata" features={features} all={all('metadata')} onSet={setAll} />}
              </span>
            </td>
          </tr>
          {FEATURES.metadata.map(f => (
            <tr key={f.key} className="feat-row">
              <td>{f.label}</td>
              <td colSpan={2}>
                <input type="checkbox" aria-label={f.label} checked={features.metadata.includes(f.key)} disabled={readOnly} onChange={() => toggle('metadata', f.key)} />
              </td>
              <td>
                <button className="copy" aria-label={`Copy {{${f.key}}}`} onClick={() => void copy(f.key)}>
                  <Icon name="copy" size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {copied && (
        <div className="toast" role="status">
          Copied {copied}
        </div>
      )}
    </div>
  );
}

function TriState({group, features, all, onSet}: {group: Group; features: FeatureSelection; all: string[]; onSet: (g: Group, on: boolean) => void}) {
  const ref = useRef<HTMLInputElement>(null);
  const n = all.filter(k => features[group].includes(k)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = n > 0 && n < all.length;
  }, [n, all.length]);
  return <input ref={ref} type="checkbox" aria-label={`Select all ${group === 'photo_text' ? 'photo&text' : group}`} checked={n === all.length} onChange={() => onSet(group, n !== all.length)} />;
}
