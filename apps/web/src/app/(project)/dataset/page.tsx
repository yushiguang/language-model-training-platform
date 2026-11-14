'use client';

import {useGo} from '@/components/nav';
import {useEffect, useRef, useState} from 'react';
import type {PageContext, Schema} from '@tsp/contracts';
import {gate, labelBalance, systemConfig} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {appendDatasetFile, appendSample, approveNode, getSamplePoolSize, pruneDataset, restoreExamples, startSampleDataset, stopSampleDataset, uploadDatasetFile, type ProjectState, type RemovalReason} from '@/backend-api';
import {Badge, Banner, Button, Card, CenterProgress, Code, dateTime, Dialog, Empty, Field, Hov, LinkChip, Metric, Metrics, num, One, PageHead, Table} from '@/ui';
import {t, tm} from '@/i18n';

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
  const head = <PageHead title={t('Eval Dataset')} actions={snap && !task ? <NextButton state={state} /> : undefined} />;
  if (task)
    return (
      <Frame head={head}>
        <CenterProgress
          title={task.kind === 'upload' ? t('Loading features for {n} items', {n: num(task.total)}) : t('Sampling {n} examples', {n: num(task.total)})}
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
    <Empty title={t('No examples yet')} text={t('Every example here is used to score your prompt. Upload a file of item IDs, or let the platform pick examples at random.')}>
      <div className="row" style={{gap: 12}}>
        <Button label={t('Upload dataset')} icon="upload" onClick={() => file.current?.click()} />
        <input ref={file} type="file" className="sr-only" accept=".txt,.csv,.jsonl,.json" aria-label={t('Upload dataset')} onChange={e => e.target.files?.[0] && void upload(e.target.files[0])} />
        <span className="t-3">{t('or')}</span>
        <input className="input sm" style={{width: 80, textAlign: 'center', padding: '0 8px'}} aria-label={t('Example count')} value={n} onChange={e => setN(e.target.value.replace(/\D/g, ''))} />
        <Button label={t('Auto sampling')} kind="primary" icon="shuffle" disabled={!(parseInt(n) > 0)} onClick={() => startSampleDataset(state.project.id, parseInt(n))} />
      </div>
      {err && (
        <p className="t-err" style={{marginTop: 12, marginBottom: 0}}>
          {t(err)}
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
      label={t('Next: Gold Labels')}
      kind="primary"
      disabled={!g.ready}
      title={g.msg ? tm(g.msg) : undefined}
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
      {few && <Banner text={t('Fewer than {n} examples: scores will be rough until you add more examples.', {n: minEvalRecommended})} style={{margin: 0}} />}
      <Card title={t('Examples')} actions={<AddExamples state={state} />}>
        <Metrics>
          <Metric label={t('Examples')} value={num(evalEx.length)} />
          <Metric label={t('Gold-labeled')} value={num(labeled)} />
          <Metric label={<Hov text={t('Waiting for gold labels')} tip={t('Scores leave these out until they have a gold label.')} />} value={num(pending)} />
          <Metric label={t('Removed')} value={num(state.removals.length)} />
        </Metrics>
        <div className="row" style={{gap: 12, paddingTop: 8}}>
          <Badge text={snap.source === 'sample' ? t('Sampled') : t('Uploaded')} icon={false} />
          <span className="t-3 one" style={{fontSize: 13}} title={snap.source === 'upload' ? snap.sourceName : undefined}>
            {t('{date} · {videos} videos · {photos} photo and text', {date: dateTime(snap.createdAt), videos: num(evalEx.filter(e => e.type === 'video').length), photos: num(evalEx.filter(e => e.type !== 'video').length)})}
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
    if (res.error) setNote({text: t(res.error), err: true});
    else if (res.added != null) setNote({text: res.duplicates ? t('Added {n}; {dup} already in the dataset were skipped.', {n: num(res.added), dup: num(res.duplicates)}) : t('Added {n}.', {n: num(res.added)})});
    if (file.current) file.current.value = '';
  };
  return (
    <div className="col" style={{gap: 4, alignItems: 'flex-end'}}>
      <div className="row" style={{gap: 8}}>
        <Button label={t('Add from file')} size="sm" icon="upload" onClick={() => file.current?.click()} />
        <input ref={file} type="file" className="sr-only" accept=".txt,.csv,.jsonl,.json" aria-label={t('Add from file')} onChange={e => e.target.files?.[0] && void upload(e.target.files[0])} />
        <input className="input sm" style={{width: 56, textAlign: 'center', padding: '0 8px'}} aria-label={t('Examples to add')} value={n} onChange={e => setN(e.target.value.replace(/\D/g, ''))} />
        <Button label={t('Add sampled')} size="sm" icon="shuffle" disabled={!(parseInt(n) > 0)} onClick={() => appendSample({projectId: state.project.id, count: parseInt(n)})} />
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
        <Button label={t('Remove unlabeled')} size="sm" kind="ghost" onClick={() => setOpen(true)} />
      </span>
      {open && (
        <Dialog
          title={t('Remove unlabeled examples')}
          text={t('{n} examples have no gold label. Removed examples can be put back from the Removed list.', {n: num(pending)})}
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button label={t('Cancel')} onClick={() => setOpen(false)} />
              <Button
                label={t('Remove')}
                kind="primary"
                onClick={async () => {
                  await pruneDataset({projectId: state.project.id, mode: 'unlabeled', keep: Math.max(0, parseInt(keep) || 0)});
                  setOpen(false);
                }}
              />
            </>
          }
        >
          <Field label={t('Unlabeled examples to keep')} width={200}>
            <input className="input" aria-label={t('Unlabeled examples to keep')} value={keep} onChange={e => setKeep(e.target.value.replace(/\D/g, ''))} />
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
          <Hov text={t('Rare')} tip={t('Fewer than {n} gold labels, or fewer than {half} in either half of the eval set. One miss moves its score a lot.', {n: c.rareValueMinCount, half: c.rareValuePerHalfMin})} />
        </span>
      </span>
      <span className="row" style={{gap: 6}}>
        <i style={{width: 8, height: 8, borderRadius: '50%', background: 'var(--err)'}} />
        <span className="t-3">{t('None')}</span>
      </span>
    </div>
  );
  return (
    <Card title={t('Label balance')} actions={legend}>
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
                            <Hov text={num(x.count)} tip={t('{a} in the half the Optimiser learns from, {b} in the half scores use', {a: num(x.optimiser), b: num(x.heldOut)})} />
                          </span>
                          <span style={{textAlign: 'right'}}>
                            {x.dominant && (
                              <Button
                                label={t('Downsample')}
                                size="sm"
                                kind="ghost"
                                title={t('Over {pct}% of the gold labels are {value}', {pct: Math.round(c.dominantValueShareWarn * 100), value: x.value})}
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
            {rare.length === 1 ? t('1 value has too few gold labels to score fairly. Add examples that show it, then label them on Gold Labels.') : t('{n} values have too few gold labels to score fairly. Add examples that show them, then label them on Gold Labels.', {n: rare.length})}
          </p>
        )}
      </div>
      {down && (
        <Dialog
          title={t('Downsample {value}', {value: down.value})}
          text={t('{n} examples have {value} as their gold label. Examples are removed at random, evenly from both halves, and can be put back from the Removed list.', {n: num(down.count), value: down.value})}
          onClose={() => setDown(null)}
          actions={
            <>
              <Button label={t('Cancel')} onClick={() => setDown(null)} />
              <Button
                label={t('Remove')}
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
          <Field label={t('{value} examples to keep', {value: down.value})} width={200}>
            <input className="input" aria-label={t('Examples to keep')} value={keep} onChange={e => setKeep(e.target.value.replace(/\D/g, ''))} />
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
    <Card title={t('Removed ({n})', {n: state.removals.length})} actions={<Button label={t('Restore all')} size="sm" onClick={() => restoreExamples({projectId: state.project.id, removalIds: ids})} />}>
      <Table
        cols={[{label: t('Item ID')}, {label: t('Why')}, {label: t('Gold label')}, {label: t('Removed')}, {label: '', kind: 'act'}]}
        widths={[130, 140, 'auto', 150, 96]}
        actWidth={96}
        rows={state.removals.map(r => ({
          key: r.id,
          cells: [
            <One key="id" text={r.externalId} />,
            t(REASON[r.reason]),
            <One key="g" text={r.gold ? Object.values(r.gold).flat().join(', ') : t('None')} className={r.gold ? undefined : 't-3'} />,
            <span key="at" className="t-3"><Hov text={dateTime(r.removedAt)} tip={t('Removed by {name}', {name: r.removedBy})} /></span>,
            <Button key="r" label={t('Restore')} size="sm" kind="ghost" onClick={() => restoreExamples({projectId: state.project.id, removalIds: [r.id]})} />,
          ],
        }))}
      />
    </Card>
  );
}
