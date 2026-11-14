'use client';

import {useGo} from '@/components/nav';
import {useSearchParams} from 'next/navigation';
import {Fragment, Suspense, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import type {Answer, Example, ExampleMedia, LabelComment, LabelField, MismatchList, MismatchReview, RemovalReason} from '@tsp/contracts';
import {FEATURES, featureText, gate, versionLabel} from '@tsp/domain';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {useSettings} from '@/components/ProjectSettings';
import {addComment, approveNode, exampleMedia, mismatches, predictionsFor, removeExamples, reviewGold, saveGold, type ProjectState} from '@/backend-api';
import {Badge, Banner, Button, Card, Code, dateTime, Dialog, Empty, Hov, Icon, num, Opt, PageHead, Seg, Tabs} from '@/ui';

type SetKey = 'eval' | 'mismatch';

/** The "Saved" beat before a saved example leaves To label or To review (motion M4). */
const BEAT_MS = 180;

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
    <ProjectPage node="gold" page={{label: 'Gold Labels', agent: 'front_desk', intent: 'answer', hint: "If an example doesn't fit any value, tell me and I'll bring in the Prompt helper.", context: {}}}>
      {({state}) => <Gold state={state} tabParam={q.get('tab')} />}
    </ProjectPage>
  );
}

/**
 * The Mismatches list for the picked version (review finding 2). It reads saved answers only.
 * Lazy (Evelyn, 2026-11-11): a review applies to the list here at once and nothing else is worked
 * out. The list is worked out again only when the page opens, another version is picked, or a
 * version or score is added; the scores the edits made out of date are rebuilt by whoever reads
 * them next (Prompt versions, a helper, the Optimiser).
 */
