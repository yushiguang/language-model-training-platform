'use client';

import {useRouter, useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useState} from 'react';
import {DEFAULT_THRESHOLDS} from '@/core/metrics';
import type {AgentProposal, ModelSettings, Schema, Thresholds} from '@/core/types';
import {Composer} from '@/components/Assistant';
import {ProjectPage} from '@/components/Shell';
import {SchemaView} from '@/components/SchemaView';
import {useProject} from '@/components/ProjectContext';
import {getApp, onChange} from '@/services/app';
import {closeProposal, openProposals, sendUserMessage, type PageContext} from '@/services/agents';
import {approveNode, type ProjectState} from '@/services/projects';
import {saveSetup} from '@/services/setup';
import {Badge, Button, Icon, Note, Tick} from '@/ui';
import {NotYet} from '@/components/NotYet';

export default function SetupPage() {
  return (
    <Suspense fallback={null}>
      <SetupRouter />
    </Suspense>
  );
}

function SetupRouter() {
  const step = useSearchParams().get('step') ?? '1';
  if (step === '2') return <ProjectPage node="setup" assistant="docked" page={{label: 'Setup · evaluation', agent: 'front_desk', intent: 'answer', hint: 'Ask what a check means.', context: {}}}>{() => <Evaluation />}</ProjectPage>;
  if (step === '3') return <ProjectPage node="setup" assistant="docked" page={{label: 'Setup · models', agent: 'front_desk', intent: 'answer', hint: 'Ask about the models.', context: {}}}>{() => <Models />}</ProjectPage>;
  return <Labels />;
}

/** Setup 1: the task goes in through the chat; the main area shows only the result. */
function Labels() {
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [started, setStarted] = useState<boolean | null>(null);
  const page: PageContext = {label: 'Setup · task and labels', agent: 'schema_agent', intent: 'revise_schema', hint: 'Tell me what to change in the labels.', context: {}};
  return (
    <ProjectPage node="setup" assistant="docked" page={page} hero={started === false ? <Hero onStarted={p => (setProposal(p), setStarted(true))} /> : undefined}>
      {ctx => <LabelsMain state={ctx.state} proposal={proposal} setProposal={setProposal} setStarted={setStarted} page={page} />}
    </ProjectPage>
  );
}

