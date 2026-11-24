'use client';

import {useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useMemo, useRef, useState} from 'react';
import {ChevronLeftIcon, ChevronRightIcon, Cog6ToothIcon, RectangleStackIcon} from '@heroicons/react/24/outline';
import {CheckCircleIcon, ExclamationCircleIcon} from '@heroicons/react/20/solid';
import type {Answer, MismatchList, PageContext, SampleRow} from '@yushiguang/sprint-contracts';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {useRuntime} from '@/components/session';
import {RemoveDialog} from '@/components/dataset/dialogs';
import {SetSettingsDialog} from '@/components/gold/dialogs';
import {ExampleCard, Hint, ModelAnswerCard, saveLabel, useModelAnswer, versionNameIn, YourAnswerCard} from '@/components/gold/labeling';
import {rangeText, setName, useLabelSets, useMembers} from '@/components/gold/sets';
import {listSamples, mismatches, reviewGold, type LabelSetView, type ProjectState} from '@/backend-api';
import {Avatar, Banner, Button, Card, EmptyState, HStack, Icon, IconButton, Selector, Spinner, Tab, TabList, Text, VStack} from '@/ui/astryx';
import {PageTitle} from '@/ui';
import {ErrorLine} from '@/components/sources/dialogs';
import {t} from '@/i18n';

/**
 * One label set (wireframes v346: W-LabelSet, W-LabelSet-Mismatch): its labeler labels it here.
 * Tabs All / Unlabeled / Mismatch; on the left the set's sample numbers with what is done; in the
 * middle the example; on the right the model's answer and yours. The Mismatch tab lists the
 * samples whose gold label the version compared with does not match and that are not reviewed
 * for it yet; saving there records the review.
 */
export default function LabelSetPage() {
  return (
    <Suspense fallback={null}>
      <Router />
    </Suspense>
  );
}

const PAGE: PageContext = {label: 'Gold Labels', agent: 'front_desk', intent: 'answer', hint: "If an example doesn't fit any value, tell me and I'll bring in the Prompt helper.", context: {}};

function Router() {
  const q = useSearchParams();
  return (
    <ProjectPage node="gold" page={PAGE}>
      {({state}) => <LabelSet state={state} setId={q.get('set')} tabParam={q.get('tab')} />}
    </ProjectPage>
  );
}

type TabKey = 'all' | 'todo' | 'mismatch';
const tabOf = (p: string | null): TabKey => (p === 'mismatch' || p === 'mismatches' ? 'mismatch' : p === 'todo' ? 'todo' : 'all');

/** The "Saved" beat before a saved example leaves Unlabeled or Mismatch (motion M4). */
const BEAT_MS = 180;
/** listSamples gives at most this many a call; a set is read in pages of it. */
const PAGE_SIZE = 500;

/** What the reads hang on: a new revision of the project reads them again. */
const revisionOf = (s: ProjectState) => s.revision ?? `${s.examples.length}|${s.removals.length}|${Object.keys(s.gold).length}|${s.reports.length}`;

/** Every live sample of the set, by number, read again when the project changes. */
function useSetSamples(projectId: string, setId: string | null, revision: string): {rows: SampleRow[] | null; failed: string | null} {
  const [rows, setRows] = useState<SampleRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!setId) return;
    let live = true;
    void (async () => {
      const all: SampleRow[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await listSamples({projectId, labelSetId: setId, filter: 'live', offset, limit: PAGE_SIZE});
        all.push(...page.items);
        if (all.length >= page.total || !page.items.length) break;
      }
      if (live) {
        setRows(all);
        setFailed(null);
      }
    })().catch(e => live && setFailed((e as Error).message));
    return () => {
      live = false;
    };
  }, [projectId, setId, revision]);
  return {rows, failed};
}

/** The version picked in "Compare with" stays for the session (per project; R5-2). */
const pickKey = (projectId: string) => `gold-compare:${projectId}`;
function readPick(projectId: string): string | null {
  try {
    return sessionStorage.getItem(pickKey(projectId));
  } catch {
    return null;
  }
}
function savePick(projectId: string, id: string) {
  try {
    sessionStorage.setItem(pickKey(projectId), id);
  } catch {
    // Storage off: the pick stays for this page only.
  }
}

/**
 * The set's Mismatches for the version compared with (the best by default). Worked out again when
 * the page opens, another version is picked, or a version or score is added; a review takes its
 * sample off the list here at once.
 */
