'use client';

import {useEffect, useState, type ReactNode} from 'react';
import {ArrowTopRightOnSquareIcon, CheckIcon, EyeIcon, EyeSlashIcon, PencilSquareIcon, PhotoIcon, PlayIcon, TrashIcon, VideoCameraIcon} from '@heroicons/react/24/outline';
import type {Answer, Example, ExampleMedia, Features, LabelComment} from '@yushiguang/sprint-contracts';
import {FEATURES, featureText, inLabelOrder, labelBounds, sameAnswer, versionLabel} from '@yushiguang/sprint-domain';
import {addComment, deleteComment, editComment, exampleMedia, getExampleFeatures, predictionsFor, saveGold, type ProjectState} from '@/backend-api';
import {Avatar, Badge, Button, Card, Heading, HStack, Icon, IconButton, MetadataList, MetadataListItem, StackItem, Text, TextArea, Token, Tooltip, VStack} from '@/ui/astryx';
import {dateTime} from '@/ui';
import {attempt} from '@/components/dataset/dialogs';
import {ErrorLine} from '@/components/sources/dialogs';
import {t} from '@/i18n';

/**
 * The labeling cards of a label set (wireframes v346: W-LabelSet, W-LabelSet-Mismatch): the
 * example with its media and features, the model's answer, and the labeler's answer with comments.
 */

/** A word with a dashed underline whose meaning shows on hover. */
export function Hint({text, tip}: {text: string; tip: string}) {
  return (
    <Tooltip content={tip} hasHoverIndication>
      <span className="sp-hint" tabIndex={0}>
        {text}
      </span>
    </Tooltip>
  );
}

/** A card's head: a title on the left, actions on the right, one line high. */
function CardHead({title, children}: {title: ReactNode; children?: ReactNode}) {
  return (
    <HStack gap={3} vAlign="center" hAlign="between" style={{minHeight: 32}}>
      <HStack gap={3} vAlign="center" style={{minWidth: 0}}>
        {title}
      </HStack>
      {children && (
        <HStack gap={2} vAlign="center" style={{marginInlineEnd: -12}}>
          {children}
        </HStack>
      )}
    </HStack>
  );
}

/* ---------------------------------------------------------------- the example */

const SHOWN = new Set(['Title', 'Description', 'OCR_Text', 'ASR', 'Creator_Nick_Name', 'Creator_Bio', 'Hashtags', 'Create_Time', 'Country_Code', 'Language', 'POI_Name', 'POI_Info', 'Interest_V3', 'Summary']);
const IMAGE_KEYS = new Set(Object.values(FEATURES).flatMap(list => list.filter(d => d.isImage).map(d => d.key)));
const FEATURE_LABEL = new Map(Object.values(FEATURES).flatMap(list => list.map(d => [d.key, d.label] as const)));
/** Our row names are catalog keys; a feature without one keeps its catalogue name. */
const ROW_NAMES = new Set(['Title', 'Description', 'On-screen text', 'Speech', 'Creator', 'Hashtags', 'Posted', 'Country, language', 'Place', 'Interest', 'Summary']);
const rowName = (k: string) => (ROW_NAMES.has(k) ? t(k) : k);

/**
 * Features read lately (#32): they never change, so going back shows them at once. The oldest are
 * let go past FEATURE_CACHE entries.
 */
const featureCache = new Map<string, Features>();
const FEATURE_CACHE = 50;
function remember(id: string, f: Features) {
  featureCache.delete(id);
  featureCache.set(id, f);
  while (featureCache.size > FEATURE_CACHE) featureCache.delete(featureCache.keys().next().value!);
}

function useFeatures(projectId: string, exampleId: string): Features | null | undefined {
  const [features, setFeatures] = useState<Features | null | undefined>(() => featureCache.get(exampleId));
  useEffect(() => {
    let live = true;
    const known = featureCache.get(exampleId);
    setFeatures(known);
    if (known) remember(exampleId, known);
    else
      void getExampleFeatures(projectId, [exampleId])
        .then(r => {
          const f = r[exampleId];
          // A missing features document is an error, never an empty card.
          if (!f) return live && setFeatures(null);
          remember(exampleId, f);
          if (live) setFeatures(f);
        })
        .catch(() => live && setFeatures(null));
    return () => {
      live = false;
    };
  }, [exampleId, projectId]);
  return features;
}

