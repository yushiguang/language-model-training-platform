'use client';

import {useGo} from '@/components/nav';
import {useEffect, useRef, useState} from 'react';
import type {PageContext, Schema} from '@tsp/contracts';
import {gate, labelBalance, systemConfig} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {appendDatasetFile, appendSample, approveNode, getSamplePoolSize, pruneDataset, restoreExamples, startSampleDataset, stopSampleDataset, uploadDatasetFile, type ProjectState, type RemovalReason} from '@/backend-api';
import {Badge, Banner, Button, Card, CenterProgress, Code, dateTime, Dialog, Empty, Field, Hov, LinkChip, Metric, Metrics, num, One, PageHead, Table} from '@/ui';

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
        <Button label="Auto sampling" kind="primary" icon="shuffle" disabled={!(parseInt(n) > 0)} onClick={() => startSampleDataset(state.project.id, parseInt(n))} />
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

/**
 * The eval dataset (spec 1.0.0, 4.3 and 4.4): every example is used for evaluation. Examples can
 * be added at any time (existing ones keep their half and gold label), removed with a trail and
 * put back, and the label balance shows values with too few gold labels to score fairly.
 */
function Ready({state}: {state: ProjectState}) {
  const snap = state.snapshot!;
  const {minEvalRecommended} = systemConfig().dataset;
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const labeled = evalEx.filter(e => !!state.gold[e.id]).length;
  const pending = evalEx.length - labeled;
  const few = evalEx.length < minEvalRecommended;
  const schema = state.setup?.schema ?? null;
  return (
    <div className="col" style={{gap: 16, width: 706}}>
      {few && <Banner text={`Fewer than ${minEvalRecommended} examples: scores will be rough until you add more examples.`} style={{margin: 0}} />}
      <Card title="Examples" actions={<AddExamples state={state} />}>
        <Metrics>
          <Metric label="Examples" value={num(evalEx.length)} />
          <Metric label="Gold-labeled" value={num(labeled)} />
          <Metric label={<Hov text="Waiting for gold labels" tip="Scores leave these out until they have a gold label." />} value={num(pending)} />
          <Metric label="Removed" value={num(state.removals.length)} />
        </Metrics>
        <div className="row" style={{gap: 12, paddingTop: 8}}>
          <Badge text={snap.source === 'sample' ? 'Sampled' : 'Uploaded'} icon={false} />
          <span className="t-3 one" style={{fontSize: 13}} title={snap.source === 'upload' ? snap.sourceName : undefined}>
            {dateTime(snap.createdAt)} · {num(evalEx.filter(e => e.type === 'video').length)} videos · {num(evalEx.filter(e => e.type !== 'video').length)} photo and text
          </span>
          {labeled > 0 && pending > 0 && <PruneUnlabeled state={state} pending={pending} />}
        </div>
      </Card>
      {schema && labeled > 0 && <BalanceCard state={state} schema={schema} />}
      {state.removals.length > 0 && <RemovedCard state={state} />}
    </div>
  );
}

/** Add examples: a file of item IDs, or more sampled ones; ids already there are skipped. */
function AddExamples({state}: {state: ProjectState}) {
  const [n, setN] = useState('');
  const [note, setNote] = useState<{text: string; err?: boolean} | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const total = state.examples.length + state.removals.length;
  useEffect(() => {
    // The default goes straight into the box: up to 20 more, as many as are left.
    getSamplePoolSize().then(a => setN(cur => cur || String(Math.max(0, Math.min(20, a - total)))));
  }, [total]);
  const upload = async (f: File) => {
    setNote(null);
    const res = await appendDatasetFile(state.project.id, f);
    if (res.error) setNote({text: res.error, err: true});
    else if (res.added != null) setNote({text: `Added ${num(res.added)}${res.duplicates ? `; ${num(res.duplicates)} already in the dataset were skipped` : ''}.`});
    if (file.current) file.current.value = '';
  };
  return (
    <div className="col" style={{gap: 4, alignItems: 'flex-end'}}>
      <div className="row" style={{gap: 8}}>
        <Button label="Add from file" size="sm" icon="upload" onClick={() => file.current?.click()} />
        <input ref={file} type="file" className="sr-only" accept=".txt,.csv,.jsonl,.json" aria-label="Add from file" onChange={e => e.target.files?.[0] && void upload(e.target.files[0])} />
        <input className="input sm" style={{width: 56, textAlign: 'center', padding: '0 8px'}} aria-label="Examples to add" value={n} onChange={e => setN(e.target.value.replace(/\D/g, ''))} />
        <Button label="Add sampled" size="sm" icon="shuffle" disabled={!(parseInt(n) > 0)} onClick={() => appendSample({projectId: state.project.id, count: parseInt(n)})} />
      </div>
      {note && (
        <span className={note.err ? 't-err' : 't-3'} style={{fontSize: 12}} role="status">
          {note.text}
        </span>
      )}
    </div>
  );
}

