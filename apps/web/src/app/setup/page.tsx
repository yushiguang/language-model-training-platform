'use client';

import {useRouter, useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useState} from 'react';
import {CUSTOM_START, DEFAULT_THRESHOLDS} from '@tsp/domain';
import type {AgentProposal, LabelField, ModelSettings, Schema, Thresholds} from '@tsp/contracts';
import {ApprovedCard} from '@/components/AskAi';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {approveNode, closeProposal, proposals, saveSetup, subscribeChanges, type PageContext, type ProjectState} from '@/backend-api';
import {Badge, Button, Card, Code, Empty, Field, Hov, Icon, Opt, PageHead, Seg, Suggestion, Switch, Table} from '@/ui';

export default function SetupPage() {
  return (
    <Suspense fallback={null}>
      <SetupRouter />
    </Suspense>
  );
}

function SetupRouter() {
  const step = useSearchParams().get('step') ?? '1';
  if (step === '2') return <EvaluationPage />;
  if (step === '3') return <ModelsPage />;
  return <SchemaPage />;
}

const FIRST = 'Tell me what your model should do. You can paste document links.';
const count = (f: LabelField) => `${f.kind === 'single' ? 'Single' : 'Multi'} · ${f.values.length}`;

// ---------------------------------------------------------------------------------------------
// Setup 1: Schema settings. The schema agent's draft comes from Ask AI; the table edits it.

function SchemaPage() {
  const [page, setPage] = useState<PageContext>({label: 'Schema settings', agent: 'schema_agent', intent: 'propose_schema', context: {}});
  return (
    <ProjectPage node="setup" page={page} chatOpen>
      {({state}) => <SchemaView state={state} setPage={setPage} />}
    </ProjectPage>
  );
}

function useProposals(state: ProjectState) {
  const [list, setList] = useState<AgentProposal[]>([]);
  useEffect(() => {
    const load = () => void proposals(state.project.id, 'schema').then(setList);
    load();
    return subscribeChanges(load);
  }, [state.project.id]);
  return list;
}

