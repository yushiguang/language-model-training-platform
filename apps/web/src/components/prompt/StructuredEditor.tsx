'use client';

import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {compilePrompt, diffWords, FEATURES, withReasons, type MarkSeg} from '@tsp/domain';
import type {FeatureSelection, StructuredFieldPrompt, StructuredPrompt} from '@tsp/contracts';
import {Badge, Button, Card, Cb, Code, Dialog, Empty, Hov, Icon, Seg, Table, useCopy} from '@/ui';

/**
 * The structured prompt editor (spec 1.0.0, 3.2 and 3.3), used on Prompt Design and in the prompt
 * editor. Three parts, top to bottom: Output Labels & Definitions (fields on the left, the picked
 * field on the right), Input Features, Task & General Rules. The text the model reads is compiled
 * from these parts, so there are no placeholders to write and no checks to fix.
 *
 * With `base` (the version being edited), changed wording shows its word-level marks under the
 * box it belongs to, and features carry Added / Removed badges.
 */
export function StructuredEditor({
  value,
  onChange,
  readOnly,
  base,
  reasons,
  reasonPrefix,
  featureTips,
  draft,
}: {
  value: StructuredPrompt;
  onChange: (p: StructuredPrompt) => void;
  readOnly?: boolean;
  /** The prompt to mark changes against. */
  base?: StructuredPrompt;
  /** A helper's reasons, matched to the words they added or removed. */
  reasons?: {text: string; reason: string}[];
  reasonPrefix?: string;
  featureTips?: Record<string, string>;
  /** Fields carry a Draft badge while a helper's draft waits for approval. */
  draft?: boolean;
}) {
  const [sel, setSel] = useState(0);
  const at = Math.min(sel, Math.max(0, value.fields.length - 1));
  const field = value.fields[at];
  const marks = (was: string | undefined, now: string) => (base && (was ?? '') !== now ? withReasons(diffWords(was ?? '', now), reasons ?? [], reasonPrefix) : undefined);
  const setField = (f: StructuredFieldPrompt | null) => {
    const fields = f ? value.fields.map((x, i) => (i === at ? f : x)) : value.fields.filter((_, i) => i !== at);
    onChange({...value, fields});
    if (!f) setSel(Math.max(0, at - 1));
  };
  const addField = () => {
    const name = uniqueName(value.fields.map(f => f.name), 'new_field');
    onChange({...value, fields: [...value.fields, {name, kind: 'single', values: [{name: '', definition: ''}, {name: '', definition: ''}]}]});
    setSel(value.fields.length);
  };
  const baseField = base?.fields.find(f => f.name === field?.name);
  const changed = (f: StructuredFieldPrompt) => {
    if (!base) return false;
    const was = base.fields.find(x => x.name === f.name);
    return !was || JSON.stringify(was) !== JSON.stringify(f);
  };

  return (
    <div className="col sp" style={{gap: 16}}>
      <Section title="Output Labels & Definitions" hint="Fields and values" tip="Fields and values are what people label with, what the model must answer with, and what scores are counted on. Each definition tells the model when a value applies.">
        {!value.fields.length ? (
          <Card>
            <Empty title="No label fields yet" text={readOnly ? 'This prompt has no label fields.' : 'Describe your task in Ask AI, paste the prompt you use today, or add a field yourself.'}>
              {!readOnly && <Button label="Add field" icon="plus" onClick={addField} />}
            </Empty>
          </Card>
        ) : (
          <div className="grid-split sp-fields">
            <Card title="Fields">
              <nav className="vlist" aria-label="Fields">
                {value.fields.map((f, i) => (
                  <button key={i} type="button" className="vrow" aria-current={i === at} onClick={() => setSel(i)}>
                    <Code>{f.name || 'unnamed'}</Code>
                    <span>{draft ? <Badge text="Draft" icon={false} /> : changed(f) && <Badge text="Changed" tone="warn" icon={false} />}</span>
                    <span className="t-3" style={{fontSize: 13}}>
                      {f.kind === 'single' ? 'Single' : 'Multi'} · {f.values.length}
                    </span>
                  </button>
                ))}
              </nav>
              {!readOnly && (
                <div style={{margin: '4px -12px 0'}}>
                  <Button label="Add field" kind="ghost" icon="plus" onClick={addField} />
                </div>
              )}
            </Card>
            {field && <FieldEditor key={at} field={field} was={baseField} onChange={setField} readOnly={readOnly} marks={marks} />}
          </div>
        )}
      </Section>

      <Section title="Input Features" hint="What the model reads" tip="The ticked features of each example go into the prompt, in this order. An empty feature reads as none.">
        <Features features={value.features} base={base?.features} onChange={readOnly ? undefined : features => onChange({...value, features})} tips={featureTips} />
      </Section>

      <Section title="Task & General Rules" hint="The task, and rules that span fields" tip="The task says what the items are and what the labels are for. General rules cover more than one field, and what to do when the evidence is thin or missing.">
        <Card className="form">
          <Block label="Task summary" value={value.taskSummary} readOnly={readOnly} placeholder="One or two sentences: what the items are, and what the labels are for" marks={marks(base?.taskSummary, value.taskSummary)} onChange={taskSummary => onChange({...value, taskSummary})} />
          <Block label="General / fallback rules" value={value.generalRules} readOnly={readOnly} placeholder="Rules that span fields, and what to choose when the evidence is thin" marks={marks(base?.generalRules, value.generalRules)} onChange={generalRules => onChange({...value, generalRules})} />
        </Card>
      </Section>
    </div>
  );
}

