'use client';

import {useRouter} from 'next/navigation';
import {useEffect, useState} from 'react';
import {gate} from '@/core/gates';
import {ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {
  applySplit,
  approveNode,
  getSamplePoolSize,
  startSampleDataset,
  stopSampleDataset,
  uploadDatasetFile,
  type ProjectState,
} from '@/backend-api';
import {Badge, Button, Icon, Note, num, Progress, timeOf} from '@/ui';
import {NotYet} from '@/components/NotYet';

export default function DatasetPage() {
  return (
    <ProjectPage node="dataset" page={{label: 'Dataset', agent: 'front_desk', intent: 'answer', hint: 'Ask how big the eval and test sets should be.', context: {}}}>
      {({state, href}) => (state.facts.approved.includes('setup') ? <Dataset state={state} /> : <NotYet text="Finish Setup first." to={href('/setup')} />)}
    </ProjectPage>
  );
}

function recommended(total: number, minEval: number | null) {
  const evalSize = minEval == null ? 0 : Math.min(total - 2, Math.max(minEval, Math.round(total * 0.35)));
  const test = Math.max(1, Math.round(total * 0.1));
  return {evalSize, test};
}

function Dataset({state}: {state: ProjectState}) {
  const snap = state.snapshot;
  const sampling = state.samplingTask;
  if (sampling && !snap)
    return (
      <>
        <Head />
        <div className="card">
          <div className="row">
            <span className="col grow" style={{gap: 2}}>
              <span style={{fontWeight: 600}}>Sampling {num(sampling.total)} examples from the platform</span>
              <span className="small muted">Started {timeOf(sampling.startedAt)} · you can leave this page</span>
            </span>
            <Button label="Stop" onClick={() => stopSampleDataset(state.project.id)} />
          </div>
          <div className="row">
            <Progress value={sampling.fetched} max={sampling.total} />
            <span className="small muted">
              {num(sampling.fetched)} / {num(sampling.total)}
            </span>
          </div>
        </div>
        <div className="card">
          <h2>Split dataset</h2>
          <p className="muted">You can set the sizes when sampling finishes.</p>
        </div>
      </>
    );
  if (!snap)
    return (
      <Empty
        state={state}
        onSample={n => {
          void startSampleDataset(state.project.id, n);
        }}
      />
    );
  return <Split state={state} />;
}

function Head() {
  return (
    <div className="page-head">
      <h1>Dataset</h1>
      <p className="muted">The examples the model will label, split into eval, test and train sets.</p>
    </div>
  );
}

function Empty({state, onSample}: {state: ProjectState; onSample: (n: number) => void}) {
  const [available, setAvailable] = useState(0);
  const [n, setN] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getSamplePoolSize().then(a => setAvailable(a));
  }, []);
  const upload = async (f: File) => {
    setBusy(true);
    const res = await uploadDatasetFile(state.project.id, f);
    setErr(res.error ?? null);
    setBusy(false);
  };
  return (
    <>
      <div className="page-head">
        <h1>Dataset</h1>
        <p className="muted">Add the examples the model will label. Choose one way to start.</p>
      </div>
      <div className="card">
        <h2>Upload a file</h2>
        <p className="muted">
          A JSONL file of examples with their features, or a CSV or JSONL file with a <code>video_id</code> column. Use this when you already have the examples you want.
        </p>
        <label className="row" style={{border: '1.5px dashed var(--line-2)', borderRadius: 12, padding: 20, justifyContent: 'center', cursor: 'pointer'}}>
          <Icon name="upload" />
          <span>Choose a file</span>
          <input type="file" className="sr-only" accept=".csv,.jsonl,.json" onChange={e => e.target.files?.[0] && void upload(e.target.files[0])} disabled={busy} />
        </label>
        {err && <Note tone="error">{err}</Note>}
      </div>
      <div className="card">
        <h2>Sample from the platform</h2>
        <p className="muted">The system picks examples at random from its data. Use this when you don&apos;t have a list yet.</p>
        <div className="row">
          <label htmlFor="n">How many examples?</label>
          <input id="n" className="num" type="number" min={1} max={available} value={n} placeholder={String(available)} onChange={e => setN(e.target.value)} />
          <Button label={`Use ${num(available)}`} size="sm" onClick={() => setN(String(available))} />
          <span className="small muted">That is every example available.</span>
        </div>
        <div>
          <Button label="Sample examples" variant="primary" size="lg" disabled={!available} onClick={() => onSample(Math.min(available, parseInt(n) || available))} />
        </div>
      </div>
    </>
  );
}

