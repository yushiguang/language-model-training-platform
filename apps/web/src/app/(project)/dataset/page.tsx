'use client';

import {useGo} from '@/components/nav';
import Link from 'next/link';
import {useState, type ReactNode} from 'react';
import type {ItemCheckCounts, PageContext, Schema} from '@yushiguang/sprint-contracts';
import {checksTotal, gate, labelBalance, systemConfig} from '@yushiguang/sprint-domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {approveNode, createDataSourceFile, pruneDataset, restoreExamples, stopSampleDataset, takeExamples, type DataSourceSummary, type ProjectState, type RemovalReason} from '@/backend-api';
import {SOURCE_ACCEPT, sourceError, sourceHint, sourceName, useDataSources} from '@/components/sources';
import {Badge, Banner, Button, Card, Cb, CenterProgress, dateTime, Dialog, Empty, Field, FileInput, Hov, Icon, Metric, Metrics, num, One, PageHead, Progress, Table} from '@/ui';
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
  // The last take failed: why, until the next take (design: V-Dataset-Take-Failed).
  const failed = state.samplingTask?.state === 'failed' ? state.samplingTask : null;
  const failedBanner = failed ? <TakeFailed error={failed.error} /> : null;
  const head = <PageHead title={t('Eval Dataset')} actions={snap && !task ? <NextButton state={state} /> : undefined} />;
  if (task)
    return (
      <Frame head={head}>
        <CenterProgress
          title={task.saving ? t('Saving the examples') : t('Taking {n} examples', {n: num(task.total)})}
          done={task.fetched}
          total={task.total}
          startedAt={task.startedAt}
          onStop={task.saving ? undefined : () => stopSampleDataset(state.project.id)}
        />
      </Frame>
    );
  if (!snap)
    return (
      <Frame head={head}>
        <Start state={state} failed={failedBanner} />
      </Frame>
    );
  return (
    <Frame head={head}>
      <Ready state={state} failed={failedBanner} />
    </Frame>
  );
}

function TakeFailed({error}: {error: string | null}) {
  const [list] = useDataSources();
  return <Banner tone="err" oneLine text={t('Taking examples failed: {why}', {why: sourceError(error || 'the service did not answer', list ?? [])})} style={{margin: 0}} />;
}

/**
 * No dataset yet (#29; design: V-Dataset-Empty-Source, V-Dataset-No-Source): take examples from
 * one or more of the team's data sources. With none, a file uploaded here becomes one, for the
 * whole team.
 */
function Start({state, failed}: {state: ProjectState; failed: ReactNode}) {
  const [list] = useDataSources();
  const [upload, setUpload] = useState(false);
  if (!list) return null;
  if (!list.length)
    return (
      <Empty title={t('No examples yet')} text={t('Your team has no data source yet. Upload a file of item IDs: it is added to your team’s Data Source, then you take examples from it.')}>
        <UploadSource />
      </Empty>
    );
  return (
    <Empty title={t('No examples yet')} text={t('Every example here is used to score your prompt. Take examples from one or more of your team’s data sources.')}>
      {failed && <div style={{width: 542, textAlign: 'left', marginBottom: 16}}>{failed}</div>}
      <PickSources list={list} add={false} onTake={picks => takeExamples({projectId: state.project.id, picks})} />
      {upload ? (
        <div style={{marginTop: 24}}>
          <UploadSource />
        </div>
      ) : (
        <p className="t-3" style={{margin: '16px 0 0'}}>
          {t('Not there yet?')}{' '}
          <button type="button" className="link-btn" onClick={() => setUpload(true)}>
            {t('Upload a file')}
          </button>
          {t(': it is added to your team’s Data Source.')}
        </p>
      )}
    </Empty>
  );
}

/** A new data source from the Dataset page: it belongs to the team, like one made on Data Source. */
function UploadSource() {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    if (!file) return;
    setErr(null);
    try {
      const res = await createDataSourceFile(name, file);
      if (res.error) return setErr(res.error);
      setName('');
      setFile(null);
    } catch (e) {
      setErr((e as Error).message || 'Something went wrong. Try again.');
    }
  };
  return (
    <Card className="form" style={{width: 542, textAlign: 'left'}}>
      <Field label={t('Data source name')}>
        <input className="input" value={name} placeholder={t('Weekly feed sample')} onChange={e => setName(e.target.value)} />
      </Field>
      <FileInput label={t('File')} hint={sourceHint()} accept={SOURCE_ACCEPT} file={file} onFile={f => (setErr(null), setFile(f))} />
      {err && (
        <p className="t-err" style={{margin: 0}} role="alert">
          <Icon name="alert" /> {t(err)}
        </p>
      )}
      <div className="row" style={{justifyContent: 'flex-end'}}>
        <Button label={t('Upload')} kind="primary" disabled={!name.trim() || !file} onClick={create} />
      </div>
    </Card>
  );
}

