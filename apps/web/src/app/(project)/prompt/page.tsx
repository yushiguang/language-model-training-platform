'use client';

import {useGo} from '@/components/nav';
import {useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import type {Answer, EndpointId, LabelingRun, OptimisationRun, OptimiserRound, PageContext, PromptVersion} from '@tsp/contracts';
import {DEFAULT_MAX_ROUNDS, dryRunSize, optimiserVersions, recommend, stepLine, versionLabel} from '@tsp/domain';
import {Frame, ProjectPage, useOpenAskAi} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {ScoreChart} from '@/components/prompt/ScoreChart';
import {useChecks, Workbench, type Draft} from '@/components/prompt/Workbench';
import {useAgentDrafts} from '@/components/prompt/useAgentDrafts';
import {approveNode, createVersion, improveWithAi, predictionsFor, retryOptimiser, scoreVersion, startOptimiser, stopOptimiser, stopRun, tick, type ProjectState} from '@/backend-api';
import {Badge, Banner, Below, Button, Card, Code, dateTime, Dialog, Empty, Hov, Icon, Metric, num, One, PageHead, Passed, Progress, reportActionError, Score, Seg, Suggestion, Table, timeOfDay} from '@/ui';
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
    setPage({
      label: 'First prompt',
      agent: 'prompt_agent',
      intent: draft.template.trim() ? 'revise_prompt' : 'draft_prompt',
      hint: 'Paste the prompt you use today, or ask me to draft one from your schema.',
      context: {schema: state.setup?.schema, task: state.setup?.task, template: draft.template, features: draft.features, images: draft.images},
    });
  }, [draft.template, draft.features, draft.images]); // eslint-disable-line react-hooks/exhaustive-deps
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

/** The run the progress panel shows: the newest, while it runs, failed or is paused. */
const panelRun = (s: ProjectState): OptimisationRun | null => {
  const o = s.optimisation[0];
  return o && (o.state === 'running' || o.state === 'failed' || o.state === 'paused') ? o : null;
};

type View = 'all' | 'major';

/**
 * Prompt versions: score chart, versions list (All, or Major: one row per major version), and on
 * the right the Optimiser's progress panel while a run is going (or failed, or paused), else the
 * selected version's card and the AI Suggestion.
 */
