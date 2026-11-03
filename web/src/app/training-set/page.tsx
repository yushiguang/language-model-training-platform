'use client';

import {useRouter, useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useState} from 'react';
import type {EndpointId, PromptVersion, TrainingRow, TrainingSet} from '@/core/types';
import {versionLabel} from '@/core/versions';
import {ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {approveNode, type ProjectState} from '@/services/projects';
import {estimate, MIN_PER_VALUE, pollTrainingSet, startTrainingSet, stopTrainingSet, trainingRows} from '@/services/training';
import {Badge, Button, Dialog, Icon, money, Note, Progress, StatusBadge, timeOf, num} from '@/ui';

export default function TrainingSetPage() {
  return (
    <Suspense fallback={null}>
      <TrainingRouter />
    </Suspense>
  );
}

function TrainingRouter() {
  const q = useSearchParams();
  return (
    <ProjectPage node="training" page={{label: 'Training Set', agent: 'front_desk', intent: 'answer', hint: 'Ask what the training set will cost, or what a label count means.', context: {}}} wide>
      {({state}) => <Training state={state} vParam={q.get('v')} mParam={q.get('m') as EndpointId | null} />}
    </ProjectPage>
  );
}

/** Best passing version per model, or the current version when nothing is evaluated. */
function candidates(state: ProjectState) {
  return state.setup!.models.map(m => {
    const mine = state.reports.filter(r => r.endpoint === m.endpoint && !r.archivedNow);
    const passing = mine.filter(r => r.passed).sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
    const best = [...mine].sort((a, b) => b.metrics.lowestField.macroF1 - a.metrics.lowestField.macroF1)[0];
    const version = state.versions.find(v => v.id === (passing ?? best)?.promptVersionId) ?? state.versions[0];
    return {endpoint: m.endpoint, version, passing: passing ?? null, best: best ?? null};
  });
}

function Training({state, vParam, mParam}: {state: ProjectState; vParam: string | null; mParam: EndpointId | null}) {
  const ts = state.trainingSets[0];
  if (ts && ts.state === 'done') return <Done state={state} ts={ts} />;
  return <Plan state={state} vParam={vParam} mParam={mParam} running={ts && (ts.state === 'running' || ts.state === 'failed' || ts.state === 'stopped') ? ts : null} />;
}

function Plan({state, vParam, mParam, running}: {state: ProjectState; vParam: string | null; mParam: EndpointId | null; running: TrainingSet | null}) {
  const {href} = useProject();
  const cands = useMemo(() => candidates(state), [state]);
  const evaluationOn = !!state.setup?.thresholds;
  const fromUrl = vParam && mParam ? {endpoint: mParam, version: state.versions.find(v => v.id === vParam)} : null;
  const [pick, setPick] = useState<{endpoint: EndpointId; version: PromptVersion} | null>(
    fromUrl?.version ? (fromUrl as {endpoint: EndpointId; version: PromptVersion}) : cands.length === 1 && cands[0].version ? {endpoint: cands[0].endpoint, version: cands[0].version} : null,
  );
  const [chooser, setChooser] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Keep polling while the batch job runs; the job continues if the page closes.
  useEffect(() => {
    if (!running || running.state !== 'running') return;
    const id = setInterval(() => void pollTrainingSet(state, running), 1500);
    return () => clearInterval(id);
  }, [running, state]);

  if (!state.versions.length) return <p>Create a prompt version first.</p>;
  if (running) return <Running state={state} ts={running} />;

  const sel = pick ?? (cands.find(c => c.passing) ? {endpoint: cands.find(c => c.passing)!.endpoint, version: cands.find(c => c.passing)!.version!} : {endpoint: cands[0].endpoint, version: state.versions[0]});
  const est = estimate(state, sel.version, sel.endpoint);
  const report = est.report;
  const passes = !!report && state.reports.find(r => r.id === report.id)?.passed;
  const t = state.setup!.thresholds;

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await startTrainingSet(state, sel.version, sel.endpoint, passes ? report : null, est.costUsd);
      setConfirm(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Training Set</span>
        <h1>Training Set</h1>
        <p className="muted">The model labels every train example with the chosen prompt. Invalid answers are dropped.</p>
      </div>
      <div className="card">
        <div className="row">
          <h2>What will be produced</h2>
          {passes ? <Badge label="Evaluated" tone="success" icon={<Icon name="check" size={12} />} /> : <Badge label="Not evaluated" tone="warning" icon={<Icon name="alert" size={12} />} />}
        </div>
        <dl className="kv">
          <dt>Prompt</dt>
          <dd className="row" style={{gap: 8}}>
            {versionLabel(sel.version)}
            {report && <Button label="report" variant="ghost" size="sm" href={href('/report', {v: sel.version.id, m: sel.endpoint})} />}
          </dd>
          <dt>Model</dt>
          <dd className="row" style={{gap: 8}}>
            Model {sel.endpoint}
            {cands.length > 1 && <Button label="change" variant="ghost" size="sm" onClick={() => setChooser(true)} />}
          </dd>
          <dt>Train examples</dt>
          <dd>{num(est.count)}</dd>
          <dt>Estimate</dt>
          <dd>
            about {money(est.costUsd)} · {est.minutes} min
          </dd>
        </dl>
        {report && (
          <div className="stats">
            {report.metrics.fields.map(f => (
              <div key={f.field} className="stat">
                <span className="small muted mono">{f.field}</span>
                <b>{f.macroF1.toFixed(2)}</b>
              </div>
            ))}
            <div className="stat">
              <span className="small muted">Invalid on eval</span>
              <b>{(report.metrics.invalidRate * 100).toFixed(1)}%</b>
            </div>
          </div>
        )}
        {report && <span className="small muted">Macro-F1 from the {versionLabel(sel.version)} report</span>}
        {!passes && evaluationOn && <Note>This version has not passed the threshold{t ? ` (lowest field ${t.macroF1.toFixed(2)})` : ''}. You can still generate, and the training set will be marked Not evaluated.</Note>}
      </div>
      <div className="next">
        <Button label="Approve and generate" variant="primary" size="lg" disabled={!est.count} onClick={() => (cands.length > 1 && !pick ? setChooser(true) : setConfirm(true))} />
        <span className="blocked">{est.count ? "You'll see the cost once more before anything is spent." : 'There are no train examples. Change the split on Dataset.'}</span>
      </div>
      {err && <Note tone="error">{err}</Note>}

      <Dialog open={chooser} onClose={() => setChooser(false)} title="Which model makes the training set?" subtitle="You picked two models in Setup. Each one's best passing version is shown.">
        <div className="col">
          {cands.map((c, i) => {
            const e = c.version ? estimate(state, c.version, c.endpoint) : null;
            const selected = sel.endpoint === c.endpoint;
            return (
              <label key={c.endpoint} className={`choice${selected ? ' selected' : ''}`}>
                <input type="radio" name="model" checked={selected} onChange={() => c.version && setPick({endpoint: c.endpoint, version: c.version})} />
                <span className="col grow" style={{gap: 4}}>
                  <span className="row" style={{gap: 8}}>
                    <b>
                      Model {c.endpoint}
                      {c.passing ? ` · ${versionLabel(c.version!)}` : ''}
                    </b>
                    {c.passing ? <StatusBadge passed /> : <span className="muted">No passing version yet</span>}
                    {c.passing && i === cands.findIndex(x => x.passing) && <Badge label="Recommended" />}
                  </span>
                  {c.passing ? (
                    <span className="small muted">
                      Lowest macro-F1 {c.passing.metrics.lowestField.macroF1.toFixed(2)} · {money(c.passing.metrics.costPer1000)} per 1,000 examples · {num(e!.count)} train examples, about {money(e!.costUsd)}, {e!.minutes} min
                    </span>
                  ) : (
                    <span className="small muted">
                      {c.best ? `Best so far ${versionLabel(state.versions.find(v => v.id === c.best!.promptVersionId)!)} at ${c.best.metrics.lowestField.macroF1.toFixed(2)} (${c.best.metrics.lowestField.field}).` : 'Not scored yet.'} You can wait and come back.
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          <p className="small muted">Setup stays as it is. Your choice is recorded on the training set.</p>
          <div className="row" style={{justifyContent: 'flex-end'}}>
            <Button label="Cancel" variant="ghost" onClick={() => setChooser(false)} />
            <Button
              label={`Continue with Model ${sel.endpoint}`}
              variant="primary"
              onClick={() => {
                setPick(sel);
                setChooser(false);
                setConfirm(true);
              }}
            />
          </div>
        </div>
      </Dialog>

      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Generate the training set?" subtitle={`Model ${sel.endpoint} labels ${num(est.count)} examples with prompt ${versionLabel(sel.version)}.`}>
        <div className="col">
          <div className="stats">
            <div className="stat">
              <span className="small muted">Estimated cost</span>
              <b>{money(est.costUsd)}</b>
            </div>
            <div className="stat">
              <span className="small muted">Estimated time</span>
              <b>{est.minutes} min</b>
            </div>
          </div>
          <p className="small muted">
            {report ? `Based on ${money(est.per1000)} per 1,000 examples from the eval runs. ` : 'Based on the prompt length, since this version has no eval run. '}
            You can leave the page; progress shows in the stepper. You can stop at any time and keep what&apos;s done.
          </p>
          <div className="row" style={{justifyContent: 'flex-end'}}>
            <Button label="Cancel" variant="ghost" onClick={() => setConfirm(false)} />
            <Button label={`Approve ${money(est.costUsd)} and generate`} variant="primary" loading={busy} onClick={go} />
          </div>
        </div>
      </Dialog>
    </>
  );
}

function Running({state, ts}: {state: ProjectState; ts: TrainingSet}) {
  const v = state.versions.find(x => x.id === ts.promptVersionId);
  const [err, setErr] = useState<string | null>(null);
  const restart = async () => {
    setErr(null);
    try {
      await startTrainingSet(state, v!, ts.endpoint, ts.reportId ? (state.reports.find(r => r.id === ts.reportId) ?? null) : null, ts.estimateUsd);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const left = Math.max(0, Math.round(((ts.total - ts.done) / Math.max(1, ts.total)) * estimate(state, v!, ts.endpoint).minutes));
  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Training Set</span>
        <h1>{ts.state === 'running' ? 'Generating the training set' : ts.state === 'failed' ? 'The training set stopped with an error' : 'The training set was stopped'}</h1>
        <p className="muted">
          Prompt {v ? versionLabel(v) : ''} · Model {ts.endpoint} · started {timeOf(ts.startedAt)} · approved {money(ts.estimateUsd)}
        </p>
      </div>
      <div className="card">
        <div className="row">
          <Progress value={ts.done} max={ts.total} />
          <span className="small">
            {num(ts.done)} of {num(ts.total)}
          </span>
        </div>
        {ts.state === 'running' && <span className="small muted">About {left} min left. You can leave this page; the job keeps running.</span>}
        {ts.error && <Note tone="error">{ts.error}</Note>}
      </div>
      <div className="next">
        {ts.state === 'running' ? (
          <Button label="Stop" size="lg" onClick={() => stopTrainingSet(ts)} />
        ) : (
          <>
            <Button label="Start again" variant="primary" size="lg" onClick={restart} />
            <span className="blocked">Starts a new batch job with the same prompt and model.</span>
          </>
        )}
      </div>
      {err && <Note tone="error">{err}</Note>}
    </>
  );
}

function Done({state, ts}: {state: ProjectState; ts: TrainingSet}) {
  const router = useRouter();
  const {href} = useProject();
  const [rows, setRows] = useState<TrainingRow[] | null>(null);
  const [show, setShow] = useState(5);
  useEffect(() => {
    void trainingRows(ts.id).then(setRows);
  }, [ts.id]);
  const v = state.versions.find(x => x.id === ts.promptVersionId);
  const schema = state.setup!.schema!;
  const byId = useMemo(() => new Map(state.examples.map(e => [e.id, e])), [state.examples]);
  const good = (rows ?? []).filter(r => r.answer);
  const counts = schema.fields.map(f => ({
    field: f,
    values: f.values.map(val => ({name: val.name, n: good.filter(r => r.answer![f.name]?.includes(val.name)).length})).sort((a, b) => b.n - a.n),
  }));
  const low = counts.flatMap(c => c.values.filter(x => x.n < MIN_PER_VALUE).map(x => ({field: c.field.name, ...x})));
  const invalidRate = ts.total ? ts.invalid / ts.total : 0;
  const limit = state.setup?.thresholds?.invalidRate;
  const took = ts.finishedAt ? Math.max(1, Math.round((Date.parse(ts.finishedAt) - Date.parse(ts.startedAt)) / 60000)) : null;
  const approved = state.project.approvedNodes.includes('training');

  const download = (kind: 'csv' | 'jsonl') => {
    const lines =
      kind === 'jsonl'
        ? good.map(r => JSON.stringify({id: byId.get(r.exampleId)?.externalId, title: byId.get(r.exampleId)?.title, answer: r.answer}))
        : [['id', 'title', ...schema.fields.map(f => f.name)].join(','), ...good.map(r => [byId.get(r.exampleId)?.externalId ?? '', byId.get(r.exampleId)?.title ?? '', ...schema.fields.map(f => (r.answer![f.name] ?? []).join('; '))].map(csvCell).join(','))];
    const blob = new Blob([lines.join('\n') + '\n'], {type: kind === 'csv' ? 'text/csv' : 'application/x-ndjson'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `training-set-${v ? versionLabel(v) : ts.id}-model-${ts.endpoint}.${kind}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Training Set</span>
        <div className="row">
          <h1>Training Set</h1>
          {ts.evaluated ? <Badge label="Evaluated" tone="success" icon={<Icon name="check" size={12} />} /> : <Badge label="Not evaluated" tone="warning" icon={<Icon name="alert" size={12} />} />}
          <span className="right row" style={{gap: 8}}>
            <Button label="CSV" size="sm" icon={<Icon name="download" />} onClick={() => download('csv')} disabled={!rows} />
            <Button label="Export JSONL" size="sm" icon={<Icon name="download" />} onClick={() => download('jsonl')} disabled={!rows} />
          </span>
        </div>
        <p className="muted">
          Prompt {v ? versionLabel(v) : ''} · Model {ts.endpoint} · finished {ts.finishedAt ? timeOf(ts.finishedAt) : ''} · cost {money(ts.costUsd)}
        </p>
      </div>
      <div className="stats">
        <div className="stat">
          <span className="small muted">Labeled examples</span>
          <b>{num(ts.labeled)}</b>
          <span className="small muted">of {num(ts.total)} train examples</span>
        </div>
        <div className="stat">
          <span className="small muted">Invalid, dropped</span>
          <b>{(invalidRate * 100).toFixed(1)}%</b>
          <span className="small muted">
            {num(ts.invalid)} answers{limit != null ? ` · limit ${(limit * 100).toFixed(0)}%` : ''}
          </span>
        </div>
        <div className="stat">
          <span className="small muted">Progress</span>
          <b>100%</b>
          {took && <span className="small muted">took {took} min</span>}
        </div>
      </div>
      {low.length > 0 && (
        <div className="banner">
          <Icon name="alert" />
          <span className="grow">
            {low
              .slice(0, 3)
              .map(l => `${l.name} (${l.field}) has only ${l.n} example${l.n === 1 ? '' : 's'}`)
              .join('; ')}
            {low.length > 3 ? ` and ${low.length - 3} more` : ''}, below the minimum of {MIN_PER_VALUE}. The model you train may learn {low.length > 1 ? 'them' : 'it'} poorly.
          </span>
          <Button label="Add examples" size="sm" href={href('/dataset')} />
        </div>
      )}
      <div className="card tight">
        <div className="card-head">
          <h2>Label counts</h2>
        </div>
        <div className="stats" style={{padding: 12, alignItems: 'start'}}>
          {counts.map(c => (
            <div key={c.field.name} className="col" style={{gap: 6}}>
              <span className="row" style={{gap: 6}}>
                <b className="mono">{c.field.name}</b>
                <span className="small muted">{c.field.kind === 'multi' ? `Multi-select${c.field.max ? `, up to ${c.field.max}` : ''}` : 'Single-select'}</span>
              </span>
              {c.values.map(x => (
                <span key={x.name} className="row small" style={{gap: 8}}>
                  <span style={{width: 130}}>{x.name}</span>
                  <span className="bar">
                    <span style={{width: `${good.length ? (100 * x.n) / Math.max(...c.values.map(y => y.n), 1) : 0}%`}} />
                  </span>
                  <span style={{width: 40, textAlign: 'right'}}>{num(x.n)}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="card tight">
        <div className="card-head">
          <h2>Sample rows</h2>
        </div>
        <div className="scroll-x">
          <table className="t">
            <thead>
              <tr>
                <th>Post</th>
                {schema.fields.map(f => (
                  <th key={f.name} className="mono">
                    {f.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {good.slice(0, show).map(r => (
                <tr key={r.exampleId}>
                  <td>{byId.get(r.exampleId)?.title}</td>
                  {schema.fields.map(f => (
                    <td key={f.name}>{(r.answer![f.name] ?? []).join(', ')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {good.length > show && (
          <div style={{padding: '8px 12px'}}>
            <Button label="Show 10 more" variant="ghost" size="sm" onClick={() => setShow(s => s + 10)} />
          </div>
        )}
      </div>
      <div className="next">
        <Button
          label={approved ? 'Back to projects' : 'Finish project'}
          variant="primary"
          size="lg"
          onClick={async () => {
            if (!approved) await approveNode(state.project.id, 'training');
            router.push('/');
          }}
        />
        <span className="blocked">
          Finished · {(invalidRate * 100).toFixed(1)}% invalid
        </span>
      </div>
    </>
  );
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

