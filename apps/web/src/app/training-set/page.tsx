'use client';

import {useRouter, useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useState} from 'react';
import type {EndpointId, PromptVersion, TrainingRow, TrainingSet} from '@tsp/contracts';
import {outputCandidates, versionLabel} from '@tsp/domain';
import {ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {useLabeledTest} from '@/components/useLabeledTest';
import {estimate, finalRunPlan, MIN_PER_VALUE} from '@tsp/domain';
import {
  approveNode,
  startTrainingSet,
  stopTrainingSet,
  tick,
  track,
  trainingRows,
  type ProjectState,
} from '@/backend-api';
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

function Training({state, vParam, mParam}: {state: ProjectState; vParam: string | null; mParam: EndpointId | null}) {
  useEffect(() => {
    void tick(state);
  }, [state]);
  const ts = state.trainingSets[0];
  if (ts && ts.state === 'done') return <Done state={state} ts={ts} />;
  return (
    <Plan
      state={state}
      vParam={vParam}
      mParam={mParam}
      running={ts && (ts.state === 'running' || ts.state === 'paused' || ts.state === 'failed' || ts.state === 'stopped') ? ts : null}
    />
  );
}

function Plan({state, vParam, mParam, running}: {state: ProjectState; vParam: string | null; mParam: EndpointId | null; running: TrainingSet | null}) {
  const {href} = useProject();
  const cands = useMemo(() => outputCandidates(state), [state]);
  const evaluationOn = !!state.setup?.thresholds;
  const fromUrl = vParam && mParam ? {endpoint: mParam, version: state.versions.find(v => v.id === vParam)} : null;
  const [pick, setPick] = useState<{endpoint: EndpointId; version: PromptVersion} | null>(
    fromUrl?.version ? (fromUrl as {endpoint: EndpointId; version: PromptVersion}) : cands.length === 1 && cands[0].version ? {endpoint: cands[0].endpoint, version: cands[0].version} : null,
  );
  const [chooser, setChooser] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [labelTest, setLabelTest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sel = pick ?? (cands.find(c => c.passing) ? {endpoint: cands.find(c => c.passing)!.endpoint, version: cands.find(c => c.passing)!.version!} : {endpoint: cands[0]?.endpoint, version: state.versions[0]});
  const labeled = useLabeledTest(state, sel.version, sel.endpoint);

  if (!state.versions.length) return <p>Create a prompt version first.</p>;
  if (running) return <Running state={state} ts={running} />;

  const plan = finalRunPlan(state, sel.version, sel.endpoint, labeled);
  const est = plan.train;
  const tp = plan.test;
  const total = plan.total(labelTest && tp.toLabel.length > 0);
  const report = plan.report;
  const vName = versionLabel(sel.version);
  const openConfirm = () => {
    setConfirm(true);
    track('final_run_confirm_shown', {train: est.count, test_to_label: tp.toLabel.length, test_with_gold: tp.withGold.length, test_with_answers: tp.withAnswer.length, estimate_usd: total.costUsd, evaluated: !!passes});
  };
  const passes = !!report && state.reports.find(r => r.id === report.id)?.passed;
  const t = state.setup!.thresholds;

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await startTrainingSet(state.project.id, sel.version, sel.endpoint, passes ? report : null, total.costUsd, {labelTest: labelTest && tp.toLabel.length > 0});
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
        <h1>Training and test sets</h1>
        <p className="muted">The model labels every train example with the chosen prompt. Test examples keep their gold label or the model answer they already have; you choose whether the model labels the rest. These two sets are what you take to model training. Invalid answers are dropped.</p>
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
          <dt>Test examples</dt>
          <dd>
            {num(tp.total)}
            <span className="small muted">
              {' '}
              · {num(tp.withGold.length)} with a gold label · {num(tp.withAnswer.length)} with an answer from {vName} · {num(tp.toLabel.length)} with no label
            </span>
          </dd>
          <dt>Estimate</dt>
          <dd>
            about {money(total.costUsd)} · {total.minutes} min{tp.toLabel.length > 0 && labelTest ? ' (with the test examples that have no label)' : ''}
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
        <Button label="Approve and generate" variant="primary" size="lg" disabled={!est.count && !tp.toLabel.length} onClick={() => (cands.length > 1 && !pick ? setChooser(true) : openConfirm())} />
        <span className="blocked">{est.count || tp.toLabel.length ? "You'll see the cost once more before anything is spent." : 'There are no train examples. Change the split on Dataset.'}</span>
      </div>
      {err && <Note tone="error">{err}</Note>}

      <Dialog open={chooser} onClose={() => setChooser(false)} title="Which model makes the training and test sets?" subtitle="You picked two models in Setup. Each one's best passing version is shown.">
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
                      Lowest macro-F1 {c.passing.metrics.lowestField.macroF1.toFixed(2)} · {money(c.passing.metrics.costPer1000)} per 1,000 examples · {num(e!.count)} train and test examples, about {money(e!.costUsd)}, {e!.minutes} min
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
                openConfirm();
              }}
            />
          </div>
        </div>
      </Dialog>

      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Generate the training and test sets?" subtitle={`Model ${sel.endpoint} labels with prompt ${vName}.`}>
        <div className="col">
          <div className="confirm-lines">
            <div className="confirm-line">
              <b>Training set</b>
              <span className="grow">{num(est.count)} examples{est.reused ? `, ${num(est.reused)} already labeled` : ''}</span>
              <span>about {money(est.costUsd)}</span>
            </div>
            <div className="confirm-line">
              <b>Test set</b>
              {tp.toLabel.length > 0 ? (
                <label className="grow row" style={{gap: 8, alignItems: 'flex-start'}}>
                  <input type="checkbox" checked={labelTest} onChange={e => setLabelTest(e.target.checked)} aria-label="Label the test examples that have no label" />
                  <span>
                    {num(tp.withGold.length)} have a gold label, {num(tp.withAnswer.length)} have an answer from {vName}. Label the other {num(tp.toLabel.length)}?
                  </span>
                </label>
              ) : (
                <span className="grow">
                  {num(tp.withGold.length)} have a gold label, {num(tp.withAnswer.length)} have an answer from {vName}. Nothing to label.
                </span>
              )}
              <span>{tp.toLabel.length > 0 ? (labelTest ? `about ${money(tp.costUsd)}` : 'skipped') : '$0.00'}</span>
            </div>
          </div>
          {tp.toLabel.length > 0 && !labelTest && <span className="small muted">The {num(tp.toLabel.length)} test examples with no label stay out of the test set. You can label them on Gold Labels.</span>}
          <div className="stats">
            <div className="stat">
              <span className="small muted">Estimated cost</span>
              <b>{money(total.costUsd)}</b>
            </div>
            <div className="stat">
              <span className="small muted">Estimated time</span>
              <b>{total.minutes} min</b>
            </div>
          </div>
          <p className="small muted">
            {report ? `Based on ${money(plan.per1000)} per 1,000 examples from the eval runs. ` : 'Based on the prompt length, since this version has no eval run. '}
            You can leave the page; progress shows in the stepper. You can stop at any time and keep what&apos;s done.
          </p>
          <div className="row" style={{justifyContent: 'flex-end'}}>
            <Button
              label="Cancel"
              variant="ghost"
              onClick={() => {
                setConfirm(false);
              }}
            />
            <Button label={`Approve ${money(total.costUsd)} and generate`} variant="primary" loading={busy} onClick={go} />
          </div>
        </div>
      </Dialog>
    </>
  );
}