function useMedia(projectId: string, exampleId: string): ExampleMedia | null | undefined {
  const [media, setMedia] = useState<ExampleMedia | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setMedia(undefined);
    void exampleMedia(projectId, exampleId)
      .then(m => live && setMedia(m))
      .catch(() => live && setMedia(null));
    return () => {
      live = false;
    };
  }, [exampleId, projectId]);
  return media;
}

/**
 * The example (W-LabelSet): its number, Remove example, the media (the platform's player, or a
 * still), the stills under it, Open item, and one line per feature.
 */
export function ExampleCard({projectId, ex, n, hint, onRemove}: {projectId: string; ex: Example; n: number; hint?: ReactNode; onRemove: () => void}) {
  const media = useMedia(projectId, ex.id);
  const features = useFeatures(projectId, ex.id);
  const [picked, setPicked] = useState(0);
  const [view, setView] = useState<'player' | 'image'>('player');
  useEffect(() => {
    setPicked(0);
    setView('player');
  }, [ex.id]);
  const stills = media ? [...(media.coverUrl ? [media.coverUrl] : []), ...media.imageUrls.filter(u => u !== media.coverUrl)] : [];
  const f = (k: string) => featureText(features?.[k]).trim();
  const joined = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  const posted = f('Create_Time');
  const rows = (
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
      ...Object.keys(features ?? {})
        .filter(k => !SHOWN.has(k) && !IMAGE_KEYS.has(k) && !/(^|_)(url|urls|id)$/i.test(k))
        .map(k => [FEATURE_LABEL.get(k) ?? k.replace(/_/g, ' '), f(k)]),
    ] as [string, string][]
  ).filter(([, v]) => v);
  const still = stills[Math.min(picked, stills.length - 1)];
  return (
    <Card padding={6}>
      <VStack gap={5}>
        <CardHead
          title={
            <>
              <Heading level={3}>{t('Example #{n}', {n: n.toLocaleString('en-US')})}</Heading>
              {hint}
            </>
          }
        >
          <Button label={t('Remove example')} variant="ghost" size="sm" onClick={onRemove} />
        </CardHead>
        <VStack gap={2}>
          <div className="media sp-media">
            {media?.playerUrl && view === 'player' ? (
              <iframe
                onLoad={e => e.currentTarget.classList.add('loaded')}
                src={media.playerUrl}
                title={t('Player for item {id}', {id: ex.externalId})}
                style={{position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0}}
                // Resilience spec, 4: the player's site sees only where the page comes from, never its
                // path, and only over https; it may autoplay inside the tile.
                referrerPolicy="strict-origin"
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                loading="lazy"
              />
            ) : still ? (
              <img key={still} onLoad={e => e.currentTarget.classList.add('loaded')} src={still} alt="" style={{position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain'}} />
            ) : (
              <Icon icon={ex.type === 'video' ? VideoCameraIcon : PhotoIcon} size="md" color="inherit" />
            )}
          </div>
          <Text type="supporting" color="secondary" hasTabularNumbers className="sp-item-id">
            {ex.externalId}
            {media?.durationSec ? ` · ${Math.round(media.durationSec)}s` : ''}
          </Text>
        </VStack>
        {(stills.length > 0 || media?.playerUrl || media?.externalUrl) && (
          <HStack gap={2} vAlign="center" wrap="wrap">
            {media?.playerUrl && stills.length > 0 && (
              <button type="button" className={`sp-still sp-still-play${view === 'player' ? ' is-on' : ''}`} aria-label={t('Show the player')} aria-pressed={view === 'player'} onClick={() => setView('player')}>
                <Icon icon={PlayIcon} size="sm" color="inherit" />
              </button>
            )}
            {stills.map((u, k) => (
              <button
                key={u}
                type="button"
                className={`sp-still${view === 'image' && k === picked ? ' is-on' : ''}`}
                aria-label={t('Show image {n}', {n: k + 1})}
                aria-pressed={view === 'image' && k === picked}
                onClick={() => {
                  setPicked(k);
                  setView('image');
                }}
              >
                <img src={u} alt="" />
              </button>
            ))}
            <StackItem size="fill" />
            {media?.externalUrl && (
              // A plain link: the item lives on its own site, so nothing is prefetched as a page of ours.
              <a className="sp-open-item" href={media.externalUrl} target="_blank" rel="noopener noreferrer">
                <Text type="supporting" color="inherit">
                  {t('Open item')}
                </Text>
                <Icon icon={ArrowTopRightOnSquareIcon} size="xsm" color="inherit" />
              </a>
            )}
          </HStack>
        )}
        {features === undefined ? (
          <Text type="supporting" color="secondary" role="status">
            {t('Loading the features…')}
          </Text>
        ) : features === null ? (
          <ErrorLine text={t('The features could not be loaded.')} />
        ) : (
          rows.length > 0 && (
            <MetadataList>
              {rows.map(([k, v]) => (
                <MetadataListItem key={k} label={rowName(k)}>
                  {v}
                </MetadataListItem>
              ))}
            </MetadataList>
          )
        )}
      </VStack>
    </Card>
  );
}

/* ---------------------------------------------------------------- the model's answer */

export interface FoundAnswer {
  answer: Answer | null;
  invalid: string | null;
  reason: string | null;
}

/**
 * The model's answer on this example, from the version compared with (the best scored by
 * default). Before any version has answers on the whole dataset, the newest version with an answer
 * for it. `null`: none; `undefined`: still looking.
 */
export function useModelAnswer(state: ProjectState, exampleId: string, versionId: string | null): FoundAnswer | null | undefined {
  const [found, setFound] = useState<FoundAnswer | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setFound(undefined);
    void (async () => {
      const candidates = versionId ? state.versions.filter(v => v.id === versionId) : [...state.versions].reverse();
      for (const v of candidates)
        for (const m of state.setup?.models ?? []) {
          const p = (await predictionsFor(v.projectId, v.id, m.endpoint, m))[exampleId];
          if (p) {
            if (live) setFound({answer: p.answer, invalid: p.invalidReason, reason: p.reason ?? null});
            return;
          }
        }
      if (live) setFound(null);
    })().catch(() => live && setFound(null));
    return () => {
      live = false;
    };
  }, [exampleId, versionId, state.versions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return found;
}

/**
 * Model answer (W-LabelSet, round 9): hidden by default while the example has no label yet, shown
 * otherwise; Hide and Show switch it. The values, then the model's own short reason.
 */
export function ModelAnswerCard({state, exampleId, found, shown, onToggle, versionName}: {state: ProjectState; exampleId: string; found: FoundAnswer | null | undefined; shown: boolean; onToggle: () => void; versionName: string | null}) {
  const schema = state.setup!.schema!;
  const gold = state.gold[exampleId]?.answer;
  return (
    <Card padding={6}>
      <VStack gap={3}>
        <CardHead
          title={
            <>
              <Heading level={3}>{t('Model answer')}</Heading>
              {!shown ? (
                <Text type="supporting" color="secondary">
                  {t('Hidden until you answer')}
                </Text>
              ) : (
                versionName && (
                  <Text type="supporting" color="secondary">
                    {versionName}
                  </Text>
                )
              )}
            </>
          }
        >
          <Button label={shown ? t('Hide') : t('Show')} variant="ghost" size="sm" icon={<Icon icon={shown ? EyeSlashIcon : EyeIcon} size="sm" />} onClick={onToggle} />
        </CardHead>
        {shown &&
          (found === undefined ? (
            <Text type="supporting" color="secondary" role="status">
              {t('Loading')}
            </Text>
          ) : !found ? (
            <Text type="supporting" color="secondary">
              {t('No answer from this version for this example')}
            </Text>
          ) : !found.answer ? (
            <ErrorLine text={found.invalid ?? t("The model's reply could not be read")} />
          ) : (
            <HStack gap={3} vAlign="center" className="sp-model-answer">
              <HStack gap={2} vAlign="center" wrap="wrap" style={{flexShrink: 0}}>
                {found.answer.map(a => (
                  // A value the gold label does not hold is marked.
                  <Token key={a} label={a} size="sm" color={gold && !gold.includes(a) ? 'red' : 'default'} description={schema.values.find(v => v.name === a)?.definition || undefined} />
                ))}
              </HStack>
              {found.reason && (
                <StackItem size="fill" style={{minWidth: 0}}>
                  <Text type="supporting" color="secondary">
                    {found.reason}
                  </Text>
                </StackItem>
              )}
            </HStack>
          ))}
      </VStack>
    </Card>
  );
}

/* ---------------------------------------------------------------- comments */

/**
 * One comment: who, when, and the text. Its author edits or deletes it; the buttons show on hover
 * (round 9). Editing turns the text into a box with Cancel and Save.
 */
function CommentRow({projectId, c, mine, versionName}: {projectId: string; c: LabelComment; mine: boolean; versionName: string | null}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    const failed = await attempt(fn);
    setBusy(false);
    setError(failed);
    if (!failed) after();
  };
  const meta = [c.authorName, dateTime(c.createdAt), ...(c.editedAt ? [t('edited')] : []), ...(versionName ? [t('on {version}', {version: versionName})] : [])].join(' · ');
  return (
    <div className={`sp-cmt${editing != null ? ' is-editing' : ''}`}>
      <HStack gap={3} vAlign="start">
        <Avatar name={c.authorName} size="xsm" />
        <StackItem size="fill" style={{minWidth: 0}}>
          <VStack gap={editing != null ? 2 : 0}>
            <Text type="supporting" color="secondary">
              {meta}
            </Text>
            {editing == null ? (
              <Text className="sp-cmt-text">{c.text}</Text>
            ) : (
              <>
                <TextArea label={t('Edit comment')} isLabelHidden rows={3} value={editing} onChange={setEditing} maxLength={500} />
                <HStack gap={2} hAlign="end">
                  <Button label={t('Cancel')} variant="ghost" size="sm" onClick={() => setEditing(null)} />
                  <Button label={t('Save comment')} variant="primary" size="sm" isLoading={busy} isDisabled={!editing.trim() || editing.trim() === c.text} onClick={() => void run(() => editComment({projectId, commentId: c.id, text: editing}), () => setEditing(null))} />
                </HStack>
              </>
            )}
            {error && <ErrorLine text={error} />}
          </VStack>
        </StackItem>
        {mine && editing == null && (
          <HStack gap={0} className="sp-cmt-act">
            <IconButton label={t('Edit comment')} variant="ghost" size="sm" icon={<Icon icon={PencilSquareIcon} size="sm" />} onClick={() => setEditing(c.text)} />
            <IconButton label={t('Delete comment')} variant="ghost" size="sm" isDisabled={busy} icon={<Icon icon={TrashIcon} size="sm" />} onClick={() => void run(() => deleteComment({projectId, commentId: c.id}), () => {})} />
          </HStack>
        )}
      </HStack>
    </div>
  );
}

