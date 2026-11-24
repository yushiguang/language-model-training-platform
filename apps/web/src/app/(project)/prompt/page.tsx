'use client';

import {useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useState} from 'react';
import type {Answer, PageContext} from '@yushiguang/sprint-contracts';
import {ArrowPathIcon, PencilSquareIcon, PlayIcon, StopIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {useSettings} from '@/components/ProjectSettings';
import {WithSide} from '@/components/shell/Page';
import {labelCounts} from '@/components/LabelDistribution';
import {predictionsFor, rescore, scoreVersion, stopOptimiser, stopRun, type ProjectState} from '@/backend-api';
import {Banner, Button, EmptyState, HStack, Icon, ProgressBar, Spinner, VStack} from '@/ui/astryx';
import {action, num, PageTitle} from '@/ui';
import {t} from '@/i18n';
import {bestItem, busy, endpointOf, orderItems, tuningItems, type SortBy, type TuningItem} from '@/components/tuning/items';
import {VersionRow} from '@/components/tuning/VersionRow';
import {AnswerSpread, ScoreCards, ScoresWait, ValueRows} from '@/components/tuning/Scores';
import {Suggestions, SuggestionsLater, SuggestionsWaiting} from '@/components/tuning/Suggestions';
import {OptimiseDialog, OptimiserProgress} from '@/components/tuning/Optimiser';

const PAGE: PageContext = {label: 'Prompt Tuning', agent: 'front_desk', intent: 'answer', hint: 'Ask me about any version.', context: {}};

/**
 * Step 4, Prompt Tuning (wireframes v346, W-PromptTuning*): a row of version cards; under it the
 * selected version's Scores and Values, with Suggestions on the right. Before every label set is
 * done there are no scores: versions show "Labeled" and Values how the answers spread. A running
 * Optimiser has a card of its own whose Progress shows when it is selected.
 */
export default function PromptTuningPage() {
  return (
    <Suspense fallback={null}>
      <Router />
    </Suspense>
  );
}

function Router() {
  const vId = useSearchParams().get('v');
  const [page, setPage] = useState<PageContext>(PAGE);
  return (
    <ProjectPage node="prompt" page={page}>
      {({state}) =>
        !state.versions.length || !state.setup?.schema ? (
          <Frame head={<PageTitle title={t('Prompt Tuning')} />}>
            <EmptyState title={t('No prompt yet')} description={t('Save the first prompt on Prompt Design.')} />
          </Frame>
        ) : (
          <Tuning state={state} vId={vId} setPage={setPage} />
        )
      }
    </ProjectPage>
  );
}

/** A per-browser memory for this page (the pin, the scores already opened); null when unset or storage is off. */
function useStored<T>(key: string): [T | null, (v: T) => void, boolean] {
  const [v, setV] = useState<T | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setV(raw == null ? null : (JSON.parse(raw) as T));
    } catch {
      setV(null);
    }
    setLoaded(true);
  }, [key]);
  const save = (x: T) => {
    setV(x);
    try {
      localStorage.setItem(key, JSON.stringify(x));
    } catch {
      // Storage off: the choice lasts for this page only.
    }
  };
  return [v, save, loaded];
}

