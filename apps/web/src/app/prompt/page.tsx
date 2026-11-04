'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useEffect, useMemo, useState} from 'react';
import type {EndpointId, PromptVersion} from '@tsp/contracts';
import {versionLabel} from '@tsp/domain';
import {NotYet} from '@/components/NotYet';
import {ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {MODEL_COLOR, ScoreChart} from '@/components/ScoreChart';
import {useChecks, Workbench, type Draft} from '@/components/prompt/Workbench';
import {estimateLabeling, MADE_BY, minutesFor, recommend} from '@tsp/domain';
import {
  approveNode,
  createVersion,
  scoreVersion,
  startOptimiser,
  stopOptimiser,
  stopRun,
  tick,
  type PageContext,
  type ProjectState,
} from '@/backend-api';
import {Button, Icon, money, Note, num, Progress, StatusBadge, timeOf} from '@/ui';
import {useAgentDrafts} from '@/components/prompt/useAgentDrafts';

export default function PromptPage() {
  return <PromptRouter />;
}

function PromptRouter() {
  const [page, setPage] = useState<PageContext>({label: 'Prompt Engineering · prompt versions', agent: 'front_desk', intent: 'answer', hint: 'Ask me about any version or report.', context: {}});
  return (
    <ProjectPage node="prompt" assistant="docked" wide page={page}>
      {({state, href}) =>
        !state.facts.approved.includes('dataset') ? (
          <NotYet text="Split the dataset first." to={href('/dataset')} />
        ) : state.versions.length ? (
          <Overview state={state} setPage={setPage} />
        ) : (
          <Start state={state} setPage={setPage} />
        )
      }
    </ProjectPage>
  );
}

/** Prompt Engineering step 1: the starting prompt becomes v1.0. */
function Start({state, setPage}: {state: ProjectState; setPage: (p: PageContext) => void}) {
  const [draft, setDraft] = useState<Draft>({template: '', features: {video: [], photo_text: [], metadata: []}, images: []});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const types = useMemo(() => [...new Set(state.examples.map(e => e.type))], [state.examples]);
  const check = useChecks(draft, state.setup?.schema, types);
  const est = estimateLabeling(state, draft);

  useEffect(() => {
    setPage({
      label: 'Prompt Engineering · starting prompt',
      agent: 'prompt_agent',
      intent: draft.template.trim() ? 'revise_prompt' : 'draft_prompt',
      hint: 'Paste the prompt you use today, or ask me to draft one from your schema. Tick the features you want, and I can place them for you.',
      context: {schema: state.setup?.schema, task: state.setup?.task, template: draft.template},
    });
  }, [draft.template, state.setup?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useAgentDrafts(state, d => setDraft(cur => ({...cur, template: d.template, features: d.features ?? cur.features})));

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const v = await createVersion(state.project.id, {...draft, parent: null, madeBy: 'user', change: 'Starting prompt', kind: 'minor', schema: state.setup!.schema!, schemaVersion: state.setup!.schemaVersion});
      void scoreVersion(state.project.id, v);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const blocked = check.errors.length ? `Fix ${check.errors.length} error${check.errors.length > 1 ? 's' : ''} in Checks to create.` : !draft.template.trim() ? 'Paste a prompt or ask the prompt agent to draft one.' : null;
  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Prompt Engineering · step 1 of 2</span>
        <h1>Where should the prompt start?</h1>
        <p className="muted">This becomes v1.0. The platform improves it from here, so it doesn&apos;t need to be perfect.</p>
      </div>
      <Workbench draft={draft} onChange={setDraft} check={check} state={state} />
      <div className="next">
        <Button label="Create" variant="primary" size="lg" disabled={!!blocked} loading={busy} onClick={create} />
        <span className="blocked">{blocked ?? `About ${est.minutes} minute${est.minutes > 1 ? 's' : ''} · ${money(est.costUsd)} to label the ${num(est.count)} eval examples`}</span>
      </div>
      {err && <Note tone="error">{err}</Note>}
    </>
  );
}

/** Prompt Engineering step 2: all versions, scores by model, and the agent's recommendation. */
function Overview({state, setPage}: {state: ProjectState; setPage: (p: PageContext) => void}) {
  const router = useRouter();
  const {href} = useProject();
  const [picked, setPicked] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const setup = state.setup!;
  const models = setup.models;
  const current = state.versions[0];
  const t = setup.thresholds;
  const running = state.optimisation.find(o => o.state === 'running');
  const lastOpt = state.optimisation[0];
  const advice = recommend(state, running?.endpoint ?? null);

  useEffect(() => {
    void tick(state);
  }, [state]);
  useEffect(() => {
    setPage({
      label: 'Prompt Engineering · prompt versions',
      agent: 'front_desk',
      intent: 'answer',
      hint: 'Ask me about any version or report.',
      context: {version: {label: versionLabel(current), madeBy: MADE_BY[current.madeBy], change: current.change}, report: reportBrief(state, current.id, models[0].endpoint), template: current.template, schema: setup.schema},
    });
  }, [current.id, state.reports.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const reportFor = (vId: string, ep: EndpointId) => state.reports.find(r => r.promptVersionId === vId && r.endpoint === ep && !r.archivedNow);
  const runFor = (vId: string, ep: EndpointId) => state.runs.find(r => r.promptVersionId === vId && r.endpoint === ep);
  const live = state.versions.filter(v => v.schemaVersion === setup.schemaVersion);
  const archived = state.versions.filter(v => v.schemaVersion !== setup.schemaVersion);
  const chronological = [...live].reverse();

  const act = async () => {
    if (advice.kind === 'make_training_set' || advice.kind === 'no_eval') {
      await approveNode(state.project.id, 'prompt');
      router.push(href('/training-set', {v: advice.versionId ?? undefined, m: advice.endpoint ?? undefined}));
    } else if (advice.kind === 'label_gold') router.push(href('/gold'));
    else if (advice.kind === 'keep_improving' && advice.endpoint) startOptimiser(state.project.id, advice.endpoint);
  };
  const toggle = (key: string) => setPicked(p => (p.includes(key) ? p.filter(x => x !== key) : [...p.slice(-1), key]));
  const compareHref = () => {
    const [a, b] = picked.map(k => k.split('|'));
    return href('/prompt/compare', {a: a[0], am: a[1], b: b[0], bm: b[1]});
  };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Prompt Engineering · step 2 of 2</span>
        <h1>Prompt versions</h1>
      </div>
      <div className="card">
        <div className="row">
          <h2>Prompt {versionLabel(current)}</h2>
          <span className="muted">
            made by {MADE_BY[current.madeBy]} · {timeOf(current.createdAt)}
            {current.images.length ? ` · ${current.images.length} image${current.images.length > 1 ? 's' : ''}` : ''}
          </span>
          <span className="right">
            <Button label="View and edit" href={href('/prompt/edit', {v: current.id})} />
          </span>
        </div>
        <pre className="mono" style={{margin: 0, whiteSpace: 'pre-wrap', maxHeight: 84, overflow: 'hidden', color: 'var(--ink-2)'}}>
          {current.template.split('\n').slice(0, 4).join('\n')} …
        </pre>
        <div className="col" style={{gap: 0, borderTop: '1px solid var(--line)', paddingTop: 12}}>
          <div className="row">
            <h3>Labeling on the eval set</h3>
            {t && <span className="small muted">Scores use the {num(state.examples.filter(e => e.split === 'eval' && !e.optimiserHalf).length)} examples the optimiser never saw</span>}
          </div>
          {models.map(m => {
            const run = runFor(current.id, m.endpoint);
            const rep = reportFor(current.id, m.endpoint);
            const total = run?.total ?? state.examples.filter(e => e.split === 'eval').length;
            return (
              <div key={m.endpoint} className="model-line">
                <b>Model {m.endpoint}</b>
                <Progress value={run?.done ?? 0} max={total} />
                <span className="small muted">
                  {run?.state === 'failed' ? 'Failed' : run?.state === 'paused' || run?.state === 'stopped' ? 'Paused' : `${num(run?.done ?? 0)} of ${num(total)} eval examples`}
                </span>
                <span className="row" style={{gap: 6}}>
                  {rep ? (
                    <>
                      <b>{rep.metrics.lowestField.macroF1.toFixed(2)}</b>
                      {t && <StatusBadge passed={rep.passed} />}
                    </>
                  ) : run?.state === 'done' && t ? (
                    <span className="small muted">Needs gold labels</span>
                  ) : null}
                </span>
                <span className="row" style={{gap: 6}}>
                  {run?.state === 'running' ? <Button label="Stop" size="sm" variant="ghost" onClick={() => stopRun(run.id)} /> : <Button label="Rerun" size="sm" onClick={() => scoreVersion(state.project.id, current, m.endpoint)} disabled={run?.state === 'done'} />}
                  {rep && <Button label="Report" size="sm" variant="ghost" href={href('/report', {v: current.id, m: m.endpoint})} />}
                </span>
              </div>
            );
          })}
          {state.runs.find(r => r.promptVersionId === current.id && r.state === 'failed')?.error && <Note tone="error">{state.runs.find(r => r.promptVersionId === current.id && r.state === 'failed')!.error}</Note>}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{gap: 8}}>
          <span className="small muted row" style={{gap: 6}}>
            <Icon name="sparkle" size={14} /> Agent recommends
          </span>
        </div>
        <h2>{advice.title}</h2>
        {advice.reasons.map((r, i) => (
          <p key={i} className="muted">
            {r}
          </p>
        ))}
        {advice.versionId && advice.endpoint && reportFor(advice.versionId, advice.endpoint) && (
          <div className="row small" style={{gap: 12}}>
            <Link href={href('/report', {v: advice.versionId, m: advice.endpoint})}>
              {versionLabel(state.versions.find(v => v.id === advice.versionId)!)} report{models.length > 1 ? ` · Model ${advice.endpoint}` : ''}
            </Link>
          </div>
        )}
        {(advice.kind === 'make_training_set' || advice.kind === 'no_eval' || advice.kind === 'label_gold' || (advice.kind === 'keep_improving' && !running)) && (
          <div>
            <Button
              label={advice.kind === 'label_gold' ? 'Go to Gold Labels' : advice.kind === 'keep_improving' ? `Run the optimiser for Model ${advice.endpoint}` : advice.title.replace('Make the training and test sets', 'Make training and test sets')}
              variant="primary"
              size="lg"
              onClick={act}
            />
          </div>
        )}
        {running ? (
          <div className="row" style={{borderTop: '1px solid var(--line)', paddingTop: 12}}>
            <span className="grow">
              <b>Optimiser is working on Model {running.endpoint}</b>
              <span className="muted">
                {' '}
                · {num(running.calls)} of {num(running.budgetCalls)} model calls · {money(running.costUsd)} so far · about {minutesFor(running.budgetCalls - running.calls)} min left
              </span>
            </span>
            <Button label="Stop" onClick={() => stopOptimiser(running.id)} />
          </div>
        ) : lastOpt ? (
          <div className="row small muted" style={{borderTop: '1px solid var(--line)', paddingTop: 12}}>
            <span className="grow">
              {lastOpt.state === 'failed'
                ? `Optimising for Model ${lastOpt.endpoint} stopped. ${lastOpt.error ?? ''}`
                : lastOpt.state === 'paused'
                  ? `The optimiser paused when the page closed.`
                  : lastOpt.stopReason === 'passes'
                    ? `The optimiser stopped because a version passes.`
                    : lastOpt.stopReason === 'user'
                      ? 'You stopped the optimiser.'
                      : lastOpt.stopReason === 'no_new_ideas'
                        ? 'The optimiser ran out of new changes to try. Edit the prompt or the labels, then run it again.'
                      : 'The optimiser used its budget for this run.'}{' '}
              {state.optimisation.length} run{state.optimisation.length > 1 ? 's' : ''} · {money(state.optimisation.reduce((s, o) => s + o.costUsd, 0))} in total
            </span>
            {(lastOpt.state === 'paused' || lastOpt.state === 'failed') && <Button label={lastOpt.state === 'failed' ? 'Restart run' : 'Resume'} size="sm" onClick={() => startOptimiser(state.project.id, lastOpt.endpoint)} />}
            {advice.kind === 'make_training_set' && <Button label="Keep improving" size="sm" onClick={() => startOptimiser(state.project.id, models.find(m => !state.reports.some(r => r.endpoint === m.endpoint && r.passed))?.endpoint ?? models[0].endpoint)} />}
          </div>
        ) : null}
      </div>

      {t && chronological.length > 1 && (
        <div className="card">
          <div className="col" style={{gap: 0}}>
            <h2>Score by version</h2>
            <span className="small muted">Lowest field macro-F1 · {models.length > 1 ? 'one line per model' : `Model ${models[0].endpoint}`}</span>
          </div>
          <ScoreChart
            labels={chronological.map(versionLabel)}
            series={models.map(m => ({name: `Model ${m.endpoint}`, color: MODEL_COLOR[m.endpoint], values: chronological.map(v => reportFor(v.id, m.endpoint)?.metrics.lowestField.macroF1 ?? null)}))}
            threshold={t.macroF1}
          />
        </div>
      )}

      <div className="card tight">
        <div className="card-head">
          <h2>Versions</h2>
          <span className="small muted">{t ? 'Score = lowest field macro-F1. Tick two scores to compare.' : 'Evaluation is off, so versions have no scores.'}</span>
          {t && (
            <span className="right">
              <Button label={picked.length === 2 ? 'Compare 2 selected' : 'Compare'} disabled={picked.length !== 2} href={picked.length === 2 ? compareHref() : undefined} />
            </span>
          )}
        </div>
        <div className="scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Version</th>
                <th>Made by</th>
                {t && models.map(m => <th key={m.endpoint}>{models.length > 1 ? `Model ${m.endpoint}` : 'Score'}</th>)}
                <th>What changed</th>
              </tr>
            </thead>
            <tbody>
              {(showArchived ? [...live, ...archived] : live).map(v => (
                <VersionRow key={v.id} v={v} state={state} isCurrent={v.id === current.id} picked={picked} toggle={toggle} reportFor={reportFor} runFor={runFor} archived={v.schemaVersion !== setup.schemaVersion} />
              ))}
            </tbody>
          </table>
        </div>
        {archived.length > 0 && (
          <div style={{padding: '8px 12px'}}>
            <Button label={showArchived ? 'Hide archived versions' : `Show ${archived.length} archived version${archived.length > 1 ? 's' : ''}`} variant="ghost" size="sm" onClick={() => setShowArchived(!showArchived)} />
          </div>
        )}
      </div>
    </>
  );
}

function VersionRow({v, state, isCurrent, picked, toggle, reportFor, runFor, archived}: {v: PromptVersion; state: ProjectState; isCurrent: boolean; picked: string[]; toggle: (k: string) => void; reportFor: (v: string, e: EndpointId) => ProjectState['reports'][number] | undefined; runFor: (v: string, e: EndpointId) => ProjectState['runs'][number] | undefined; archived: boolean}) {
  const {href} = useProject();
  const t = state.setup!.thresholds;
  return (
    <tr>
      <td>
        <Link href={href('/prompt/edit', {v: v.id})}>{versionLabel(v)}</Link>
        {isCurrent && <span className="small muted"> current</span>}
        {archived && <span className="small muted"> archived</span>}
      </td>
      <td>{MADE_BY[v.madeBy]}</td>
      {t &&
        state.setup!.models.map(m => {
          const r = reportFor(v.id, m.endpoint);
          const run = runFor(v.id, m.endpoint);
          const key = `${v.id}|${m.endpoint}`;
          return (
            <td key={m.endpoint}>
              {r ? (
                <label className="row" style={{gap: 6}}>
                  <input type="checkbox" checked={picked.includes(key)} onChange={() => toggle(key)} aria-label={`Compare ${versionLabel(v)} on Model ${m.endpoint}`} />
                  <Link href={href('/report', {v: v.id, m: m.endpoint})}>{r.metrics.lowestField.macroF1.toFixed(2)}</Link>
                  <StatusBadge passed={r.passed} />
                </label>
              ) : run?.state === 'running' ? (
                <span className="small muted">
                  Labeling {run.done}/{run.total}
                </span>
              ) : (
                <span className="muted">–</span>
              )}
            </td>
          );
        })}
      <td className="muted">{v.change}</td>
    </tr>
  );
}

function reportBrief(state: ProjectState, vId: string, ep: EndpointId) {
  const r = state.reports.find(x => x.promptVersionId === vId && x.endpoint === ep && !x.archivedNow);
  if (!r) return null;
  const mu = r.metrics.mixUps[0];
  return {
    label: versionLabel(state.versions.find(v => v.id === vId)!),
    endpoint: ep,
    lowestField: r.metrics.lowestField,
    lowestValue: r.metrics.lowestValue,
    topMixUp: mu ? (mu.kind === 'confused' ? `${mu.gold} tagged as ${mu.predicted} (${mu.count})` : `${mu.predicted ?? mu.gold} ${mu.kind} (${mu.count})`) : null,
  };
}
