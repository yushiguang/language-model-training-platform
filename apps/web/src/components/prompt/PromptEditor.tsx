'use client';

import {useMemo, useRef, useState, type ReactNode} from 'react';
import {ALL_KEYS, FEATURES, ITEM_ROWS} from '@tsp/domain';
import type {FeatureSelection} from '@tsp/contracts';

interface Suggest {
  start: number;
  query: string;
  index: number;
}

/**
 * Template editor. Placeholders show as grey chips (red when the key is unknown). Typing {{
 * opens a list of features that narrows as you type; ↑ ↓ move, Enter inserts, Esc closes.
 * Picking a feature that isn't ticked inserts it, and Checks then asks to tick it.
 */
export function PromptEditor({value, onChange, features, readOnly, label = 'Prompt template', minHeight}: {value: string; onChange: (v: string) => void; features: FeatureSelection; readOnly?: boolean; label?: string; minHeight?: number}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [suggest, setSuggest] = useState<Suggest | null>(null);

  const options = useMemo(() => {
    if (!suggest) return [];
    const q = suggest.query.toLowerCase();
    return ALL_KEYS.filter(k => k.toLowerCase().startsWith(q) || k.toLowerCase().includes(q)).slice(0, 8);
  }, [suggest]);

  const where = (key: string) => {
    const parts: string[] = [];
    if (features.video.includes(key)) parts.push('Video');
    if (features.photo_text.includes(key)) parts.push('Photo&text');
    if (features.metadata.includes(key)) parts.push('Metadata');
    if (parts.length) return parts.join(' · ');
    return FEATURES.metadata.some(f => f.key === key) ? 'Metadata · not ticked' : 'Not ticked';
  };

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = before.match(/\{\{([A-Za-z0-9_]*)$/);
    setSuggest(m ? {start: caret - m[0].length, query: m[1], index: 0} : null);
  };

  const insert = (key: string) => {
    if (!suggest || !ta.current) return;
    const caret = ta.current.selectionStart;
    const after = value.slice(caret).replace(/^[A-Za-z0-9_]*\}\}/, '');
    const next = `${value.slice(0, suggest.start)}{{${key}}}${after}`;
    onChange(next);
    setSuggest(null);
    const pos = suggest.start + key.length + 4;
    requestAnimationFrame(() => ta.current?.setSelectionRange(pos, pos));
  };

  const caretPos = useMemo(() => {
    if (!suggest) return {top: 0, left: 0};
    const lines = value.slice(0, suggest.start).split('\n');
    return {top: lines.length * 20 + 14 - (ta.current?.scrollTop ?? 0), left: Math.min(420, 12 + lines[lines.length - 1].length * 7.8)};
  }, [suggest, value]);

  return (
    <div className="editor-wrap">
      <label className="sr-only" htmlFor="tpl">
        {label}
      </label>
      <div className="editor">
        <div className="layer" ref={layer} aria-hidden="true" style={minHeight ? {minHeight} : undefined}>
          {highlight(value)}
          {'\n'}
        </div>
        <textarea
          id="tpl"
          ref={ta}
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          style={minHeight ? {minHeight} : undefined}
          onScroll={e => layer.current && (layer.current.scrollTop = e.currentTarget.scrollTop)}
          onChange={e => {
            onChange(e.target.value);
            detect(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={e => {
            if (!suggest || !options.length) return;
            if (e.key === 'ArrowDown') (e.preventDefault(), setSuggest({...suggest, index: (suggest.index + 1) % options.length}));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSuggest({...suggest, index: (suggest.index - 1 + options.length) % options.length}));
            else if (e.key === 'Enter' || e.key === 'Tab') (e.preventDefault(), insert(options[suggest.index]));
            else if (e.key === 'Escape') (e.preventDefault(), setSuggest(null));
          }}
          onBlur={() => setTimeout(() => setSuggest(null), 150)}
        />
      </div>
      {suggest && options.length > 0 && (
        <div className="suggest" role="listbox" aria-label="Features" style={{top: caretPos.top + 12, left: caretPos.left}}>
          {options.map((k, i) => (
            <button key={k} type="button" className="opt" role="option" aria-selected={i === suggest.index} onMouseDown={e => (e.preventDefault(), insert(k))}>
              <span className="ph mono">{`{{${k}}}`}</span>
              <span className="where">{where(k)}</span>
            </button>
          ))}
          <div className="small muted row" style={{borderTop: '1px solid var(--line)', marginTop: 4, padding: '8px 10px 4px', gap: 12}}>
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>Enter</kbd> insert
            </span>
            <span>
              <kbd>Esc</kbd> close
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)) {
    out.push(text.slice(last, m.index));
    out.push(
      <span key={m.index} className={`ph${ALL_KEYS.includes(m[1]) ? '' : ' bad'}`}>
        {m[0]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export {ITEM_ROWS};