/** Removes unlabeled examples down to a number to keep, evenly from both halves (spec 4.3). */
function PruneUnlabeled({state, pending}: {state: ProjectState; pending: number}) {
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState('0');
  return (
    <>
      <span style={{marginLeft: 'auto'}}>
        <Button label="Remove unlabeled" size="sm" kind="ghost" onClick={() => setOpen(true)} />
      </span>
      {open && (
        <Dialog
          title="Remove unlabeled examples"
          text={`${num(pending)} examples have no gold label. Removed examples can be put back from the Removed list.`}
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button label="Cancel" onClick={() => setOpen(false)} />
              <Button
                label="Remove"
                kind="primary"
                onClick={async () => {
                  await pruneDataset({projectId: state.project.id, mode: 'unlabeled', keep: Math.max(0, parseInt(keep) || 0)});
                  setOpen(false);
                }}
              />
            </>
          }
        >
          <Field label="Unlabeled examples to keep" width={200}>
            <input className="input" aria-label="Unlabeled examples to keep" value={keep} onChange={e => setKeep(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </Dialog>
      )}
    </>
  );
}

/**
 * Label balance and coverage (spec 4.3): gold labels per value. A rare value (fewer than 4, or
 * fewer than 2 in a half) is yellow, one with none is red; a dominant value can be downsampled.
 */
function BalanceCard({state, schema}: {state: ProjectState; schema: Schema}) {
  const c = systemConfig().dataset;
  const b = labelBalance(schema, state.examples.filter(e => e.split === 'eval'), state.gold);
  const [down, setDown] = useState<{field: string; value: string; count: number} | null>(null);
  const [keep, setKeep] = useState('');
  const rare = b.fields.flatMap(f => f.values.filter(v => v.rare));
  const legend = (
    <div className="row" style={{gap: 16, fontSize: 12}}>
      <span className="row" style={{gap: 6}}>
        <i style={{width: 8, height: 8, borderRadius: '50%', background: '#e0a800'}} />
        <span className="t-3">
          <Hov text="Rare" tip={`Fewer than ${c.rareValueMinCount} gold labels, or fewer than ${c.rareValuePerHalfMin} in either half of the eval set. One miss moves its score a lot.`} />
        </span>
      </span>
      <span className="row" style={{gap: 6}}>
        <i style={{width: 8, height: 8, borderRadius: '50%', background: 'var(--err)'}} />
        <span className="t-3">None</span>
      </span>
    </div>
  );
  return (
    <Card title="Label balance" actions={legend}>
      <div className="col" style={{gap: 24}}>
        {b.fields.map((f, i) => {
          const mx = Math.max(1, ...f.values.map(x => x.count));
          return (
            <div key={f.field} className="col" style={{gap: 24}}>
              {i > 0 && <div style={{height: 1, background: 'var(--border)'}} />}
              <div className="col" style={{gap: 8, alignItems: 'flex-start'}}>
                <span>
                  <Code>{f.field}</Code>
                </span>
                <div className="col" style={{gap: 4, alignSelf: 'stretch'}}>
                  {[...f.values]
                    .sort((x, y) => y.count - x.count)
                    .map(x => {
                      const tone = x.count === 0 ? 'err' : x.rare ? 'warn' : '';
                      const col = tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : 'var(--text)';
                      const bold = tone ? 600 : undefined;
                      return (
                        <div key={x.value} className="bal-row">
                          <span className="one" title={x.value} style={{color: col, fontWeight: bold}}>
                            {x.value}
                          </span>
                          <span className="bal-bar">
                            <span style={{width: `${Math.round((x.count / mx) * 100)}%`, background: tone === 'warn' ? '#e0a800' : '#1b1b1b'}} />
                          </span>
                          <span style={{textAlign: 'right', color: tone ? col : 'var(--text-2)', fontWeight: bold}}>
                            <Hov text={num(x.count)} tip={`${num(x.optimiser)} in the half the Optimiser learns from, ${num(x.heldOut)} in the half scores use`} />
                          </span>
                          <span style={{textAlign: 'right'}}>
                            {x.dominant && (
                              <Button
                                label="Downsample"
                                size="sm"
                                kind="ghost"
                                title={`Over ${Math.round(c.dominantValueShareWarn * 100)}% of the gold labels are ${x.value}`}
                                onClick={() => {
                                  setKeep(String(Math.max(c.rareValueMinCount, Math.round(x.count / 2))));
                                  setDown({field: f.field, value: x.value, count: x.count});
                                }}
                              />
                            )}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          );
        })}
        {rare.length > 0 && (
          <p className="t-3" style={{margin: 0, fontSize: 13}}>
            {rare.length} {rare.length === 1 ? 'value has' : 'values have'} too few gold labels to score fairly. Add examples that show {rare.length === 1 ? 'it' : 'them'}, then label them on Gold Labels.
          </p>
        )}
      </div>
      {down && (
        <Dialog
          title={`Downsample ${down.value}`}
          text={`${num(down.count)} examples have ${down.value} as their gold label. Examples are removed at random, evenly from both halves, and can be put back from the Removed list.`}
          onClose={() => setDown(null)}
          actions={
            <>
              <Button label="Cancel" onClick={() => setDown(null)} />
              <Button
                label="Remove"
                kind="primary"
                disabled={!(parseInt(keep) >= 0 && parseInt(keep) < down.count)}
                onClick={async () => {
                  await pruneDataset({projectId: state.project.id, mode: 'downsample', field: down.field, value: down.value, keep: parseInt(keep)});
                  setDown(null);
                }}
              />
            </>
          }
        >
          <Field label={`${down.value} examples to keep`} width={200}>
            <input className="input" aria-label="Examples to keep" value={keep} onChange={e => setKeep(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </Dialog>
      )}
    </Card>
  );
}

const REASON: Record<RemovalReason, string> = {broken: 'Broken', out_of_scope: 'Out of scope', downsample: 'Downsampled', excess_unlabeled: 'Unlabeled extra'};

/** Removed (N): every removal with why, who and when, and Restore (spec 4.4). */
function RemovedCard({state}: {state: ProjectState}) {
  const ids = state.removals.map(r => r.id);
  return (
    <Card title={`Removed (${state.removals.length})`} actions={<Button label="Restore all" size="sm" onClick={() => restoreExamples({projectId: state.project.id, removalIds: ids})} />}>
      <Table
        cols={[{label: 'Item ID'}, {label: 'Why'}, {label: 'Gold label'}, {label: 'Removed'}, {label: '', kind: 'act'}]}
        widths={[130, 140, 'auto', 150, 96]}
        actWidth={96}
        rows={state.removals.map(r => ({
          key: r.id,
          cells: [
            <One key="id" text={r.externalId} />,
            REASON[r.reason],
            <One key="g" text={r.gold ? Object.values(r.gold).flat().join(', ') : 'None'} className={r.gold ? undefined : 't-3'} />,
            <span key="at" className="t-3"><Hov text={dateTime(r.removedAt)} tip={`Removed by ${r.removedBy}`} /></span>,
            <Button key="r" label="Restore" size="sm" kind="ghost" onClick={() => restoreExamples({projectId: state.project.id, removalIds: [r.id]})} />,
          ],
        }))}
      />
    </Card>
  );
}