function useStartState(state: ProjectState | null, setStarted: (b: boolean) => void, setProposal: (p: AgentProposal | null) => void) {
  useEffect(() => {
    if (!state) return;
    const load = () => {
      openProposals(state.project.id, 'schema').then(list => {
        setProposal(list[0] ?? null);
        setStarted(!!state.setup?.task || list.length > 0);
      });
    };
    load();
    return onChange(load);
  }, [state?.project.id, state?.setup?.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

function Hero({onStarted}: {onStarted: (p: AgentProposal) => void}) {
  const {projectId, state} = useProject();
  const [busy, setBusy] = useState(false);
  const send = async (text: string) => {
    setBusy(true);
    await saveSetup(projectId, {task: text});
    await sendUserMessage(projectId, text, {label: 'Setup · task and labels', agent: 'schema_agent', intent: 'propose_schema', context: {task: text, schema: state?.setup?.schema ?? null}}, onStarted);
    setBusy(false);
  };
  return (
    <div className="hero-inner">
      <h1>What do you want your model to do?</h1>
      <Composer hero onSend={send} disabled={busy} placeholder="Describe the task, for example: tag short videos by what the viewer gets from them" />
      {busy ? <span className="typing">The schema agent is drafting your labels…</span> : <span className="small muted">The schema agent drafts the label fields and a policy from your description. You approve them next.</span>}
    </div>
  );
}

function LabelsMain({state, proposal, setProposal, setStarted, page}: {state: ProjectState; proposal: AgentProposal | null; setProposal: (p: AgentProposal | null) => void; setStarted: (b: boolean) => void; page: PageContext}) {
  const router = useRouter();
  const {href} = useProject();
  useStartState(state, setStarted, setProposal);
  const setup = state.setup;
  page.context = {task: setup?.task, schema: setup?.schema ?? (proposal?.payload as Schema) ?? null};
  const approved = setup?.steps.schema && !proposal;

  const approve = async () => {
    if (!proposal) return;
    await saveSetup(state.project.id, {schema: proposal.payload as Schema, steps: {schema: true, evaluation: setup?.steps.evaluation ?? false, models: setup?.steps.models ?? false}});
    // The proposal stays on screen until the saved schema loads, so nothing flashes.
    await closeProposal(proposal, 'approved');
  };
  const discard = async () => {
    if (!proposal) return;
    await closeProposal(proposal, 'discarded');
    setProposal(null);
  };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Setup · step 1 of 3</span>
        <h1>Agree on the labels</h1>
      </div>
      {setup?.task && (
        <section className="card" aria-label="Task">
          <h2>Task</h2>
          <p>{setup.task}</p>
        </section>
      )}
      {proposal ? (
        <section className="card" aria-label="Labels">
          <div className="row">
            <span style={{fontWeight: 600}}>Proposed by the schema agent</span>
            <span className="right row" style={{gap: 8}}>
              <Button label="Discard" size="lg" onClick={discard} />
              <Button label="Approve" variant="primary" size="lg" onClick={approve} />
            </span>
          </div>
          <SchemaView schema={proposal.payload as Schema} before={setup?.schema} />
        </section>
      ) : setup?.schema ? (
        <section className="card" aria-label="Labels">
          <div className="row">
            <span className="row" style={{gap: 8, fontWeight: 600}}>
              <Tick /> Labels approved
            </span>
            <span className="right">{approved && <Button label="Next step: Evaluation" variant="primary" size="lg" icon={<Icon name="arrow" />} onClick={() => router.push(href('/setup', {step: '2'}))} />}</span>
          </div>
          <SchemaView schema={setup.schema} />
          <p className="small muted">To change a field or value, tell the schema agent in the chat. Changing the schema after labeling means labels get a quick re-check.</p>
        </section>
      ) : (
        <section className="card">
          <p className="muted">Waiting for the schema agent…</p>
        </section>
      )}
    </>
  );
}

function SummaryRows({state, upTo}: {state: ProjectState; upTo: 1 | 2}) {
  const {href} = useProject();
  const s = state.setup;
  const t = s?.thresholds;
  return (
    <div className="card tight">
      <div className="done-row">
        <Tick />
        <span style={{fontWeight: 500}}>Task and labels</span>
        <span className="muted">{s?.schema?.fields.length ?? 0} label fields · policy approved</span>
        <span className="right">
          <Button label="Edit" variant="ghost" size="sm" href={href('/setup', {step: '1'})} />
        </span>
      </div>
      {upTo === 2 && (
        <div className="done-row">
          <Tick />
          <span style={{fontWeight: 500}}>Evaluation</span>
          <span className="muted">{!t ? 'No evaluation' : t.mode === 'default' ? 'Default threshold' : 'Custom threshold'}</span>
          <span className="right">
            <Button label="Edit" variant="ghost" size="sm" href={href('/setup', {step: '2'})} />
          </span>
        </div>
      )}
    </div>
  );
}

/** Setup 2: how good the labels must be. */
function Evaluation() {
  const {state, href, refresh} = useProject();
  const router = useRouter();
  const s = state!.setup;
  const [mode, setMode] = useState<'default' | 'custom' | 'none'>(s?.steps.evaluation ? (s.thresholds ? s.thresholds.mode : 'none') : 'default');
  const [t, setT] = useState<Thresholds>(s?.thresholds?.mode === 'custom' ? s.thresholds : {...DEFAULT_THRESHOLDS, mode: 'custom'});
  if (!s?.steps.schema) return <NotYet text="Approve the labels first." to={href('/setup', {step: '1'})} />;
  const D = DEFAULT_THRESHOLDS;

  const save = async () => {
    const thresholds = mode === 'none' ? null : mode === 'default' ? D : {...t, mode: 'custom' as const};
    await saveSetup(state!.project.id, {thresholds, steps: {...s.steps, evaluation: true}});
    await refresh(); // step 3 checks this step, so load it before going there
    router.push(href('/setup', {step: '3'}));
  };
  const numIn = (label: string, value: number | null, on: boolean, set: (v: number) => void, pct = false) => (
    <input className="num" aria-label={label} disabled={!on} value={value == null ? '' : pct ? `${+(value * 100).toFixed(1)}%` : String(value)} onChange={e => set(pct ? parseFloat(e.target.value) / 100 || 0 : parseFloat(e.target.value) || 0)} />
  );
  const opt = <K extends keyof Thresholds>(key: K, fallback: number) => ({on: t[key] != null, toggle: () => setT({...t, [key]: t[key] == null ? fallback : null})});
  const vf = opt('valueF1', 0.6);
  const ir = opt('invalidRate', 0.01);
  const ac = opt('accuracy', 0.85);

  return (
    <>
      <SummaryRows state={state!} upTo={1} />
      <div className="page-head">
        <span className="eyebrow">Setup · step 2 of 3</span>
        <h1>How good must the labels be?</h1>
        <p className="muted">The platform checks every prompt version against this before you can make the training set.</p>
      </div>
      <fieldset style={{border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10}}>
        <legend className="sr-only">Evaluation threshold</legend>
        <label className={`choice${mode === 'default' ? ' selected' : ''}`}>
          <input type="radio" name="eval" checked={mode === 'default'} onChange={() => setMode('default')} />
          <span className="col" style={{gap: 2}}>
            <span className="row" style={{gap: 8, fontWeight: 600}}>
              Use the default threshold <Badge label="Recommended" />
            </span>
            <span className="muted">
              Macro-F1 per field ≥ {D.macroF1.toFixed(2)} · F1 per value ≥ {D.valueF1!.toFixed(2)} · invalid outputs ≤ 1% · eval examples ≥ {D.minEval}
            </span>
          </span>
        </label>
        <div className={`choice${mode === 'custom' ? ' selected' : ''}`} style={{flexDirection: 'column', gap: 14, cursor: 'default'}}>
          <label className="row" style={{gap: 12, alignItems: 'flex-start', cursor: 'pointer'}}>
            <input type="radio" name="eval" checked={mode === 'custom'} onChange={() => setMode('custom')} />
            <span className="col" style={{gap: 2}}>
              <span style={{fontWeight: 600}}>Set my own</span>
              <span className="muted">Pick the checks that matter and their numbers.</span>
            </span>
          </label>
          {mode === 'custom' && (
            <div style={{marginLeft: 28, borderTop: '1px solid var(--line)'}}>
              <div className="check-row">
                <input type="checkbox" checked disabled aria-label="Macro-F1 per field, always on" />
                <span className="grow col" style={{gap: 0}}>
                  <span className="row" style={{gap: 6, fontWeight: 500}}>
                    Macro-F1 per field <Badge label="Main score" />
                  </span>
                  <span className="small muted">Always on. Average quality across values, so rare values count as much as common ones</span>
                </span>
                <span className="sign">≥</span>
                {numIn('Macro-F1 per field minimum', t.macroF1, true, v => setT({...t, macroF1: v}))}
              </div>
              {(
                [
                  ['F1 per value', 'Stops a rare value from being ignored while the average looks fine', vf, 'valueF1', '≥', false],
                  ['Invalid output rate', "Answers that aren't valid JSON or use values outside the schema", ir, 'invalidRate', '≤', true],
                  ['Accuracy, single-select fields', 'Share of examples where the label is exactly right', ac, 'accuracy', '≥', false],
                ] as const
              ).map(([label, help, o, key, sign, pct]) => (
                <div className="check-row" key={key}>
                  <input type="checkbox" checked={o.on} onChange={o.toggle} aria-label={label} />
                  <span className="grow col" style={{gap: 0}}>
                    <span style={{fontWeight: 500}}>{label}</span>
                    <span className="small muted">{help}</span>
                  </span>
                  <span className="sign">{sign}</span>
                  {numIn(`${label} limit`, t[key], o.on, v => setT({...t, [key]: v}), pct)}
                </div>
              ))}
              <div className="check-row">
                <input type="checkbox" checked disabled aria-label="Eval examples, always on" />
                <span className="grow col" style={{gap: 0}}>
                  <span style={{fontWeight: 500}}>Eval examples</span>
                  <span className="small muted">Always on. More examples make scores steadier</span>
                </span>
                <span className="sign">≥</span>
                {numIn('Eval examples minimum', t.minEval, true, v => setT({...t, minEval: Math.round(v)}))}
              </div>
            </div>
          )}
        </div>
        <label className={`choice${mode === 'none' ? ' selected' : ''}`}>
          <input type="radio" name="eval" checked={mode === 'none'} onChange={() => setMode('none')} />
          <span className="col" style={{gap: 2}}>
            <span style={{fontWeight: 600}}>No evaluation</span>
            <span className="muted">Faster, but the training set is marked Not evaluated and the optimiser can&apos;t run.</span>
          </span>
        </label>
      </fieldset>
      {mode !== 'none' && <Note>You&apos;ll need correct answers (gold labels) for the eval examples. You can label them on the platform or upload them later.</Note>}
      <div className="next">
        <Button label="Continue: Models" variant="primary" size="lg" onClick={save} />
      </div>
    </>
  );
}

/** Setup 3: which models label the examples. */
function Models() {
  const {state, href} = useProject();
  const router = useRouter();
  const s = state!.setup;
  const eps = getApp().platform.models.endpoints();
  const [models, setModels] = useState<ModelSettings[]>(s?.models.length ? s.models : eps.map(e => ({endpoint: e.id, maxOutputTokens: 1024, temperature: e.supportsTemperature ? 0 : null})));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!s?.steps.evaluation) return <NotYet text="Choose how good the labels must be first." to={href('/setup', {step: s?.steps.schema ? '2' : '1'})} />;
  const toggle = (id: 'A' | 'B') => {
    const ep = eps.find(e => e.id === id)!;
    setModels(models.some(m => m.endpoint === id) ? models.filter(m => m.endpoint !== id) : [...models, {endpoint: id, maxOutputTokens: 1024, temperature: ep.supportsTemperature ? 0 : null}].sort((a, b) => a.endpoint.localeCompare(b.endpoint)));
  };
  const patch = (id: string, p: Partial<ModelSettings>) => setModels(models.map(m => (m.endpoint === id ? {...m, ...p} : m)));
  const next = async () => {
    setBusy(true);
    setErr(null);
    try {
      await saveSetup(state!.project.id, {models, steps: {...s.steps, models: true}});
      await approveNode(state!.project.id, 'setup');
      router.push(href('/dataset'));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <SummaryRows state={state!} upTo={2} />
      <div className="page-head">
        <span className="eyebrow">Setup · step 3 of 3</span>
        <h1>Select models for labeling</h1>
        <p className="muted">These large models label your examples. Pick one, or both to compare them.</p>
      </div>
      <fieldset style={{border: 0, margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12}}>
        <legend className="sr-only">Labeling models</legend>
        {eps.map(ep => {
          const m = models.find(x => x.endpoint === ep.id);
          return (
            <div key={ep.id} className={`card${m ? ' selected' : ''}`}>
              <label className="row" style={{gap: 10, cursor: 'pointer'}}>
                <input type="checkbox" checked={!!m} onChange={() => toggle(ep.id)} />
                <span style={{fontWeight: 700, fontSize: 17, lineHeight: '24px'}}>Model {ep.id}</span>
                <span className="right">
                  <Badge label={ep.badge} />
                </span>
              </label>
              <span className="muted">{ep.name}</span>
              <div className="stats" style={{gridTemplateColumns: '1fr 1fr'}}>
                <span className="stat">
                  <span className="small muted">Cost</span>
                  <span style={{fontWeight: 600}}>{ep.cost}</span>
                </span>
                <span className="stat">
                  <span className="small muted">Speed</span>
                  <span style={{fontWeight: 600}}>{ep.speed}</span>
                </span>
              </div>
              <div className="col" style={{borderTop: '1px solid var(--line)', paddingTop: 12}}>
                <span className="small" style={{fontWeight: 600}}>
                  Settings
                </span>
                <label className="row" style={{gap: 8}}>
                  <span className="grow col" style={{gap: 0}}>
                    <span>Max output tokens</span>
                    <span className="small muted">Longest answer the model may write</span>
                  </span>
                  <input className="num" type="number" disabled={!m} value={m?.maxOutputTokens ?? 1024} onChange={e => patch(ep.id, {maxOutputTokens: parseInt(e.target.value) || 1})} />
                </label>
                <label className="row" style={{gap: 8}}>
                  <span className="grow col" style={{gap: 0}}>
                    <span>Temperature</span>
                    <span className="small muted">{ep.supportsTemperature ? 'Lower = more consistent labels' : 'Not supported by this model'}</span>
                  </span>
                  {ep.supportsTemperature ? (
                    <input className="num" type="number" step="0.1" min="0" max="2" disabled={!m} value={m?.temperature ?? 0} onChange={e => patch(ep.id, {temperature: parseFloat(e.target.value) || 0})} />
                  ) : (
                    <input className="num" value="–" disabled title="This model does not support temperature" readOnly />
                  )}
                </label>
              </div>
            </div>
          );
        })}
      </fieldset>
      {models.length > 1 && <Note>Every prompt runs on both so you can compare. Optimisation also runs for each, so it costs about twice as much. You pick one model before making the training set.</Note>}
      <div className="next">
        <Button label="Next step: Dataset" variant="primary" size="lg" icon={<Icon name="arrow" />} onClick={next} disabled={!models.length} loading={busy} />
        <span className="blocked">{models.length ? 'You can edit any step later.' : 'Pick at least one model.'}</span>
      </div>
      {err && <Note tone="error">{err}</Note>}
    </>
  );
}