function Versions({state, setPage}: {state: ProjectState; setPage: (p: PageContext) => void}) {
  const go = useGo();
  const {href} = useProject();
  const setup = state.setup!;
  const t = setup.thresholds;
  const info = useMemo(() => optimiserVersions(state.optimisation), [state.optimisation]);
  // A change whose round failed waits for Retry and is not listed (the panel shows it).
  const live = state.versions.filter(v => v.schemaVersion === setup.schemaVersion && info.get(v.id)?.round.outcome !== 'failed');
  const list = live.length ? live : state.versions;
  const [view, setView] = useState<View>('all');
  // null: the panel while a run is going, else the newest version.
  const [selId, setSel] = useState<string | null>(null);
  const run = panelRun(state);
  const showPanel = !!run && (selId === null || selId === run.stepVersionId);
  const sel = list.find(v => v.id === selId) ?? (run?.stepVersionId ? list.find(v => v.id === run.stepVersionId) : undefined) ?? list[0];
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
  const selInfo = info.get(sel.id);
  const selDropped = selInfo?.round.outcome === 'dropped';
  const selRunning = runsFor(state, sel.id).some(r => r.state === 'running' && r.purpose !== 'optimiser');
  // A version labeled while the eval set has no gold labels: what can be known without scores.
  const selNoGold = !showPanel && !selDropped && !selRunning && !versionScore(state, sel.id) && labeledRuns(state, sel.id).length > 0;
  const onMake = async (vId: string, ep: EndpointId) => {
    await approveNode(state.project.id, 'prompt');
    await go(href('/training-set', {v: vId, m: ep}));
  };
  const pick = (id: string) => setSel(run && id === run.stepVersionId ? null : id);

  const rowRight = (v: PromptVersion, s: {score: number; passed: boolean} | null) => {
    const o = info.get(v.id)?.round;
    const lab = labeledRuns(state, v.id)[0];
    if (o?.outcome === 'running' || runsFor(state, v.id).some(r => r.state === 'running' && r.purpose !== 'optimiser')) return <Badge text="Running" tone="run" />;
    if (o?.outcome === 'dropped') return <Badge text="Dropped" icon={false} />;
    if (o?.outcome === 'stopped') return <Badge text="Stopped" icon={false} />;
    if (s) return <Score v={s.score} ok={s.passed} />;
    if (lab)
      return (
        <span className="t-3" style={{fontSize: 13}}>
          {lab.valid ?? 0} / {lab.total}
        </span>
      );
    return <span className="t-3">–</span>;
  };
  const optTag = <Badge text="Optimiser" icon={false} />;
  const rows =
    view === 'all'
      ? scored.map(({v, s}) => (
          <button key={v.id} type="button" className="vrow" aria-current={showPanel ? v.id === run?.stepVersionId : v.id === sel.id} onClick={() => pick(v.id)}>
            <span className="v">{versionLabel(v)}</span>
            <span style={{display: 'inline-flex', gap: 6, alignItems: 'center'}}>
              {v.madeBy === 'optimiser' && optTag}
              {best && best.v.id === v.id && best.s!.passed && <Badge text="Best" tone="ok" icon={false} />}
            </span>
            {rowRight(v, s)}
          </button>
        ))
      : majors(scored, info).map(g => (
          <button key={g.major} type="button" className="vrow" aria-current={g.versions.some(v => v.id === sel.id)} onClick={() => pick(g.pick.id)}>
            <span className="v">v{g.major}</span>
            <span style={{display: 'inline-flex', gap: 6, alignItems: 'center'}}>{g.optimiser && optTag}</span>
            {g.best ? <Score v={g.best.score} ok={g.best.passed} /> : rowRight(g.pick, null)}
          </button>
        ));
  const hasOptimiser = state.versions.some(v => v.madeBy === 'optimiser');
  const versions = (
    <Card
      title="Versions"
      actions={
        hasOptimiser ? (
          <Seg
            label="View"
            value={view}
            onChange={setView}
            options={[
              {value: 'all', label: 'All'},
              {value: 'major', label: 'Major'},
            ]}
          />
        ) : undefined
      }
      className="fill"
      style={{height: PV_H}}
    >
      <nav className="vlist" aria-label="Versions">
        {rows}
      </nav>
    </Card>
  );
  // The chart card keeps its place in every state; before any score it says when scores come.
  const hasGold = state.examples.some(e => e.split === 'eval' && state.gold.has(e.id));
  const chart = (
    <Card title="Score by version">
      {t && points.length > 0 ? (
        <ScoreChart points={points} threshold={t.macroF1} selected={showPanel ? undefined : versionLabel(sel)} onSelect={l => setSel(list.find(v => versionLabel(v) === l)?.id ?? null)} />
      ) : (
        <div className="pv-empty">
          <span className="t-3">{!t ? 'Evaluation is off, so versions have no scores' : hasGold ? 'Scores show here once a version is scored' : 'Scores show here once the eval set has gold labels'}</span>
        </div>
      )}
    </Card>
  );

  const advice = !running && !showPanel && !selDropped ? <Advice state={state} onMake={onMake} selId={sel.id} /> : null;
  return (
    <Frame head={<PageHead title="Prompt versions" />}>
      {chart}
      <div style={{display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start'}}>
        {versions}
        <RightColumn advice={advice}>
          {box =>
            showPanel ? (
              <OptimiserPanel state={state} run={run!} box={box} />
            ) : selDropped ? (
              <DroppedCard state={state} v={sel} round={selInfo!.round} box={box} />
            ) : selRunning ? (
              <RunningCard state={state} v={sel} box={box} />
            ) : selNoGold ? (
              <NoGoldCard key={sel.id} state={state} v={sel} box={box} />
            ) : (
              <VersionCard key={sel.id} state={state} v={sel} box={box} />
            )
          }
        </RightColumn>
      </div>
    </Frame>
  );
}

/** The list and the right column are always this high (design: "Prompt versions: one layout"). */
const PV_H = 478;

/** How the right column sizes its detail card. */
type Box = {className: string; style: CSSProperties};

/**
 * The right column: the detail card fills what the AI Suggestion leaves and scrolls inside; only
 * its height changes (200 ms) when the Suggestion comes or goes.
 */
function RightColumn({advice, children}: {advice: ReactNode; children: (box: Box) => ReactNode}) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  const has = advice != null;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return setH(0);
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    setH(el.offsetHeight);
    return () => ro.disconnect();
  }, [has]);
  const box: Box = {className: 'fill-scroll', style: {flex: 'none', height: PV_H - (h ? h + 16 : 0), transition: 'height 200ms ease'}};
  return (
    <div className="pv-right" style={{height: PV_H}}>
      {children(box)}
      {has && (
        <div ref={ref} style={{marginTop: h ? 16 : 0, flex: 'none'}}>
          {advice}
        </div>
      )}
    </div>
  );
}

