'use client';

import {useMemo, useState} from 'react';
import {costForTokens, estimateTokens, renderPrompt, TYPE_LABEL} from '@tsp/domain';
import type {Example} from '@tsp/contracts';
import type {ProjectState} from '@/backend-api';
import {Button, money, num} from '@/ui';
import type {Draft} from './Workbench';

/**
 * "Preview with an example": the prompt for one example exactly as the model gets it, in order.
 * Text shows inline and each image as a thumbnail at its spot. The captions under thumbnails are
 * for people only; the model receives the images with no added text. Uses the same renderPrompt
 * as the labeling app, so the preview and the real call can't differ.
 */
export function PromptPreview({draft, state}: {draft: Draft; state: ProjectState}) {
  const pool = useMemo(() => {
    const order = {eval: 0, test: 1, train: 2} as Record<string, number>;
    return [...state.examples].sort((a, b) => (order[a.split ?? ''] ?? 3) - (order[b.split ?? ''] ?? 3)).slice(0, 40);
  }, [state.examples]);
  const firstOfEachType = useMemo(() => [...new Map(pool.map(e => [e.type, e])).values()], [pool]);
  const [open, setOpen] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const ex: Example | undefined = pool.find(e => e.id === id) ?? pool[0];
  const parts = useMemo(() => (ex ? renderPrompt(draft.template, ex, draft.features, draft.images) : []), [ex, draft]);
  if (!pool.length) return null;
  const tokens = estimateTokens(parts);
  const images = parts.filter(p => p.type === 'image').length;

  return (
    <div className="card" aria-label="Preview with an example">
      <div className="row">
        <h2>Preview with an example</h2>
        <span className="small muted">What the model receives, in order</span>
        <span className="right">
          <Button label={open ? 'Hide' : 'Show'} variant="ghost" size="sm" onClick={() => setOpen(o => !o)} />
        </span>
      </div>
      {open && ex && (
        <>
          <div className="row" style={{gap: 8, flexWrap: 'wrap'}}>
            <label className="sr-only" htmlFor="preview-ex">
              Example
            </label>
            <select id="preview-ex" className="text-input" value={ex.id} onChange={e => setId(e.target.value)} style={{maxWidth: 360}}>
              {pool.map(e => (
                <option key={e.id} value={e.id}>
                  {TYPE_LABEL[e.type]} · {e.title || e.externalId}
                </option>
              ))}
            </select>
            {firstOfEachType.length > 1 &&
              firstOfEachType.map(e => (
                <Button key={e.type} label={`A ${TYPE_LABEL[e.type].toLowerCase()} example`} variant="ghost" size="sm" onClick={() => setId(e.id)} />
              ))}
          </div>
          <div className="preview" data-testid="prompt-preview">
            {parts.map((p, i) =>
              p.type === 'text' ? (
                <span key={i} className="preview-text">
                  {p.text}
                </span>
              ) : (
                <figure key={i} className={`preview-img ${p.source}`}>
                  <img src={p.url} alt="" />
                  <figcaption>{p.caption}</figcaption>
                </figure>
              ),
            )}
          </div>
          <p className="small muted">
            About {num(tokens)} input tokens for this example ({images} image{images === 1 ? '' : 's'}
            {images ? ' count for most of them' : ''})
            {(state.setup?.models ?? []).map(m => ` · Model ${m.endpoint} about ${money(costForTokens(state.endpoints, m.endpoint, tokens, 150))} per call`).join('')}. The captions under the images are only shown here; the model gets the images where they sit, with no added text.
          </p>
        </>
      )}
    </div>
  );
}
