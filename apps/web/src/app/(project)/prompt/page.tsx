'use client';

import {useRouter} from 'next/navigation';
import {useEffect, useMemo, useState, type ReactNode} from 'react';
import type {Answer, EndpointId, LabelingRun, PageContext, PromptVersion} from '@tsp/contracts';
import {recommend, versionLabel} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {ScoreChart} from '@/components/prompt/ScoreChart';
import {useChecks, Workbench, type Draft} from '@/components/prompt/Workbench';
import {useAgentDrafts} from '@/components/prompt/useAgentDrafts';
import {approveNode, createVersion, predictionsFor, scoreVersion, startOptimiser, stopRun, tick, type ProjectState} from '@/backend-api';
import {Badge, Below, Button, Card, Code, dateTime, Empty, Hov, Metric, num, PageHead, Passed, Progress, Score, Suggestion, Table} from '@/ui';
import {LabelDistribution, labelCounts} from '@/components/LabelDistribution';
import {fieldRows, modelName, reportFor, runsFor, versionScore} from '@/components/prompt/scores';

const VERSIONS_PAGE: PageContext = {label: 'Prompt versions', agent: 'front_desk', intent: 'answer', hint: 'Ask me about any version.', context: {}};

export default function PromptPage() {
  const [page, setPage] = useState<PageContext>(VERSIONS_PAGE);
  return (
    <ProjectPage node="prompt" page={page}>
      {({state}) =>
        !state.snapshot?.split || !state.setup?.schema ? (
          <Frame head={<PageHead title="Prompt versions" />}>
            <Empty title="No dataset yet" text="Split the dataset first, then write the first prompt here." />
          </Frame>
        ) : state.versions.length ? (
          <Versions state={state} setPage={setPage} />
        ) : (
          <FirstPrompt state={state} setPage={setPage} />
        )
      }
    </ProjectPage>
  );
}

const EMPTY: Draft = {template: '', features: {video: [], photo_text: [], metadata: []}, images: []};

/** The first prompt becomes v1 and is scored right away (the click is the user's start). */
function FirstPrompt({state, setPage}: {state: ProjectState; setPage: (p: PageContext) => void}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const types = useMemo(() => [...new Set(state.examples.map(e => e.type))], [state.examples]);
  const check = useChecks(draft, state.setup?.schema, types);
  useEffect(() => {
    setPage({label: 'First prompt', agent: 'prompt_agent', intent: draft.template.trim() ? 'revise_prompt' : 'draft_prompt', hint: 'Paste the prompt you use today, or ask me to draft one from your schema.', context: {schema: state.setup?.schema, task: state.setup?.task, template: draft.template}});
  }, [draft.template]); // eslint-disable-line react-hooks/exhaustive-deps
  useAgentDrafts(state, d => setDraft(cur => ({...cur, template: d.template, features: d.features ?? cur.features})));
  // A failed create shows the page's red banner with Retry (the Button reports it).
  const create = async () => {
    const v = await createVersion(state.project.id, {...draft, parent: null, madeBy: 'user', change: 'First prompt', kind: 'major', schema: state.setup!.schema!, schemaVersion: state.setup!.schemaVersion});
    void scoreVersion(state.project.id, v);
  };
  const dirty = draft.template !== '' || Object.values(draft.features).some(l => l.length);
  const blocked = check.errors.length > 0 || !draft.template.trim();
  return (
    <Frame
      head={
        <PageHead
          title="First prompt"
          actions={
            <>
              <Button label="Discard" kind="ghost" disabled={!dirty} onClick={() => setDraft(EMPTY)} />
              <Button label="Create and score" kind="primary" disabled={blocked} onClick={create} />
            </>
          }
        />
      }
    >
      <Workbench draft={draft} onChange={setDraft} check={check} />
    </Frame>
  );
}

