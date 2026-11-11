'use client';

import {useGo} from '@/components/nav';
import {useSearchParams} from 'next/navigation';
import {Fragment, Suspense, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import type {Answer, Example, ExampleMedia, LabelField, MismatchList, MismatchReview} from '@tsp/contracts';
import {FEATURES, versionLabel} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {approveNode, exampleMedia, mismatches, predictionsFor, rebuildReports, reopenGold, reviewGold, saveGold, type ProjectState} from '@/backend-api';
import {Badge, Banner, Button, Card, Code, dateTime, Empty, Hov, Icon, num, PageHead, reportActionError, Seg, Tabs} from '@/ui';

type SetKey = 'eval' | 'test' | 'mismatch';

export default function GoldPage() {
  return (
    <Suspense fallback={null}>
      <GoldRouter />
    </Suspense>
  );
}

function GoldRouter() {
  const q = useSearchParams();
  return (
    <ProjectPage node="gold" page={{label: 'Gold Labels', agent: 'front_desk', intent: 'answer', hint: "If an example doesn't fit any value, tell me and I'll bring in the schema agent.", context: {}}}>
      {({state}) => <Gold state={state} tabParam={q.get('tab')} />}
    </ProjectPage>
  );
}

/** How long after the last gold edit the lists and scores are worked out again (R5-5). */
const SETTLE_MS = 1500;

/**
 * The Mismatches list for the picked version (review finding 2). It reads saved answers only.
 * Acceptance R5-5: a burst of gold edits is worked out once, SETTLE_MS after the last one, and the
 * reports those edits archived are rebuilt then too; `edit` applies a review to the list at once,
 * so the user keeps going without waiting. A new version, a new score or another picked version
 * reloads at once.
 */
function useMismatches(state: ProjectState, versionId: string | null): {list: MismatchList | null; settling: boolean; edited: (exampleId: string, review: MismatchReview | null) => void} {
  const [list, setList] = useState<MismatchList | null>(null);
  const [n, setN] = useState(0);
  const [settling, setSettling] = useState(false);
  const first = useRef(true);
  const lastEdit = useRef(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      void mismatches(state.project.id, versionId).then(m => {
        if (!live) return;
        setList(m);
        setSettling(false);
        if (lastEdit.current) void rebuildReports(state.project.id);
        lastEdit.current = 0;
      });
    const wait = first.current ? 0 : Math.max(0, lastEdit.current + SETTLE_MS - Date.now());
    first.current = false;
    if (!wait) load();
    const id = wait ? setTimeout(load, wait) : undefined;
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [state.project.id, versionId, state.contextId, state.reports.length, state.versions.length, n]);
  const edited = (exampleId: string, review: MismatchReview | null) => {
    lastEdit.current = Date.now();
    setSettling(true);
    setList(l => {
      if (!l) return l;
      const item = l.items.find(x => x.exampleId === exampleId);
      if (review) {
        const reviewedItems = [review, ...l.reviewedItems.filter(r => r.exampleId !== exampleId)];
        return {...l, items: l.items.filter(x => x.exampleId !== exampleId), reviewedItems, reviewed: reviewedItems.length, reviewedAll: l.reviewedAll + 1};
      }
      // Reopened: back in To review until the list is worked out again.
      const reviewedItems = l.reviewedItems.filter(r => r.exampleId !== exampleId);
      return {...l, items: item ? l.items : [...l.items, {exampleId, wrongIn: 0, of: l.versions.length}], reviewedItems, reviewed: reviewedItems.length};
    });
    setN(x => x + 1);
  };
  return {list, settling, edited};
}

/** R5-2: the version picked in "Compare with" stays for the session (per project). */
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

const sameValues = (a: string[] = [], b: string[] = []) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

function Gold({state, tabParam}: {state: ProjectState; tabParam: string | null}) {
  const go = useGo();
  const {href} = useProject();
  const [cmp, setCmpState] = useState<string | null>(() => readPick(state.project.id));
  const setCmp = (id: string) => {
    setCmpState(id);
    savePick(state.project.id, id);
  };
  const {list: mm, settling, edited} = useMismatches(state, cmp);
  // R5-2: the first list picks the best version; from then on the pick holds, and only the
  // "(best)" mark moves when scores change.
  useEffect(() => {
    if (mm?.versionId && cmp !== mm.versionId && (!cmp || !mm.versions.some(v => v.id === cmp))) setCmp(mm.versionId);
  }, [mm?.versionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // R4-5: Mismatches splits into To review and Reviewed, both for the version picked for the page.
  const [sub, setSub] = useState<'open' | 'done'>('open');
  const byId = useMemo(() => new Map(state.examples.map(e => [e.id, e])), [state.examples]);
  const sets = useMemo(
    () => ({
      eval: state.examples.filter(e => e.split === 'eval'),
      test: state.examples.filter(e => e.split === 'test'),
      mismatch: (sub === 'done' ? (mm?.reviewedItems ?? []) : (mm?.items ?? [])).map(x => byId.get(x.exampleId)!).filter(Boolean),
    }),
    [state.examples, mm, byId, sub],
  );
  // "Review labels" on Prompt versions opens the Mismatches tab.
  const [tab, setTab] = useState<SetKey>(tabParam === 'mismatches' ? 'mismatch' : 'eval');
  useEffect(() => {
    if (tabParam === 'mismatches') setTab('mismatch');
  }, [tabParam]);
  const list = sets[tab];
  const firstOpen = (k: SetKey) => (k === 'mismatch' ? 0 : Math.max(0, sets[k].findIndex(e => !state.gold.has(e.id))));
  // Opens on the first example without a gold label; it stays put while labels save. On
  // Mismatches, a kept or changed example leaves the list and the next one takes its place.
  const [pos, setPos] = useState<Record<SetKey, number>>(() => ({eval: firstOpen('eval'), test: firstOpen('test'), mismatch: 0}));
  const i = Math.min(pos[tab], Math.max(0, list.length - 1));
  const ex = list[i];
  const onMismatch = tab === 'mismatch';
  // The model answer starts hidden on every example; Show reveals it for this example only (R2-2).
  // On Mismatches it shows from the start.
  const [shownFor, setShownFor] = useState<Set<string>>(() => new Set());
  const showModel = !!ex && (onMismatch || shownFor.has(ex.id));
  // Once shown on an example, the label records that the answer was seen, even if hidden again.
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  // The model's answer for the example on screen (null: none, or invalid); a label only counts as
  // "model answer seen" when there was one to see.
  const [model, setModel] = useState<{exampleId: string; answer: Answer | null} | null>(null);
  const modelAnswer = model && ex && model.exampleId === ex.id ? model.answer : null;
  const evalDone = state.facts.goldEvalDone >= sets.eval.length && sets.eval.length > 0;
  const move = (n: number) => setPos(p => ({...p, [tab]: n}));
  const versionId = mm?.versionId ?? null;
  const item = onMismatch && ex && sub === 'open' ? mm?.items.find(x => x.exampleId === ex.id) : undefined;
  const done = onMismatch && ex && sub === 'done' ? mm?.reviewedItems.find(x => x.exampleId === ex.id) : undefined;
  const gold = ex ? state.gold.get(ex.id)?.answer : undefined;
  const diff = onMismatch && gold && modelAnswer ? new Set(state.setup!.schema!.fields.filter(f => !sameValues(gold[f.name], modelAnswer[f.name])).map(f => f.name)) : new Set<string>();
  const review = async (outcome: 'kept' | 'changed', note: string, answer?: Answer) => {
    if (!ex || !versionId) return;
    const at = new Date().toISOString();
    const used = outcome === 'kept' ? 'kept' : answer && modelAnswer && same(answer, modelAnswer) ? 'model' : 'other';
    await reviewGold(state.project.id, ex.id, versionId, outcome, answer, note);
    edited(ex.id, {exampleId: ex.id, outcome: used, note: note.trim() || null, at});
  };
  const reopen = async () => {
    if (!ex || !versionId) return;
    try {
      await reopenGold(state.project.id, ex.id, versionId);
    } catch (e) {
      reportActionError(`The review could not be reopened: ${(e as Error).message}`);
      return;
    }
    edited(ex.id, null);
  };
  const pickSub = (v: 'open' | 'done') => {
    setSub(v);
    setPos(p => ({...p, mismatch: 0}));
  };

  const head = (
    <PageHead
      title="Gold Labels"
      actions={
        <>
          {onMismatch && mm && (
            <>
              <Seg
                label="Mismatches"
                value={sub}
                onChange={pickSub}
                options={[
                  {value: 'open', label: `To review ${num(mm.items.length)}`},
                  {value: 'done', label: `Reviewed ${num(mm.reviewed)}`},
                ]}
              />
              <span style={{width: 8}} />
            </>
          )}
          {list.length > 0 && (
            <>
              <Button label="" ariaLabel="Previous" kind="ghost" icon="left" disabled={i === 0} onClick={() => move(i - 1)} />
              <span className="t-2" style={{fontSize: 13, minWidth: 56, textAlign: 'center'}}>
                {num(i + 1)} of {num(list.length)}
              </span>
              <Button label="" ariaLabel="Next" kind="ghost" icon="right" disabled={i >= list.length - 1} onClick={() => move(i + 1)} />
            </>
          )}
          <Button
            label="Next: Prompt Engineering"
            kind="primary"
            disabled={!evalDone}
            title={evalDone ? undefined : 'Label every eval example first. Gold labels on the test set are optional.'}
            onClick={async () => {
              await approveNode(state.project.id, 'gold');
              await go(href('/prompt'));
            }}
          />
        </>
      }
    />
  );

  if (!state.snapshot?.split || !state.setup?.schema)
    return (
      <Frame head={<PageHead title="Gold Labels" />}>
        <Empty title="No examples to label yet" text="Split the dataset first, then label the eval set here." />
      </Frame>
    );

  const picked = mm?.versions.find(v => v.id === versionId);
  // A version has scores, so the Mismatches tab and Compare with will be there (R5-1).
  const expectMm = state.reports.some(r => r.schemaVersion === state.setup!.schemaVersion);
  return (
    <Frame head={head}>
      {state.staleGold.size > 0 && <Banner text={`The schema changed. ${num(state.staleGold.size)} labels were made under the old schema and need a quick re-check.`} />}
      <Tabs
        label="Sets"
        selected={tab}
        onSelect={setTab}
        items={[
          {key: 'eval', label: 'Eval set', count: `${num(state.facts.goldEvalDone)} / ${num(sets.eval.length)}`},
          {key: 'test', label: 'Test set', count: `${num(state.facts.goldTestDone)} / ${num(sets.test.length)}`},
          // Once a version has answers on the whole eval set.
          // R5-1: the tab is there from the first paint when versions have scores; its count
          // follows once the list is worked out.
          ...(mm?.versions.length || (!mm && expectMm) ? [{key: 'mismatch' as const, label: 'Mismatches', count: mm ? num(mm.items.length) : '–'}] : []),
        ]}
        end={
          // Evelyn 2026-11-11: one "Compare with" for the page. Every tab shows this version's
          // answers, and Mismatches and reviews are for it.
          (mm?.versions.length && versionId) || (!mm && expectMm) ? (
            <div className="row" style={{alignItems: 'center', paddingBottom: 6}}>
              {(settling || state.scoresUpdating) && (
                <span style={{marginRight: 12}}>
                  <Badge text="Scores updating" tone="run" />
                </span>
              )}
              <span className="t-3" style={{fontSize: 13, marginRight: 8}}>
                <Hov text="Compare with" tip="The version whose answers show on every tab. Mismatches and reviews are for this version" />
              </span>
              <span className="select" style={{width: 132}}>
                <select aria-label="Compare with" style={{height: 32}} value={versionId ?? ''} disabled={!mm} onChange={e => setCmp(e.target.value)}>
                  {(mm?.versions ?? []).map(v => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                      {v.best ? ' (best)' : ''}
                    </option>
                  ))}
                </select>
                <Icon name="chev" />
              </span>
            </div>
          ) : undefined
        }
      />
      {ex ? (
        <div style={{display: 'grid', gridTemplateColumns: '520px 1fr', gap: 16, alignItems: 'start'}}>
          <ExampleCard ex={ex} n={onMismatch ? sets.eval.indexOf(ex) + 1 : i + 1} extra={item ? <Hov text={`Wrong in ${item.wrongIn} of ${item.of} versions`} tip="The examples wrong in the most versions come first" /> : undefined} />
          <div className="col" style={{gap: 16}}>
            <ModelAnswer
              key={`m-${ex.id}-${versionId ?? ''}`}
              state={state}
              ex={ex}
              versionId={versionId}
              paged={!!mm?.versions.length}
              why={onMismatch}
              shown={showModel}
              toggle={!onMismatch}
              diff={diff}
              onToggle={() =>
                setShownFor(s => {
                  const n = new Set(s);
                  if (n.has(ex.id)) n.delete(ex.id);
                  else {
                    n.add(ex.id);
                    setSeen(x => new Set(x).add(ex.id));
                  }
                  return n;
                })
              }
              onFound={answer => setModel({exampleId: ex.id, answer})}
            />
            <YourAnswer
              key={`y-${ex.id}-${tab}-${sub}-${versionId ?? ''}`}
              state={state}
              ex={ex}
              modelShown={(showModel || seen.has(ex.id)) && !!modelAnswer}
              review={onMismatch && picked ? {modelAnswer, done, onKeep: note => review('kept', note), onChange: (a, note) => review('changed', note, a), onReopen: reopen} : undefined}
            />
          </div>
        </div>
      ) : onMismatch && sub === 'done' ? (
        mm && <Empty title="Nothing reviewed yet" text={`Labels you keep or change for ${picked?.label ?? 'this version'} show here.`} />
      ) : onMismatch ? (
        mm && <Empty title="No mismatches left" text={`Every label ${picked?.label ?? 'the model'} disagrees with has been checked.`} />
      ) : (
        <Empty title="No examples in this set" text="Change the split on the Dataset page to add some." />
      )}
    </Frame>
  );
}

/**
 * The example with the features of its own type (design: media on top, one line per feature).
 * The media tile embeds the player page the platform's media source returns, with the still
 * images (cover, a photo post's images, or key frames) under it; without a media source it
 * shows the item id only.
 */
const SHOWN = new Set(['Title', 'Description', 'OCR_Text', 'ASR', 'Creator_Nick_Name', 'Creator_Bio', 'Hashtags', 'Create_Time', 'Country_Code', 'Language', 'POI_Name', 'POI_Info', 'Interest_V3', 'Summary']);
const IMAGE_KEYS = new Set(Object.values(FEATURES).flatMap(list => list.filter(d => d.isImage).map(d => d.key)));
const FEATURE_LABEL = new Map(Object.values(FEATURES).flatMap(list => list.map(d => [d.key, d.label] as const)));

function ExampleCard({ex, n, extra}: {ex: Example; n: number; extra?: ReactNode}) {
  const [media, setMedia] = useState<ExampleMedia | null | undefined>(undefined);
  const [picked, setPicked] = useState(0);
  const [view, setView] = useState<'player' | 'image'>('player');
  useEffect(() => {
    let live = true;
    setMedia(undefined);
    setPicked(0);
    setView('player');
    void exampleMedia(ex.id)
      .then(m => live && setMedia(m))
      .catch(() => live && setMedia(null));
    return () => {
      live = false;
    };
  }, [ex.id]);
  const stills = media ? [...(media.coverUrl ? [media.coverUrl] : []), ...media.imageUrls.filter(u => u !== media.coverUrl)] : [];
  const f = (k: string) => {
    const v = ex.features[k];
    return (Array.isArray(v) ? v.join(', ') : (v ?? '')).trim();
  };
  const joined = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  const posted = f('Create_Time');
  const rows: [string, string][] = (
    [
      ['Title', ex.title || f('Title')],
      ['Description', f('Description')],
      ['On-screen text', f('OCR_Text')],
      ['Speech', f('ASR')],
      ['Creator', joined(f('Creator_Nick_Name'), f('Creator_Bio'))],
      ['Hashtags', f('Hashtags')],
      ['Posted', posted ? dateTime(posted.replace(' ', 'T')) : ''],
      ['Country, language', joined(f('Country_Code'), f('Language'))],
      ['Place', joined(f('POI_Name'), f('POI_Info'))],
      ['Interest', f('Interest_V3')],
      ['Summary', f('Summary')],
      // Every other feature the example has, under its catalogue name, so nothing is hidden.
      ...Object.keys(ex.features)
        .filter(k => !SHOWN.has(k) && !IMAGE_KEYS.has(k) && !/(^|_)(url|urls|id)$/i.test(k))
        .map(k => [FEATURE_LABEL.get(k) ?? k.replace(/_/g, ' '), f(k)]),
    ] as [string, string][]
  ).filter(([, v]) => v);
  return (
    <Card title={`Example ${n}`} titleExtra={extra ? <span className="t-3" style={{fontSize: 13}}>{extra}</span> : undefined}>
      <div className="media">
        {media?.playerUrl && view === 'player' ? (
          <iframe
            src={media.playerUrl}
            title={`Player for item ${ex.externalId}`}
            style={{position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0}}
            allow="encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            loading="lazy"
          />
        ) : stills.length ? (
          <img src={stills[Math.min(picked, stills.length - 1)]} alt="" style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain'}} />
        ) : (
          <Icon name={ex.type === 'video' ? 'video' : 'image'} />
        )}
        <small>
          {ex.externalId}
          {media?.durationSec ? ` · ${Math.round(media.durationSec)}s` : ''}
        </small>
      </div>
      {(stills.length > 1 || media?.playerUrl) && (
        <div className="row" style={{gap: 6, flexWrap: 'wrap', alignItems: 'center'}}>
          {media?.playerUrl && (
            <button type="button" className="opt" style={{border: '1px solid var(--border)', fontWeight: view === 'player' ? 600 : 400}} aria-label="Show the player" onClick={() => setView('player')}>
              ▶ Player
            </button>
          )}
          {stills.map((u, k) => (
            <button key={k} type="button" className="copy" style={{padding: 0, visibility: 'visible', outline: view === 'image' && k === picked ? '2px solid var(--line-2)' : undefined}} aria-label={`Show image ${k + 1}`} onClick={() => { setPicked(k); setView('image'); }}>
              <img src={u} alt="" style={{width: 44, height: 44, objectFit: 'cover', borderRadius: 6, display: 'block'}} />
            </button>
          ))}
          <span className="small muted">{view === 'player' ? 'Stills from the item — click one to inspect it' : 'Still image — click Player to go back to the video'}</span>
        </div>
      )}
      <div className="kv">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <span>{k}</span>
            <span title={v}>{v}</span>
          </Fragment>
        ))}
      </div>
    </Card>
  );
}