/* ---------------------------------------------------------------- your answer */

/**
 * Your answer (spec 1.0.0, 5.3 and 5.4; W-LabelSet round 9): the values to pick, Save, and the
 * comments with a box for a new one. Nothing saves until Save. `onSave` records the label (and on
 * the Mismatch tab the review); the new comment is saved with it.
 */
export function YourAnswerCard({
  state,
  ex,
  me,
  versionName,
  onSave,
}: {
  state: ProjectState;
  ex: Example;
  /** The signed-in user: only their own comments can be edited or deleted. */
  me: string | null;
  versionName: (id: string | null) => string | null;
  /** Records the answer (changed or not) and the new comment; resolves once saved. */
  onSave: (answer: Answer, changed: boolean, note: string) => Promise<void>;
}) {
  const schema = state.setup!.schema!;
  const saved = state.gold[ex.id];
  const [answer, setAnswer] = useState<Answer | null>(saved?.answer ?? null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [beat, setBeat] = useState(false);
  // Another save (an upload, another tab) changes the saved label: the picks follow while untouched.
  const savedKey = saved?.answer.join('|') ?? '';
  useEffect(() => setAnswer(saved?.answer ?? null), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const multi = schema.kind === 'multi';
  const {min, max} = labelBounds(schema);
  const complete = answer != null && answer.length >= Math.max(1, min) && answer.length <= max;
  const changed = !saved || !sameAnswer(saved.answer, answer);
  const hasNote = !!note.trim();
  const canSave = complete && (changed || hasNote);
  // Single select: a value picks itself alone. Multi select: values toggle, up to the most
  // allowed; a value that stands alone ("None") clears the others, and any other clears it.
  const toggle = (v: string) => {
    if (!multi) return setAnswer([v]);
    const cur = answer ?? [];
    const alone = (x: string) => !!schema.values.find(y => y.name === x)?.exclusive;
    const next = cur.includes(v) ? cur.filter(x => x !== v) : alone(v) ? [v] : [...cur.filter(x => !alone(x)), v];
    setAnswer(next.length ? inLabelOrder(next, schema) : null);
  };
  const save = async () => {
    if (!answer) return;
    setBusy(true);
    const failed = await attempt(() => onSave(answer, changed, note));
    setBusy(false);
    setError(failed);
    if (failed) return;
    setNote('');
    setBeat(true);
  };
  useEffect(() => {
    if (!beat) return;
    const id = setTimeout(() => setBeat(false), 1600);
    return () => clearTimeout(id);
  }, [beat]);
  const comments: LabelComment[] = state.comments[ex.id] ?? [];
  const isSaved = beat || (!!saved && !changed && !hasNote);
  return (
    <Card padding={6}>
      <VStack gap={6}>
        <CardHead
          title={
            <>
              <Heading level={3}>{t('Your answer')}</Heading>
              {isSaved ? <Badge variant="success" label={t('Saved')} /> : saved && (changed || hasNote) ? <Badge variant="neutral" label={t('Not saved')} /> : null}
            </>
          }
        >
          <Button label={t('Save')} variant="primary" size="sm" isDisabled={!canSave} isLoading={busy} onClick={() => void save()} />
        </CardHead>
        <VStack gap={3}>
          {multi && (
            <Text type="supporting" color="secondary">
              {min === max ? t('Choose {n}', {n: max}) : t('Choose {min} to {max}', {min: Math.max(1, min), max})}
            </Text>
          )}
          <div role="group" aria-label={schema.name} className="sp-values">
            {schema.values.map(v => {
              const on = !!answer?.includes(v.name);
              // At the most allowed, other values wait until one is taken off (a value that stands alone still replaces them).
              const full = multi && !on && !v.exclusive && (answer?.filter(x => !schema.values.find(y => y.name === x)?.exclusive).length ?? 0) >= max;
              return <Button key={v.name} label={v.name} variant={on ? 'primary' : 'secondary'} size="sm" aria-pressed={on} tooltip={v.definition || undefined} isDisabled={full} icon={on ? <Icon icon={CheckIcon} size="sm" /> : undefined} onClick={() => toggle(v.name)} />;
            })}
          </div>
        </VStack>
        <VStack gap={3}>
          <Text type="label" weight="semibold">
            <Hint text={t('Comment')} tip={t('Optional. Saved with Save. Comments go to the Optimiser and the Prompt helper with this example, so they learn what the label means; comments on the half used for scores never reach them')} />
          </Text>
          {comments.length > 0 && (
            <VStack gap={1} className="sp-cmts" aria-label={t('Comments')}>
              {comments.map(c => (
                <CommentRow key={c.id} projectId={state.project.id} c={c} mine={c.authorId === me} versionName={versionName(c.promptVersionId)} />
              ))}
            </VStack>
          )}
          <TextArea label={t('Add a comment')} isLabelHidden rows={3} maxLength={500} value={note} onChange={setNote} placeholder={t('Add a comment: for example, the clip is cut from a show, so it is a Clip')} />
        </VStack>
        {error && <ErrorLine text={error} />}
      </VStack>
    </Card>
  );
}

/** The name of a version, for the comment lines and the model answer card. */
export const versionNameIn = (state: ProjectState) => (id: string | null) => {
  if (!id) return null;
  const v = state.versions.find(x => x.id === id);
  return v ? versionLabel(v) : null;
};

/** Saves a label and an optional comment, outside the Mismatch tab. */
export async function saveLabel(state: ProjectState, ex: Example, answer: Answer, changed: boolean, note: string, modelShown: boolean): Promise<void> {
  if (changed) await saveGold(state.project.id, ex.id, state.setup!.schemaVersion, answer, modelShown);
  if (note.trim()) await addComment({projectId: state.project.id, exampleId: ex.id, text: note});
}
