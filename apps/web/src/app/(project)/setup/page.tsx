'use client';

import {useGo} from '@/components/nav';
import {useSearchParams} from 'next/navigation';
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
  const step = useSearchParams().get('step');
  const {state} = useProject();
  const steps = state?.setup?.steps;
  if (step === '2') return <EvaluationPage />;
  if (step === '3') return <ModelsPage />;
  // A finished Setup opens on its summary, with Edit on each part (R2-1).
  if (step === null && steps?.schema && steps.evaluation && steps.models) return <SummaryPage />;
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
  const go = useGo();
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
    await closeProposal({projectId: state.project.id, proposalId: open.id, decision: 'approved'});
  };
  // Discarding a draft goes back to the saved schema (or none).
  const discard = async () => {
    if (!open) return;
    await closeProposal({projectId: state.project.id, proposalId: open.id, decision: 'discarded'});
    setDraft(setup?.schema ?? null);
  };
  const save = async () => {
    if (!draft) return;
    await saveSetup(state.project.id, {schema: draft, steps: {schema: true, evaluation: setup?.steps.evaluation ?? false, models: setup?.steps.models ?? false}});
  };
  const addField = () => {
    const d: Schema = draft ?? {fields: []};
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
        isDraft ? (
          <>
            <span className="done-at" style={{margin: 0}}>
              <Badge text="AI draft" icon={false} />
            </span>
            <Button label="Discard" kind="ghost" onClick={discard} />
            <Button label="Approve" kind="primary" disabled={!valid(draft)} onClick={approve} />
          </>
        ) : dirty ? (
          <>
            <span className="done-at" style={{margin: 0}}>
              <Badge text="Unsaved changes" tone="warn" icon={false} />
            </span>
            <Button label="Discard" kind="ghost" onClick={() => setDraft(setup?.schema ?? null)} />
            <Button label="Save" kind="primary" disabled={!valid(draft)} onClick={save} />
          </>
        ) : (
          <Button label="Next: Evaluation" kind="primary" disabled={!approved} onClick={() => go(href('/setup', {step: '2'}))} />
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
            <button key={i} type="button" className="vrow" aria-current={i === sel} onClick={() => setSel(i)}>
              <Code>{f.name || 'unnamed'}</Code>
              <span>{isDraft && <Badge text="Draft" icon={false} />}</span>
              <span className="t-3" style={{fontSize: 13}}>
                {count(f)}
              </span>
            </button>
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

type Mode = 'default' | 'custom';
type Check = 'macroF1' | 'valueF1' | 'precision' | 'recall';
const CHECKS: {key: Check; name: string; tip: string; applies: string}[] = [
  {key: 'macroF1', name: 'Macro-F1', tip: 'Per field, every value counts equally', applies: 'Each field'},
  {key: 'valueF1', name: 'F1', tip: 'Per value, so rare values are not ignored', applies: 'Each value'},
  {key: 'precision', name: 'Precision', tip: 'Per value: how often the model’s pick is right', applies: 'Each value'},
  {key: 'recall', name: 'Recall', tip: 'Per value: how many true cases the model finds', applies: 'Each value'},
];

function Evaluation({state}: {state: ProjectState}) {
  const go = useGo();
  const {href, refresh} = useProject();
  const s = state.setup;
  const saved = s?.thresholds ?? null;
  // R5-8: no "None" pass rule any more (it skipped gold labels). A project saved with none opens on Default.
  const [mode, setMode] = useState<Mode>(saved ? saved.mode : 'default');
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
      mode === 'default' ? DEFAULT_THRESHOLDS : {...DEFAULT_THRESHOLDS, mode: 'custom', macroF1: n('macroF1') ?? DEFAULT_THRESHOLDS.macroF1, valueF1: n('valueF1'), precision: n('precision'), recall: n('recall')};
    await saveSetup(state.project.id, {thresholds, steps: {schema: !!s?.steps.schema, evaluation: true, models: !!s?.steps.models}});
    await refresh();
    await go(href('/setup', {step: '3'}));
  };

  const head = <PageHead title="Evaluation settings" back={{label: 'Schema settings', href: href('/setup', {step: '1'})}} actions={<Button label="Next: Models" kind="primary" disabled={!s?.steps.schema} onClick={next} />} />;
  const body = (
    <div className="grid-split" style={{gridTemplateColumns: '400px 1fr'}}>
      <Card title="Pass rule">
        <div className="opts" role="radiogroup" aria-label="Pass rule">
          <Opt title="Default" tip={`Macro-F1 of every field must reach ${DEFAULT_THRESHOLDS.macroF1.toFixed(2)}`} checked={mode === 'default'} onSelect={() => setMode('default')} extra={<><span className="grow" /><Badge text="Recommended" icon={false} /></>} />
          <Opt title="Custom" tip="Choose which checks count and their threshold" checked={mode === 'custom'} onSelect={() => setMode('custom')} />
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
// Setup 3: Labeling model (one per project).

function ModelsPage() {
  return (
    <ProjectPage node="setup" page={{label: 'Labeling model', agent: 'front_desk', intent: 'answer', hint: 'Ask about the models.', context: {}}}>
      {({state}) => <Models state={state} />}
    </ProjectPage>
  );
}

function Models({state}: {state: ProjectState}) {
  const go = useGo();
  const {href} = useProject();
  const s = state.setup;
  const eps = state.endpoints;
  // One labeling model per project: the saved one, else the first listed.
  const saved = s?.models[0];
  const [ep, setEp] = useState(saved?.endpoint ?? eps[0]?.id);
  const info = eps.find(e => e.id === ep);
  const [tokens, setTokens] = useState(String(saved?.maxOutputTokens ?? 1024));
  const [temp, setTemp] = useState(String(saved?.temperature ?? 0));
  const next = async () => {
    if (!info) return;
    const models: ModelSettings[] = [{endpoint: info.id, maxOutputTokens: parseInt(tokens) || 1024, temperature: info.supportsTemperature ? parseFloat(temp) || 0 : null}];
    await saveSetup(state.project.id, {models, steps: {schema: !!s?.steps.schema, evaluation: !!s?.steps.evaluation, models: true}});
    if (!state.project.approvedNodes.includes('setup')) await approveNode(state.project.id, 'setup');
    await go(href('/dataset'));
  };
  const head = <PageHead title="Labeling model" back={{label: 'Evaluation settings', href: href('/setup', {step: '2'})}} actions={<Button label="Next: Dataset" kind="primary" disabled={!s?.steps.evaluation || !info} onClick={next} />} />;
  const body = (
    <div style={{display: 'grid', gridTemplateColumns: '400px 1fr', gap: 16, alignItems: 'start'}}>
      <Card title="Model">
        <div className="opts" role="radiogroup" aria-label="Model">
          {eps.map(e => (
            <Opt
              key={e.id}
              title={e.name}
              tip={e.description}
              checked={e.id === ep}
              onSelect={() => setEp(e.id)}
              extra={
                <>
                  <span className="grow" />
                  <Badge text={e.badge} icon={false} />
                </>
              }
            />
          ))}
        </div>
      </Card>
      <Card title="Settings" className="form">
        <div className="row" style={{gap: 16, alignItems: 'flex-end'}}>
          <Field label="Max output tokens">
            <input className="input" value={tokens} onChange={e => setTokens(e.target.value.replace(/\D/g, ''))} />
          </Field>
          {info?.supportsTemperature ? (
            <Field label="Temperature">
              <input className="input" value={temp} onChange={e => setTemp(e.target.value)} />
            </Field>
          ) : (
            <Field label={<Hov text="Temperature" tip="This model does not support temperature" />} off>
              <input className="input" value="Not supported" readOnly disabled />
            </Field>
          )}
        </div>
      </Card>
    </div>
  );
  return <Frame head={head}>{body}</Frame>;
}

// ---------------------------------------------------------------------------------------------
// A finished Setup: one line per part, each with Edit (R2-1).

function SummaryPage() {
  return (
    <ProjectPage node="setup" page={{label: 'Setup', agent: 'front_desk', intent: 'answer', hint: 'Ask about the schema, the pass rule or the model.', context: {}}}>
      {({state}) => <Summary state={state} />}
    </ProjectPage>
  );
}

function Summary({state}: {state: ProjectState}) {
  const go = useGo();
  const {href} = useProject();
  const s = state.setup!;
  const fields = s.schema?.fields ?? [];
  const t = s.thresholds;
  const f2 = (x: number) => x.toFixed(2);
  const rule = !t
    ? 'None: versions are not scored'
    : t.mode === 'default'
      ? `Default: Macro-F1 ${f2(t.macroF1)} per field`
      : [`Custom: Macro-F1 ${f2(t.macroF1)} per field`, t.valueF1 != null && `F1 ${f2(t.valueF1)} per value`, t.precision != null && `precision ${f2(t.precision)}`, t.recall != null && `recall ${f2(t.recall)}`].filter(Boolean).join(', ');
  const m = s.models[0];
  const model = m ? `${state.endpoints.find(e => e.id === m.endpoint)?.name ?? m.endpoint} · max ${m.maxOutputTokens} output tokens` : 'Not chosen';
  const rows = [
    {name: 'Schema', text: `${fields.length} label field${fields.length === 1 ? '' : 's'}: ${fields.map(f => f.name).join(', ')}`, step: '1'},
    {name: 'Evaluation', text: rule, step: '2'},
    {name: 'Labeling model', text: model, step: '3'},
  ];
  const next = async () => {
    if (!state.project.approvedNodes.includes('setup')) await approveNode(state.project.id, 'setup');
    await go(href('/dataset'));
  };
  return (
    <Frame head={<PageHead title="Setup" actions={<Button label="Next: Dataset" kind="primary" onClick={next} />} />}>
      <div style={{width: 800}}>
        <section className="card" aria-label="Setup" style={{padding: '0 24px', gap: 0}}>
          {rows.map((r, i) => (
            <div key={r.name} className="row" style={{height: 64, gap: 12, borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : undefined}}>
              <span className="chk ok">
                <Icon name="check" />
              </span>
              <b style={{width: 160}}>{r.name}</b>
              <span className="grow one t-2" title={r.text}>
                {r.text}
              </span>
              <Button label="Edit" kind="ghost" href={href('/setup', {step: r.step})} />
            </div>
          ))}
        </section>
      </div>
    </Frame>
  );
}