/** Prompt versions: score chart, versions list, the selected version's card and the AI Suggestion. */
function Versions({state, setPage}: {state: ProjectState; setPage: (p: PageContext) => void}) {
  const router = useRouter();
  const {href} = useProject();
  const setup = state.setup!;
  const t = setup.thresholds;
  const live = state.versions.filter(v => v.schemaVersion === setup.schemaVersion);
  const list = live.length ? live : state.versions;
  const [selId, setSel] = useState<string | null>(null);
  const sel = list.find(v => v.id === selId) ?? list[0];
  const running = state.runs.some(r => r.state === 'running') || state.optimisation.some(o => o.state === 'running');

  useEffect(() => {
    void tick(state);
  }, [state]);
  useEffect(() => {
    setPage({...VERSIONS_PAGE, label: `Prompt versions · ${versionLabel(sel)}`, context: {version: versionLabel(sel)}});
  }, [sel.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const scored = list.map(v => ({v, s: versionScore(state, v.id)}));
  const best = scored.filter(x => x.s).sort((a, b) => b.s!.score - a.s!.score)[0];
  const points = [...scored].reverse().flatMap(({v, s}) => (s ? [{label: versionLabel(v), score: s.score, passed: s.passed}] : []));
  const selRunning = runsFor(state, sel.id).some(r => r.state === 'running');
  // A version labeled while the eval set has no gold labels: what can be known without scores.
  const selNoGold = !selRunning && !versionScore(state, sel.id) && labeledRuns(state, sel.id).length > 0;
  const onMake = async (vId: string, ep: EndpointId) => {
    await approveNode(state.project.id, 'prompt');
    router.push(href('/training-set', {v: vId, m: ep}));
  };
  const versions = (
    <Card title="Versions" className={selNoGold ? undefined : 'fill'} style={selNoGold ? undefined : running ? {height: 478} : {gridRow: 'span 2'}}>
      <nav className="vlist" aria-label="Versions">
        {scored.map(({v, s}) => {
          const isRunning = runsFor(state, v.id).some(r => r.state === 'running');
          const lab = labeledRuns(state, v.id)[0];
          return (
            <button key={v.id} type="button" className="vrow" aria-current={v.id === sel.id} onClick={() => setSel(v.id)}>
              <span className="v">{versionLabel(v)}</span>
              <span>{best && best.v.id === v.id && <Badge text="Best" tone="ok" icon={false} />}</span>
              {isRunning ? (
                <Badge text="Running" tone="run" />
              ) : s ? (
                <Score v={s.score} ok={s.passed} />
              ) : lab ? (
                <span className="t-3" style={{fontSize: 13}}>
                  {lab.valid ?? 0} / {lab.total}
                </span>
              ) : (
                <span className="t-3">–</span>
              )}
            </button>
          );
        })}
      </nav>
    </Card>
  );

  if (selNoGold)
    return (
      <Frame head={<PageHead title="Prompt versions" />}>
        {t && points.length > 0 && (
          <Card title="Score by version">
            <ScoreChart points={points} threshold={t.macroF1} selected={versionLabel(sel)} onSelect={l => setSel(list.find(v => versionLabel(v) === l)?.id ?? null)} />
          </Card>
        )}
        <div style={{display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start'}}>
          {versions}
          <NoGoldCard key={sel.id} state={state} v={sel} advice={<Advice state={state} onMake={onMake} />} />
        </div>
      </Frame>
    );

  return (
    <Frame head={<PageHead title="Prompt versions" />}>
      {t && points.length > 0 && (
        <Card title="Score by version">
          <ScoreChart points={points} threshold={t.macroF1} selected={versionLabel(sel)} onSelect={l => setSel(list.find(v => versionLabel(v) === l)?.id ?? null)} />
        </Card>
      )}
      <div style={{display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, alignItems: running ? 'start' : 'stretch'}}>
        {versions}
        {selRunning ? <RunningCard state={state} v={sel} /> : <VersionCard key={sel.id} state={state} v={sel} />}
        {!running && <Advice state={state} onMake={onMake} />}
      </div>
    </Frame>
  );
}

function RunningCard({state, v}: {state: ProjectState; v: PromptVersion}) {
  const runs = runsFor(state, v.id).filter(r => r.state === 'running');
  const done = runs.reduce((n, r) => n + r.done, 0);
  const total = runs.reduce((n, r) => n + r.total, 0);
  return (
    <Card>
      <div style={{display: 'flex', alignItems: 'center', gap: 16, paddingBottom: 8}}>
        <span className="card-t" style={{fontSize: 17, lineHeight: '24px', fontWeight: 700}}>
          Prompt {versionLabel(v)}
        </span>
        <Badge text="Running" tone="run" />
        <span className="t-3" style={{fontSize: 13}}>
          Created {dateTime(v.createdAt)}
        </span>
        <div style={{marginLeft: 'auto'}}>
          <Button label="Stop" icon="stop" onClick={() => Promise.all(runs.map(r => stopRun(r.id)))} />
        </div>
      </div>
      <Progress done={done} total={total} />
      <div style={{paddingTop: 8}} className="t-3">
        Field scores appear when scoring is done.
      </div>
    </Card>
  );
}

/** Finished labeling runs of a version, one per model, in the order of the models. */
function labeledRuns(state: ProjectState, versionId: string): LabelingRun[] {
  const runs = runsFor(state, versionId).filter(r => r.state === 'done');
  return state.setup!.models.flatMap(m => runs.filter(r => r.endpoint === m.endpoint).slice(0, 1));
}

/**
 * The version card when the eval set has no gold labels yet (design: "Prompt versions · labeled,
 * no gold labels yet"): how many examples got a label, how many the safety filter stopped, how
 * many failed, then the AI Suggestion and how the labels spread per field.
 */
function NoGoldCard({state, v, advice}: {state: ProjectState; v: PromptVersion; advice: ReactNode}) {
  const {href} = useProject();
  const setup = state.setup!;
  const runs = labeledRuns(state, v.id);
  const [ep, setEp] = useState<EndpointId>(runs[0].endpoint);
  const run = runs.find(r => r.endpoint === ep) ?? runs[0];
  const [answers, setAnswers] = useState<(Answer | null)[] | null>(null);
  useEffect(() => {
    const settings = setup.models.find(m => m.endpoint === run.endpoint);
    if (!settings) return;
    const evalIds = new Set(state.examples.filter(e => e.split === 'eval').map(e => e.id));
    let live = true;
    void predictionsFor(v.id, run.endpoint, settings).then(m => live && setAnswers([...m.values()].filter(p => evalIds.has(p.exampleId)).map(p => p.answer)));
    return () => void (live = false);
  }, [v.id, run.endpoint]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = run.filtered ?? 0;
  const failed = (run.failed ?? 0) + Math.max(0, (run.invalid ?? 0) - filtered);
  const data = useMemo(() => (answers && setup.schema ? labelCounts(setup.schema, answers) : null), [answers]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col" style={{gap: 16}}>
      <Card>
        <div style={{display: 'flex', alignItems: 'center', gap: 16, paddingBottom: 8}}>
          <span className="card-t" style={{fontSize: 17, lineHeight: '24px', fontWeight: 700}}>
            Prompt {versionLabel(v)}
          </span>
          <span className="t-3" style={{fontSize: 13}}>
            Created {dateTime(v.createdAt)}
          </span>
          <div style={{marginLeft: 'auto', display: 'flex', gap: 8}}>
            <Button label="Edit prompt" kind="ghost" href={href('/prompt/edit', {v: v.id})} />
            <Button label="View prompt" href={href('/prompt/edit', {v: v.id, view: '1'})} />
          </div>
        </div>
        {runs.length > 1 && (
          <div style={{margin: '8px 0 -6px'}}>
            <div className="tabs" role="tablist" aria-label="Models">
              {runs.map(r => (
                <button key={r.endpoint} type="button" role="tab" className="tab" aria-selected={r.endpoint === run.endpoint} onClick={() => setEp(r.endpoint)}>
                  {modelName(state, r.endpoint)}
                </button>
              ))}
              <div className="tabs-end" />
            </div>
          </div>
        )}
        <div style={{display: 'flex', gap: 80, paddingTop: 16}}>
          <Metric label="Labeled" value={num(run.valid ?? 0)} unit={`/ ${num(run.total)}`} />
          <Metric label={<Hov text="Filtered" tip="Stopped by the safety filter, so the model gave no answer" />} value={num(filtered)} />
          <Metric label={<Hov text="Failed" tip="The model errored or its answer did not match the schema" />} value={num(failed)} tone={failed > 0 ? 'err' : undefined} />
        </div>
      </Card>
      {advice}
      {data && <LabelDistribution data={data} />}
    </div>
  );
}

function VersionCard({state, v}: {state: ProjectState; v: PromptVersion}) {
  const {href} = useProject();
  const setup = state.setup!;
  const t = setup.thresholds;
  const models = setup.models;
  const withReport = models.filter(m => reportFor(state, v.id, m.endpoint));
  const bestEp = [...withReport].sort((a, b) => reportFor(state, v.id, b.endpoint)!.metrics.lowestField.macroF1 - reportFor(state, v.id, a.endpoint)!.metrics.lowestField.macroF1)[0]?.endpoint;
  const [ep, setEp] = useState<EndpointId | undefined>(bestEp);
  const cur = ep && reportFor(state, v.id, ep) ? ep : bestEp;
  const rep = cur ? reportFor(state, v.id, cur) : undefined;
  const actions = (
    <div style={{marginLeft: 'auto', display: 'flex', gap: 8, paddingBottom: rep ? 8 : 0}}>
      <Button label="Edit prompt" kind="ghost" href={href('/prompt/edit', {v: v.id})} />
      <Button label="View prompt" href={href('/prompt/edit', {v: v.id, view: '1'})} />
    </div>
  );
  if (!t || !rep) {
    const runs = runsFor(state, v.id);
    const why = !t ? 'Evaluation is off, so versions have no scores.' : runs.some(r => r.state === 'done') ? 'Scores appear when the eval set has gold labels.' : runs.some(r => r.state === 'failed') ? 'Scoring failed.' : runs.length ? 'Scoring stopped.' : 'Not scored yet.';
    const canScore = t && !runs.some(r => r.state === 'done');
    return (
      <Card>
        <div style={{display: 'flex', alignItems: 'center', gap: 16}}>
          <span className="card-t" style={{fontSize: 17, lineHeight: '24px', fontWeight: 700}}>
            Prompt {versionLabel(v)}
          </span>
          <span className="t-3" style={{fontSize: 13}}>
            Created {dateTime(v.createdAt)}
          </span>
          {actions}
        </div>
        <div className="row" style={{gap: 12}}>
          <span className="t-3">{why}</span>
          {canScore && <Button label={runs.length ? 'Resume' : 'Score'} size="sm" icon="play" onClick={() => void scoreVersion(state.project.id, v)} />}
        </div>
      </Card>
    );
  }
  const rows = fieldRows(rep, t);
  return (
    <Card>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: 16, paddingBottom: 16}}>
        <Metric label="Macro-F1" value={rep.metrics.lowestField.macroF1.toFixed(2)} unit={`/ ${+t.macroF1.toFixed(2)}`} tone={rep.passed ? 'ok' : 'err'} size="lg" />
        <div style={{display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 9}}>
          {rep.passed ? <Passed /> : <Below />}
          <span className="t-3" style={{fontSize: 13}}>
            Created {dateTime(v.createdAt)}
          </span>
        </div>
        {actions}
      </div>
      {models.length > 1 && (
        <div style={{margin: '8px 0 -6px'}}>
          <div className="tabs" role="tablist" aria-label="Models">
            {models.map(m => {
              const r = reportFor(state, v.id, m.endpoint);
              return (
                <button key={m.endpoint} type="button" role="tab" className="tab" aria-selected={m.endpoint === cur} disabled={!r} onClick={() => setEp(m.endpoint)} style={{display: 'inline-flex', alignItems: 'center', gap: 8}}>
                  {modelName(state, m.endpoint)}
                  {r && <Badge text={r.metrics.lowestField.macroF1.toFixed(2)} tone={r.passed ? 'ok' : 'err'} icon={false} />}
                </button>
              );
            })}
            <div className="tabs-end" />
          </div>
        </div>
      )}
      <Table
        cols={[{label: 'Field'}, {label: 'F1', kind: 'c'}, {label: 'Precision', kind: 'c'}, {label: 'Recall', kind: 'c'}, {label: 'Result', kind: 'c'}]}
        rows={rows.map(r => ({key: r.field, cells: [<Code key="f">{r.field}</Code>, <Score key="s" v={r.f1} ok={r.passed} />, r.precision.toFixed(2), r.recall.toFixed(2), r.passed ? <Passed key="p" /> : <Below key="b" />]}))}
      />
    </Card>
  );
}

/**
 * The AI Suggestion card. The next step is chosen by code from the reports; the card is hidden
 * while the agent waits for scoring or the optimiser (design: no card while it waits).
 */
function Advice({state, onMake}: {state: ProjectState; onMake: (versionId: string, endpoint: EndpointId) => Promise<void>}) {
  const {href} = useProject();
  const router = useRouter();
  const a = recommend(state, null);
  const name = (id: string | null) => (id ? versionLabel(state.versions.find(v => v.id === id)!) : '');
  const latest = state.versions[0];
  const keep = (ep?: EndpointId | null) => startOptimiser(state.project.id, ep ?? state.setup!.models.find(m => !state.reports.some(r => r.endpoint === m.endpoint && r.passed && !r.archivedNow))?.endpoint ?? state.setup!.models[0].endpoint);
  let title: string;
  let text: string;
  let acts: React.ReactNode;
  if (a.kind === 'make_training_set' && a.versionId && a.endpoint) {
    const latestScore = versionScore(state, latest.id);
    const many = state.setup!.models.length > 1;
    if (latest.id !== a.versionId && latestScore?.passed) {
      title = `${versionLabel(latest)} passes, ${name(a.versionId)} is still the best`;
      text = `${name(a.versionId)} still scores higher (${reportFor(state, a.versionId, a.endpoint)!.metrics.lowestField.macroF1.toFixed(2)}). Use ${name(a.versionId)} for the training and test sets.`;
    } else {
      title = `${name(a.versionId)} passes${many ? ` on ${modelName(state, a.endpoint)}` : ''}`;
      text = 'Use it to make the training and test sets.';
    }
    acts = (
      <>
        <Button label="Keep improving" onClick={() => keep(state.setup!.models.find(m => m.endpoint !== a.endpoint)?.endpoint ?? a.endpoint)} />
        <Button label="Make training and test sets" kind="primary" onClick={() => onMake(a.versionId!, a.endpoint!)} />
      </>
    );
  } else if (a.kind === 'no_eval' && a.versionId && a.endpoint) {
    title = `Make the training and test sets with ${name(a.versionId)}`;
    text = 'Evaluation is off, so versions have no scores.';
    acts = <Button label="Make training and test sets" kind="primary" onClick={() => onMake(a.versionId!, a.endpoint!)} />;
  } else if (a.kind === 'label_gold') {
    title = a.title;
    text = 'Scores need gold labels for the eval set.';
    acts = <Button label="Go to Gold Labels" kind="primary" onClick={() => router.push(href('/gold'))} />;
  } else if (a.kind === 'keep_improving') {
    title = 'No version passes yet';
    text = a.reasons[0] ?? '';
    acts = <Button label="Keep improving" kind="primary" onClick={() => keep(a.endpoint)} />;
  } else return null;
  return (
    <section className="card ai" aria-label="AI Suggestion">
      <Suggestion title={title} text={text} actions={acts} />
    </section>
  );
}