function useSetMismatches(state: ProjectState, setId: string | null, versionId: string | null) {
  const [list, setList] = useState<MismatchList | null>(null);
  useEffect(() => {
    if (!setId) return;
    let live = true;
    void mismatches(state.project.id, versionId, setId)
      .then(m => live && setList(m))
      .catch(() => live && setList(null));
    return () => {
      live = false;
    };
  }, [state.project.id, setId, versionId, state.versions.length, state.reports.length]);
  const reviewed = (exampleId: string) => setList(l => (l ? {...l, items: l.items.filter(x => x.exampleId !== exampleId)} : l));
  return {list, reviewed};
}

function LabelSet({state, setId, tabParam}: {state: ProjectState; setId: string | null; tabParam: string | null}) {
  const {href} = useProject();
  const {info} = useRuntime();
  const revision = revisionOf(state);
  const {list: sets, failed: setsFailed} = useLabelSets(state.project.id, revision);
  const members = useMembers();
  // Without a set named (Review labels on Prompt Tuning): the first set with mismatches, else the first.
  const set: LabelSetView | null | undefined = sets ? ((setId ? sets.sets.find(s => s.id === setId) : (sets.sets.find(s => s.mismatch > 0) ?? sets.sets[0])) ?? null) : undefined;
  const {rows, failed} = useSetSamples(state.project.id, set?.id ?? null, revision);
  const [cmp, setCmpState] = useState<string | null>(() => readPick(state.project.id));
  const setCmp = (id: string) => {
    setCmpState(id);
    savePick(state.project.id, id);
  };
  const {list: mm, reviewed} = useSetMismatches(state, set?.id ?? null, cmp);
  // The first list picks the best version; from then on the pick holds (R5-2).
  useEffect(() => {
    if (mm?.versionId && cmp !== mm.versionId && (!cmp || !mm.versions.some(v => v.id === cmp))) setCmp(mm.versionId);
  }, [mm?.versionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tab, setTab] = useState<TabKey>(() => tabOf(tabParam));
  useEffect(() => setTab(tabOf(tabParam)), [tabParam]);
  // A just-saved sample stays in Unlabeled or Mismatch for a short "Saved" beat, then the next slides in (M4).
  const [hold, setHold] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SampleRow | null>(null);
  const [settings, setSettings] = useState(false);
  const byId = useMemo(() => new Map((rows ?? []).map(r => [r.exampleId, r])), [rows]);
  const lists = useMemo(
    () => ({
      all: rows ?? [],
      todo: (rows ?? []).filter(r => !r.labeled || r.exampleId === hold),
      mismatch: (mm?.items ?? []).map(x => byId.get(x.exampleId)).filter((r): r is SampleRow => !!r),
    }),
    [rows, hold, mm, byId],
  );
  const shown = lists[tab];
  const [pos, setPos] = useState<Record<TabKey, number>>({all: 0, todo: 0, mismatch: 0});
  const i = Math.min(pos[tab], Math.max(0, shown.length - 1));
  const row = shown[i];
  const ex = row ? state.examples.find(e => e.id === row.exampleId) : undefined;
  const move = (n: number) => setPos(p => ({...p, [tab]: n}));
  const pickTab = (k: TabKey) => {
    setTab(k);
    setPos(p => ({...p, [k]: 0}));
  };

  // The model answer starts hidden while the sample has no label, shown otherwise (round 9);
  // Hide and Show switch it for this sample. Once shown, a label records that it was seen.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const versionId = mm?.versionId ?? null;
  const found = useModelAnswer(state, ex?.id ?? '', versionId);
  const labeled = !!ex && !!state.gold[ex.id];
  const showModel = !!ex && (toggled[ex.id] ?? (labeled || tab === 'mismatch'));
  useEffect(() => {
    if (ex && showModel) setSeen(s => (s.has(ex.id) ? s : new Set(s).add(ex.id)));
  }, [ex?.id, showModel]); // eslint-disable-line react-hooks/exhaustive-deps
  const versionName = versionNameIn(state);
  const item = tab === 'mismatch' && ex ? mm?.items.find(x => x.exampleId === ex.id) : undefined;

  const beat = () => new Promise<void>(res => setTimeout(res, BEAT_MS));
  const onSave = async (answer: Answer, changed: boolean, note: string) => {
    if (!ex) return;
    const leaves = tab === 'todo' || tab === 'mismatch';
    if (leaves) setHold(ex.id);
    try {
      if (tab === 'mismatch' && versionId) {
        await reviewGold({projectId: state.project.id, exampleId: ex.id, promptVersionId: versionId, outcome: changed ? 'changed' : 'kept', ...(changed ? {answer} : {}), ...(note.trim() ? {note} : {})});
        await beat();
        reviewed(ex.id);
      } else {
        await saveLabel(state, ex, answer, changed, note, seen.has(ex.id) && !!found?.answer);
        if (leaves) await beat();
      }
    } finally {
      if (leaves) setHold(null);
    }
  };

  const back = {label: t('Gold Labels'), href: href('/gold')};
  if (setsFailed || failed) return <Frame head={<PageTitle title={t('Label set')} back={back} />}>{<ErrorLine text={setsFailed ?? failed!} />}</Frame>;
  if (set === undefined || (set && !rows))
    return (
      <Frame head={<PageTitle title={set ? setName(set) : t('Label set')} back={back} />}>
        <HStack hAlign="center" paddingBlock={10}>
          <Spinner label={t('Loading')} />
        </HStack>
      </Frame>
    );
  if (!set || !state.setup?.schema)
    return (
      <Frame head={<PageTitle title={t('Label set')} back={back} />}>
        <Card padding={10}>
          <EmptyState
            title={!set ? t('This label set does not exist') : t('Nothing to label with yet')}
            description={!set ? t('It may have been made in another project. Open one from Gold Labels.') : t('Approve the prompt on Prompt Design first: its values are what you label with.')}
            icon={<Icon icon={RectangleStackIcon} size="lg" color="secondary" />}
            actions={<Button label={t('Open Gold Labels')} variant="secondary" href={back.href} />}
          />
        </Card>
      </Frame>
    );

  const labeler = members.find(m => m.userId === set.labelerIds[0]);
  const all = rows!;
  const done = all.filter(r => r.labeled).length;
  const n = (x: number) => x.toLocaleString('en-US');
  const head = (
    <PageTitle
      title={setName(set)}
      back={back}
      titleEnd={
        <Text color="secondary" hasTabularNumbers>
          {rangeText(set.first, set.last)}
        </Text>
      }
      subtitle={
        <HStack gap={2} vAlign="center">
          {labeler && <Avatar name={labeler.name} size="xsm" />}
          <Text color="secondary" hasTabularNumbers>
            {[labeler ? labeler.name : t('No labeler yet'), t('{done} of {total} labeled', {done: n(done), total: n(all.length)})].join(' · ')}
          </Text>
        </HStack>
      }
      actions={
        <>
          <Button label={t('Settings')} variant="ghost" size="sm" icon={<Icon icon={Cog6ToothIcon} size="sm" />} onClick={() => setSettings(true)} />
          <span style={{width: 8}} />
          <IconButton label={t('Previous example')} variant="ghost" icon={<Icon icon={ChevronLeftIcon} size="sm" />} isDisabled={i === 0 || !shown.length} onClick={() => move(i - 1)} />
          <Text type="supporting" color="secondary" hasTabularNumbers style={{minWidth: 56, textAlign: 'center'}}>
            {shown.length ? t('{done} of {total}', {done: n(i + 1), total: n(shown.length)}) : '–'}
          </Text>
          <IconButton label={t('Next example')} variant="ghost" icon={<Icon icon={ChevronRightIcon} size="sm" />} isDisabled={i >= shown.length - 1} onClick={() => move(i + 1)} />
        </>
      }
    />
  );
  const counts: Record<TabKey, number> = {all: all.length, todo: all.filter(r => !r.labeled).length, mismatch: mm?.items.length ?? 0};
  return (
    <Frame head={head}>
      <VStack gap={6}>
        <HStack gap={4} vAlign="end" hAlign="between" className="sp-tabs-row">
          <div className="sp-tabs-inset">
            <TabList role="tablist" aria-label={t('Samples')} value={tab} onChange={v => pickTab(v as TabKey)} hasDivider={false}>
              <Tab value="all" panelId="sp-set-panel" label={t('All')} endContent={<CountBadge n={counts.all} />} />
              <Tab value="todo" panelId="sp-set-panel" label={t('Unlabeled')} endContent={<CountBadge n={counts.todo} />} />
              <Tab value="mismatch" panelId="sp-set-panel" label={t('Mismatch')} endContent={<CountBadge n={counts.mismatch} />} />
            </TabList>
          </div>
          {tab === 'mismatch' && mm && mm.versions.length > 0 && versionId && (
            <HStack gap={2} vAlign="center" style={{paddingBottom: 6}}>
              <Text type="supporting" color="secondary">
                <Hint text={t('Compare with')} tip={t('The version whose answers this tab checks the gold labels against. Saving here records a review for it')} />
              </Text>
              <div style={{width: 160}}>
                <Selector label={t('Compare with')} isLabelHidden size="sm" value={versionId} options={mm.versions.map(v => ({value: v.id, label: v.best ? t('{version} (best)', {version: v.label}) : v.label}))} onChange={v => v && setCmp(v)} />
              </div>
            </HStack>
          )}
        </HStack>
        {Object.keys(state.staleGold).length > 0 && <Banner status="warning" title={t('The label or its values changed. {n} labels were made before the change and need a quick re-check.', {n: n(Object.keys(state.staleGold).length)})} />}
        <div id="sp-set-panel" role="tabpanel">
          {row && ex ? (
            <div className="sp-labeling">
              <SampleNumbers rows={shown} open={row.exampleId} mismatchTab={tab === 'mismatch'} onOpen={k => move(k)} />
              <ExampleCard
                key={`ex-${ex.id}`}
                projectId={state.project.id}
                ex={ex}
                n={row.number}
                hint={item && item.of > 1 ? <Text type="supporting" color="secondary"><Hint text={t('Wrong in {n} of {of} versions', {n: item.wrongIn, of: item.of})} tip={t('The examples wrong in the most versions come first')} /></Text> : undefined}
                onRemove={() => setRemoving(row)}
              />
              <VStack gap={4}>
                <ModelAnswerCard state={state} exampleId={ex.id} found={found} shown={showModel} versionName={versionId ? versionName(versionId) : null} onToggle={() => setToggled(m => ({...m, [ex.id]: !showModel}))} />
                <YourAnswerCard key={`y-${ex.id}-${tab}-${versionId ?? ''}`} state={state} ex={ex} me={info?.user.id ?? null} versionName={versionName} onSave={onSave} />
              </VStack>
            </div>
          ) : (
            <Card padding={10}>
              <TabEmpty tab={tab} hasVersions={!!mm?.versions.length} versionLabel={mm?.versions.find(v => v.id === versionId)?.label ?? null} />
            </Card>
          )}
        </div>
      </VStack>
      {removing && <RemoveDialog projectId={state.project.id} sample={removing} onClose={() => setRemoving(null)} />}
      {settings && <SetSettingsDialog projectId={state.project.id} set={set} members={members} onClose={() => setSettings(false)} />}
    </Frame>
  );
}

function CountBadge({n}: {n: number}) {
  return (
    <Text type="supporting" color="secondary" hasTabularNumbers>
      {n.toLocaleString('en-US')}
    </Text>
  );
}

/** The narrow list of sample numbers (W-LabelSet): what is labeled, what is a mismatch; the open one is marked. */
function SampleNumbers({rows, open, mismatchTab, onOpen}: {rows: SampleRow[]; open: string; mismatchTab: boolean; onOpen: (index: number) => void}) {
  const ref = useRef<HTMLDivElement>(null);
  // The open sample stays in view as Previous and Next move through the list.
  useEffect(() => {
    ref.current?.querySelector('[aria-current="true"]')?.scrollIntoView({block: 'nearest'});
  }, [open]);
  return (
    <div ref={ref} className="sp-numbers" role="list" aria-label={t('Samples')}>
      {rows.map((r, k) => {
        const mismatch = mismatchTab || r.mismatch;
        return (
          <button key={r.exampleId} type="button" role="listitem" className="sp-number" aria-current={r.exampleId === open} onClick={() => onOpen(k)}>
            <Text hasTabularNumbers weight={r.exampleId === open ? 'semibold' : 'normal'}>{`#${r.number.toLocaleString('en-US')}`}</Text>
            {mismatch ? <Icon icon={ExclamationCircleIcon} size="sm" color="error" label={t('Mismatch')} /> : r.labeled ? <Icon icon={CheckCircleIcon} size="sm" color="success" label={t('Labeled')} /> : null}
          </button>
        );
      })}
    </div>
  );
}

function TabEmpty({tab, hasVersions, versionLabel}: {tab: TabKey; hasVersions: boolean; versionLabel: string | null}) {
  const [title, text] =
    tab === 'todo'
      ? [t('Every example is labeled'), t('Labels you saved are under All.')]
      : tab === 'mismatch'
        ? hasVersions
          ? [t('No mismatches left'), versionLabel ? t('Every label {version} disagrees with has been checked.', {version: versionLabel}) : t('Every label the model disagrees with has been checked.')]
          : [t('No mismatches yet'), t('They show once a version has answers on every labeled example.')]
        : [t('No examples in this set'), t('Every example in its range was removed.')];
  return <EmptyState title={title} description={text} icon={<Icon icon={RectangleStackIcon} size="lg" color="secondary" />} />;
}