function Running({state, ts}: {state: ProjectState; ts: TrainingSet}) {
  const v = state.versions.find(x => x.id === ts.promptVersionId);
  const [err, setErr] = useState<string | null>(null);
  const resume = async () => {
    setErr(null);
    try {
      await startTrainingSet(
        state.project.id,
        v!,
        ts.endpoint,
        ts.reportId ? (state.reports.find(r => r.id === ts.reportId) ?? null) : null,
        ts.estimateUsd,
        {existing: ts},
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const left = Math.max(0, Math.round(((ts.total - ts.done) / Math.max(1, ts.total)) * estimate(state, v!, ts.endpoint).minutes));
  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Training Set</span>
        <h1>
          {ts.state === 'running'
            ? 'Generating the training and test sets'
            : ts.state === 'paused'
              ? 'Generating the sets is paused'
              : ts.state === 'failed'
                ? 'Generating the sets stopped with an error'
                : 'Generating the sets was stopped'}
        </h1>
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
        {ts.state === 'running' && <span className="small muted">About {left} min left. Keep this page open while labeling runs; if closed, you can resume from what is already saved.</span>}
        {ts.error && <Note tone="error">{ts.error}</Note>}
      </div>
      <div className="next">
        {ts.state === 'running' ? (
          <Button label="Stop" size="lg" onClick={() => stopTrainingSet(ts.id)} />
        ) : (
          <>
            <Button label={ts.failed > 0 ? 'Retry failed' : 'Resume'} variant="primary" size="lg" onClick={resume} />
            <span className="blocked">
              Continues from the {num(ts.done)} examples already labeled{ts.failed > 0 ? `; tries the ${num(ts.failed)} that failed again` : ''}.
            </span>
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
  const [tab, setTab] = useState<'train' | 'test'>('train');
  const [show, setShow] = useState(5);
  useEffect(() => {
    void trainingRows(ts.id).then(setRows);
  }, [ts.id]);
  const v = state.versions.find(x => x.id === ts.promptVersionId);
  const schema = state.setup!.schema!;
  const byId = useMemo(() => new Map(state.examples.map(e => [e.id, e])), [state.examples]);
  const good = (rows ?? []).filter(r => r.answer && r.split === 'train');
  const testRows = (rows ?? []).filter(r => r.split === 'test');
  const goodTest = testRows.filter(r => r.answer);
  const fromGold = goodTest.filter(r => r.labelSource === 'gold').length;
  const fromModel = goodTest.length - fromGold;
  const unlabeled = testRows.length - goodTest.length;
  const agreeing = testRows.filter(r => r.gold && r.model && schema.fields.every(f => sameValues(r.gold![f.name], r.model![f.name]))).length;
  const withBoth = testRows.filter(r => r.gold && r.model).length;
  const trainTotal = ts.trainTotal ?? ts.total;
  const testTotal = ts.testTotal ?? 0;
  const counts = schema.fields.map(f => ({
    field: f,
    values: f.values.map(val => ({name: val.name, n: good.filter(r => r.answer![f.name]?.includes(val.name)).length})).sort((a, b) => b.n - a.n),
  }));
  const low = counts.flatMap(c => c.values.filter(x => x.n < MIN_PER_VALUE).map(x => ({field: c.field.name, ...x})));
  const invalidRate = ts.total ? ts.invalid / ts.total : 0;
  const limit = state.setup?.thresholds?.invalidRate;
  const took = ts.finishedAt ? Math.max(1, Math.round((Date.parse(ts.finishedAt) - Date.parse(ts.startedAt)) / 60000)) : null;
  const approved = state.project.approvedNodes.includes('training');
  const shown = tab === 'train' ? good : testRows;

  const save = (name: string, lines: string[], type: string, ext: 'csv' | 'jsonl') => {
    const blob = new Blob([lines.join('\n') + '\n'], {type});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-${v ? versionLabel(v) : ts.id}-model-${ts.endpoint}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const name = (split: 'train' | 'test') => (split === 'train' ? 'training-set' : 'test-set');
  const jsonl = (split: 'train' | 'test') => {
    const rs = split === 'train' ? good : goodTest;
    const lines = rs.map(r => JSON.stringify({id: byId.get(r.exampleId)?.externalId, title: byId.get(r.exampleId)?.title, answer: r.answer, ...(split === 'test' ? {label_source: r.labelSource, gold: r.gold, model: r.model} : {})}));
    save(name(split), lines, 'application/x-ndjson', 'jsonl');
    track('export_downloaded', {set: split === 'train' ? 'training' : 'test', format: 'jsonl', rows: rs.length});
  };
  const csv = (split: 'train' | 'test') => {
    const rs = split === 'train' ? good : goodTest;
    const head = ['id', 'title', ...schema.fields.map(f => f.name), ...(split === 'test' ? ['label_source'] : [])];
    const lines = [
      head.join(','),
      ...rs.map(r => [byId.get(r.exampleId)?.externalId ?? '', byId.get(r.exampleId)?.title ?? '', ...schema.fields.map(f => (r.answer![f.name] ?? []).join('; ')), ...(split === 'test' ? [r.labelSource ?? ''] : [])].map(csvCell).join(',')),
    ];
    save(name(split), lines, 'text/csv', 'csv');
    track('export_downloaded', {set: split === 'train' ? 'training' : 'test', format: 'csv', rows: rs.length});
  };

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Training Set</span>
        <div className="row">
          <h1>Training and test sets</h1>
          {ts.evaluated ? <Badge label="Evaluated" tone="success" icon={<Icon name="check" size={12} />} /> : <Badge label="Not evaluated" tone="warning" icon={<Icon name="alert" size={12} />} />}
        </div>
        <p className="muted">
          Prompt {v ? versionLabel(v) : ''} · Model {ts.endpoint} · finished {ts.finishedAt ? timeOf(ts.finishedAt) : ''} · cost {money(ts.costUsd)}
          {took ? ` · took ${took} min` : ''}
        </p>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'train'} className={tab === 'train' ? 'on' : ''} onClick={() => (setTab('train'), setShow(5))}>
          Training set <span className="muted">{num(good.length)}</span>
        </button>
        <button role="tab" aria-selected={tab === 'test'} className={tab === 'test' ? 'on' : ''} onClick={() => (setTab('test'), setShow(5))}>
          Test set <span className="muted">{num(goodTest.length)}</span>
        </button>
        <span className="right row" style={{gap: 8}}>
          <Button label="Download JSONL" size="sm" icon={<Icon name="download" />} onClick={() => jsonl(tab)} disabled={!rows || !(tab === 'train' ? good : goodTest).length} />
          <Button label="Download CSV" size="sm" icon={<Icon name="download" />} onClick={() => csv(tab)} disabled={!rows || !(tab === 'train' ? good : goodTest).length} />
        </span>
      </div>
      {tab === 'train' ? (
        <div className="stats">
          <div className="stat">
            <span className="small muted">Labeled</span>
            <b>{num(good.length)}</b>
            <span className="small muted">of {num(trainTotal)} train examples</span>
          </div>
          <div className="stat">
            <span className="small muted">Invalid, dropped</span>
            <b>{(invalidRate * 100).toFixed(1)}%</b>
            <span className="small muted">
              {num(ts.invalid)} answers{limit != null ? ` · limit ${(limit * 100).toFixed(0)}%` : ''}
            </span>
          </div>
        </div>
      ) : (
        <div className="stats">
          <div className="stat">
            <span className="small muted">Labeled</span>
            <b>{num(goodTest.length)}</b>
            <span className="small muted">of {num(testTotal)} test examples</span>
          </div>
          <div className="stat">
            <span className="small muted">Gold labels</span>
            <b>{num(fromGold)}</b>
            <span className="small muted">{withBoth ? `model agrees on ${num(agreeing)} of ${num(withBoth)}` : 'given by people'}</span>
          </div>
          <div className="stat">
            <span className="small muted">Model answers</span>
            <b>{num(fromModel)}</b>
            <span className="small muted">from {v ? versionLabel(v) : 'this version'}</span>
          </div>
          <div className="stat">
            <span className="small muted">No label</span>
            <b>{num(unlabeled)}</b>
            <span className="small muted">{unlabeled ? 'left out of the download' : 'every example has a label'}</span>
          </div>
        </div>
      )}
      {tab === 'train' && low.length > 0 && (
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
      {tab === 'test' && unlabeled > 0 && (
        <Note>
          {num(unlabeled)} test example{unlabeled === 1 ? ' has' : 's have'} no label. Add gold labels or model answers on <a href={href('/gold')}>Gold Labels</a>.
        </Note>
      )}
      {tab === 'train' && (
        <div className="card tight">
          <div className="card-head">
            <h2>Label counts in the training set</h2>
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
      )}
      <div className="card tight">
        <div className="card-head">
          <h2>{tab === 'train' ? 'Training set rows' : 'Test set rows'}</h2>
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
                {tab === 'test' && <th>Label from</th>}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, show).map(r => (
                <tr key={r.exampleId}>
                  <td>{byId.get(r.exampleId)?.title}</td>
                  {schema.fields.map(f => (
                    <td key={f.name}>{r.answer ? (r.answer[f.name] ?? []).join(', ') : <span className="muted">—</span>}</td>
                  ))}
                  {tab === 'test' && <td className="small">{r.labelSource === 'gold' ? <Badge label="Gold" tone="success" /> : r.labelSource === 'model' ? <Badge label="Model" /> : <span className="muted">No label</span>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length > show && (
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
          Finished · {num(good.length)} train and {num(goodTest.length)} test rows
        </span>
      </div>
    </>
  );
}

const sameValues = (a: string[] | undefined, b: string[] | undefined) => {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

