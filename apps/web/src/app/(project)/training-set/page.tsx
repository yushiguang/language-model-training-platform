'use client';

import {useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useState} from 'react';
import type {Answer, EndpointId, LabelingRun, PromptVersion, Schema, TrainingSet} from '@tsp/contracts';
import {estimate, MIN_PER_VALUE, recommend, versionLabel} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {LabelDistribution, labelCounts} from '@/components/LabelDistribution';
import {modelName, versionScore} from '@/components/prompt/scores';
import {labelTestSet, predictionsFor, startTrainingSet, stopRun, stopTrainingSet, track, trainingRows, type ProjectState} from '@/backend-api';
import {Badge, Button, Card, Code, dateTime, Empty, Hov, Metric, Metrics, num, PageHead, Progress, Select, Tabs} from '@/ui';

type SetKey = 'train' | 'test';
type SetState = 'todo' | 'running' | 'stopped' | 'done';

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
    <ProjectPage node="training" page={{label: 'Training and test sets', agent: 'front_desk', intent: 'answer', hint: 'Ask what a label count means.', context: {}}}>
      {({state}) => <Training state={state} vParam={q.get('v')} mParam={q.get('m') as EndpointId | null} />}
    </ProjectPage>
  );
}

/** One labeled row of a set: the answer and where it came from. */
interface Row {
  exampleId: string;
  answer: Answer | null;
  source: 'gold' | 'model' | null;
}

const trainState = (ts: TrainingSet | undefined): SetState => (!ts ? 'todo' : ts.state === 'done' ? 'done' : ts.state === 'running' ? 'running' : 'stopped');
const testState = (r: LabelingRun | undefined): SetState => (!r ? 'todo' : r.state === 'done' ? 'done' : r.state === 'running' ? 'running' : 'stopped');

function Training({state, vParam, mParam}: {state: ProjectState; vParam: string | null; mParam: EndpointId | null}) {
  const ts = state.trainingSets[0];
  const testRun = state.testRuns[0];
  const st: Record<SetKey, SetState> = {train: trainState(ts), test: testState(testRun)};
  const [tab, setTab] = useState<SetKey>('train');
  const nTrain = state.examples.filter(e => e.split === 'train').length;
  const nTest = state.examples.filter(e => e.split === 'test').length;
  const rows = useRows(state, tab, st[tab] === 'done' ? (tab === 'train' ? ts : testRun) : undefined);
  const head = <PageHead title="Training and test sets" />;

  if (!state.versions.length)
    return (
      <Frame head={head}>
        <Empty title="No prompt version yet" text="Write and score a prompt on Prompt Engineering first." />
      </Frame>
    );
  const tag = (s: SetState) => (s === 'running' ? <Badge text="Running" tone="run" /> : s === 'done' ? <Badge text="Finished" tone="ok" /> : undefined);
  return (
    <Frame head={head}>
      <Tabs
        label="Sets"
        selected={tab}
        onSelect={setTab}
        items={[
          {key: 'train', label: 'Training set', count: num(nTrain), extra: tag(st.train)},
          {key: 'test', label: 'Test set', count: num(nTest), extra: tag(st.test)},
        ]}
        end={st[tab] === 'done' && rows ? <Downloads state={state} split={tab} rows={rows} versionId={(tab === 'train' ? ts : testRun)!.promptVersionId} endpoint={(tab === 'train' ? ts : testRun)!.endpoint} /> : undefined}
      />
      {st[tab] === 'todo' ? (
        <Settings key={tab} state={state} split={tab} vParam={vParam} mParam={mParam} />
      ) : st[tab] === 'done' ? (
        rows && <Done state={state} split={tab} rows={rows} job={tab === 'train' ? ts : testRun} />
      ) : (
        <Labeling state={state} split={tab} ts={ts} run={testRun} />
      )}
    </Frame>
  );
}