function SchemaView({state, setPage}: {state: ProjectState; setPage: (p: PageContext) => void}) {
  const router = useRouter();
  const {href} = useProject();
  const setup = state.setup;
  const all = useProposals(state);
  const open = [...all].reverse().find(p => p.state === 'open') ?? null;
  const source: Schema | null = (open?.payload as Schema | undefined) ?? setup?.schema ?? null;
  const [draft, setDraft] = useState<Schema | null>(source);
  const [sel, setSel] = useState(0);
  const key = open?.id ?? `saved-${setup?.schemaVersion ?? 0}`;
  const [loadedKey, setLoadedKey] = useState(key);
  // Approve closes the proposal a moment before the saved schema arrives: keep the draft meanwhile.
  if (key !== loadedKey && !(source === null && draft && !open)) {
    setLoadedKey(key);
    setDraft(source);
    setSel(0);
  }
  const isDraft = !!open;
  const dirty = !isDraft && !!draft && JSON.stringify(draft) !== JSON.stringify(setup?.schema ?? null);
  const approved = !!setup?.steps.schema && !isDraft;

  useEffect(() => {
    setPage({
      label: 'Schema settings',
      agent: 'schema_agent',
      intent: draft?.fields.length ? 'revise_schema' : 'propose_schema',
      hint: FIRST,
      context: {task: setup?.task ?? '', schema: draft},
    });
  }, [JSON.stringify(draft), setup?.task]); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async () => {
    if (!open || !draft) return;
    await saveSetup(state.project.id, {schema: draft, steps: {schema: true, evaluation: setup?.steps.evaluation ?? false, models: setup?.steps.models ?? false}});
    await closeProposal(open, 'approved');
  };
  const save = async () => {
    if (!draft) return;
    await saveSetup(state.project.id, {schema: draft, steps: {schema: true, evaluation: setup?.steps.evaluation ?? false, models: setup?.steps.models ?? false}});
  };
  const addField = () => {
    const d: Schema = draft ?? {policy: '', fields: []};
    const name = uniqueName(d.fields.map(f => f.name), 'new_field');
    setDraft({...d, fields: [...d.fields, {name, kind: 'single', values: [{name: '', definition: ''}, {name: '', definition: ''}]}]});
    setSel(d.fields.length);
  };
  const field = draft?.fields[sel];
  const setField = (f: LabelField | null) => {
    if (!draft) return;
    const fields = f ? draft.fields.map((x, i) => (i === sel ? f : x)) : draft.fields.filter((_, i) => i !== sel);
    setDraft({...draft, fields});
    if (!f) setSel(Math.max(0, sel - 1));
  };

  const head = (
    <PageHead
      title="Schema settings"
      actions={
        dirty ? (
          <>
            <span className="done-at" style={{margin: 0}}>
              <Badge text="Unsaved changes" tone="warn" icon={false} />
            </span>
            <Button label="Discard" kind="ghost" onClick={() => setDraft(setup?.schema ?? null)} />
            <Button label="Save" kind="primary" disabled={!valid(draft)} onClick={save} />
          </>
        ) : (
          <Button label="Next: Evaluation" kind="primary" disabled={!approved} onClick={() => router.push(href('/setup', {step: '2'}))} />
        )
      }
    />
  );

  const body = !draft?.fields.length ? (
    <Empty title="No label fields yet" text="Describe your task in Ask AI, or add a field yourself.">
      <Button label="Add field" icon="plus" onClick={addField} />
    </Empty>
  ) : (
    <div className="grid-split" style={{gridTemplateColumns: '360px 1fr'}}>
      <Card title="Fields">
        <nav className="vlist" aria-label="Fields">
          {draft.fields.map((f, i) => (
            <a
              key={i}
              className="vrow"
              href="#"
              aria-current={i === sel}
              onClick={e => {
                e.preventDefault();
                setSel(i);
              }}
            >
              <Code>{f.name || 'unnamed'}</Code>
              <span>{isDraft && <Badge text="Draft" icon={false} />}</span>
              <span className="t-3" style={{fontSize: 13}}>
                {count(f)}
              </span>
            </a>
          ))}
        </nav>
        <div style={{margin: '4px -12px 0'}}>
          <Button label="Add field" kind="ghost" icon="plus" onClick={addField} />
        </div>
      </Card>
      {field && <FieldEditor key={`${key}-${sel}`} field={field} onChange={setField} />}
    </div>
  );

  // Ask AI: the draft waits for Approve; an approved draft shrinks to one line.
  const cards = all.map(p => {
    const n = (p.payload as Schema).fields.length;
    const title = `${n} label field${n === 1 ? '' : 's'}`;
    return p.state === 'approved' ? (
      <ApprovedCard key={p.id} title={title} />
    ) : (
      <section key={p.id} className="card ai">
        <Suggestion kicker={false} title={title} text="Check them on the left." actions={<Button label="Approve" kind="primary" disabled={!valid(draft)} onClick={approve} />} />
      </section>
    );
  });

  return (
    <Frame
      head={head}
      chat={{
        extra: cards.length ? <>{cards}</> : undefined,
        first: FIRST,
        placeholder: draft?.fields.length ? 'Ask about this page' : 'Describe your task or paste a document link',
        onSend: async (text: string) => {
          if (!setup?.task) await saveSetup(state.project.id, {task: text});
        },
      }}
    >
      {body}
    </Frame>
  );
}

function uniqueName(names: string[], base: string) {
  let n = base;
  for (let i = 2; names.includes(n); i++) n = `${base}_${i}`;
  return n;
}
const valid = (s: Schema | null) => !!s && s.fields.length > 0 && s.fields.every(f => f.name.trim() && f.values.length >= 2 && f.values.every(v => v.name.trim())) && new Set(s.fields.map(f => f.name)).size === s.fields.length;