function uniqueName(names: string[], base: string) {
  let n = base;
  for (let i = 2; names.includes(n); i++) n = `${base}_${i}`;
  return n;
}

/** One part of the prompt: its name, and one short line whose detail shows on hover. */
function Section({title, hint, tip, children}: {title: string; hint: string; tip: string; children: ReactNode}) {
  return (
    <section className="col" style={{gap: 8}} aria-label={title}>
      <div className="row" style={{gap: 12, alignItems: 'baseline'}}>
        <h2 className="card-t">{title}</h2>
        <span className="t-3" style={{fontSize: 13}}>
          <Hov text={hint} tip={tip} />
        </span>
      </div>
      {children}
    </section>
  );
}

/** A text box that is as tall as its text (spec 3.3): long definitions are never clipped. */
export function Grow({value, onChange, readOnly, placeholder, label, className = 'input sm'}: {value: string; onChange: (v: string) => void; readOnly?: boolean; placeholder?: string; label: string; className?: string}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={ref} rows={1} className={`${className} grow-box`} value={value} readOnly={readOnly} placeholder={readOnly ? undefined : placeholder} aria-label={label} spellCheck={false} onChange={e => onChange(e.target.value)} />;
}

/** Word-level change marks for one block: added words green, removed words red and struck; a reason shows on hover. */
function Marks({segs}: {segs?: MarkSeg[]}) {
  if (!segs?.some(m => m.kind !== 'same')) return null;
  return (
    <div className="sp-marks" aria-label="Changes">
      {segs.map((m, i) =>
        m.kind === 'same' ? (
          <span key={i}>{m.text}</span>
        ) : m.kind === 'add' ? (
          <ins key={i} className={m.reason ? 'why' : undefined} title={m.reason}>
            {m.text}
          </ins>
        ) : (
          <del key={i} title={m.reason}>
            {m.text}
          </del>
        ),
      )}
    </div>
  );
}

function Block({label, value, onChange, readOnly, placeholder, marks}: {label: string; value: string; onChange: (v: string) => void; readOnly?: boolean; placeholder: string; marks?: MarkSeg[]}) {
  return (
    <div className="field">
      <span className="field-l">{label}</span>
      <Grow className="input" label={label} value={value} readOnly={readOnly} placeholder={placeholder} onChange={onChange} />
      <Marks segs={marks} />
    </div>
  );
}

function FieldEditor({
  field,
  was,
  onChange,
  readOnly,
  marks,
}: {
  field: StructuredFieldPrompt;
  was?: StructuredFieldPrompt;
  onChange: (f: StructuredFieldPrompt | null) => void;
  readOnly?: boolean;
  marks: (was: string | undefined, now: string) => MarkSeg[] | undefined;
}) {
  const multi = field.kind === 'multi';
  const setVal = (i: number, patch: Partial<{name: string; definition: string}>) => onChange({...field, values: field.values.map((v, k) => (k === i ? {...v, ...patch} : v))});
  const setNote = (note: string) => {
    const {note: _old, ...rest} = field;
    onChange(note ? {...rest, note} : rest);
  };
  return (
    <Card className="sp-field">
      <div className="row sp-field-h">
        <input className="input mono" style={{width: 200}} value={field.name} readOnly={readOnly} aria-label="Field name" onChange={e => onChange({...field, name: e.target.value.replace(/\s+/g, '_')})} />
        {readOnly ? (
          <Badge text={multi ? `Multi-select · choose ${field.min ?? 1} to ${field.max ?? field.values.length}` : 'Single-select'} icon={false} />
        ) : (
          <>
            <Seg
              label="Type"
              value={field.kind}
              options={[
                {value: 'single', label: 'Single-select'},
                {value: 'multi', label: 'Multi-select'},
              ]}
              onChange={k => {
                const {min: _a, max: _b, ...rest} = field;
                onChange(k === 'multi' ? {...rest, kind: 'multi', min: field.min ?? 1, max: field.max ?? Math.min(3, field.values.length)} : {...rest, kind: 'single'});
              }}
            />
            {multi && (
              <span className="row" style={{gap: 8}}>
                <span className="t-2">Choose</span>
                <input className="input sm" style={{width: 56, padding: '0 12px'}} aria-label="At least" value={field.min ?? 1} onChange={e => onChange({...field, min: parseInt(e.target.value) || 1})} />
                <span className="t-2">to</span>
                <input className="input sm" style={{width: 56, padding: '0 12px'}} aria-label="At most" value={field.max ?? field.values.length} onChange={e => onChange({...field, max: parseInt(e.target.value) || 1})} />
              </span>
            )}
            <span className="grow" />
            <Button label="Remove field" kind="ghost" onClick={() => onChange(null)} />
          </>
        )}
      </div>
      <div style={{paddingTop: 8}} className="sp-values">
        <Table
          first={28}
          actWidth={56}
          cols={readOnly ? [{label: 'Value'}, {label: 'Definition'}] : [{label: 'Value'}, {label: 'Definition'}, {label: '', kind: 'act'}]}
          rows={field.values.map((v, i) => ({
            key: String(i),
            cells: [
              <input key="n" className="input sm" value={v.name} readOnly={readOnly} aria-label="Value" onChange={e => setVal(i, {name: e.target.value})} />,
              <div key="d" className="col" style={{gap: 4}}>
                <Grow label="Definition" value={v.definition} readOnly={readOnly} placeholder="When this value applies, and the nearest thing that does not count" onChange={definition => setVal(i, {definition})} />
                <Marks segs={marks(was?.values.find(x => x.name === v.name)?.definition, v.definition)} />
              </div>,
              ...(readOnly
                ? []
                : [
                    <button key="x" type="button" className="icon-btn" aria-label="Remove value" onClick={() => onChange({...field, values: field.values.filter((_, k) => k !== i)})}>
                      <Icon name="x" />
                    </button>,
                  ]),
            ],
          }))}
        />
      </div>
      {!readOnly && (
        <div style={{margin: '0 -12px'}}>
          <Button label="Add value" kind="ghost" icon="plus" onClick={() => onChange({...field, values: [...field.values, {name: '', definition: ''}]})} />
        </div>
      )}
      <div className="field" style={{paddingTop: 8}}>
        <span className="field-l">
          <Hov text="Tie-break rules" tip="Rules for this field only: which value wins when two could apply. One rule per line. Improve with AI and the Optimiser add their rules here." />
        </span>
        <Grow className="input" label="Tie-break rules" value={field.note ?? ''} readOnly={readOnly} placeholder="Which value wins when two could apply" onChange={setNote} />
        <Marks segs={marks(was?.note, field.note ?? '')} />
      </div>
    </Card>
  );
}