/** Labeling settings (design: 706 wide, two 320 px selects, Start labeling). */
function Settings({state, split, vParam, mParam}: {state: ProjectState; split: SetKey; vParam: string | null; mParam: EndpointId | null}) {
  const setup = state.setup!;
  // Changes the Optimiser dropped after their dry run are not offered.
  const dropped = new Set(state.optimisation.flatMap(o => o.history.filter(h => h.outcome !== 'kept' && h.versionId).map(h => h.versionId!)));
  const versions = state.versions.filter(v => v.schemaVersion === setup.schemaVersion && !dropped.has(v.id));
  const list = versions.length ? versions : state.versions;
  const a = recommend(state, null);
  const [vId, setV] = useState(list.find(v => v.id === vParam)?.id ?? (a.kind === 'make_training_set' || a.kind === 'no_eval' ? a.versionId : null) ?? list[0].id);
  // One labeling model per project (Setup).
  const ep: EndpointId = setup.models.find(m => m.endpoint === mParam)?.endpoint ?? setup.models[0].endpoint;
  const [err, setErr] = useState<string | null>(null);
  const v = list.find(x => x.id === vId)!;
  const label = (x: PromptVersion) => {
    const s = versionScore(state, x.id);
    return [versionLabel(x), s ? s.score.toFixed(2) : null, s?.passed ? 'passed' : null].filter(Boolean).join(' · ');
  };
  const start = async () => {
    setErr(null);
    try {
      // The estimate is only recorded with the run (no cost limit); it is never shown.
      const budget = estimate(state, v, ep, [split]).costUsd;
      if (split === 'train') {
        await startTrainingSet({projectId: state.project.id, promptVersionId: v.id, endpoint: ep, estimateUsd: budget, labelTest: false});
      } else await labelTestSet({projectId: state.project.id, promptVersionId: v.id, endpoint: ep, estimateUsd: budget});
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div style={{width: 706}}>
      <Card title="Labeling settings" className="form" actions={<Button label="Start labeling" kind="primary" icon="play" title={err ?? undefined} onClick={start} />}>
        <div className="row" style={{gap: 16, alignItems: 'flex-end'}}>
          <div style={{width: 320}}>
            <Select label="Prompt" value={vId} onChange={setV} options={list.map(x => ({value: x.id, label: label(x)}))} />
          </div>
        </div>
        {err && (
          <span className="t-err" style={{fontSize: 13}}>
            {err}
          </span>
        )}
      </Card>
    </div>
  );
}

/** Labeling (design: progress, "Prompt v4 · model · Started …", Stop). A stopped run resumes here. */
function Labeling({state, split, ts, run}: {state: ProjectState; split: SetKey; ts?: TrainingSet; run?: LabelingRun}) {
  const job = split === 'train' ? ts! : run!;
  const running = job.state === 'running';
  const v = state.versions.find(x => x.id === job.promptVersionId);
  const resume = async () => {
    if (split === 'train') await startTrainingSet({projectId: state.project.id, promptVersionId: v!.id, endpoint: ts!.endpoint, estimateUsd: ts!.estimateUsd, resumeTrainingSetId: ts!.id});
    else await labelTestSet({projectId: state.project.id, promptVersionId: v!.id, endpoint: run!.endpoint, estimateUsd: estimate(state, v!, run!.endpoint, ['test']).costUsd});
  };
  return (
    <Card
      title="Labeling"
      titleExtra={running ? undefined : <Badge text={job.state === 'failed' ? 'Failed' : 'Stopped'} tone={job.state === 'failed' ? 'err' : 'warn'} icon={false} />}
      actions={running ? <Button label="Stop" icon="stop" onClick={() => (split === 'train' ? stopTrainingSet(ts!.id) : stopRun(run!.id))} /> : v && <Button label="Resume" icon="play" onClick={resume} />}
    >
      <Progress done={job.done} total={job.total} />
      <div className="row" style={{gap: 8, paddingTop: 8}}>
        <span className="t-3 one" style={{fontSize: 13}}>
          Prompt {v ? versionLabel(v) : ''} · {modelName(state, job.endpoint)} · Started {dateTime(job.startedAt)}
        </span>
      </div>
      {job.error && (
        <span className="t-err one" style={{fontSize: 13}} title={job.error}>
          {job.error}
        </span>
      )}
    </Card>
  );
}

/** The finished set's rows. Test rows take the gold label when there is one, else the model's answer. */
function useRows(state: ProjectState, split: SetKey, job: TrainingSet | LabelingRun | undefined): Row[] | null {
  const [rows, setRows] = useState<Row[] | null>(null);
  const key = job ? `${split}:${job.id}:${job.state}:${Object.keys(state.gold).length}` : '';
  useEffect(() => {
    setRows(null);
    if (!job) return;
    let live = true;
    void (async () => {
      let out: Row[];
      if (split === 'train') {
        const rs = await trainingRows(job.id);
        out = rs.filter(r => r.split === 'train').map(r => ({exampleId: r.exampleId, answer: r.answer, source: r.answer ? 'model' : null}));
      } else {
        const settings = state.setup!.models.find(m => m.endpoint === job.endpoint)!;
        const preds = await predictionsFor(job.promptVersionId, job.endpoint, settings);
        out = state.examples
          .filter(e => e.split === 'test')
          .map(e => {
            const g = state.gold[e.id];
            const p = preds[e.id];
            return g ? {exampleId: e.id, answer: g.answer, source: 'gold' as const} : {exampleId: e.id, answer: p?.answer ?? null, source: p?.answer ? ('model' as const) : null};
          });
      }
      if (live) setRows(out);
    })();
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return rows;
}


const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Done({state, split, rows, job}: {state: ProjectState; split: SetKey; rows: Row[]; job: TrainingSet | LabelingRun}) {
  const schema = state.setup!.schema!;
  const v = state.versions.find(x => x.id === job.promptVersionId);
  const labeled = rows.filter(r => r.answer);
  const c = useMemo(() => labelCounts(schema, labeled.map(r => r.answer)), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const tokens = (job as {tokens?: number}).tokens ?? 0;
  const finishedAt = job.finishedAt ?? job.startedAt;
  const fromGold = labeled.filter(r => r.source === 'gold').length;
  const metrics =
    split === 'train' ? (
      <Metrics vertical>
        <Metric label="Labeled" value={num(labeled.length)} unit={`/${num(rows.length)}`} />
        <Metric label={<Hov text="Invalid, dropped" tip="Answers that did not match the schema" />} value={pct(rows.length ? (rows.length - labeled.length) / rows.length : 0)} />
        <Metric label="Total tokens" value={num(tokens)} />
      </Metrics>
    ) : (
      <Metrics vertical>
        <Metric label="Labeled" value={num(labeled.length)} unit={`/${num(rows.length)}`} />
        <Metric label="Gold labels" value={num(fromGold)} />
        <Metric label="Labeled by the model" value={num(labeled.length - fromGold)} />
        <Metric label="Total tokens" value={num(tokens)} />
      </Metrics>
    );
  return (
    <>
      {/* No "Add examples" action: adding to an existing dataset comes in a later version. */}
      {/* No banner for rare values: the legend under the distribution already marks them (review finding 18). */}
      {split === 'test' && labeled.length - fromGold > 0 && (
        <div className="t-3" style={{fontSize: 13, paddingBottom: 12}}>
          <Hov
            text={`${plural(labeled.length - fromGold, "row carries the model's answer", "rows carry the model's answer")}, not a gold label`}
            tip="A model tested on these rows is measured against this labeling, not against the truth. Give them gold labels in Gold Labels for a true test"
          />
        </div>
      )}
      <div style={{display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, alignItems: 'start'}}>
        <Card title="Run">
          {metrics}
          <div style={{paddingTop: 8}}>
            <div className="col" style={{gap: 6}}>
              <div className="row" style={{gap: 8}}>
                <Badge text="Finished" tone="ok" />
                <span className="t-3" style={{fontSize: 13}}>
                  {dateTime(finishedAt)}
                </span>
              </div>
              <span className="t-3 one" style={{fontSize: 13}}>
                Prompt {v ? versionLabel(v) : ''} · {modelName(state, job.endpoint)}
              </span>
            </div>
          </div>
        </Card>
        <LabelDistribution data={c} min={MIN_PER_VALUE} />
      </div>
    </>
  );
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;


function Downloads({state, split, rows, versionId, endpoint}: {state: ProjectState; split: SetKey; rows: Row[]; versionId: string; endpoint: EndpointId}) {
  const schema = state.setup!.schema!;
  const byId = new Map(state.examples.map(e => [e.id, e]));
  const v = state.versions.find(x => x.id === versionId);
  const good = rows.filter(r => r.answer);
  const name = `${split === 'train' ? 'training-set' : 'test-set'}-${v ? versionLabel(v) : versionId}-${modelName(state, endpoint)}`;
  const save = (lines: string[], type: string, ext: 'csv' | 'jsonl') => {
    const blob = new Blob([lines.join('\n') + '\n'], {type});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
    track('export_downloaded', {set: split === 'train' ? 'training' : 'test', format: ext, rows: good.length});
  };
  const jsonl = () => save(good.map(r => JSON.stringify({id: byId.get(r.exampleId)?.externalId, title: byId.get(r.exampleId)?.title, answer: r.answer, ...(split === 'test' ? {label_source: r.source} : {})})), 'application/x-ndjson', 'jsonl');
  const csv = () => {
    const head = ['id', 'title', ...schema.fields.map(f => f.name), ...(split === 'test' ? ['label_source'] : [])];
    save(
      [head.join(','), ...good.map(r => [byId.get(r.exampleId)?.externalId ?? '', byId.get(r.exampleId)?.title ?? '', ...schema.fields.map(f => (r.answer![f.name] ?? []).join('; ')), ...(split === 'test' ? [r.source ?? ''] : [])].map(csvCell).join(','))],
      'text/csv',
      'csv',
    );
  };
  return (
    <>
      <Button label="Download JSONL" icon="download" size="sm" onClick={jsonl} />
      <Button label="Download CSV" icon="download" size="sm" onClick={csv} />
    </>
  );
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
