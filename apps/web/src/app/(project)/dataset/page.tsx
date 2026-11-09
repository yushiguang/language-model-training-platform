'use client';

import {useRouter} from 'next/navigation';
import {useEffect, useRef, useState} from 'react';
import {gate} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {applySplit, approveNode, getSamplePoolSize, startSampleDataset, stopSampleDataset, uploadDatasetFile, type ProjectState} from '@/backend-api';
import {Badge, Button, Card, CenterProgress, dateTime, Empty, Field, Hov, LinkChip, Metric, Metrics, num, PageHead} from '@/ui';

export default function DatasetPage() {
  return (
    <ProjectPage node="dataset" page={{label: 'Dataset', agent: 'front_desk', intent: 'answer', hint: 'Ask how big the eval and test sets should be.', context: {}}}>
      {({state}) => <Dataset state={state} />}
    </ProjectPage>
  );
}

function Dataset({state}: {state: ProjectState}) {
  const snap = state.snapshot;
  const task = state.samplingTask?.state === 'running' ? state.samplingTask : null;
  // Split sizes save a moment after typing; Next saves any change still waiting first, and is off
  // while the sizes are invalid, so the step never moves on with old numbers.
  const flush = useRef<() => Promise<void>>(async () => undefined);
  const [splitOk, setSplitOk] = useState(true);
  const head = <PageHead title="Dataset" actions={snap && !task ? <NextButton state={state} flush={flush} splitOk={splitOk} /> : undefined} />;
  if (task)
    return (
      <Frame head={head}>
        <CenterProgress
          title={task.kind === 'upload' ? `Loading features for ${num(task.total)} items` : `Sampling ${num(task.total)} examples`}
          chip={task.kind === 'upload' && task.fileName ? <LinkChip text={task.fileName} /> : undefined}
          done={task.fetched}
          total={task.total}
          startedAt={task.startedAt}
          onStop={() => stopSampleDataset(state.project.id)}
        />
      </Frame>
    );
  if (!snap)
    return (
      <Frame head={head}>
        <Start state={state} />
      </Frame>
    );
  return (
    <Frame head={head}>
      <Ready state={state} flush={flush} onValid={setSplitOk} />
    </Frame>
  );
}

function Start({state}: {state: ProjectState}) {
  const [n, setN] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The default goes straight into the box: every example available.
    getSamplePoolSize().then(a => setN(cur => cur || String(a)));
  }, []);
  const upload = async (f: File) => {
    setErr(null);
    const res = await uploadDatasetFile(state.project.id, f);
    if (res.error) setErr(res.error);
    if (file.current) file.current.value = '';
  };
  return (
    <Empty title="No examples yet" text="Upload a file of item IDs, or let the platform pick examples at random.">
      <div className="row" style={{gap: 12}}>
        <Button label="Upload dataset" icon="upload" onClick={() => file.current?.click()} />
        <input ref={file} type="file" className="sr-only" accept=".txt,.csv,.jsonl,.json" aria-label="Upload dataset" onChange={e => e.target.files?.[0] && void upload(e.target.files[0])} />
        <span className="t-3">or</span>
        <input className="input sm" style={{width: 80, textAlign: 'center', padding: '0 8px'}} aria-label="Example count" value={n} onChange={e => setN(e.target.value.replace(/\D/g, ''))} />
        <Button label="Auto sampling" kind="primary" icon="shuffle" disabled={!(parseInt(n) > 0)} onClick={() => void startSampleDataset(state.project.id, parseInt(n))} />
      </div>
      {err && (
        <p className="t-err" style={{marginTop: 12, marginBottom: 0}}>
          {err}
        </p>
      )}
    </Empty>
  );
}

function recommended(total: number, minEval: number | null) {
  const evalSize = minEval == null ? 0 : Math.min(total - 2, Math.max(minEval, Math.round(total * 0.35)));
  const test = Math.max(1, Math.round(total * 0.1));
  return {evalSize, test};
}

function NextButton({state, flush, splitOk}: {state: ProjectState; flush: {current: () => Promise<void>}; splitOk: boolean}) {
  const router = useRouter();
  const {href} = useProject();
  const evalOn = !!state.setup?.thresholds;
  const g = gate('dataset', state.facts);
  return (
    <Button
      label={evalOn ? 'Next: Gold Labels' : 'Next: Prompt Engineering'}
      kind="primary"
      disabled={!g.ready || !splitOk}
      title={!splitOk ? 'Fix the split sizes first' : g.ready ? undefined : (g.reason ?? undefined)}
      onClick={async () => {
        await flush.current();
        await approveNode(state.project.id, 'dataset');
        router.push(href(evalOn ? '/gold' : '/prompt'));
      }}
    />
  );
}

