'use client';

import {useMemo} from 'react';
import {applyFix, checkTemplate, type CheckResult, type Fix} from '@tsp/domain';
import type {FeatureSelection, PromptImage, Schema} from '@tsp/contracts';
import {uploadAsset} from '@/backend-api';
import {Icon} from '@/ui';
import {FeaturesPanel} from './FeaturesPanel';
import {PromptEditor} from './PromptEditor';
import {PromptPreview} from './PromptPreview';
import type {ProjectState} from '@/backend-api';

export interface Draft {
  template: string;
  features: FeatureSelection;
  images: PromptImage[];
}

export function useChecks(draft: Draft, schema: Schema | null | undefined, types: ('video' | 'photo_text')[]): CheckResult {
  return useMemo(
    () => checkTemplate(draft.template, draft.features, {schema, types, images: draft.images, costNote: 'Image features make up most of the cost of each call; the estimate under the button counts them.'}),
    [draft.template, draft.features, draft.images, schema, types],
  );
}

/** Editor + prompt images + checks on the left, features on the right. Used by "start" and "edit". */
export function Workbench({draft, onChange, check, readOnly, hint, state}: {draft: Draft; onChange: (d: Draft) => void; check: CheckResult; readOnly?: boolean; hint?: React.ReactNode; state?: ProjectState}) {
  const fix = (f: Fix) => onChange({...draft, ...applyFix(draft.template, draft.features, f)});
  const addImage = async (file: File) => {
    const {url} = await uploadAsset(file);
    const images = [...draft.images, {name: file.name, url, size: file.size}];
    onChange({...draft, images, template: draft.template + (draft.template.endsWith('\n') ? '' : '\n') + `[Image ${images.length}]`});
  };
  return (
    <div className="prompt-grid">
      <div className="col" style={{gap: 16}}>
        <div className="col">
          <div className="row">
            <span style={{fontWeight: 500}}>Prompt template</span>
            <span className="small muted">
              Type {'{{'} to pick a feature. <span className="ph img">Image</span> placeholders put images at that spot.
            </span>
            {hint}
            {!readOnly && (
              <label className="right row" style={{gap: 6, cursor: 'pointer', fontWeight: 500}}>
                <Icon name="image" /> Add image
                <input type="file" accept="image/*" className="sr-only" onChange={e => e.target.files?.[0] && void addImage(e.target.files[0])} />
              </label>
            )}
          </div>
          <PromptEditor value={draft.template} onChange={template => onChange({...draft, template})} features={draft.features} readOnly={readOnly} />
          {draft.images.length > 0 && (
            <div className="row" style={{gap: 8}}>
              {draft.images.map((img, i) => (
                <div key={i} className="img-card">
                  <img src={img.url} alt="" />
                  <span className="col" style={{gap: 0}}>
                    <b>Image {i + 1}</b>
                    <span className="small muted">
                      {img.name} · {Math.round(img.size / 1024)} KB
                    </span>
                  </span>
                  {!readOnly && (
                    <button className="copy" style={{visibility: 'visible'}} aria-label={`Remove image ${i + 1}`} onClick={() => onChange({...draft, images: draft.images.filter((_, k) => k !== i)})}>
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {state && <PromptPreview draft={draft} state={state} />}
        <Checks check={check} onFix={readOnly ? undefined : fix} />
      </div>
      <FeaturesPanel features={draft.features} onChange={features => onChange({...draft, features})} readOnly={readOnly} />
    </div>
  );
}

export function Checks({check, onFix}: {check: CheckResult; onFix?: (f: Fix) => void}) {
  const {errors, warnings} = check;
  const summary = errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''} · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : `No errors · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
  return (
    <div className="card" aria-label="Checks">
      <div className="row">
        <h2>Checks</h2>
        <span className={errors.length ? '' : 'muted'} style={errors.length ? {color: 'var(--err)', fontWeight: 500} : undefined}>
          {summary}
        </span>
      </div>
      {!errors.length && <span className="row small" style={{gap: 8}}>
        <span className="tick"><Icon name="check" size={12} /></span>
        All {check.matched} placeholders match ticked features.
      </span>}
      <div>
        {errors.map((e, i) => (
          <div className="issue" key={`e${i}`}>
            <span className="dot-err" aria-label="Error">
              !
            </span>
            <span className="grow">{e.message}</span>
            {onFix && e.fixes.map(f => <button key={f.label} className="opt" style={{border: '1px solid var(--line-2)'}} onClick={() => onFix(f.fix)}>{f.label}</button>)}
          </div>
        ))}
        {warnings.map((w, i) => (
          <div className="issue" key={`w${i}`}>
            <span className="dot-warn" aria-label="Warning">
              !
            </span>
            <span className="grow muted">{w.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
