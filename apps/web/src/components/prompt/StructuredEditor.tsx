'use client';

import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {compilePrompt, diffWords, FEATURES, matchRuleGroup, nextRuleGroupId, withReasons, type MarkSeg} from '@tsp/domain';
import type {FeatureSelection, LabelValue, RuleGroup, Schema, StructuredPrompt} from '@tsp/contracts';
import {Badge, Button, Card, Cb, Dialog, Empty, Hov, Icon, useCopy} from '@/ui';
import {t} from '@/i18n';

/**
 * The structured prompt editor (spec 1.0.0, 3.2 and 3.3), used on Prompt Design and in the prompt
 * editor. Four parts in authoring order (2026-11-16 refinements, 2.2): Persona & Task, Input
 * Features, Output Labels & Definitions (the project's one label: its key, then one stacked card
 * per value, like the rule groups; 2026-11-16), Rule Groups (named by the user). The text the model reads is compiled from these parts, so there are
 * no placeholders to write and no checks to fix.
 *
 * With `base` (the version being edited), changed wording shows its word-level marks under the
 * box it belongs to, features carry Added / Removed badges, and values and rule groups New / Changed.
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
  /** Values carry a Draft badge while a helper's draft waits for approval. */
  draft?: boolean;
}) {
  const marks = (was: string | undefined, now: string) => (base && (was ?? '') !== now ? withReasons(diffWords(was ?? '', now), reasons ?? [], reasonPrefix) : undefined);

  return (
    <div className="col sp" style={{gap: 16}}>
      <Section title={t('Persona & Task')} hint={t('Who the model is and what it judges')} tip={t('The role the model takes, what the items are, and what the labels are for.')}>
        <Card className="form">
          <Block label={t('Persona and task')} value={value.taskSummary} readOnly={readOnly} placeholder={t('Who the model is, what the items are, and what the labels are for')} marks={marks(base?.taskSummary, value.taskSummary)} onChange={taskSummary => onChange({...value, taskSummary})} />
        </Card>
      </Section>

      <Section title={t('Input Features')} hint={t('What the model reads')} tip={t('The ticked features of each example go into the prompt, in this order. An empty feature reads as none.')}>
        <Features features={value.features} base={base?.features} onChange={readOnly ? undefined : features => onChange({...value, features})} tips={featureTips} />
      </Section>

      <Section title={t('Output Labels & Definitions')} hint={t('One label and its values')} tip={t("The project's one label: every item gets exactly one of its values. The values are what people label with, what the model must answer with, and what scores are counted on. Each value's definition says when it applies and when it does not.")}>
        <LabelEditor label={value.label} base={base?.label} readOnly={readOnly} draft={draft} marks={marks} onChange={label => onChange({...value, label})} />
      </Section>

      <Section title={t('Rule Groups')} hint={t('Rules across values')} tip={t("Rules that span values, in groups you name: the order values are checked in, what wins when an item fits two values, and how to read the inputs. A value's own criteria belong in its definition.")}>
        <RuleGroups groups={value.ruleGroups} base={base?.ruleGroups} readOnly={readOnly} marks={marks} onChange={ruleGroups => onChange({...value, ruleGroups})} />
      </Section>
    </div>
  );
}