function Split({state}: {state: ProjectState}) {
  const router = useRouter();
  const {href} = useProject();
  const snap = state.snapshot!;
  const t = state.setup?.thresholds ?? null;
  const total = snap.counts.valid;
  const rec = recommended(total, t?.minEval ?? null);
  const [evalSize, setEval] = useState(String(snap.split?.eval ?? rec.evalSize));
  const [test, setTest] = useState(snap.split ? String(snap.split.test) : '');
  const [err, setErr] = useState<string | null>(null);
  const locked = state.gold.size > 0;
  const e = parseInt(evalSize) || 0;
  const te = parseInt(test) || 0;
  const train = Math.max(0, total - e - te);
  const dirty = !snap.split || snap.split.eval !== e || snap.split.test !== te;
  const g = gate('dataset', state.facts);
  const evalOn = !!t;

  const apply = async () => {
    if (e + te >= total) return setErr('Leave some examples for train.');
    if (evalOn && e < t!.minEval) return setErr(`The eval set needs at least ${t!.minEval} examples.`);
    setErr(null);
    await applySplit(state.project.id, snap.id, e, te);
  };
  const next = async () => {
    await approveNode(state.project.id, 'dataset');
    router.push(href(evalOn ? '/gold' : '/prompt'));
  };

  return (
    <>
      <Head />
      <div className="card">
        <div className="row">
          <span className="col grow" style={{gap: 2}}>
            <span style={{fontWeight: 600}}>{snap.sourceName}</span>
            <span className="small muted">
              {snap.source === 'sample' ? 'Sampled' : 'Uploaded file'} · {timeOf(snap.createdAt)} · {num(snap.counts.video)} videos · {num(snap.counts.photoText)} photo&amp;text
            </span>
          </span>
        </div>
        <div className="stats">
          <span className="stat">
            <span className="small muted">Rows</span>
            <b>{num(snap.counts.rows)}</b>
          </span>
          <span className="stat">
            <span className="small muted">Valid</span>
            <b>{num(snap.counts.valid)}</b>
          </span>
          <span className="stat">
            <span className="small muted">Invalid</span>
            <b>{num(snap.counts.invalid)}</b>
          </span>
        </div>
      </div>
      <div className="card">
        <div className="col" style={{gap: 2}}>
          <h2>Split dataset</h2>
          <p className="muted">Set the eval and test sizes. Everything else goes to train.</p>
        </div>
        {evalOn && (
          <div className="check-row">
            <span className="grow col" style={{gap: 0}}>
              <span className="row" style={{gap: 6, fontWeight: 500}}>
                Eval size {e === rec.evalSize && <Badge label="Recommended" />}
              </span>
              <span className="small muted">Checks prompt quality. The optimiser learns from half and is scored on the other half; at least {t!.minEval}.</span>
            </span>
            <input className="num" type="number" aria-label="Eval size" value={evalSize} disabled={locked} onChange={x => setEval(x.target.value)} />
          </div>
        )}
        <div className="check-row">
          <span className="grow col" style={{gap: 0}}>
            <span className="row" style={{gap: 6, fontWeight: 500}}>
              Test size {te === rec.test && <Badge label="Recommended" />}
            </span>
            <span className="small muted">Kept aside to test the model you train later. Needs gold labels, any time.</span>
          </span>
          {!test && !locked && <Button label={`Use ${rec.test}`} size="sm" onClick={() => setTest(String(rec.test))} />}
          <input className="num" type="number" aria-label="Test size" value={test} disabled={locked} placeholder="0" onChange={x => setTest(x.target.value)} />
        </div>
        <div className="split-bar" aria-hidden="true">
          {evalOn && (
            <div className="seg-eval" style={{flex: Math.max(e, 1)}}>
              Eval {num(e)}
            </div>
          )}
          {te ? (
            <div className="seg-test" style={{flex: te}}>
              Test {num(te)}
            </div>
          ) : (
            <div className="seg-empty">Test 0</div>
          )}
          <div className="seg-train" style={{flex: Math.max(train, 1)}}>
            Train {num(train)}
          </div>
        </div>
        <div className="col small" style={{gap: 4}}>
          {evalOn && (
            <span>
              <b>Eval</b> · {num(e)} examples · <span className="muted">The optimiser learns from {Math.ceil(e / 2)} and is scored on the other {Math.floor(e / 2)}</span>
            </span>
          )}
          <span>
            <b>Test</b> · {num(te)} examples · <span className="muted">Never shown to the model or the optimiser</span>
          </span>
          <span>
            <b>Train</b> · {num(train)} examples · <span className="muted">Labeled by the model to become the training set</span>
          </span>
        </div>
        {!locked && (
          <div className="row">
            <Button label={snap.split ? 'Apply new sizes' : 'Apply'} variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || !te} onClick={apply} />
            {!te && <span className="blocked">Set the test size to continue.</span>}
          </div>
        )}
        {locked && <p className="small muted">The split is fixed because gold labels exist for it.</p>}
        {err && <Note tone="error">{err}</Note>}
      </div>
      <div className="next">
        <Button label={evalOn ? 'Next step: Gold Labels' : 'Next step: Prompt Engineering'} variant={g.ready && !dirty ? 'primary' : 'secondary'} size="lg" icon={<Icon name="arrow" />} disabled={!g.ready || dirty} onClick={next} />
        <span className="blocked">{g.ready && !dirty ? `${num(snap.split!.eval)} eval · ${num(snap.split!.test)} test · ${num(snap.split!.train)} train` : g.reason ?? 'Apply the sizes to continue.'}</span>
      </div>
    </>
  );
}