/** Major view: one row per major version, with its best score; a click opens its best version. */
function majors(scored: {v: PromptVersion; s: {score: number; passed: boolean} | null}[], info: ReturnType<typeof optimiserVersions>) {
  const groups = new Map<number, {v: PromptVersion; s: {score: number; passed: boolean} | null}[]>();
  for (const x of scored) groups.set(x.v.major, [...(groups.get(x.v.major) ?? []), x]);
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([major, xs]) => {
      const kept = xs.filter(x => x.s && info.get(x.v.id)?.round.outcome !== 'dropped');
      const top = [...kept].sort((a, b) => b.s!.score - a.s!.score)[0];
      return {major, versions: xs.map(x => x.v), optimiser: xs.some(x => x.v.madeBy === 'optimiser'), best: top?.s ?? null, pick: top?.v ?? xs[0].v};
    });
}

const ROUND_RESULT: Record<OptimiserRound['outcome'], {text: string; tone?: 'run' | 'err'} | null> = {
  running: {text: 'Running', tone: 'run'},
  kept: null,
  dropped: {text: 'Dropped after dry run'},
  checks: {text: 'Failed the Checks'},
  repeat: {text: 'Same as an earlier version'},
  failed: {text: 'Failed', tone: 'err'},
  stopped: {text: 'Stopped'},
};

/** The Optimiser's progress panel: round, where it started, what it does now, every round so far. */
function OptimiserPanel({state, run, box}: {state: ProjectState; run: OptimisationRun; box: Box}) {
  const label = (id: string | null) => {
    const v = id ? state.versions.find(x => x.id === id) : undefined;
    return v ? versionLabel(v) : null;
  };
  const tag = run.state === 'running' ? <Badge text="Running" tone="run" /> : run.state === 'failed' ? <Badge text="Failed" tone="err" /> : <Badge text="Paused" icon={false} />;
  const act = run.state === 'running' ? <Button label="Stop" icon="stop" onClick={() => stopOptimiser(run.id)} /> : <Button label={run.state === 'failed' ? 'Retry' : 'Resume'} kind="primary" onClick={() => void retryOptimiser(run.id)} />;
  const half = state.examples.filter(e => e.split === 'eval' && e.optimiserHalf && state.gold.has(e.id)).length;
  const task = run.stepVersionId ? state.runs.find(r => r.promptVersionId === run.stepVersionId && r.endpoint === run.endpoint && r.state === 'running') : undefined;
  const now =
    run.state === 'running' ? (
      <div className="col" style={{gap: 8, padding: '16px 0 8px'}}>
        <div className="row" style={{gap: 8}}>
          <div className="live grow">
            <Icon name="ring" />
            <span>{stepLine(run.step, label(run.stepVersionId), dryRunSize(half))}</span>
          </div>
          {run.stepStartedAt && (
            <span className="t-3" style={{fontSize: 13}}>
              since {timeOfDay(run.stepStartedAt)}
            </span>
          )}
        </div>
        {task && <Progress done={task.done} total={task.total} />}
      </div>
    ) : run.state === 'failed' && run.error ? (
      <div style={{padding: '16px 0 8px'}}>
        <Banner text={run.error} tone="err" oneLine style={{margin: 0}} />
      </div>
    ) : null;
  const rows = [...run.history].reverse().map(r => {
    const res = ROUND_RESULT[r.outcome];
    return {
      key: String(r.round),
      cells: [
        <span key="n" className="t-3">
          {r.round}
        </span>,
        label(r.versionId) ? (
          <b key="v">{label(r.versionId)}</b>
        ) : (
          <span key="v" className="t-3">
            None
          </span>
        ),
        <One key="c" text={r.change || 'Writing a change'} />,
        res ? (
          <Badge key="r" text={res.text} tone={res.tone ?? 'gray'} icon={res.tone === 'run' || res.tone === 'err'} />
        ) : r.score != null ? (
          <Score key="r" v={r.score} ok={r.passed} />
        ) : (
          <span key="r" className="t-3">
            –
          </span>
        ),
      ],
    };
  });
  // Best so far: the highest score among the start version and the changes this run kept.
  const tried = [{id: run.startVersionId, s: versionScore(state, run.startVersionId)?.score}, ...run.history.filter(h => h.outcome === 'kept' && h.score != null).map(h => ({id: h.versionId, s: h.score!}))];
  const top = tried.filter(x => x.s != null).sort((a, b) => b.s! - a.s!)[0];
  return (
    <Card title="Optimiser" titleExtra={tag} actions={act} className={box.className} style={box.style}>
      <div className="row" style={{gap: 40, alignItems: 'flex-end'}}>
        <Metric label="Round" value={String(run.round)} unit={`/ ${run.maxRounds}`} />
        <Metric label="Started from" value={label(run.startVersionId) ?? '–'} />
        <Metric label="Best so far" value={top ? top.s!.toFixed(2) : '–'} unit={top ? (label(top.id) ?? undefined) : undefined} />
        <span className="t-3" style={{fontSize: 13, paddingBottom: 4}}>
          Started {dateTime(run.startedAt)}
        </span>
      </div>
      {now}
      {rows.length > 0 && <Table cols={[{label: 'Round'}, {label: 'Version'}, {label: 'Change'}, {label: 'Result', kind: 'c'}]} rows={rows} widths={[72, 88, 'auto', 200]} />}
    </Card>
  );
}