function Tuning({state, vId, setPage}: {state: ProjectState; vId: string | null; setPage: (p: PageContext) => void}) {
  const {href} = useProject();
  const settings = useSettings();
  const projectId = state.project.id;
  const setup = state.setup!;
  const thr = setup.thresholds;
  const sc = state.scoring;
  const [sort, setSort] = useState<SortBy>('score');
  const [pinned, setPinned] = useStored<number | null>(`sp-pt-pin:${projectId}`);
  const [seenList, setSeen, seenLoaded] = useStored<string[]>(`sp-pt-seen:${projectId}`);
  const all = useMemo(() => tuningItems(state), [state]);
  const scoredIds = all.flatMap(i => (i.state.kind === 'scored' ? [i.state.report.id] : []));
  // The first visit has opened nothing: every score there is counts as seen.
  useEffect(() => {
    if (seenLoaded && seenList === null) setSeen(scoredIds);
  }, [seenLoaded, seenList]); // eslint-disable-line react-hooks/exhaustive-deps
  const seen = new Set(seenList ?? scoredIds);
  const unread = (i: TuningItem) => i.state.kind === 'scored' && !seen.has(i.state.report.id);
  const items = orderItems(all, sort, pinned, unread);
  const best = bestItem(all);
  const asked = vId ? state.versions.find(v => v.id === vId)?.major : undefined;
  const [selMajor, setSel] = useState<number | null>(asked ?? null);
  const sel = items.find(i => i.major === selMajor) ?? (best ? items.find(i => i.major === best.major) : undefined) ?? items[0];
  // The selection is kept in the address (?v=), so a reload or a language switch keeps it.
  const keep = (major: number) => {
    const id = state.versions.filter(v => v.major === major).at(-1)?.id;
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    if (id) u.searchParams.set('v', id);
    else u.searchParams.delete('v');
    window.history.replaceState(null, '', u);
  };
  const select = (major: number) => {
    setSel(major);
    keep(major);
    const it = items.find(i => i.major === major);
    if (it?.state.kind === 'scored' && !seen.has(it.state.report.id)) setSeen([...seen, it.state.report.id]);
  };
  useEffect(() => {
    if (sel) setPage({...PAGE, label: `Prompt Tuning · ${sel.label}`, context: {version: sel.label}});
  }, [sel?.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const [optimise, setOptimise] = useState(false);

  if (!sel) return null;
  const version = sel.version;
  const s = sel.state;
  const optimiserBusy = state.optimisation.some(busy);
  const editHref = version ? href('/prompt-design', {v: version.id}) : undefined;
  const edit = editHref ? <Button key="edit" label={t('Edit')} variant="secondary" icon={<Icon icon={PencilSquareIcon} size="sm" />} href={editHref} /> : null;
  const stopAll = (runs: {projectId: string; id: string}[]) => Promise.all(runs.map(r => stopRun({projectId: r.projectId, runId: r.id})));
  const retry = async () => {
    // Paid work started by a click: the first one confirms Project Settings (spec 2.3).
    if (!version || !(await settings.confirmed())) return;
    await scoreVersion({projectId, promptVersionId: version.id});
  };
  const canRescore = state.scoresUpdating && sc.ready && !sc.rescoring;
  const actions =
    s.kind === 'optimiser' ? (
      <Button label={t('Stop')} variant="secondary" icon={<Icon icon={StopIcon} size="sm" />} clickAction={action(t('Stop'), () => stopOptimiser({projectId, runId: s.run.id}))} />
    ) : s.kind === 'labeling' || s.kind === 'queued' ? (
      <>
        {edit}
        <Button label={s.kind === 'queued' ? t('Cancel') : t('Stop')} variant="secondary" icon={<Icon icon={s.kind === 'queued' ? XMarkIcon : StopIcon} size="sm" />} clickAction={action(t('Stop'), () => stopAll(s.runs))} />
      </>
    ) : s.kind === 'failed' || s.kind === 'stopped' || s.kind === 'new' ? (
      <>
        {edit}
        {sc.ready && <Button label={s.kind === 'new' ? t('Score') : t('Retry')} variant="secondary" icon={<Icon icon={ArrowPathIcon} size="sm" />} clickAction={action(t('Retry'), retry)} />}
      </>
    ) : s.kind === 'labeled' ? (
      edit
    ) : (
      <>
        {edit}
        <Button
          label={t('Rescore')}
          variant="secondary"
          icon={<Icon icon={ArrowPathIcon} size="sm" />}
          isDisabled={!canRescore}
          tooltip={sc.rescoring ? t('Rescoring now') : !canRescore ? t('Scores are up to date') : undefined}
          clickAction={action(t('Rescore'), () => rescore(projectId))}
        />
        <Button
          label={t('Optimise')}
          variant={'ai' as never}
          icon={<Icon icon={PlayIcon} size="sm" />}
          isDisabled={optimiserBusy}
          tooltip={optimiserBusy ? t('The Optimiser is already running') : undefined}
          clickAction={action(t('Optimise'), async () => {
            if (await settings.confirmed()) setOptimise(true);
          })}
        />
      </>
    );
  const subtitle = sc.ready
    ? t('Scored on {n} examples with a person’s label', {n: num(sc.labeled)})
    : sc.ranges
      ? t('Not scored yet: {done} of {n} label sets are done', {done: sc.labelSetsDone, n: sc.labelSets})
      : t('Not scored yet: no example has a person’s label');

  return (
    <Frame head={<PageTitle title={t('Prompt Tuning')} subtitle={subtitle} actions={<HStack gap={2}>{actions}</HStack>} />}>
      <VStack gap={8}>
        <RescoreBanner state={state} />
        <VersionRow items={items} selected={sel.major} onSelect={select} sort={sort} onSort={setSort} pinned={pinned ?? null} onPin={setPinned} best={best?.major ?? null} unread={unread} />
        {s.kind === 'optimiser' ? (
          <OptimiserProgress state={state} run={s.run} />
        ) : (
          <WithSide side={!sc.ready ? <SuggestionsWaiting state={state} /> : s.kind === 'scored' && version ? <Suggestions state={state} versionId={version.id} onOptimise={() => setOptimise(true)} onSwitch={id => select(state.versions.find(v => v.id === id)?.major ?? sel.major)} /> : <SuggestionsLater />}>
            <Detail state={state} item={sel} items={all} />
          </WithSide>
        )}
      </VStack>
      {optimise && version && s.kind === 'scored' && (
        <OptimiseDialog
          state={state}
          versionId={version.id}
          label={sel.label}
          score={s.report.metrics.macroF1}
          onClose={() => setOptimise(false)}
          onStarted={major => {
            setOptimise(false);
            setSel(major);
            if (major != null) keep(major);
          }}
        />
      )}
    </Frame>
  );
}

/**
 * Scores out of date (docs/design/server.md 4.3): what changed since they were built, and Rescore
 * works every version's scores out again from the answers already saved.
 */
function RescoreBanner({state}: {state: ProjectState}) {
  const sc = state.scoring;
  if (sc.rescoring) return <Banner status="info" title={t('Rescoring')} description={t('Every version’s scores update when it is done; nothing is labeled again.')} icon={<Spinner size="sm" aria-label={t('Rescoring')} />} />;
  if (!sc.ready || !sc.staleVersionIds.length) return null;
  const only = sc.changed.length === 1 ? sc.changed[0] : null;
  const title =
    only === 'gold'
      ? t('Gold labels changed after these scores were built')
      : only === 'samples'
        ? t('The examples changed after these scores were built')
        : only === 'thresholds'
          ? t('The thresholds changed after these scores were built')
          : t('Examples, gold labels or thresholds changed after these scores were built');
  return <Banner status="warning" title={title} description={t('Press Rescore to update every version’s scores; nothing is labeled again.')} />;
}

/** The main column for the selected version: its Scores and Values, or where its labeling stands. */
function Detail({state, item, items}: {state: ProjectState; item: TuningItem; items: TuningItem[]}) {
  const thr = state.setup!.thresholds!;
  const s = item.state;
  const label = item.label;
  switch (s.kind) {
    case 'scored': {
      const prev = items.filter(i => i.state.kind === 'scored' && i.major < item.major).sort((a, b) => b.major - a.major)[0];
      const previous = prev?.state.kind === 'scored' ? prev.state.report : null;
      return (
        <VStack gap={8}>
          <ScoreCards report={s.report} thr={thr} label={label} />
          <ValueRows report={s.report} previous={previous} thr={thr} values={state.setup!.schema!.values.map(v => v.name)} />
        </VStack>
      );
    }
    case 'labeling':
      return (
        <ScoresWait label={label} title={t('Labeling {pct}%', {pct: s.total ? Math.floor((100 * s.done) / s.total) : 0})} text={t('Its scores show here when it is done.')}>
          <ProgressBar label={t('Labeling')} isLabelHidden value={s.done} max={Math.max(1, s.total)} variant="neutral" />
        </ScoresWait>
      );
    case 'queued':
      return <ScoresWait label={label} title={t('Queued')} text={s.ahead ? t('{n} jobs for this model go first. Its scores show here when it is done.', {n: s.ahead}) : t('It starts when the model is free. Its scores show here when it is done.')} />;
    case 'failed':
      return <ScoresWait label={label} title={t('{version} stopped at {done} of {total}', {version: label, done: num(s.run.done), total: num(s.run.total)})} text={`${s.run.error ? `${t(s.run.error)} ` : ''}${t('Retry goes on from where it stopped.')}`} />;
    case 'stopped':
      return <ScoresWait label={label} title={t('{version} was stopped at {done} of {total}', {version: label, done: num(s.run.done), total: num(s.run.total)})} text={t('Retry goes on from where it stopped.')} />;
    case 'new':
      return <ScoresWait label={label} title={t('Not labeled yet')} text={state.scoring.ready ? t('Score labels the dataset with this version.') : t('It is labeled once the label sets are done.')} />;
    case 'labeled':
      return <Spread state={state} item={item} />;
    case 'optimiser':
      return null;
  }
}

/** A labeled version before scores (round 18): how its answers spread over the values. */
function Spread({state, item}: {state: ProjectState; item: TuningItem}) {
  const setup = state.setup!;
  const v = item.version!;
  const ep = endpointOf(state);
  const [answers, setAnswers] = useState<(Answer | null)[] | null>(null);
  useEffect(() => {
    const settings = setup.models.find(m => m.endpoint === ep);
    if (!settings || !ep) return;
    const evalIds = new Set(state.examples.filter(e => e.split === 'eval').map(e => e.id));
    let live = true;
    void predictionsFor(v.projectId, v.id, ep, settings).then(m => live && setAnswers(Object.values(m).filter(p => evalIds.has(p.exampleId)).map(p => p.answer)));
    return () => void (live = false);
  }, [v.id, ep]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!answers) return null;
  const counts = labelCounts(setup.schema!, answers);
  return <AnswerSpread counts={counts} label={item.label} total={answers.length} />;
}

