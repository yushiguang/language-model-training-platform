'use client';

import {useMemo, useRef, type ReactNode} from 'react';
import {ALL_KEYS, applyFix, checkTemplate, FEATURES, labelOf, placeholderKeys, type CheckResult, type Fix} from '@tsp/domain';
import type {ExampleType, FeatureSelection, PromptImage, Schema} from '@tsp/contracts';
import {Badge, Button, Card, Cb, CheckRow, useCopy} from '@/ui';

export interface Draft {
  template: string;
  features: FeatureSelection;
  images: PromptImage[];
}

export function useChecks(draft: Draft, schema: Schema | null | undefined, types: ExampleType[]): CheckResult {
  return useMemo(() => checkTemplate(draft.template, draft.features, {schema, types, images: draft.images}), [draft.template, draft.features, draft.images, schema, types]);
}

/**
 * The prompt page (design: "Prompt page"): Prompt template on the left, Checks and Features on
 * the right. Used to write the first version, edit one, or view one.
 */
export function Workbench({draft, onChange, check, readOnly}: {draft: Draft; onChange: (d: Draft) => void; check: CheckResult; readOnly?: boolean}) {
  const fix = (f: Fix) => onChange({...draft, ...applyFix(draft.template, draft.features, f)});
  return (
    <div className="prompt-grid">
      <Card title="Prompt template" className="fill-scroll" style={{height: '100%'}}>
        <Editor value={draft.template} onChange={template => onChange({...draft, template})} readOnly={readOnly} />
      </Card>
      <div className="col" style={{gap: 16, minHeight: 0}}>
        <Checks draft={draft} check={check} onFix={readOnly ? undefined : fix} />
        <Features features={draft.features} onChange={readOnly ? undefined : features => onChange({...draft, features})} />
      </div>
    </div>
  );
}