function FieldEditor({field, onChange}: {field: LabelField; onChange: (f: LabelField | null) => void}) {
  const multi = field.kind === 'multi';
  const setVal = (i: number, patch: Partial<{name: string; definition: string}>) => onChange({...field, values: field.values.map((v, k) => (k === i ? {...v, ...patch} : v))});
  return (
    <Card>
      <div className="row" style={{gap: 12}}>
        <input className="input mono" style={{width: 240}} value={field.name} aria-label="Field name" onChange={e => onChange({...field, name: e.target.value.replace(/\s+/g, '_')})} />
        <Seg
          label="Type"
          value={field.kind}
          options={[
            {value: 'single', label: 'Single-select'},
            {value: 'multi', label: 'Multi-select'},
          ]}
          onChange={k => onChange(k === 'multi' ? {...field, kind: 'multi', min: field.min ?? 1, max: field.max ?? Math.min(3, field.values.length)} : {...field, kind: 'single', min: undefined, max: undefined})}
        />
        {multi && (
          <>
            <span className="t-2" style={{marginLeft: 8}}>
              Choose
            </span>
            <input className="input sm" style={{width: 56, padding: '0 12px'}} aria-label="At least" value={field.min ?? 1} onChange={e => onChange({...field, min: parseInt(e.target.value) || 1})} />
            <span className="t-2">to</span>
            <input className="input sm" style={{width: 56, padding: '0 12px'}} aria-label="At most" value={field.max ?? field.values.length} onChange={e => onChange({...field, max: parseInt(e.target.value) || 1})} />
          </>
        )}
        <span className="grow" />
        <Button label="Remove field" kind="ghost" onClick={() => onChange(null)} />
      </div>
      <div style={{paddingTop: 8}}>
        <Table
          first={30}
          actWidth={56}
          cols={[{label: 'Value'}, {label: 'Definition'}, {label: '', kind: 'act'}]}
          rows={field.values.map((v, i) => ({
            key: String(i),
            cells: [
              <input key="n" className="input sm" value={v.name} aria-label="Value" onChange={e => setVal(i, {name: e.target.value})} />,
              <input key="d" className="input sm" value={v.definition} aria-label="Definition" title={v.definition} onChange={e => setVal(i, {definition: e.target.value})} />,
              <button key="x" type="button" className="icon-btn" aria-label="Remove value" onClick={() => onChange({...field, values: field.values.filter((_, k) => k !== i)})}>
                <Icon name="x" />
              </button>,
            ],
          }))}
        />
      </div>
      <div style={{margin: '0 -12px'}}>
        <Button label="Add value" kind="ghost" icon="plus" onClick={() => onChange({...field, values: [...field.values, {name: '', definition: ''}]})} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Setup 2: Evaluation settings.

function EvaluationPage() {
  return (
    <ProjectPage node="setup" page={{label: 'Evaluation settings', agent: 'front_desk', intent: 'answer', hint: 'Ask what a check means.', context: {}}}>
      {({state}) => <Evaluation state={state} />}
    </ProjectPage>
  );
}

type Mode = 'default' | 'custom' | 'none';
type Check = 'macroF1' | 'valueF1' | 'precision' | 'recall';
const CHECKS: {key: Check; name: string; tip: string; applies: string}[] = [
  {key: 'macroF1', name: 'Macro-F1', tip: 'Per field, every value counts equally', applies: 'Each field'},
  {key: 'valueF1', name: 'F1', tip: 'Per value, so rare values are not ignored', applies: 'Each value'},
  {key: 'precision', name: 'Precision', tip: 'Per value: how often the model’s pick is right', applies: 'Each value'},
  {key: 'recall', name: 'Recall', tip: 'Per value: how many true cases the model finds', applies: 'Each value'},
];

function Evaluation({state}: {state: ProjectState}) {
  const router = useRouter();
  const {href, refresh} = useProject();
  const s = state.setup;
  const saved = s?.thresholds ?? null;
  const [mode, setMode] = useState<Mode>(s?.steps.evaluation ? (saved ? saved.mode : 'none') : 'default');
  const start = saved?.mode === 'custom' ? saved : null;
  const [on, setOn] = useState<Record<Check, boolean>>({macroF1: true, valueF1: start ? start.valueF1 != null : true, precision: start?.precision != null, recall: start?.recall != null});
  const [val, setVal] = useState<Record<Check, string>>({
    macroF1: (start?.macroF1 ?? DEFAULT_THRESHOLDS.macroF1).toFixed(2),
    valueF1: (start?.valueF1 ?? CUSTOM_START.valueF1).toFixed(2),
    precision: (start?.precision ?? CUSTOM_START.precision).toFixed(2),
    recall: (start?.recall ?? CUSTOM_START.recall).toFixed(2),
  });

  const next = async () => {
    const n = (k: Check) => (on[k] ? Math.min(1, Math.max(0, parseFloat(val[k]) || 0)) : null);
    const thresholds: Thresholds | null =
      mode === 'none' ? null : mode === 'default' ? DEFAULT_THRESHOLDS : {...DEFAULT_THRESHOLDS, mode: 'custom', macroF1: n('macroF1') ?? DEFAULT_THRESHOLDS.macroF1, valueF1: n('valueF1'), precision: n('precision'), recall: n('recall')};
    await saveSetup(state.project.id, {thresholds, steps: {schema: !!s?.steps.schema, evaluation: true, models: !!s?.steps.models}});
    await refresh();
    router.push(href('/setup', {step: '3'}));
  };

  const head = <PageHead title="Evaluation settings" back={{label: 'Schema settings', href: href('/setup', {step: '1'})}} actions={<Button label="Next: Models" kind="primary" disabled={!s?.steps.schema} onClick={next} />} />;
  const body = (
    <div className="grid-split" style={{gridTemplateColumns: '400px 1fr'}}>
      <Card title="Pass rule">
        <div className="opts" role="radiogroup" aria-label="Pass rule">
          <Opt title="Default" tip="Macro-F1 of every field must reach 0.80" checked={mode === 'default'} onSelect={() => setMode('default')} extra={<><span className="grow" /><Badge text="Recommended" icon={false} /></>} />
          <Opt title="Custom" tip="Choose which checks count and their threshold" checked={mode === 'custom'} onSelect={() => setMode('custom')} />
          <Opt title="None" tip="No scores, so the optimiser cannot run" checked={mode === 'none'} onSelect={() => setMode('none')} />
        </div>
      </Card>
      {mode === 'custom' && (
        <Card title="Checks">
          <Table
            first={34}
            cols={[{label: 'Check'}, {label: 'Applies to'}, {label: 'On', kind: 'c'}, {label: 'Threshold', kind: 'c'}]}
            rows={CHECKS.map(c => ({
              key: c.key,
              cells: [
                <b key="n">
                  <Hov text={c.name} tip={c.tip} />
                </b>,
                c.applies,
                <Switch key="s" label={`${c.name} on`} on={on[c.key]} locked={c.key === 'macroF1'} onChange={v => setOn({...on, [c.key]: v})} />,
                <input
                  key="v"
                  className="input sm"
                  style={{width: 72, textAlign: 'center', padding: '0 8px'}}
                  aria-label={`${c.name} threshold`}
                  value={val[c.key]}
                  onChange={e => {
                    setVal({...val, [c.key]: e.target.value});
                    if (c.key !== 'macroF1') setOn({...on, [c.key]: true});
                  }}
                />,
              ],
            }))}
          />
        </Card>
      )}
    </div>
  );
  return <Frame head={head}>{body}</Frame>;
}

// ---------------------------------------------------------------------------------------------
// Setup 3: Labeling models.

function ModelsPage() {
  return (
    <ProjectPage node="setup" page={{label: 'Labeling models', agent: 'front_desk', intent: 'answer', hint: 'Ask about the models.', context: {}}}>
      {({state}) => <Models state={state} />}
    </ProjectPage>
  );
}

function Models({state}: {state: ProjectState}) {
  const router = useRouter();
  const {href} = useProject();
  const s = state.setup;
  const eps = state.endpoints;
  // The design shows every model with its settings and no way to leave one out (docs/ui-gaps.md).
  const [models, setModels] = useState<ModelSettings[]>(
    eps.map(e => s?.models.find(m => m.endpoint === e.id) ?? {endpoint: e.id, maxOutputTokens: 1024, temperature: e.supportsTemperature ? 0 : null}),
  );
  const patch = (id: string, p: Partial<ModelSettings>) => setModels(models.map(m => (m.endpoint === id ? {...m, ...p} : m)));
  const next = async () => {
    await saveSetup(state.project.id, {models, steps: {schema: !!s?.steps.schema, evaluation: !!s?.steps.evaluation, models: true}});
    await approveNode(state.project.id, 'setup');
    router.push(href('/dataset'));
  };
  const head = <PageHead title="Labeling models" back={{label: 'Evaluation settings', href: href('/setup', {step: '2'})}} actions={<Button label="Next: Dataset" kind="primary" disabled={!s?.steps.evaluation} onClick={next} />} />;
  const body = (
    <div className="grid-2">
      {eps.map(ep => {
        const m = models.find(x => x.endpoint === ep.id)!;
        return (
          <Card key={ep.id} title={ep.name} titleExtra={<Badge text={ep.badge} icon={false} />} className="form">
            <div className="row" style={{gap: 16, alignItems: 'flex-end'}}>
              <Field label="Max output tokens">
                <input className="input" value={m.maxOutputTokens} onChange={e => patch(ep.id, {maxOutputTokens: parseInt(e.target.value) || 1})} />
              </Field>
              <Field label="Temperature">
                {ep.supportsTemperature ? (
                  <input className="input" value={m.temperature ?? 0} onChange={e => patch(ep.id, {temperature: parseFloat(e.target.value) || 0})} />
                ) : (
                  <input className="input" value="–" readOnly disabled title="This model does not support temperature" />
                )}
              </Field>
            </div>
          </Card>
        );
      })}
    </div>
  );
  return <Frame head={head}>{body}</Frame>;
}