/** Rule Groups: one card per group (title, rules, move and remove), then Add rule group. */
function RuleGroups({groups, base, readOnly, marks, onChange}: {groups: RuleGroup[]; base?: RuleGroup[]; readOnly?: boolean; marks: (was: string | undefined, now: string) => MarkSeg[] | undefined; onChange: (g: RuleGroup[]) => void}) {
  const set = (i: number, g: RuleGroup) => onChange(groups.map((x, k) => (k === i ? g : x)));
  const move = (i: number, by: number) => {
    const next = [...groups];
    const [g] = next.splice(i, 1);
    next.splice(i + by, 0, g);
    onChange(next);
  };
  const add = () => onChange([...groups, {id: nextRuleGroupId(groups), title: '', content: ''}]);
  const removed = base?.filter(b => !groups.some(g => matchRuleGroup(g, [b]))) ?? [];
  return (
    <div className="col" style={{gap: 12}}>
      {!groups.length && (
        <Card>
          <Empty title={t('No rule groups yet')} text={readOnly ? t('This prompt has no rules.') : t('Add a group for each kind of rule, or let the Prompt helper sort the rules of a prompt you paste.')}>
            {!readOnly && <Button label={t('Add rule group')} icon="plus" onClick={add} />}
          </Empty>
        </Card>
      )}
      {groups.map((g, i) => {
        const was = base ? matchRuleGroup(g, base) : undefined;
        const tag = !base ? null : !was ? <Badge text={t('New')} tone="ok" icon={false} /> : was.title !== g.title || was.content !== g.content ? <Badge text={t('Changed')} tone="warn" icon={false} /> : null;
        return (
          <Card key={g.id || i} className="sp-group">
            <section className="col" style={{gap: 8}} aria-label={g.title || t('Rule group')}>
              <div className="row" style={{gap: 8}}>
                <input className="input sp-group-t" value={g.title} readOnly={readOnly} placeholder={readOnly ? undefined : t('Group title, for example Label priority')} aria-label={t('Rule group title')} onChange={e => set(i, {...g, title: e.target.value})} />
                {tag}
                <span className="grow" />
                {!readOnly && (
                  <>
                    <button type="button" className="icon-btn" aria-label={t('Move up')} title={t('Move up')} disabled={i === 0} onClick={() => move(i, -1)}>
                      <Icon name="chev-up" />
                    </button>
                    <button type="button" className="icon-btn" aria-label={t('Move down')} title={t('Move down')} disabled={i === groups.length - 1} onClick={() => move(i, 1)}>
                      <Icon name="chev" />
                    </button>
                    <button type="button" className="icon-btn" aria-label={t('Remove rule group')} title={t('Remove rule group')} onClick={() => onChange(groups.filter((_, k) => k !== i))}>
                      <Icon name="x" />
                    </button>
                  </>
                )}
              </div>
              <Marks segs={was && was.title !== g.title ? marks(was.title, g.title) : undefined} />
              <Grow className="input" label={t('Rules')} value={g.content} readOnly={readOnly} placeholder={t('Paragraphs, or one rule per line')} onChange={content => set(i, {...g, content})} />
              <Marks segs={base ? marks(was?.content, g.content) : undefined} />
            </section>
          </Card>
        );
      })}
      {removed.map(g => (
        <div key={`gone-${g.id}`} className="row sp-group-gone">
          <Badge text={t('Removed')} tone="err" icon={false} />
          <del className="one">{g.title || t('Rule group')}</del>
        </div>
      ))}
      {!readOnly && groups.length > 0 && (
        <div style={{margin: '-4px -12px 0'}}>
          <Button label={t('Add rule group')} kind="ghost" icon="plus" onClick={add} />
        </div>
      )}
    </div>
  );
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
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    // The box also changes width (Ask AI opening or closing, a window resize): measure again.
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);
  return <textarea ref={ref} rows={1} className={`${className} grow-box`} value={value} readOnly={readOnly} placeholder={readOnly ? undefined : placeholder} aria-label={label} spellCheck={false} onChange={e => onChange(e.target.value)} />;
}