/** A change the dry run dropped: how many dry-run examples it and its parent got fully right. */
function DroppedCard({state, v, round, box}: {state: ProjectState; v: PromptVersion; round: OptimiserRound; box: Box}) {
  const {href} = useProject();
  const dry = round.dryRun!;
  const parent = state.versions.find(x => x.id === dry.parentId);
  const me = versionLabel(v);
  const them = parent ? versionLabel(parent) : 'Parent';
  const tip = (who: string) => `In the dry run, how many of the ${dry.examples} examples ${who} labeled fully right`;
  return (
    <Card className={box.className} style={box.style}>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: 16, paddingBottom: 16}}>
        <div style={{display: 'flex', gap: 48}}>
          <Metric label={<Hov text={`${me} passed`} tip={tip(me)} />} value={String(dry.passed)} unit={`/ ${dry.examples}`} tone="err" size="lg" />
          <Metric label={<Hov text={`${them} passed`} tip={tip(them)} />} value={String(dry.parentPassed)} unit={`/ ${dry.examples}`} size="lg" />
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 9}}>
          <Badge text="Dropped after dry run" icon={false} />
          <span className="t-3" style={{fontSize: 13}}>
            Created {dateTime(v.createdAt)}
          </span>
        </div>
        <div style={{marginLeft: 'auto', display: 'flex', gap: 8, paddingBottom: 8}}>
          <Button label="Edit prompt" kind="ghost" href={href('/prompt/edit', {v: v.id})} />
          <Button label="View prompt" href={href('/prompt/edit', {v: v.id, view: '1'})} />
        </div>
      </div>
      <Table
        cols={[{label: 'Field'}, {label: `${me} passed`, kind: 'c'}, {label: `${them} passed`, kind: 'c'}]}
        first={40}
        rows={dry.fields.map(f => ({key: f.field, cells: [<Code key="f">{f.field}</Code>, `${f.passed} / ${dry.examples}`, `${f.parentPassed} / ${dry.examples}`]}))}
      />
    </Card>
  );
}

