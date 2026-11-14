'use client';

import {useGo} from '@/components/nav';
import {useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react';
import type {Answer, LabelingRun, MismatchList, OptimisationRun, OptimiserRound, PageContext, PromptVersion} from '@tsp/contracts';
import {aiSuggestion, canScore, compilePrompt, dryRunSize, optimiserVersions, stepLine, versionLabel, systemConfig, type SuggestionAction} from '@tsp/domain';
import {Frame, ProjectPage, useOpenAskAi} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {ScoreChart} from '@/components/prompt/ScoreChart';
import {useSettings} from '@/components/ProjectSettings';
import {approveNode, improveWithAi, mismatches, predictionsFor, retryOptimiser, scoreVersion, startOptimiser, stopOptimiser, rebuildReports, stopRun, track, type ProjectState} from '@/backend-api';
import {Badge, Banner, Below, Rough, Button, Card, Code, dateTime, Dialog, Empty, Hov, Icon, IconToggle, Metric, num, One, Opt, PageHead, Passed, Progress, reportActionError, Score, Seg, Suggestion, Table, timeOfDay, useCopy} from '@/ui';
import {LabelDistribution, labelCounts} from '@/components/LabelDistribution';
import {fieldRows, modelName, reportFor, runsFor, versionScore} from '@/components/prompt/scores';

const VERSIONS_PAGE: PageContext = {label: 'Prompt Tuning', agent: 'front_desk', intent: 'answer', hint: 'Ask me about any version.', context: {}};

export default function PromptPage() {
  const [page, setPage] = useState<PageContext>(VERSIONS_PAGE);
  return (
    <ProjectPage node="prompt" page={page}>
      {({state}) =>
        !state.versions.length || !state.setup?.schema ? (
          <Frame head={<PageHead title="Prompt Tuning" />}>
            <Empty title="No prompt yet" text="Write and approve the first prompt on Prompt Design." />
          </Frame>
        ) : (
          <Versions state={state} setPage={setPage} />
        )
      }
    </ProjectPage>
  );
}

const hideKey = (projectId: string) => `pv-hide-dropped:${projectId}`;
function readHideDropped(projectId: string): boolean {
  try {
    return sessionStorage.getItem(hideKey(projectId)) === '1';
  } catch {
    return false;
  }
}
function saveHideDropped(projectId: string, on: boolean) {
  try {
    sessionStorage.setItem(hideKey(projectId), on ? '1' : '0');
  } catch {
    // Storage off: the choice holds for this page only.
  }
}

/** The newest run, when it ended without a pass (a pass shows on its version). */
const endedRun = (s: ProjectState): OptimisationRun | null => {
  const o = s.optimisation[0];
  return o && ((o.state === 'done' && o.stopReason !== 'passes') || o.state === 'stopped') ? o : null;
};
const seenKey = (projectId: string) => `pv-run-end-seen:${projectId}`;
function readSeenEnd(projectId: string): string | null {
  try {
    return sessionStorage.getItem(seenKey(projectId));
  } catch {
    return null;
  }
}
function saveSeenEnd(projectId: string, runId: string) {
  try {
    sessionStorage.setItem(seenKey(projectId), runId);
  } catch {
    // Storage off: the panel goes when a version is picked, for this page only.
  }
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
  // R6-2: hide versions the Optimiser dropped (off by default, remembered for the session).
  const [hideDropped, setHideDropped] = useState(false);
  useEffect(() => setHideDropped(readHideDropped(state.project.id)), [state.project.id]);
  const toggleHide = () => {
    saveHideDropped(state.project.id, !hideDropped);
    setHideDropped(!hideDropped);
  };
  // null: the panel while a run is going, else the newest version.
  const [selId, setSel] = useState<string | null>(null);
  const run = panelRun(state);
  // Run end (round 6): a run that finished without a pass keeps its panel, saying how it ended,
  // until a version is picked (remembered for the session).
  const ended = run ? null : endedRun(state);
  const [seenEnd, setSeenEnd] = useState<string | null>(null);
  useEffect(() => setSeenEnd(readSeenEnd(state.project.id)), [state.project.id]);
  const showEnd = !!ended && selId === null && seenEnd !== ended.id;
  const showPanel = (!!run && (selId === null || selId === run.stepVersionId)) || showEnd;
  const choose = (id: string | null) => {
    if (showEnd && ended) {
      saveSeenEnd(state.project.id, ended.id);
      setSeenEnd(ended.id);
    }
    setSel(id);
  };
  const sel = list.find(v => v.id === selId) ?? (run?.stepVersionId ? list.find(v => v.id === run.stepVersionId) : undefined) ?? list[0];
  const running = state.runs.some(r => r.state === 'running') || state.optimisation.some(o => o.state === 'running');

  useEffect(() => {
    setPage({...VERSIONS_PAGE, label: `Prompt Tuning · ${versionLabel(sel)}`, context: {version: versionLabel(sel)}});
  }, [sel.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const scored = list.map(v => ({v, s: versionScore(state, v.id)}));
  const best = scored.filter(x => x.s).sort((a, b) => b.s!.score - a.s!.score)[0];
  const points = [...scored].reverse().flatMap(({v, s}) => (s ? [{label: versionLabel(v), score: s.score, passed: s.passed && !s.rough}] : []));
  const selInfo = info.get(sel.id);
  const selDropped = selInfo?.round.outcome === 'dropped';
  const selRunning = runsFor(state, sel.id).some(r => r.state === 'running' && r.purpose !== 'optimiser');
  // A version labeled while the eval set has no gold labels: what can be known without scores.
  const selNoGold = !showPanel && !selDropped && !selRunning && !versionScore(state, sel.id) && labeledRuns(state, sel.id).length > 0;
  const pick = (id: string) => choose(run && id === run.stepVersionId ? null : id);

  const rowRight = (v: PromptVersion, s: {score: number; passed: boolean; rough: boolean} | null) => {
    const o = info.get(v.id)?.round;
    const lab = labeledRuns(state, v.id)[0];
    if (o?.outcome === 'running' || runsFor(state, v.id).some(r => r.state === 'running' && r.purpose !== 'optimiser')) return <Badge text="Running" tone="run" />;
    if (o?.outcome === 'dropped')
      return (
        <span className="badge b-gray">
          <Hov text="Dropped" tip={droppedWhy(state, v, o)} />
        </span>
      );
    if (o?.outcome === 'stopped') return <Badge text="Stopped" icon={false} />;
    if (s) return <Score v={s.score} ok={s.rough ? null : s.passed} />;
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
      ? scored
          .filter(({v}) => !hideDropped || info.get(v.id)?.round.outcome !== 'dropped')
          .map(({v, s}) => (
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
            {g.best ? <Score v={g.best.score} ok={g.best.rough ? null : g.best.passed} /> : rowRight(g.pick, null)}
          </button>
        ));
  const hasOptimiser = state.versions.some(v => v.madeBy === 'optimiser');
  const versions = (
    <Card
      title="Versions"
      actions={
        hasOptimiser ? (
          <div className="row" style={{gap: 8, alignItems: 'center'}}>
            {view === 'all' && <IconToggle icon={hideDropped ? 'eye-off' : 'eye'} tip={hideDropped ? 'Show dropped versions' : 'Hide dropped versions'} pressed={hideDropped} onClick={toggleHide} />}
          <Seg
            label="View"
            value={view}
            onChange={setView}
            options={[
              {value: 'all', label: 'All'},
              {value: 'major', label: 'Major'},
            ]}
          />
          </div>
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
  const hasGold = state.examples.some(e => e.split === 'eval' && !!state.gold[e.id]);
  const chart = (
    <Card title="Score by version">
      {t && points.length > 0 ? (
        <ScoreChart points={points} threshold={t.macroF1} selected={showPanel ? undefined : versionLabel(sel)} onSelect={l => choose(list.find(v => versionLabel(v) === l)?.id ?? null)} />
      ) : (
        <div className="pv-empty">
          <span className="t-3">{hasGold ? 'Scores show here once a version is scored' : 'Scores show here once the eval set has gold labels'}</span>
        </div>
      )}
    </Card>
  );

  // No advice from scores that are out of date (Rebuild scores first).
  // A dropped version gets one too: it says which version to go back to (spec 6.3).
  const advice = !running && !showPanel && !state.scoresUpdating ? <Advice state={state} selId={sel.id} onStarted={() => setSel(null)} onSwitch={id => choose(id)} /> : null;
  return (
    <Frame
      head={
        <PageHead
          title="Prompt Tuning"
          actions={
            // Evelyn 2026-11-12: scores are rebuilt only here, by hand. Gold edits, settings changes
            // and new code all move scores; nothing tries to sense them one by one.
            <>
              {state.scoresUpdating && (
                <span className="badge b-gray">
                  <Hov text="Scores out of date" tip={OOD_TIP} />
                </span>
              )}
              <Button label="Rebuild scores" disabled={running} title={running ? 'Wait until the running work ends' : undefined} onClick={() => rebuildReports(state.project.id)} />
            </>
          }
        />
      }
    >
      {chart}
      <div style={{display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start'}}>
        {versions}
        <RightColumn advice={advice}>
          {box =>
            showPanel ? (
              <OptimiserPanel state={state} run={(run ?? ended)!} box={box} onShow={choose} />
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
function majors(scored: {v: PromptVersion; s: {score: number; passed: boolean; rough: boolean} | null}[], info: ReturnType<typeof optimiserVersions>) {
  const groups = new Map<number, {v: PromptVersion; s: {score: number; passed: boolean; rough: boolean} | null}[]>();
  for (const x of scored) groups.set(x.v.major, [...(groups.get(x.v.major) ?? []), x]);
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([major, xs]) => {
      const kept = xs.filter(x => x.s && info.get(x.v.id)?.round.outcome !== 'dropped');
      const top = [...kept].sort((a, b) => b.s!.score - a.s!.score)[0];
      return {major, versions: xs.map(x => x.v), optimiser: xs.some(x => x.v.madeBy === 'optimiser'), best: top?.s ?? null, pick: top?.v ?? xs[0].v};
    });
}

/** R4-1 (2026-11-11): the label stays "Score", with the real metric name in small grey text next to it. */
const named = (name: string) => (
  <span>
    Score
    <span className="t-3" style={{fontSize: 13, fontWeight: 400, marginLeft: 6}}>
      {name}
    </span>
  </span>
);
const LEFT_OUT_TIP = "Answers that can't be read as labels (invalid) or that the safety filter stopped are left out of the score. A version passes only when at most 1% of its answers are invalid";
/** R4-6: how many answers the score rests on, and how many were left out. Red when invalid answers are over the cap. */
function LeftOut({m, cap}: {m: ProjectState['reports'][number]['metrics']; cap: number}) {
  const total = m.total ?? m.n;
  if (!total) return null;
  const filtered = m.filtered ?? 0;
  const over = m.invalidRate > cap;
  const txt = `Scored on ${m.n} of ${total} examples · ${m.invalid} invalid (${Math.round(100 * m.invalidRate)}%${over ? `, above ${+(100 * cap).toFixed(1)}%` : ''}) · ${filtered} filtered left out`;
  return (
    <div className="row" style={{paddingTop: 12, fontSize: 13}}>
      <span className={over ? 't-err' : 't-3'}>
        <Hov text={txt} tip={LEFT_OUT_TIP} />
      </span>
    </div>
  );
}

/** Why the Optimiser dropped a version, for the hover on its Dropped badge (spec 6.3). */
function droppedWhy(state: ProjectState, v: PromptVersion, r: OptimiserRound): string {
  const d = r.dryRun;
  if (!d) return 'The Optimiser dropped this change before scoring it';
  const parent = state.versions.find(x => x.id === d.parentId);
  return `In the dry run ${versionLabel(v)} got ${d.passed} of ${d.examples} examples fully right and ${parent ? versionLabel(parent) : 'the version it changed'} got ${d.parentPassed}. It was no better, so it was not scored on the eval set`;
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

const OOD_TIP = "Gold labels changed since these scores were made. Press Rebuild scores to work them out again from saved answers";

/** Why the Optimiser picked a round's parent (R5-7). */
const parentWhy = (r: OptimiserRound, parent: string) =>
  r.parentWins === null
    ? `Round 1 changes ${parent}, the version you started from`
    : r.parentWins === undefined
      ? `The change was made to ${parent}`
      : `${parent} is the best version on ${r.parentWins} ${r.parentWins === 1 ? 'example' : 'examples'} of the optimiser half. Versions that are best on more examples are picked more often`;

/** The Optimiser's progress panel: round, where it started, what it does now, every round so far. */
function OptimiserPanel({state, run, box, onShow}: {state: ProjectState; run: OptimisationRun; box: Box; onShow: (versionId: string) => void}) {
  const label = (id: string | null) => {
    const v = id ? state.versions.find(x => x.id === id) : undefined;
    return v ? versionLabel(v) : null;
  };
  const over = run.state === 'done' || run.state === 'stopped';
  const tag =
    run.state === 'running' ? (
      <Badge text="Running" tone="run" />
    ) : run.state === 'failed' ? (
      <Badge text="Failed" tone="err" />
    ) : run.state === 'done' ? (
      <Badge text="Finished" tone="ok" />
    ) : (
      <Badge text={run.state === 'stopped' ? 'Stopped' : 'Paused'} icon={false} />
    );
  const act = over ? undefined : run.state === 'running' ? <Button label="Stop" icon="stop" onClick={() => stopOptimiser(run.id)} /> : <Button label={run.state === 'failed' ? 'Retry' : 'Resume'} kind="primary" onClick={() => void retryOptimiser(run.id)} />;
  const half = state.examples.filter(e => e.split === 'eval' && e.optimiserHalf && !!state.gold[e.id]).length;
  const task = run.stepVersionId ? state.runs.find(r => r.promptVersionId === run.stepVersionId && r.endpoint === run.endpoint && r.state === 'running') : undefined;
  // Best so far: the highest score among the start version and the changes this run kept.
  const tried = [{id: run.startVersionId, s: versionScore(state, run.startVersionId)?.score}, ...run.history.filter(h => h.outcome === 'kept' && h.score != null).map(h => ({id: h.versionId, s: h.score!}))];
  const top = tried.filter(x => x.s != null).sort((a, b) => b.s! - a.s!)[0];
  const now =
    run.state === 'running' ? (
      <div className="col" style={{gap: 8, padding: '16px 0 8px'}}>
        <div className="row" style={{gap: 8}}>
          <div className="live grow">
            <Icon name="ring" />
            <span>{stepLine(run.step, label(run.stepVersionId), dryRunSize(half), label(run.history.at(-1)?.parentId ?? null))}</span>
          </div>
          {run.stepStartedAt && (
            <span className="t-3" style={{fontSize: 13}}>
              since {timeOfDay(run.stepStartedAt)}
            </span>
          )}
        </div>
        {task && <Progress done={task.done} total={task.total} />}
      </div>
    ) : over && top ? (
      <EndLine state={state} run={run} top={top} label={label} onShow={onShow} />
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
        <span key="c" className="row" style={{gap: 8, minWidth: 0}}>
          {label(r.parentId) && (
            <span className="t-3" style={{flex: 'none'}}>
              <Hov text={`from ${label(r.parentId)}`} tip={parentWhy(r, label(r.parentId)!)} />
            </span>
          )}
          <One text={r.change || 'Writing a change'} />
        </span>,
        res ? (
          <Badge key="r" text={res.text} tone={res.tone ?? 'gray'} icon={res.tone === 'run' || res.tone === 'err'} />
        ) : r.score != null && r.passed && r.confirm && !r.confirm.passed ? (
          // A pass the second labeling of the held-out half did not confirm (review finding 6).
          <span key="r" className="row" style={{gap: 8, justifyContent: 'center'}}>
            <Score v={r.score} ok />
            <span className="badge b-gray">
              <Hov text="Not confirmed" tip={`The second labeling of the held-out half scored ${r.confirm.score.toFixed(2)}, below the bar`} />
            </span>
          </span>
        ) : r.score != null && r.tied ? (
          // R5-6: a tie is labeled in full but is not progress.
          <span key="r" className="row" style={{gap: 8, justifyContent: 'center'}}>
            <Score v={r.score} ok={r.passed} />
            <span className="badge b-gray">
              <Hov text="Tied" tip={`In the dry run it got as many fields right as ${label(r.parentId) ?? 'its parent'}, on different examples. It was labeled in full but does not count as progress`} />
            </span>
          </span>
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
  return (
    <Card title="Optimiser" titleExtra={tag} actions={act} className={box.className} style={box.style}>
      <div className="row" style={{gap: 40, alignItems: 'flex-end'}}>
        <Metric label="Round" value={String(run.round)} unit={`/ ${run.maxRounds}`} />
        <Metric label="Started from" value={label(run.startVersionId) ?? '–'} />
        <Metric label={over ? 'Best' : 'Best so far'} value={top ? top.s!.toFixed(2) : '–'} unit={top ? (label(top.id) ?? undefined) : undefined} />
        <span className="t-3" style={{fontSize: 13, paddingBottom: 4}}>
          {over && run.finishedAt ? `Finished ${dateTime(run.finishedAt)}` : `Started ${dateTime(run.startedAt)}`}
        </span>
      </div>
      {now}
      {rows.length > 0 && <Table cols={[{label: 'Round'}, {label: 'Version'}, {label: 'Change'}, {label: 'Result', kind: 'c'}]} rows={rows} widths={[72, 88, 'auto', 200]} />}
    </Card>
  );
}

/**
 * How a finished run ended (round 6): whether any change beat the version it started from, said
 * plainly, so the user need not find out version by version.
 */
function EndLine({state, run, top, label, onShow}: {state: ProjectState; run: OptimisationRun; top: {id: string | null; s: number | undefined}; label: (id: string | null) => string | null; onShow: (versionId: string) => void}) {
  const start = label(run.startVersionId) ?? 'the start version';
  const won = top.id !== run.startVersionId;
  const best = label(top.id) ?? '';
  const startScore = versionScore(state, run.startVersionId)?.score;
  const need = state.setup?.thresholds?.macroF1.toFixed(2) ?? '–';
  const passes = versionScore(state, top.id!)?.passed;
  const tried = run.history.length;
  const rough = !!versionScore(state, top.id!)?.rough;
  const said = won ? `${best} beat ${start}: ${top.s!.toFixed(2)} against ${startScore?.toFixed(2) ?? '–'}` : `No change beat ${start}. ${start} is still the best at ${top.s!.toFixed(2)}`;
  // Too few gold labels for a verdict (spec 1.0.0, 4.2): the end line says the result is rough.
  const text = rough ? `${said}, a rough reading` : said;
  const tip = won
    ? rough
      ? `The best change this run kept. Fewer than ${state.setup?.thresholds?.minEval ?? 20} eval examples have a gold label, so the scores are rough and nothing can pass yet`
      : `The best change this run kept.${passes ? '' : ` It does not pass yet (needs ${need})`}`
    : `None of the ${tried} ${tried === 1 ? 'change' : 'changes'} scored higher than ${start}, or they were dropped in the dry run. Changing the wording more may not help: check your labels on the examples every version gets wrong`;
  return (
    <div className="row" style={{gap: 8, padding: '16px 0 8px', fontSize: 15, lineHeight: '22px', alignItems: 'center'}}>
      <span className="t-2" style={{display: 'inline-flex'}}>
        <Icon name={won ? 'check' : 'alert'} />
      </span>
      <span className="grow">
        <Hov text={text} tip={tip} />
      </span>
      <Button label={`Show ${best}`} size="sm" onClick={() => onShow(top.id!)} />
    </div>
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
    void predictionsFor(v.id, run.endpoint, settings).then(m => live && setAnswers(Object.values(m).filter(p => evalIds.has(p.exampleId)).map(p => p.answer)));
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
  const settings = useSettings();
  // A click on Score is the user's own start; the first one confirms Project Settings (spec 2.3).
  const score = async () => {
    if (!(await settings.confirmed())) return;
    void scoreVersion({projectId: state.project.id, promptVersionId: v.id});
  };
  const actions = (
    <div style={{marginLeft: 'auto', display: 'flex', gap: 8, paddingBottom: rep ? 8 : 0}}>
      <Button label="Edit prompt" kind="ghost" href={href('/prompt/edit', {v: v.id})} />
      <Button label="View prompt" href={href('/prompt/edit', {v: v.id, view: '1'})} />
    </div>
  );
  if (!t || !rep) {
    const runs = runsFor(state, v.id);
    const last = runs[0];
    const stopped = !runs.some(r => r.state === 'done') && !runs.some(r => r.state === 'failed') && !!last;
    const ready = canScore(state.facts);
    const why = !ready
      ? 'Scores appear once enough examples have gold labels.'
      : runs.some(r => r.state === 'done')
        ? 'Scores appear when the eval set has gold labels.'
        : runs.some(r => r.state === 'failed')
          ? 'Scoring failed.'
          : last
            ? `Scoring stopped at ${num(last.done)} of ${num(last.total)}.`
            : 'Not scored yet.';
    const scorable = ready && !runs.some(r => r.state === 'done');
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
          {/* A gold edit archived the score; Rebuild scores works it out again from saved answers. */}
          {state.scoresUpdating && runs.some(r => r.state === 'done') ? (
            <span className="badge b-gray">
              <Hov text="Scores out of date" tip={OOD_TIP} />
            </span>
          ) : (
            <span className="t-3">{why}</span>
          )}
          {scorable && <Button label={runs.length ? 'Resume' : 'Score'} size="sm" icon="play" onClick={score} />}
        </div>
      </Card>
    );
  }
  const rows = fieldRows(rep, t);
  return (
    <Card className={box.className} style={box.style}>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: 16, paddingBottom: 16}}>
        <Metric label={named('Lowest field macro-F1')} value={rep.metrics.lowestField.macroF1.toFixed(2)} unit={`/ ${+t.macroF1.toFixed(2)}`} tone={rep.rough ? undefined : rep.passed ? 'ok' : 'err'} size="lg" />
        <div style={{display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 9}}>
          {rep.rough ? <Rough need={t.minEval} /> : rep.passed ? <Passed /> : <Below />}
          <span className="t-3" style={{fontSize: 13}}>
            Created {dateTime(v.createdAt)}
          </span>
        </div>
        {actions}
      </div>
      <Table
        cols={[{label: 'Field'}, {label: named('Macro-F1'), kind: 'c'}, {label: 'Precision', kind: 'c'}, {label: 'Recall', kind: 'c'}, {label: 'Result', kind: 'c'}]}
        rows={rows.map(r => ({key: r.field, cells: [<Code key="f">{r.field}</Code>, <Score key="s" v={r.f1} ok={rep.rough ? null : r.passed} />, r.precision.toFixed(2), r.recall.toFixed(2), rep.rough ? <span key="p" className="t-3">–</span> : r.passed ? <Passed key="p" /> : <Below key="b" />]}))}
      />
      <LeftOut m={rep.metrics} cap={t.invalidRate ?? systemConfig().evaluation.invalidRateCap} />
    </Card>
  );
}

/**
 * The AI Suggestion card (spec 1.0.0, 6.3). Code picks one of six fixed templates from the
 * project's records (`aiSuggestion`), so the headline always says what to do. The card is hidden
 * while scoring or the Optimiser runs. Improve with AI drafts in the editor; Auto Optimise opens
 * one dialog that asks for the rounds.
 */
function Advice({state, selId, onStarted, onSwitch}: {state: ProjectState; selId: string; onStarted: () => void; onSwitch: (versionId: string) => void}) {
  const {href} = useProject();
  const go = useGo();
  const settings = useSettings();
  const [rounds, setRounds] = useState(String(systemConfig().optimiser.defaultMaxRounds));
  // Review finding 2: where the model disagrees with gold labels (saved answers only, nothing labeled).
  const [mm, setMm] = useState<MismatchList | null>(null);
  const scored = state.reports.some(r => !r.archivedNow);
  useEffect(() => {
    let live = true;
    if (scored) void mismatches(state.project.id).then(m => live && setMm(m));
    return () => {
      live = false;
    };
  }, [state.project.id, scored, state.contextId, state.reports.length, state.optimisation[0]?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = aiSuggestion(state, {selectedId: selId, mismatches: mm ? {open: mm.items.length, wrongEverywhere: mm.wrongEverywhere, reviewedAll: mm.reviewedAll} : null});
  const [copied, copy] = useCopy();
  const latest = state.versions[0];
  const openAskAi = useOpenAskAi();
  const improve = (versionId: string) => {
    openAskAi();
    improveWithAi(state.project.id, versionId).catch(e => reportActionError(`Improve with AI failed: ${(e as Error).message}`, () => improve(versionId)));
    return go(href('/prompt/edit', {v: versionId}));
  };
  // Auto Optimise starts from the version selected in the list (R3-7). It always opens one dialog
  // (R4-3, design: U-J-Optimise-Dialog): where to start, shown only when a better minor of the same
  // major exists, and the most rounds to try.
  const [ask, setAsk] = useState<{sel: PromptVersion; selScore: number | null; best: PromptVersion | null; bestScore: number; from: string} | null>(null);
  const start = (versionId: string, n: number) => {
    setAsk(null);
    // R5-4: starting a run takes the user to it (the progress panel), not the version they left.
    onStarted();
    startOptimiser({projectId: state.project.id, maxRounds: n, startVersionId: versionId}).catch(e => reportActionError(`The Optimiser could not start: ${(e as Error).message}`, () => start(versionId, n)));
  };
  const auto = async () => {
    // Paid work: the first start confirms Project Settings (spec 2.3).
    if (!(await settings.confirmed())) return;
    const sel = state.versions.find(v => v.id === selId) ?? latest;
    const selScore = versionScore(state, sel.id)?.score ?? null;
    const best = state.versions
      .filter(v => v.major === sel.major && v.schemaVersion === sel.schemaVersion)
      .map(v => ({v, s: versionScore(state, v.id)?.score}))
      .filter(x => x.s != null)
      .sort((x, y) => y.s! - x.s!)[0];
    const better = best && best.v.id !== sel.id && (selScore == null || best.s! > selScore);
    setRounds(String(systemConfig().optimiser.defaultMaxRounds));
    setAsk({sel, selScore, best: better ? best.v : null, bestScore: better ? best.s! : 0, from: better ? best.v.id : sel.id});
  };
  if (!a) return null;
  const target = a.versionId ? state.versions.find(v => v.id === a.versionId) : undefined;
  const finished = state.project.approvedNodes.includes('prompt');
  const copyPrompt = () => {
    if (!target) return;
    copy(compilePrompt(target.structured));
    track('prompt_copied', {from: 'suggestion'});
  };
  // One button per action of the template, in its order; the last is the main one.
  const button = (act: SuggestionAction, main: boolean) => {
    const kind = main ? ('primary' as const) : ('secondary' as const);
    switch (act) {
      case 'go_gold':
        return <Button key={act} label="Go to Gold Labels" kind={kind} onClick={() => go(href('/gold'))} />;
      case 'add_examples':
        return <Button key={act} label="Add examples" kind={kind} onClick={() => go(href('/dataset'))} />;
      case 'review_labels':
        return <Button key={act} label="Review labels" kind={kind} onClick={() => go(href('/gold', {tab: 'mismatches'}))} />;
      case 'auto_optimise':
        return <Button key={act} label="Auto Optimise" kind={kind} onClick={auto} />;
      case 'improve':
        return <Button key={act} label="Improve with AI" kind={kind} onClick={() => improve(a.versionId!)} />;
      case 'switch':
        return <Button key={act} label={`Switch to ${target ? versionLabel(target) : 'it'}`} kind={kind} onClick={() => void (a.versionId && onSwitch(a.versionId))} />;
      case 'copy_prompt':
        return <Button key={act} label={copied ? 'Copied' : 'Copy prompt'} icon={copied ? 'check' : 'copy'} kind="secondary" onClick={copyPrompt} />;
      case 'finish':
        return finished ? (
          <span key={act} className="done-at" style={{margin: 0}}>
            <Badge text="Finished" tone="ok" />
          </span>
        ) : (
          <Button key={act} label="Finish" kind={kind} title="Marks this project as finished. You can still come back and change it." onClick={() => approveNode(state.project.id, 'prompt')} />
        );
    }
  };
  const title = a.title;
  const text = a.text;
  const acts = (
    <div className="row" style={{gap: 8}}>
      {a.actions.map((x, i) => button(x, i === a.actions.length - 1))}
    </div>
  );
  return (
    <section className="card ai" aria-label="AI Suggestion">
      <Suggestion title={title} text={text} actions={acts} />
      {ask && (
        <Dialog
          title="Auto Optimise"
          onClose={() => setAsk(null)}
          actions={
            <>
              <Button label="Cancel" onClick={() => setAsk(null)} />
              <Button label="Start" kind="primary" onClick={() => start(ask.from, Math.max(1, Math.min(systemConfig().optimiser.maxRoundsCap, Math.round(Number(rounds)) || systemConfig().optimiser.defaultMaxRounds)))} />
            </>
          }
        >
          {ask.best && (
            <div className="col" style={{gap: 8}}>
              <span className="field-l">Start from</span>
              <div className="opts" role="radiogroup" aria-label="Start from">
                <Opt title={versionLabel(ask.best)} tip={`The best version in v${ask.sel.major}`} checked={ask.from === ask.best.id} onSelect={() => setAsk({...ask, from: ask.best!.id})} extra={<span className="t-3" style={{fontSize: 13, marginLeft: 'auto'}}>{`Best in v${ask.sel.major} · ${ask.bestScore.toFixed(2)}`}</span>} />
                <Opt title={versionLabel(ask.sel)} tip="The version you selected" checked={ask.from === ask.sel.id} onSelect={() => setAsk({...ask, from: ask.sel.id})} extra={<span className="t-3" style={{fontSize: 13, marginLeft: 'auto'}}>{`Selected · ${ask.selScore == null ? 'no score yet' : ask.selScore.toFixed(2)}`}</span>} />
              </div>
            </div>
          )}
          <div className="col" style={{gap: 8}}>
            <span className="field-l">
              <Hov text="Max rounds" tip="Most rounds to try. Each round tries one change to the prompt" />
            </span>
            <input className="input sm" style={{width: 72, textAlign: 'center'}} value={rounds} inputMode="numeric" aria-label="Max rounds" onChange={e => setRounds(e.target.value.replace(/\D/g, '').slice(0, 2))} />
          </div>
          {/* R5-7: how the parent of each round is picked. */}
          <span className="t-3" style={{fontSize: 13, lineHeight: '20px'}}>
            Round 1 changes the version you start from. Later rounds can start from any scored version, most often one that is best on many examples
          </span>
        </Dialog>
      )}
    </section>
  );
}