type Group = keyof FeatureSelection;
const GROUPS: {group: Group; name: string}[] = [
  {group: 'video', name: 'Video'},
  {group: 'photo_text', name: 'Photo and text'},
  {group: 'metadata', name: 'Metadata'},
];

/** Input Features: three groups side by side, a select-all box each; a feature's description shows on hover. */
function Features({features, base, onChange, tips}: {features: FeatureSelection; base?: FeatureSelection; onChange?: (f: FeatureSelection) => void; tips?: Record<string, string>}) {
  const toggle = (g: Group, key: string) => onChange?.({...features, [g]: features[g].includes(key) ? features[g].filter(k => k !== key) : [...features[g], key]});
  return (
    <Card>
      <div className="sp-feats">
        {GROUPS.map(({group, name}) => {
          const keys = FEATURES[group].map(f => f.key);
          const on = keys.filter(k => features[group].includes(k)).length;
          const all = on === keys.length ? 'on' : on === 0 ? 'off' : 'mixed';
          return (
            <div key={group} className="col" style={{gap: 0, minWidth: 0}}>
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
                  const now = features[group].includes(f.key);
                  const before = base ? base[group].includes(f.key) : now;
                  return (
                    <div key={f.key} className="row" style={{height: 36, gap: 12}}>
                      <span className="grow one">{tips?.[f.key] ? <Hov text={f.label} tip={tips[f.key]} /> : f.label}</span>
                      {now !== before && <Badge text={now ? 'Added' : 'Removed'} tone={now ? 'ok' : 'err'} icon={false} />}
                      <Cb state={now ? 'on' : 'off'} label={`${f.label}, ${name}`} onToggle={onChange ? () => toggle(group, f.key) : undefined} />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** View full prompt: the text the model reads, compiled live from the parts, with Copy prompt. */
export function FullPromptButton({prompt, onOpen, onCopy}: {prompt: StructuredPrompt; onOpen?: () => void; onCopy?: () => void}) {
  const [open, setOpen] = useState(false);
  const [copied, copy] = useCopy();
  const text = useMemo(() => (open ? compilePrompt(prompt) : ''), [open, prompt]);
  return (
    <>
      <Button
        label="View full prompt"
        icon="eye"
        disabled={!prompt.fields.length}
        onClick={() => {
          setOpen(true);
          onOpen?.();
        }}
      />
      {open && (
        <Dialog
          title="Full prompt"
          text="This is the text the model reads. It is written from the parts on the page."
          width={760}
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button label="Close" onClick={() => setOpen(false)} />
              <Button
                label={copied === text ? 'Copied' : 'Copy prompt'}
                kind="primary"
                icon={copied === text ? 'check' : 'copy'}
                onClick={() => {
                  copy(text);
                  onCopy?.();
                }}
              />
            </>
          }
        >
          <pre className="full-prompt" tabIndex={0}>
            {text}
          </pre>
        </Dialog>
      )}
    </>
  );
}