function RunningCard({state, v, box}: {state: ProjectState; v: PromptVersion; box: Box}) {
  const runs = runsFor(state, v.id).filter(r => r.state === 'running');
  const done = runs.reduce((n, r) => n + r.done, 0);
  const total = runs.reduce((n, r) => n + r.total, 0);
  return (
    <Card className={box.className} style={box.style}>
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
function NoGoldCard({state, v, box}: {state: ProjectState; v: PromptVersion; box: Box}) {
  const {href} = useProject();
  const setup = state.setup!;
  const run = labeledRuns(state, v.id)[0];
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
    <Card className={box.className} style={box.style}>
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
      <div style={{display: 'flex', gap: 80, paddingTop: 16}}>
        <Metric label="Labeled" value={num(run.valid ?? 0)} unit={`/ ${num(run.total)}`} />
        <Metric label={<Hov text="Filtered" tip="Stopped by the safety filter, so the model gave no answer" />} value={num(filtered)} />
        <Metric label={<Hov text="Failed" tip="The model errored or its answer did not match the schema" />} value={num(failed)} tone={failed > 0 ? 'err' : undefined} />
      </div>
      {data && (
        <>
          <h3 className="card-t" style={{paddingTop: 8}}>
            Label distribution
          </h3>
          <LabelDistribution data={data} bare />
        </>
      )}
    </Card>
  );
}

function VersionCard({state, v, box}: {state: ProjectState; v: PromptVersion; box: Box}) {
  const {href} = useProject();
  const setup = state.setup!;
  const t = setup.thresholds;
  // One labeling model per project.
  const ep = setup.models[0]?.endpoint;
  const rep = ep ? reportFor(state, v.id, ep) : undefined;
  const actions = (
    <div style={{marginLeft: 'auto', display: 'flex', gap: 8, paddingBottom: rep ? 8 : 0}}>
      <Button label="Edit prompt" kind="ghost" href={href('/prompt/edit', {v: v.id})} />
      <Button label="View prompt" href={href('/prompt/edit', {v: v.id, view: '1'})} />
    </div>
  );
  if (!t || !rep) {
    const runs = runsFor(state, v.id);
    const last = runs[0];
    const stopped = !!t && !runs.some(r => r.state === 'done') && !runs.some(r => r.state === 'failed') && !!last;
    const why = !t
      ? 'Evaluation is off, so versions have no scores.'
      : runs.some(r => r.state === 'done')
        ? 'Scores appear when the eval set has gold labels.'
        : runs.some(r => r.state === 'failed')
          ? 'Scoring failed.'
          : last
            ? `Scoring stopped at ${num(last.done)} of ${num(last.total)}.`
            : 'Not scored yet.';
    const canScore = t && !runs.some(r => r.state === 'done');
    return (
      <Card className={box.className} style={box.style}>
        <div style={{display: 'flex', alignItems: 'center', gap: 16}}>
          <span className="card-t" style={{fontSize: 17, lineHeight: '24px', fontWeight: 700}}>
            Prompt {versionLabel(v)}
          </span>
          {stopped && <Badge text="Stopped" icon={false} />}
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
    <Card className={box.className} style={box.style}>
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
      <Table
        cols={[{label: 'Field'}, {label: 'F1', kind: 'c'}, {label: 'Precision', kind: 'c'}, {label: 'Recall', kind: 'c'}, {label: 'Result', kind: 'c'}]}
        rows={rows.map(r => ({key: r.field, cells: [<Code key="f">{r.field}</Code>, <Score key="s" v={r.f1} ok={r.passed} />, r.precision.toFixed(2), r.recall.toFixed(2), r.passed ? <Passed key="p" /> : <Below key="b" />]}))}
      />
    </Card>
  );
}

/**
 * The AI Suggestion card. The next step is chosen by code from the reports; the card is hidden
 * while scoring or the Optimiser runs (design: no card while it waits). Below the bar it offers
 * Improve with AI (a draft in the editor) or Auto Optimise for up to N rounds.
 */
function Advice({state, onMake, selId}: {state: ProjectState; onMake: (versionId: string, endpoint: EndpointId) => Promise<void>; selId: string}) {
  const {href} = useProject();
  const go = useGo();
  const [rounds, setRounds] = useState(String(DEFAULT_MAX_ROUNDS));
  const a = recommend(state, null);
  const name = (id: string | null) => (id ? versionLabel(state.versions.find(v => v.id === id)!) : '');
  const latest = state.versions[0];
  const openAskAi = useOpenAskAi();
  const improve = (versionId: string) => {
    openAskAi();
    improveWithAi(state.project.id, versionId).catch(e => reportActionError(`Improve with AI failed: ${(e as Error).message}`, () => improve(versionId)));
    return go(href('/prompt/edit', {v: versionId}));
  };
  // Auto Optimise starts from the version selected in the list (R3-7). When a better minor of the
  // same major exists, a dialog asks which one (design: U-F-Optimise-Confirm).
  const [ask, setAsk] = useState<{sel: PromptVersion; selScore: number | null; best: PromptVersion; bestScore: number; n: number} | null>(null);
  const start = (versionId: string, n: number) => {
    setAsk(null);
    startOptimiser(state.project.id, n, versionId).catch(e => reportActionError(`The Optimiser could not start: ${(e as Error).message}`, () => start(versionId, n)));
  };
  const auto = () => {
    const n = Math.max(1, Math.min(50, Math.round(Number(rounds)) || DEFAULT_MAX_ROUNDS));
    const sel = state.versions.find(v => v.id === selId) ?? latest;
    const selScore = versionScore(state, sel.id)?.score ?? null;
    const best = state.versions
      .filter(v => v.major === sel.major && v.schemaVersion === sel.schemaVersion)
      .map(v => ({v, s: versionScore(state, v.id)?.score}))
      .filter(x => x.s != null)
      .sort((a, b) => b.s! - a.s!)[0];
    if (best && best.v.id !== sel.id && (selScore == null || best.s! > selScore)) setAsk({sel, selScore, best: best.v, bestScore: best.s!, n});
    else start(sel.id, n);
  };
  // The newest run that passed and started the training and test sets.
  const done = state.optimisation[0];
  const passedBy = done?.state === 'done' && done.stopReason === 'passes' && done.trainingSetId ? done.history.filter(h => h.passed).at(-1)?.versionId : null;
  let title: string;
  let text: string;
  let acts: React.ReactNode;
  if (a.kind === 'make_training_set' && passedBy && a.versionId === passedBy) {
    title = `${name(passedBy)} passes, training and test sets started`;
    text = `The Optimiser stopped after round ${done!.round} of ${done!.maxRounds}. Labeling started with ${name(passedBy)}.`;
    acts = <Button label="Go to Training Set" kind="primary" onClick={() => go(href('/training-set'))} />;
  } else if (a.kind === 'make_training_set' && a.versionId && a.endpoint) {
    const latestScore = versionScore(state, latest.id);
    if (latest.id !== a.versionId && latestScore?.passed) {
      title = `${versionLabel(latest)} passes, ${name(a.versionId)} is still the best`;
      text = `${name(a.versionId)} still scores higher (${reportFor(state, a.versionId, a.endpoint)!.metrics.lowestField.macroF1.toFixed(2)}). Use ${name(a.versionId)} for the training and test sets.`;
    } else {
      title = `${name(a.versionId)} passes`;
      text = 'Use it to make the training and test sets.';
    }
    acts = (
      <>
        <Button label="Improve with AI" onClick={() => improve(a.versionId!)} />
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
    acts = <Button label="Go to Gold Labels" kind="primary" onClick={() => go(href('/gold'))} />;
  } else if (a.kind === 'keep_improving' && a.versionId) {
    title = a.title;
    text = a.reasons[0] ?? '';
    const or = <span style={{fontSize: 13, color: 'var(--text-2)'}}>or</span>;
    acts = (
      <div className="row" style={{gap: 8}}>
        <Button label="Improve with AI" onClick={() => improve(a.versionId!)} />
        {or}
        <Button label="Auto Optimise" kind="primary" onClick={auto} />
        <input className="input sm" style={{width: 56, textAlign: 'center'}} value={rounds} inputMode="numeric" aria-label="Max rounds" onChange={e => setRounds(e.target.value.replace(/\D/g, '').slice(0, 2))} />
        <span style={{fontSize: 13, color: 'var(--text-2)'}}>
          <Hov text="rounds" tip="Most rounds to try. Each round tries one change to the prompt" />
        </span>
      </div>
    );
  } else return null;
  return (
    <section className="card ai" aria-label="AI Suggestion">
      <Suggestion title={title} text={text} actions={acts} />
      {ask && (
        <Dialog
          title={`Start from ${versionLabel(ask.sel)}`}
          text={`${versionLabel(ask.best)} is the best version in v${ask.sel.major}, at ${ask.bestScore.toFixed(2)} ${ask.selScore == null ? `while ${versionLabel(ask.sel)} has no score yet` : `against ${ask.selScore.toFixed(2)} for ${versionLabel(ask.sel)}`}`}
          onClose={() => setAsk(null)}
          actions={
            <>
              <Button label={`Start from ${versionLabel(ask.sel)}`} onClick={() => start(ask.sel.id, ask.n)} />
              <Button label={`Start from ${versionLabel(ask.best)}`} kind="primary" onClick={() => start(ask.best.id, ask.n)} />
            </>
          }
        />
      )}
    </section>
  );
}