const CHIP = {cursor: 'default', background: 'var(--bg-muted)', borderColor: 'transparent'} as const;
const CHIP_DIFF = {cursor: 'default', background: '#fdecec', borderColor: 'transparent', color: '#b42318'} as const;

/**
 * The model's answer, from the version picked for the page (review finding 2, moved to the page by
 * Evelyn 2026-11-11; default: the best scored version with answers on the whole eval set). Before
 * any version has those, it is the newest version with an answer for this example, named in the
 * card. On Mismatches (`why`) it adds the model's own short reason, or why its reply could not be
 * read (R4-4).
 */
function ModelAnswer({
  state,
  ex,
  versionId,
  paged,
  why,
  shown,
  toggle,
  diff,
  onToggle,
  onFound,
}: {
  state: ProjectState;
  ex: Example;
  versionId: string | null;
  paged: boolean;
  why: boolean;
  shown: boolean;
  toggle: boolean;
  diff: Set<string>;
  onToggle: () => void;
  onFound: (answer: Answer | null) => void;
}) {
  const [found, setFound] = useState<{answer: Answer | null; invalid: string | null; reason: string | null; label: string; endpoint: string} | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void (async () => {
      const candidates = versionId ? state.versions.filter(v => v.id === versionId) : [...state.versions].reverse();
      for (const v of candidates)
        for (const m of state.setup!.models) {
          const p = (await predictionsFor(v.id, m.endpoint, m)).get(ex.id);
          if (p) {
            if (live) onFound(p.answer);
            if (live) setFound({answer: p.answer, invalid: p.invalidReason, reason: p.reason ?? null, label: versionLabel(v), endpoint: state.endpoints.find(e => e.id === m.endpoint)?.name ?? m.endpoint});
            return;
          }
        }
      if (live) {
        onFound(null);
        setFound(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [ex.id, versionId, state.versions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const schema = state.setup!.schema!;
  // No model answer for this example (or still looking) and nothing to pick: no card at all (design, 2026-11-09).
  if (found === undefined || (!found && !paged)) return null;
  const said = (lab: string, text: string, err: boolean) => (
    <div className="row" style={{gap: 12, paddingTop: 4, fontSize: 13, lineHeight: '20px', alignItems: 'flex-start'}}>
      <span className="t-3" style={{width: 128, flex: 'none'}}>
        {lab}
      </span>
      <span className={err ? 't-err' : 't-2'}>{text}</span>
    </div>
  );
  return (
    <Card
      title="Model answer"
      titleExtra={
        shown && found && !paged ? (
          <span className="t-3 one" style={{fontSize: 13}}>
            {found.endpoint} · prompt {found.label}
          </span>
        ) : undefined
      }
      actions={
        toggle ? <Button label={shown ? 'Hide' : 'Show'} kind="ghost" size="sm" icon="eye" onClick={onToggle} /> : undefined
      }
    >
      {!shown ? null : !found ? (
        <span className="t-3 one" style={{fontSize: 13}}>
          No answer from this version for this example
        </span>
      ) : !found.answer ? (
        why ? (
          <div className="col" style={{gap: 12}}>
            {said('Not readable', found.invalid ?? "The model's reply could not be read", true)}
          </div>
        ) : (
          <span className="t-3 one" style={{fontSize: 13}} title={found.invalid ?? undefined}>
            The model&apos;s answer was invalid
          </span>
        )
      ) : (
        <div className="col" style={{gap: 12}}>
          {schema.fields.map(fl => (
            <div key={fl.name} className="row" style={{gap: 12}}>
              <span style={{width: 128, flex: 'none'}}>
                <Code>{fl.name}</Code>
              </span>
              {(found.answer![fl.name] ?? []).map(v => (
                <span key={v} className="ch" style={diff.has(fl.name) ? CHIP_DIFF : CHIP}>
                  {v}
                </span>
              ))}
            </div>
          ))}
          {why && found.reason && said("Model's reason", found.reason, false)}
        </div>
      )}
    </Card>
  );
}

const DONE_TEXT: Record<MismatchReview['outcome'], string> = {kept: 'Kept my label', model: "Used the model's answer", other: 'Changed my label'};
const kindText = (f: LabelField) => (f.kind === 'single' ? 'Single-select' : `Multi-select, ${f.min ?? 1} to ${f.max ?? f.values.length}`);
const same = (a: Answer, b: Answer) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * Picking values saves the answer as soon as every field has one (no Save button in the design).
 * On Mismatches (`review`), the card keeps the label or takes the model's answer, and a third
 * answer picked on the chips is recorded as a change too. "Why" goes with the decision (R4-4). A
 * reviewed example (`review.done`) shows the decision, its time, the note, and Reopen (R4-5).
 */
function YourAnswer({
  state,
  ex,
  modelShown,
  review,
}: {
  state: ProjectState;
  ex: Example;
  modelShown: boolean;
  review?: {modelAnswer: Answer | null; done?: MismatchReview; onKeep: (note: string) => Promise<void>; onChange: (a: Answer, note: string) => Promise<void>; onReopen: () => Promise<void>};
}) {
  const schema = state.setup!.schema!;
  const saved = state.gold.get(ex.id);
  const [answer, setAnswer] = useState<Answer>(saved?.answer ?? {});
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const complete = schema.fields.every(f => (answer[f.name]?.length ?? 0) >= (f.kind === 'single' ? 1 : (f.min ?? 1)));
  const isSaved = !!saved && same(saved.answer, answer);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const done = review?.done;
  const [note, setNote] = useState(done?.note ?? '');
  const noteRef = useRef(note);
  noteRef.current = note;

  // A complete answer saves a moment after the last click. Moving to another example (which
  // unmounts this card) saves at once instead of dropping the answer.
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!complete || (savedRef.current && same(savedRef.current.answer, answer))) return;
    const save = () => {
      pending.current = null;
      if (reviewRef.current) {
        if (!reviewRef.current.done) void reviewRef.current.onChange(answer, noteRef.current);
      } else void saveGold(state.project.id, ex.id, state.setup!.schemaVersion, answer, modelShown);
    };
    pending.current = save;
    const id = setTimeout(save, 300);
    return () => clearTimeout(id);
  }, [answer, complete]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => pending.current?.(), []);

  const pick = (f: LabelField, value: string) => {
    const cur = answer[f.name] ?? [];
    if (f.kind === 'single') return setAnswer({...answer, [f.name]: [value]});
    const next = cur.includes(value) ? cur.filter(v => v !== value) : cur.length >= (f.max ?? 99) ? cur : [...cur, value];
    setAnswer({...answer, [f.name]: next});
  };
  return (
    <Card
      title="Your answer"
      titleExtra={
        isSaved && !review ? (
          <span className="done-at" style={{margin: 0}}>
            <Badge text="Saved" tone="ok" />
          </span>
        ) : undefined
      }
      actions={
        review && done ? (
          <div className="row" style={{gap: 8, alignItems: 'center'}}>
            <Badge text={DONE_TEXT[done.outcome]} tone="ok" />
            <span className="t-3" style={{fontSize: 13}}>
              {dateTime(done.at)}
            </span>
            <Button label="Reopen" size="sm" onClick={review.onReopen} />
          </div>
        ) : review ? (
          <div className="row" style={{gap: 8}}>
            <Button label="Keep my label" size="sm" disabled={!isSaved} onClick={() => review.onKeep(note)} />
            <Button label="Use the model's answer" size="sm" disabled={!review.modelAnswer} onClick={() => review.onChange(review.modelAnswer!, note)} />
          </div>
        ) : undefined
      }
    >
      <div className="col" style={{gap: 28}}>
        {schema.fields.map(f => (
          <div key={f.name} className="col" style={{gap: 10}}>
            <div className="row" style={{gap: 8}}>
              <Code>{f.name}</Code>
              <span className="t-3" style={{fontSize: 13}}>
                {kindText(f)}
              </span>
            </div>
            <div className="chs" role="group" aria-label={f.name}>
              {f.values.map(v => {
                const on = (answer[f.name] ?? []).includes(v.name);
                return (
                  <button key={v.name} type="button" className="ch" aria-pressed={on} title={v.definition} disabled={!!done} onClick={() => pick(f, v.name)}>
                    {on && <Icon name="check" />}
                    {v.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {review && (!done || done.note) && (
          <div style={{paddingTop: 8}}>
            <div className="col" style={{gap: 8}}>
              <span className="field-l">
                <Hov text="Why" tip="Goes to the Optimiser with this example, so it learns what your label means. It never reaches the held-out half" />
              </span>
              <textarea
                className="input"
                rows={3}
                aria-label="Why"
                readOnly={!!done}
                placeholder={done ? undefined : 'Optional: for example, the clip is cut from a show, so it is a Clip'}
                maxLength={500}
                value={note}
                onChange={e => setNote(e.target.value)}
                style={{height: 76, padding: '8px 12px', resize: 'none', lineHeight: '20px', ...(done ? {background: 'var(--bg-muted)', borderColor: 'transparent'} : {})}}
              />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