/** The default count of a source when it is ticked: up to 100, as many as are left. */
const takeDefault = (s: DataSourceSummary) => String(Math.min(100, s.notUsed));

/**
 * Data sources to take examples from (#29): tick one or more and say how many from each. The
 * first one is ticked with its count already in the box. A count over what is left is refused here,
 * before anything is queued.
 */
function PickSources({list, add, onTake}: {list: DataSourceSummary[]; add: boolean; onTake: (picks: {sourceId: string; count: number}[]) => Promise<unknown>}) {
  const usable = list.filter(s => !s.importing && s.notUsed > 0);
  const [take, setTake] = useState<Record<string, string>>(() => (usable[0] ? {[usable[0].id]: takeDefault(usable[0])} : {}));
  const [err, setErr] = useState<string | null>(null);
  // A ticked source that is importing again or used up is left out of the take.
  const picks = Object.entries(take)
    .map(([sourceId, v]) => ({sourceId, count: parseInt(v) || 0}))
    .filter(p => usable.some(s => s.id === p.sourceId));
  const over = picks.find(p => p.count > (list.find(s => s.id === p.sourceId)?.notUsed ?? 0));
  const total = picks.reduce((n, p) => n + p.count, 0);
  const ok = picks.length > 0 && picks.every(p => p.count > 0) && !over;
  const toggle = (s: DataSourceSummary) =>
    setTake(cur => {
      const next = {...cur};
      if (s.id in next) delete next[s.id];
      else next[s.id] = takeDefault(s);
      return next;
    });
  return (
    <Card title={add ? t('Add examples') : undefined} style={{width: 542, textAlign: 'left', flex: 'none'}}>
      <Table
        cols={[{label: ''}, {label: t('Data source')}, {label: t('Available')}, {label: t('Take')}]}
        widths={[40, 'auto', 150, 96]}
        rows={list.map(s => {
          const on = s.id in take;
          const off = !!s.importing || s.notUsed === 0;
          return {
            key: s.id,
            cells: [
              <Cb key="c" state={on ? 'on' : 'off'} label={t('Use {name}', {name: sourceName(s)})} onToggle={off && !on ? undefined : () => toggle(s)} />,
              <One key="n" text={sourceName(s)} />,
              s.importing ? <Progress key="p" done={s.importing.done} total={s.importing.total} /> : <span key="a" className="t-3">{t('{n} not used', {n: num(s.notUsed)})}</span>,
              <input
                key="t"
                className={`input sm${on && !off && over?.sourceId === s.id ? ' bad' : ''}`}
                style={{width: 80, textAlign: 'center', padding: '0 8px'}}
                aria-label={t('Examples from {name}', {name: sourceName(s)})}
                placeholder="0"
                disabled={!on || off}
                value={on ? take[s.id] : ''}
                onChange={e => setTake(cur => ({...cur, [s.id]: e.target.value.replace(/\D/g, '')}))}
              />,
            ],
          };
        })}
      />
      <div className="row" style={{justifyContent: 'space-between'}}>
        <span className={over || err ? 't-err' : 't-3'} role={over || err ? 'alert' : undefined}>
          {over
            ? t('Only {n} left in {name}.', {n: num(list.find(s => s.id === over.sourceId)!.notUsed), name: sourceName(list.find(s => s.id === over.sourceId)!)})
            : err
              ? sourceError(err, list)
              : add
                ? t('{n} more examples · items already here are skipped', {n: num(total)})
                : t('{n} examples · repeats across sources count once', {n: num(total)})}
        </span>
        <Button
          label={add ? t('Add examples') : t('Create dataset')}
          kind="primary"
          disabled={!ok}
          onClick={async () => {
            setErr(null);
            try {
              await onTake(picks);
              if (add) setTake({});
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        />
      </div>
    </Card>
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
function Ready({state, failed}: {state: ProjectState; failed: ReactNode}) {
  const snap = state.snapshot!;
  const {minEvalRecommended} = systemConfig().dataset;
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const labeled = evalEx.filter(e => !!state.gold[e.id]).length;
  const pending = evalEx.length - labeled;
  const leftOut = checksTotal(snap.counts.checks);
  const few = evalEx.length < minEvalRecommended;
  const schema = state.setup?.schema ?? null;
  return (
    <div className="row" style={{gap: 32, alignItems: 'flex-start'}}>
      <div className="col" style={{gap: 16, width: 706, flex: 'none'}}>
        {failed}
        {few && <Banner text={t('Fewer than {n} examples: scores will be rough until you add more examples.', {n: minEvalRecommended})} style={{margin: 0}} />}
        <Card title={t('Examples')}>
          <Metrics>
            <Metric label={t('Examples')} value={num(evalEx.length)} />
            <Metric label={t('Gold-labeled')} value={num(labeled)} />
            <Metric label={<Hov text={t('Waiting for gold labels')} tip={t('Scores leave these out until they have a gold label.')} />} value={num(pending)} />
            <Metric label={t('Removed')} value={num(state.removals.length)} />
          </Metrics>
          {state.datasetSources.length > 0 && (
            <Table
              cols={[{label: t('Data source')}, {label: t('Examples')}, {label: t('Added')}]}
              widths={['auto', 110, 150]}
              rows={state.datasetSources.map(l => ({
                key: l.sourceId,
                cells: [
                  <Link key="n" className="one" href={`/source/?id=${encodeURIComponent(l.sourceId)}`} title={sourceName(l)}>
                    {sourceName(l)}
                  </Link>,
                  num(l.examples),
                  <span key="a" className="t-3">
                    {dateTime(l.addedAt)}
                  </span>,
                ],
              }))}
            />
          )}
          {(snap.source !== 'sources' || !!snap.counts.notSaved || leftOut > 0 || (labeled > 0 && pending > 0)) && (
            <div className="row" style={{gap: 12, paddingTop: 8}}>
              {snap.source !== 'sources' && (
                <>
                  <Badge text={snap.source === 'sample' ? t('Sampled') : t('Uploaded')} icon={false} />
                  <span className="t-3 one" style={{fontSize: 13}} title={snap.source === 'upload' ? snap.sourceName : undefined}>
                    {t('{date} · {videos} videos · {photos} photo and text', {date: dateTime(snap.createdAt), videos: num(evalEx.filter(e => e.type === 'video').length), photos: num(evalEx.filter(e => e.type !== 'video').length)})}
                  </span>
                </>
              )}
              {leftOut > 0 && (
                <span className="t-3" style={{fontSize: 13}}>
                  <Hov text={leftOut === 1 ? t('1 item left out') : t('{n} items left out', {n: num(leftOut)})} tip={leftOutWhy(snap.counts.checks!)} />
                </span>
              )}
              {!!snap.counts.notSaved && (
                <span className="t-3" style={{fontSize: 13}}>
                  <Hov text={t('{n} could not be saved', {n: num(snap.counts.notSaved)})} tip={t('Saving these failed twice, so they were skipped. Add more examples to make up for them.')} />
                </span>
              )}
              {labeled > 0 && pending > 0 && <PruneUnlabeled state={state} pending={pending} />}
            </div>
          )}
        </Card>
        {schema && labeled > 0 && <BalanceCard state={state} schema={schema} />}
        {state.removals.length > 0 && <RemovedCard state={state} />}
      </div>
      <AddExamples state={state} />
    </div>
  );
}

/** Add examples (#29; design: V-Dataset-Add-Examples): more from one or more data sources; items already here are skipped. */
/** Why items were left out when they were taken (#32), per check, as the hover says it. */
function leftOutWhy(c: ItemCheckCounts): string {
  const parts = [
    c.missing && t('{n} not found', {n: num(c.missing)}),
    c.minorCreator && t('{n} from a creator under 18', {n: num(c.minorCreator)}),
    c.notRecommendable && t('{n} not publicly recommendable', {n: num(c.notRecommendable)}),
  ].filter(Boolean);
  return t('{list}. Items are checked when they are taken.', {list: parts.join(t(', '))});
}

function AddExamples({state}: {state: ProjectState}) {
  const [list] = useDataSources();
  if (!list?.length) return null;
  return <PickSources key={list.map(s => s.id).join()} list={list} add onTake={picks => takeExamples({projectId: state.project.id, picks})} />;
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
  const [down, setDown] = useState<{value: string; count: number} | null>(null);
  const [keep, setKeep] = useState('');
  const rare = b.values.filter(v => v.rare);
  const mx = Math.max(1, ...b.values.map(x => x.count));
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
        <div className="col" style={{gap: 4}}>
          {[...b.values]
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
                          setDown({value: x.value, count: x.count});
                        }}
                      />
                    )}
                  </span>
                </div>
              );
            })}
        </div>
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
                  await pruneDataset({projectId: state.project.id, mode: 'downsample', value: down.value, keep: parseInt(keep)});
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
            <One key="g" text={r.gold?.length ? r.gold.join(', ') : t('None')} className={r.gold?.length ? undefined : 't-3'} />,
            <span key="at" className="t-3"><Hov text={dateTime(r.removedAt)} tip={t('Removed by {name}', {name: r.removedBy})} /></span>,
            <Button key="r" label={t('Restore')} size="sm" kind="ghost" onClick={() => restoreExamples({projectId: state.project.id, removalIds: [r.id]})} />,
          ],
        }))}
      />
    </Card>
  );
}