/** Word-level change marks for one block: added words green, removed words red and struck; a reason shows on hover. */
function Marks({segs}: {segs?: MarkSeg[]}) {
  if (!segs?.some(m => m.kind !== 'same')) return null;
  return (
    <div className="sp-marks" aria-label={t('Changes')}>
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

/** The value in `base` that `v` continues: the same name, else the value at the same place (a rename). */
function baseValue(v: LabelValue, i: number, base: LabelValue[], values: LabelValue[]): LabelValue | undefined {
  const named = base.find(x => x.name === v.name);
  if (named) return named;
  const at = base[i];
  return at && !values.some(x => x.name === at.name) ? at : undefined;
}

/**
 * Output Labels & Definitions (2026-11-16, 2.1): the label's key in a compact row, then one stacked
 * card per value like the rule groups: the value's name in bold, its badge, move and remove, and a
 * full-width box for its definition, which grows with it (criteria, exclusions, exemptions).
 */
function LabelEditor({label, base, readOnly, draft, marks, onChange}: {label: Schema; base?: Schema; readOnly?: boolean; draft?: boolean; marks: (was: string | undefined, now: string) => MarkSeg[] | undefined; onChange: (l: Schema) => void}) {
  const values = label.values;
  const setValues = (next: LabelValue[]) => onChange({...label, values: next});
  const set = (i: number, patch: Partial<LabelValue>) => setValues(values.map((v, k) => (k === i ? {...v, ...patch} : v)));
  const move = (i: number, by: number) => {
    const next = [...values];
    const [v] = next.splice(i, 1);
    next.splice(i + by, 0, v);
    setValues(next);
  };
  const add = () => setValues([...values, {name: '', definition: ''}]);
  const kept = base ? values.map((v, i) => baseValue(v, i, base.values, values)) : [];
  const removed = base?.values.filter(b => !kept.includes(b)) ?? [];
  return (
    <div className="col" style={{gap: 12}}>
      <Card className="sp-key">
        <label className="row" style={{gap: 12}}>
          <span className="field-l" style={{margin: 0}}>
            <Hov text={t('Label name')} tip={t("The key of the model's answer, for example category. Gold labels and scores are tied to it.")} />
          </span>
          <input className="input sm mono" style={{width: 240}} value={label.name} readOnly={readOnly} placeholder={readOnly ? undefined : 'category'} onChange={e => onChange({...label, name: e.target.value.replace(/\s+/g, '_')})} />
          {base && base.name !== label.name && <Badge text={t('Changed')} tone="warn" icon={false} />}
        </label>
      </Card>
      {!values.length && (
        <Card>
          <Empty title={t('No values yet')} text={readOnly ? t('This prompt has no values.') : t('Describe your task in Ask AI, paste the prompt you use today, or add the values yourself.')}>
            {!readOnly && <Button label={t('Add value')} icon="plus" onClick={add} />}
          </Empty>
        </Card>
      )}
      {values.map((v, i) => {
        const was = kept[i];
        const tag = draft ? <Badge text={t('Draft')} icon={false} /> : !base ? null : !was ? <Badge text={t('New')} tone="ok" icon={false} /> : was.name !== v.name || was.definition !== v.definition ? <Badge text={t('Changed')} tone="warn" icon={false} /> : null;
        return (
          <Card key={i} className="sp-group sp-value">
            <section className="col" style={{gap: 8}} aria-label={v.name || t('Value')}>
              <div className="row" style={{gap: 8}}>
                <input className="input sp-group-t" value={v.name} readOnly={readOnly} placeholder={readOnly ? undefined : t('Value name')} aria-label={t('Value name')} onChange={e => set(i, {name: e.target.value})} />
                {tag}
                <span className="grow" />
                {!readOnly && (
                  <>
                    <button type="button" className="icon-btn" aria-label={t('Move up')} title={t('Move up')} disabled={i === 0} onClick={() => move(i, -1)}>
                      <Icon name="chev-up" />
                    </button>
                    <button type="button" className="icon-btn" aria-label={t('Move down')} title={t('Move down')} disabled={i === values.length - 1} onClick={() => move(i, 1)}>
                      <Icon name="chev" />
                    </button>
                    <button type="button" className="icon-btn" aria-label={t('Remove value')} title={t('Remove value')} onClick={() => setValues(values.filter((_, k) => k !== i))}>
                      <Icon name="x" />
                    </button>
                  </>
                )}
              </div>
              <Marks segs={was && was.name !== v.name ? marks(was.name, v.name) : undefined} />
              <Grow className="input" label={t('Definition')} value={v.definition} readOnly={readOnly} placeholder={t('When this value applies and when it does not: one condition per line')} onChange={definition => set(i, {definition})} />
              <Marks segs={base ? marks(was?.definition, v.definition) : undefined} />
            </section>
          </Card>
        );
      })}
      {removed.map((v, i) => (
        <div key={`gone-${i}`} className="row sp-group-gone">
          <Badge text={t('Removed')} tone="err" icon={false} />
          <del className="one">{v.name || t('Value')}</del>
        </div>
      ))}
      {!readOnly && values.length > 0 && (
        <div style={{margin: '-4px -12px 0'}}>
          <Button label={t('Add value')} kind="ghost" icon="plus" onClick={add} />
        </div>
      )}
    </div>
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
        {GROUPS.map(({group, name: key}) => {
          const name = t(key);
          const keys = FEATURES[group].map(f => f.key);
          const on = keys.filter(k => features[group].includes(k)).length;
          const all = on === keys.length ? 'on' : on === 0 ? 'off' : 'mixed';
          return (
            <div key={group} className="col" style={{gap: 0, minWidth: 0}}>
              <div className="row" style={{height: 40, gap: 12, borderBottom: '1px solid var(--border)'}}>
                <b style={{fontSize: 13}} className="grow">
                  {name}
                </b>
                <span title={t('Select all')}>
                  <Cb state={all} label={t('Select all {group}', {group: name})} onToggle={onChange ? () => onChange({...features, [group]: all === 'on' ? [] : keys}) : undefined} />
                </span>
              </div>
              <div className="col" style={{gap: 0, paddingTop: 4}}>
                {FEATURES[group].map(f => {
                  const now = features[group].includes(f.key);
                  const before = base ? base[group].includes(f.key) : now;
                  return (
                    <div key={f.key} className="row" style={{height: 36, gap: 12}}>
                      <span className="grow one">{tips?.[f.key] ? <Hov text={t(f.label)} tip={tips[f.key]} /> : t(f.label)}</span>
                      {now !== before && <Badge text={now ? t('Added') : t('Removed')} tone={now ? 'ok' : 'err'} icon={false} />}
                      <Cb state={now ? 'on' : 'off'} label={`${t(f.label)}, ${name}`} onToggle={onChange ? () => toggle(group, f.key) : undefined} />
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
        label={t('View full prompt')}
        icon="eye"
        disabled={!prompt.label.values.length}
        onClick={() => {
          setOpen(true);
          onOpen?.();
        }}
      />
      {open && (
        <Dialog
          title={t('Full prompt')}
          text={t('This is the text the model reads. It is written from the parts on the page.')}
          width={760}
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button label={t('Close')} onClick={() => setOpen(false)} />
              <Button
                label={copied === text ? t('Copied') : t('Copy prompt')}
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