function Ready({state, flush, onValid}: {state: ProjectState; flush: {current: () => Promise<void>}; onValid: (ok: boolean) => void}) {
  const snap = state.snapshot!;
  const t = state.setup?.thresholds ?? null;
  const evalOn = !!t;
  const total = snap.counts.valid;
  const rec = recommended(total, t?.minEval ?? null);
  const [evalSize, setEval] = useState(String(snap.split?.eval ?? rec.evalSize));
  const [test, setTest] = useState(String(snap.split?.test ?? rec.test));
  const locked = state.gold.size > 0;
  const e = evalOn ? parseInt(evalSize) || 0 : 0;
  const te = parseInt(test) || 0;
  const train = Math.max(0, total - e - te);
  const err = e + te >= total ? 'Leave some examples for train' : evalOn && e < t!.minEval ? `The eval set needs at least ${t!.minEval} examples` : null;

  // Sizes save as they are typed (no Apply button).
  const unsaved = !locked && !err && !(snap.split && snap.split.eval === e && snap.split.test === te);
  useEffect(() => {
    if (!unsaved) return;
    const id = setTimeout(() => void applySplit(state.project.id, snap.id, e, te), 400);
    return () => clearTimeout(id);
  }, [e, te, locked, err]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => onValid(locked || !err), [locked, err]); // eslint-disable-line react-hooks/exhaustive-deps
  flush.current = async () => {
    if (unsaved) await applySplit(state.project.id, snap.id, e, te);
  };

  const lockTip = locked ? 'The split is fixed because gold labels exist for it' : undefined;
  return (
    <div className="grid-split" style={{gridTemplateColumns: '1fr 1fr', alignItems: 'stretch'}}>
      <Card title="Examples">
        <Metrics>
          <Metric label="Examples" value={num(snap.counts.rows)} />
          <Metric label="Valid" value={num(snap.counts.valid)} />
          <Metric label="Invalid" value={num(snap.counts.invalid)} />
        </Metrics>
        <div className="row" style={{gap: 12, paddingTop: 8}}>
          <Badge text={snap.source === 'sample' ? 'Sampled' : 'Uploaded'} icon={false} />
          <span className="t-3 one" style={{fontSize: 13}} title={snap.source === 'upload' ? snap.sourceName : undefined}>
            {dateTime(snap.createdAt)} · {num(snap.counts.video)} videos · {num(snap.counts.photoText)} photo and text
          </span>
        </div>
      </Card>
      <Card title="Split" className="form">
        <div className="row" style={{gap: 16, alignItems: 'flex-end'}}>
          {evalOn && (
            <Field label="Eval size" width={160}>
              <input className="input" value={evalSize} disabled={locked} title={lockTip} onChange={x => setEval(x.target.value.replace(/\D/g, ''))} />
            </Field>
          )}
          <Field label="Test size" width={160}>
            <input className="input" value={test} disabled={locked} title={lockTip} onChange={x => setTest(x.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label={<Hov text="Train size" tip="Everything that is not eval or test" />} width={160}>
            <span className="input" style={{display: 'flex', alignItems: 'center', background: 'var(--bg-muted)', borderColor: 'transparent'}}>
              {num(train)}
            </span>
          </Field>
        </div>
        {err && (
          <span className="t-err" style={{fontSize: 13}}>
            {err}
          </span>
        )}
        <div className="split" style={{marginTop: 16}}>
          {evalOn && <i style={{flex: Math.max(e, 0), background: '#1b1b1b'}} />}
          <i style={{flex: Math.max(te, 0), background: '#6a6a6a'}} />
          <i style={{flex: Math.max(train, 0), background: '#d4d4d4'}} />
        </div>
        <div className="legend">
          {evalOn && (
            <span>
              <i style={{background: '#1b1b1b'}} />
              Eval <b>{num(e)}</b>
            </span>
          )}
          <span>
            <i style={{background: '#6a6a6a'}} />
            Test <b>{num(te)}</b>
          </span>
          <span>
            <i style={{background: '#d4d4d4'}} />
            Train <b>{num(train)}</b>
          </span>
        </div>
      </Card>
    </div>
  );
}