/** Placeholders show as grey tokens, red when they are not a feature. No autocomplete in the MVP. */
function Editor({value, onChange, readOnly}: {value: string; onChange: (v: string) => void; readOnly?: boolean}) {
  return (
    <div className="ed-scroll">
      <div className="ed">
        <div className="editor" aria-hidden="true">
          {highlight(value)}
          {'\n'}
        </div>
        <label className="sr-only" htmlFor="tpl">
          Prompt template
        </label>
        <textarea id="tpl" value={value} readOnly={readOnly} spellCheck={false} placeholder={readOnly ? undefined : 'Paste your prompt, or ask AI to draft one'} onChange={e => onChange(e.target.value)} />
      </div>
    </div>
  );
}

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)) {
    out.push(text.slice(last, m.index));
    out.push(
      <span key={m.index} className={`tok${ALL_KEYS.includes(m[1]) ? '' : ' bad'}`}>
        {m[0]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/** A message with its {{placeholders}} drawn as tokens (red when they are not a feature). */
function withTokens(text: string): ReactNode {
  const parts = text.split(/(\{\{[A-Za-z0-9_]+\}\})/);
  return parts.map((p, i) =>
    /^\{\{/.test(p) ? (
      <span key={i} className={`tok${ALL_KEYS.includes(p.slice(2, -2)) ? '' : ' bad'}`} style={{textDecoration: 'none', verticalAlign: 1}}>
        {p}
      </span>
    ) : (
      p
    ),
  );
}

/**
 * Checks (design: green tick, amber warning or red error, one Fix per error). Warnings that the
 * design does not draw (image cost, values not named in the prompt) are left out: see docs/ui-gaps.md.
 */
function Checks({draft, check, onFix}: {draft: Draft; check: CheckResult; onFix?: (f: Fix) => void}) {
  const n = check.errors.length;
  const oneType = check.warnings.some(w => w.code === 'one_type_only');
  const used = [...placeholderKeys(draft.template)];
  const onlyPhoto = used.filter(k => draft.features.photo_text.includes(k) && !draft.features.video.includes(k)).map(labelOf);
  const onlyVideo = used.filter(k => draft.features.video.includes(k) && !draft.features.photo_text.includes(k)).map(labelOf);
  const and = (l: string[]) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}` : l[0]);
  const oneTip = [onlyPhoto.length ? `${and(onlyPhoto)} load${onlyPhoto.length === 1 ? 's' : ''} only for photo and text` : '', onlyVideo.length ? `${and(onlyVideo)} only for video` : ''].filter(Boolean).join('; ') + '. Examples of the other type leave those lines out.';
  const oneCount = onlyPhoto.length + onlyVideo.length;
  return (
    <Card title="Checks" className="tight" titleExtra={n ? <Badge text={`${n} error${n > 1 ? 's' : ''}`} tone="err" icon={false} /> : undefined}>
      <div>
        {check.errors.map((e, i) => (
          <CheckRow key={`e${i}`} tone="err" text={withTokens(e.message)} tip={e.message} fix={onFix && e.fixes[0] ? <Button label="Fix" kind="secondary" size="sm" title={e.fixes[0].label} onClick={() => onFix(e.fixes[0].fix)} /> : undefined} />
        ))}
        {!n && <CheckRow tone={check.matched ? 'ok' : 'warn'} text={check.matched ? `All ${check.matched} placeholders match ticked features` : 'No placeholders in the template yet'} />}
        {oneType && oneCount > 0 && <CheckRow tone="warn" text={`${oneCount} placeholder${oneCount > 1 ? 's' : ''} load${oneCount > 1 ? '' : 's'} for one type only`} tip={oneTip} />}
      </div>
    </Card>
  );
}

type Group = keyof FeatureSelection;
const SECTIONS: {group: Group; name: string}[] = [
  {group: 'video', name: 'Video'},
  {group: 'photo_text', name: 'Photo and text'},
  {group: 'metadata', name: 'Metadata'},
];

/** Features: three sections with a select-all box each; clicking a name copies its placeholder. */
function Features({features, onChange}: {features: FeatureSelection; onChange?: (f: FeatureSelection) => void}) {
  const [copied, copy] = useCopy();
  const scroll = useRef<HTMLDivElement>(null);
  const toggle = (g: Group, key: string) => onChange?.({...features, [g]: features[g].includes(key) ? features[g].filter(k => k !== key) : [...features[g], key]});
  return (
    <Card title="Features" className="fill-scroll">
      <div ref={scroll} className="ed-scroll" style={{paddingBottom: 24}}>
        <div className="col" style={{gap: 20}}>
          {SECTIONS.map(({group, name}) => {
            const keys = FEATURES[group].map(f => f.key);
            const on = keys.filter(k => features[group].includes(k)).length;
            const all = on === keys.length ? 'on' : on === 0 ? 'off' : 'mixed';
            return (
              <div key={group} className="col" style={{gap: 0}}>
                <div className="row" style={{height: 40, gap: 12, borderBottom: '1px solid var(--border)'}}>
                  <b style={{fontSize: 13}} className="grow">
                    {name}
                  </b>
                  <span title="Select all">
                    <Cb state={all} label={`Select all ${name}`} onToggle={onChange ? () => onChange({...features, [group]: all === 'on' ? [] : keys}) : undefined} />
                  </span>
                </div>
                <div className="col" style={{gap: 0, paddingTop: 4}}>
                  {FEATURES[group].map(f => {
                    const ph = `{{${f.key}}}`;
                    return (
                      <div key={f.key} className="row" style={{height: 36, gap: 12}}>
                        <span className="grow one copy-name" role="button" tabIndex={0} title={copied === ph ? `Copied ${ph}` : `Click to copy ${ph}`} onClick={() => copy(ph)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), copy(ph))}>
                          {f.label}
                        </span>
                        <Cb state={features[group].includes(f.key) ? 'on' : 'off'} label={`${f.label}, ${name}`} onToggle={onChange ? () => toggle(group, f.key) : undefined} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
