'use client';

import {useGo} from '@/components/nav';
import {useEffect, useRef, useState} from 'react';
import type {PageContext} from '@tsp/contracts';
import {gate, systemConfig} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {approveNode, getSamplePoolSize, startSampleDataset, stopSampleDataset, uploadDatasetFile, type ProjectState} from '@/backend-api';
import {Badge, Banner, Button, Card, CenterProgress, dateTime, Empty, LinkChip, Metric, Metrics, num, PageHead} from '@/ui';

export default function DatasetPage() {
  return (
    <ProjectPage node="dataset" page={PAGE}>
      {({state}) => <Dataset state={state} />}
    </ProjectPage>
  );
}

const PAGE: PageContext = {label: 'Eval Dataset', agent: 'front_desk', intent: 'answer', hint: 'Ask how many examples the eval dataset needs.', context: {}};

function Dataset({state}: {state: ProjectState}) {
  const snap = state.snapshot;
  const task = state.samplingTask?.state === 'running' ? state.samplingTask : null;
  const head = <PageHead title="Eval Dataset" actions={snap && !task ? <NextButton state={state} /> : undefined} />;
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
      <Ready state={state} />
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
    <Empty title="No examples yet" text="Every example here is used to score your prompt. Upload a file of item IDs, or let the platform pick examples at random.">
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

function NextButton({state}: {state: ProjectState}) {
  const go = useGo();
  const {href} = useProject();
  const g = gate('dataset', state.facts);
  return (
    <Button
      label="Next: Gold Labels"
      kind="primary"
      disabled={!g.ready}
      title={g.ready ? undefined : (g.reason ?? undefined)}
      onClick={async () => {
        await approveNode(state.project.id, 'dataset');
        await go(href('/gold'));
      }}
    />
  );
}

/** The eval dataset: every valid example is used for evaluation (spec 1.0.0, 2.1). No split to set. */
function Ready({state}: {state: ProjectState}) {
  const snap = state.snapshot!;
  const {minEvalRecommended} = systemConfig().dataset;
  const few = snap.counts.valid < minEvalRecommended;
  return (
    <div className="col" style={{gap: 16, width: 706}}>
      {few && <Banner text={`Scores from fewer than ${minEvalRecommended} examples are a rough reading. You can go on, and add more examples later.`} style={{margin: 0}} />}
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
    </div>
  );
}