function useMismatches(state: ProjectState, versionId: string | null): {list: MismatchList | null; edited: (exampleId: string, review: MismatchReview) => void} {
  const [list, setList] = useState<MismatchList | null>(null);
  useEffect(() => {
    let live = true;
    void mismatches(state.project.id, versionId).then(m => live && setList(m));
    return () => {
      live = false;
    };
    // Not on gold edits (contextId): those are applied by `edited`.
  }, [state.project.id, versionId, state.versions.length, state.reports.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const edited = (exampleId: string, review: MismatchReview) =>
    setList(l => {
      if (!l) return l;
      if (review) {
        // R6-3: saving a reviewed item adds a review and updates it where it is; nothing moves.
        const had = l.reviewedItems.find(r => r.exampleId === exampleId);
        if (had) {
          const {earlier, ...prev} = had;
          const next = {...review, earlier: [prev, ...(earlier ?? [])]};
          return {...l, reviewedItems: l.reviewedItems.map(r => (r.exampleId === exampleId ? next : r))};
        }
      }
      const reviewedItems = [review, ...l.reviewedItems];
      return {...l, items: l.items.filter(x => x.exampleId !== exampleId), reviewedItems, reviewed: reviewedItems.length, reviewedAll: l.reviewedAll + 1};
    });
  return {list, edited};
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
  const {list: mm, edited} = useMismatches(state, cmp);
  // R5-2: the first list picks the best version; from then on the pick holds, and only the
  // "(best)" mark moves when scores change.
  useEffect(() => {
    if (mm?.versionId && cmp !== mm.versionId && (!cmp || !mm.versions.some(v => v.id === cmp))) setCmp(mm.versionId);
  }, [mm?.versionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // R4-5: Mismatches splits into To review and Reviewed, both for the version picked for the page.
  const [sub, setSub] = useState<'open' | 'done'>('open');
  // Spec 1.0.0, 5.2: the eval set splits the same way, into To label and Labeled.
  const evalAll = useMemo(() => state.examples.filter(e => e.split === 'eval'), [state.examples]);
  const [evalSub, setEvalSub] = useState<'open' | 'done'>(() => (evalAll.some(e => !state.gold[e.id]) ? 'open' : 'done'));
  const byId = useMemo(() => new Map(state.examples.map(e => [e.id, e])), [state.examples]);
  // A just-saved example stays in To label for a short "Saved" beat, then the next slides in (M4).
  const [hold, setHold] = useState<string | null>(null);
  const toLabel = useMemo(() => evalAll.filter(e => !state.gold[e.id] || e.id === hold), [evalAll, state.gold, hold]);
  const labeledEx = useMemo(() => evalAll.filter(e => !!state.gold[e.id] && e.id !== hold), [evalAll, state.gold, hold]);
  const sets = useMemo(
    () => ({
      eval: evalSub === 'open' ? toLabel : labeledEx,
      mismatch: (sub === 'done' ? (mm?.reviewedItems ?? []) : (mm?.items ?? [])).map(x => byId.get(x.exampleId)!).filter(Boolean),
    }),
    [toLabel, labeledEx, mm, byId, sub, evalSub],
  );
  // "Review labels" on Prompt versions opens the Mismatches tab.
  const [tab, setTab] = useState<SetKey>(tabParam === 'mismatches' ? 'mismatch' : 'eval');
  useEffect(() => {
    if (tabParam === 'mismatches') setTab('mismatch');
  }, [tabParam]);
  const list = sets[tab];
  // In To label and To review a saved example leaves the list, so the next one takes its place;
  // in Labeled and Reviewed it is updated where it is.
  const [pos, setPos] = useState<Record<SetKey, number>>(() => ({eval: 0, mismatch: 0}));
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
  // Scoring never waits for every example (spec 2.5): a few labels in each half are enough to go on.
  const next = gate('gold', state.facts);
  const settings = useSettings();
  // Motion M4: which way the next example comes in (Previous from the left; anything else from the right).
  const dir = useRef<'next' | 'prev' | 'switch'>('switch');
  const move = (n: number) => {
    dir.current = n < pos[tab] ? 'prev' : 'next';
    setPos(p => ({...p, [tab]: n}));
  };
  const stepClass = `step-${dir.current}`;
  // After each render the default goes back to "next" (a save that advances).
  useEffect(() => {
    dir.current = 'next';
  });
  const versionId = mm?.versionId ?? null;
  const item = onMismatch && ex && sub === 'open' ? mm?.items.find(x => x.exampleId === ex.id) : undefined;
  const done = onMismatch && ex && sub === 'done' ? mm?.reviewedItems.find(x => x.exampleId === ex.id) : undefined;
  const gold = ex ? state.gold[ex.id]?.answer : undefined;
  const diff = onMismatch && gold && modelAnswer ? new Set(state.setup!.schema!.fields.filter(f => !sameValues(gold[f.name], modelAnswer[f.name])).map(f => f.name)) : new Set<string>();
  const review = async (outcome: 'kept' | 'changed', note: string, answer?: Answer) => {
    if (!ex || !versionId) return;
    const at = new Date().toISOString();
    const used = outcome === 'kept' ? 'kept' : answer && modelAnswer && same(answer, modelAnswer) ? 'model' : 'other';
    await reviewGold({projectId: state.project.id, exampleId: ex.id, promptVersionId: versionId, outcome, answer, note});
    // In To review the item leaves the list after the "Saved" beat (M4); in Reviewed it updates at once.
    if (sub === 'open') await beat();
    edited(ex.id, {exampleId: ex.id, outcome: used, note: note.trim() || null, at});
  };
  const beat = () => new Promise<void>(res => setTimeout(res, BEAT_MS));
  const pickSub = (v: 'open' | 'done') => {
    dir.current = 'switch';
    setSub(v);
    setPos(p => ({...p, mismatch: 0}));
  };
  const pickEvalSub = (v: 'open' | 'done') => {
    dir.current = 'switch';
    setEvalSub(v);
    setPos(p => ({...p, eval: 0}));
  };

  const head = (
    <PageHead
      title="Gold Labels"
      actions={
        <>
          {!onMismatch && (
            <>
              <Seg
                label="Eval set"
                value={evalSub}
                onChange={pickEvalSub}
                options={[
                  {value: 'open', label: `To label ${num(toLabel.length)}`},
                  {value: 'done', label: `Labeled ${num(labeledEx.length)}`},
                ]}
              />
              <span style={{width: 8}} />
            </>
          )}
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
            label="Next: Prompt Tuning"
            kind={onMismatch ? 'secondary' : 'primary'}
            disabled={!next.ready}
            title={next.ready ? undefined : (next.reason ?? undefined)}
            onClick={async () => {
              // The first paid run is about to start: the user confirms Project Settings once.
              if (!(await settings.confirmed())) return;
              await approveNode(state.project.id, 'gold');
              await go(href('/prompt'));
            }}
          />
        </>
      }
    />
  );

  if (!state.snapshot || !state.setup?.schema)
    return (
      <Frame head={<PageHead title="Gold Labels" />}>
        <Empty title="No examples to label yet" text={state.setup?.schema ? 'Add examples on Eval Dataset first, then label them here.' : 'Approve the prompt on Prompt Design first: its fields and values are what you label with.'} />
      </Frame>
    );

  const picked = mm?.versions.find(v => v.id === versionId);
  // A version has scores, so the Mismatches tab and Compare with will be there (R5-1).
  const expectMm = state.reports.some(r => r.schemaVersion === state.setup!.schemaVersion);
  return (
    <Frame head={head}>
      {Object.keys(state.staleGold).length > 0 && <Banner text={`The label fields or values changed. ${num(Object.keys(state.staleGold).length)} labels were made before the change and need a quick re-check.`} />}
      <Tabs
        label="Sets"
        selected={tab}
        onSelect={k => {
          dir.current = 'switch';
          setTab(k);
        }}
        items={[
          {key: 'eval', label: 'Eval set', count: `${num(state.facts.goldEvalDone)} / ${num(evalAll.length)}`},
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
              {state.scoresUpdating && (
                <span className="badge b-gray" style={{marginRight: 12}}>
                  <Hov text="Scores out of date" tip="Your label changes are saved. Rebuild scores on Prompt versions to see them in the scores" />
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
        <div key={`${tab}-${ex.id}`} className={stepClass} style={{display: 'grid', gridTemplateColumns: '520px 1fr', gap: 16, alignItems: 'start'}}>
          <ExampleCard
            key={`ex-${ex.id}`}
            ex={ex}
            n={evalAll.indexOf(ex) + 1}
            extra={item ? <Hov text={`Wrong in ${item.wrongIn} of ${item.of} versions`} tip="The examples wrong in the most versions come first" /> : undefined}
            onRemove={reason => removeExamples({projectId: state.project.id, exampleIds: [ex.id], reason})}
          />
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
              versionName={id => {
                const v = state.versions.find(x => x.id === id);
                return v ? versionLabel(v) : null;
              }}
              review={onMismatch && picked ? {done, onKeep: note => review('kept', note), onChange: (a, note) => review('changed', note, a)} : undefined}
              advance={
                !onMismatch && evalSub === 'open'
                  ? async save => {
                      // Held from before the save, so the reload never drops it early.
                      setHold(ex.id);
                      try {
                        await save();
                        await beat();
                      } finally {
                        setHold(null);
                      }
                    }
                  : undefined
              }
            />
          </div>
        </div>
      ) : !onMismatch && evalSub === 'open' && evalAll.length > 0 ? (
        <Empty title="Every example is labeled" text="Labels you saved are under Labeled. Add examples on Eval Dataset to label more." />
      ) : onMismatch && sub === 'done' ? (
        mm && <Empty title="Nothing reviewed yet" text={`Labels you keep or change for ${picked?.label ?? 'this version'} show here.`} />
      ) : onMismatch ? (
        mm && <Empty title="No mismatches left" text={`Every label ${picked?.label ?? 'the model'} disagrees with has been checked.`} />
      ) : (
        <Empty title="No examples yet" text="Add examples on the Eval Dataset page." />
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

function ExampleCard({ex, n, extra, onRemove}: {ex: Example; n: number; extra?: ReactNode; onRemove: (reason: RemovalReason) => Promise<void>}) {
  const [media, setMedia] = useState<ExampleMedia | null | undefined>(undefined);
  const [removing, setRemoving] = useState<RemovalReason | null>(null);
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
    return featureText(ex.features[k]).trim();
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
    <Card
      title={`Example ${n}`}
      titleExtra={extra ? <span className="t-3" style={{fontSize: 13}}>{extra}</span> : undefined}
      actions={<Button label="Remove example" kind="ghost" size="sm" onClick={() => setRemoving('broken')} />}
    >
      {removing && (
        <Dialog
          title="Remove this example?"
          text="It leaves the eval dataset and every score worked out from now on. You can put it back from the Removed list on Eval Dataset."
          onClose={() => setRemoving(null)}
          actions={
            <>
              <Button label="Cancel" onClick={() => setRemoving(null)} />
              <Button
                label="Remove"
                kind="primary"
                onClick={async () => {
                  await onRemove(removing);
                  setRemoving(null);
                }}
              />
            </>
          }
        >
          <div className="opts" role="radiogroup" aria-label="Why">
            <Opt title="Broken" tip="The item can't be opened or its features are empty or wrong" checked={removing === 'broken'} onSelect={() => setRemoving('broken')} />
            <Opt title="Out of scope" tip="Not the kind of item this project labels" checked={removing === 'out_of_scope'} onSelect={() => setRemoving('out_of_scope')} />
          </div>
        </Dialog>
      )}
      <div className="media">
        {media?.playerUrl && view === 'player' ? (
          <iframe
            onLoad={e => e.currentTarget.classList.add('loaded')}
            src={media.playerUrl}
            title={`Player for item ${ex.externalId}`}
            style={{position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0}}
            allow="encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            loading="lazy"
          />
        ) : stills.length ? (
          <img key={stills[Math.min(picked, stills.length - 1)]} onLoad={e => e.currentTarget.classList.add('loaded')} src={stills[Math.min(picked, stills.length - 1)]} alt="" style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain'}} />
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
          const p = (await predictionsFor(v.id, m.endpoint, m))[ex.id];
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
 * Your answer (spec 1.0.0, 5.3 and 5.4): the chips and an optional comment; nothing saves until
 * Save. In To label and To review, Save moves on to the next example (the saved one leaves the
 * list); in Labeled and Reviewed it updates the example where it is. On Mismatches (`review`)
 * Save records a decision for the picked version: the label kept, or changed (to the model's
 * answer or another one). Comments are added, never edited, and listed oldest first.
 */
function YourAnswer({
  state,
  ex,
  modelShown,
  versionName,
  review,
  advance,
}: {
  state: ProjectState;
  ex: Example;
  modelShown: boolean;
  versionName: (id: string) => string | null;
  /** To label: runs the save while the example is held for the "Saved" beat, then lets it leave the list. */
  advance?: (save: () => Promise<void>) => Promise<void>;
  review?: {done?: MismatchReview; onKeep: (note: string) => Promise<void>; onChange: (a: Answer, note: string) => Promise<void>};
}) {
  const schema = state.setup!.schema!;
  const saved = state.gold[ex.id];
  const [answer, setAnswer] = useState<Answer>(saved?.answer ?? {});
  const [note, setNote] = useState('');
  const [beat, setBeat] = useState(false);
  const complete = schema.fields.every(f => (answer[f.name]?.length ?? 0) >= (f.kind === 'single' ? 1 : (f.min ?? 1)));
  const changed = !saved || !same(saved.answer, answer);
  const hasNote = !!note.trim();
  const done = review?.done;
  // Save is on when there is something to record: a new or changed label, a comment, or (in To
  // review) the decision to keep the label.
  const canSave = complete && (changed || hasNote || (!!review && !done));
  const comments: LabelComment[] = state.comments[ex.id] ?? [];
  const save = () => (advance ? advance(record) : record());
  const record = async () => {
    if (review) {
      if (changed) await review.onChange(answer, note);
      else await review.onKeep(note);
    } else {
      if (changed) await saveGold(state.project.id, ex.id, state.setup!.schemaVersion, answer, modelShown);
      if (hasNote) await addComment({projectId: state.project.id, exampleId: ex.id, text: note});
    }
    setNote('');
    setBeat(true);
  };
  useEffect(() => {
    if (!beat) return;
    const id = setTimeout(() => setBeat(false), 1600);
    return () => clearTimeout(id);
  }, [beat]);

  const pick = (f: LabelField, value: string) => {
    const cur = answer[f.name] ?? [];
    if (f.kind === 'single') return setAnswer({...answer, [f.name]: [value]});
    const next = cur.includes(value) ? cur.filter(v => v !== value) : cur.length >= (f.max ?? 99) ? cur : [...cur, value];
    setAnswer({...answer, [f.name]: next});
  };
  const vName = (id: string | null) => (id ? versionName(id) : null);
  return (
    <Card
      title="Your answer"
      titleExtra={
        beat || (!review && saved && !changed && !hasNote) ? (
          <span className={`done-at${beat ? ' saved-beat' : ''}`} style={{margin: 0}}>
            <Badge text="Saved" tone="ok" />
          </span>
        ) : undefined
      }
      actions={
        <div className="row" style={{gap: 8, alignItems: 'center'}}>
          {done && (
            <>
              <Badge text={DONE_TEXT[done.outcome]} tone="ok" />
              <span className="t-3" style={{fontSize: 13}}>
                {dateTime(done.at)}
              </span>
              {!!done.earlier?.length && (
                <span className="t-3" style={{fontSize: 13}}>
                  <Hov text={`${done.earlier.length + 1} reviews`} tip={`Earlier: ${done.earlier.map(e => `${DONE_TEXT[e.outcome]} · ${dateTime(e.at)}`).join('; ')}. The newest review counts`} />
                </span>
              )}
              <span style={{width: 8}} />
            </>
          )}
          {saved && (changed || hasNote) && !beat && (
            <span className="t-3" style={{fontSize: 13}}>
              Not saved
            </span>
          )}
          <Button label="Save" kind="primary" size="sm" disabled={!canSave} onClick={save} />
        </div>
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
                  <button key={v.name} type="button" className="ch" aria-pressed={on} title={v.definition} onClick={() => pick(f, v.name)}>
                    {on && <Icon name="check" />}
                    {v.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="col" style={{gap: 8, paddingTop: 8}}>
          <span className="field-l">
            <Hov text="Comment" tip="Optional. Saved with Save. Comments go to the Optimiser and the Prompt helper with this example, so they learn what the label means; comments on the half used for scores never reach them" />
          </span>
          {comments.length > 0 && (
            <div className="cmts" aria-label="Comments">
              {comments.map(c => (
                <div key={c.id} className="cmt">
                  <span className="cmt-h">
                    {c.authorName} · {dateTime(c.createdAt)}
                    {vName(c.promptVersionId) ? ` · on ${vName(c.promptVersionId)}` : ''}
                  </span>
                  <span className="cmt-t">{c.text}</span>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="input"
            rows={3}
            aria-label="Add a comment"
            placeholder="Add a comment: for example, the clip is cut from a show, so it is a Clip"
            maxLength={500}
            value={note}
            onChange={e => setNote(e.target.value)}
            style={{height: 76, padding: '8px 12px', resize: 'none', lineHeight: '20px'}}
          />
        </div>
      </div>
    </Card>
  );
}
