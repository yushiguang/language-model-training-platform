'use client';

import {useState} from 'react';
import {removeExamples, takeExamples, type DataSourceSummary, type RemovalReason} from '@/backend-api';
import {Button, CheckboxList, CheckboxListItem, HStack, NumberInput, RadioList, RadioListItem, Spinner, Text, TextArea, VStack} from '@/ui/astryx';
import {isAccessDenied, reportAccessDenied} from '@/ui';
import {t} from '@/i18n';
import {FormDialog} from '../shell/dialogs';
import {ErrorLine} from '../sources/dialogs';
import {sourceError, sourceName} from '../sources';

/** A failed change: the access dialog for a missing permission, else a sentence to show in the dialog. */
export async function attempt(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (isAccessDenied(e)) {
      reportAccessDenied(e.permission);
      return '';
    }
    const msg = e instanceof Error ? e.message : '';
    return /^[A-Z][^{}<>\n]{0,200}\.$/.test(msg) ? t(msg) : t('Check your connection and try again.');
  }
}

const REASONS: {value: RemovalReason; label: string; hint?: string}[] = [
  {value: 'broken', label: 'Broken', hint: 'The video or images do not open, or it is empty'},
  {value: 'out_of_scope', label: 'Out of scope', hint: 'It does not belong to this task'},
  {value: 'other', label: 'Other'},
];

/**
 * Remove one sample (W-EvalDataset-Remove): why, and an optional note. It keeps its number and
 * leaves every count and score; it can be restored from Removed.
 */
export function RemoveDialog({projectId, sample, onClose}: {projectId: string; sample: {number: number; exampleId: string}; onClose: () => void}) {
  const [reason, setReason] = useState<RemovalReason>('broken');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    const failed = await attempt(() => removeExamples({projectId, exampleIds: [sample.exampleId], reason, ...(note.trim() ? {note: note.trim()} : {})}));
    setBusy(false);
    if (failed) return setError(failed);
    onClose();
  };
  return (
    <FormDialog
      title={t('Remove #{n}?', {n: sample.number})}
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={t('Remove')} variant="destructive" isLoading={busy} onClick={() => void remove()} />
        </>
      }
    >
      <VStack gap={5}>
        <Text type="body" color="secondary">
          {t('It keeps its number and leaves every count and score. You can restore it from Removed.')}
        </Text>
        <RadioList label={t('Reason')} value={reason} onChange={v => setReason(v as RemovalReason)}>
          {REASONS.map(r => (
            <RadioListItem key={r.value} value={r.value} label={t(r.label)} description={r.hint ? t(r.hint) : undefined} />
          ))}
        </RadioList>
        <TextArea label={t('Note')} isOptional value={note} onChange={setNote} placeholder={t('For example: the clip is cut from a TV show')} />
        {error && <ErrorLine text={error} />}
      </VStack>
    </FormDialog>
  );
}

/**
 * How many of `total` to take from each ticked source: in proportion to what each has left, the
 * remainder going to the sources with the most left; never more than a source has.
 */
export function splitTake(total: number, sources: {id: string; left: number}[]): {sourceId: string; count: number}[] {
  const left = sources.reduce((n, s) => n + s.left, 0);
  if (!left || total <= 0) return [];
  const want = Math.min(total, left);
  const picks = sources.map(s => ({sourceId: s.id, count: Math.floor((want * s.left) / left), left: s.left}));
  let rest = want - picks.reduce((n, p) => n + p.count, 0);
  for (const p of [...picks].sort((a, b) => b.left - a.left)) {
    if (!rest) break;
    if (p.count < p.left) {
      p.count++;
      rest--;
    }
  }
  return picks.filter(p => p.count > 0).map(({sourceId, count}) => ({sourceId, count}));
}

/** The default number of examples to add: 200, or what the ticked sources have left. */
const DEFAULT_COUNT = 200;

/**
 * Append examples (W-EvalDataset-Append): tick data sources (one still being read can't be ticked)
 * and say how many. They are picked at random; examples already in the dataset are skipped. Also
 * how a project's first examples are taken.
 */
export function AppendDialog({projectId, list, onClose}: {projectId: string; list: DataSourceSummary[]; onClose: () => void}) {
  const usable = (s: DataSourceSummary) => s.state === 'ready' && !s.importing && s.notUsed > 0;
  const [ticked, setTicked] = useState<string[]>(() => list.filter(usable).slice(0, 1).map(s => s.id));
  const chosen = list.filter(s => ticked.includes(s.id) && usable(s));
  const left = chosen.reduce((n, s) => n + s.notUsed, 0);
  const [count, setCount] = useState<number | null>(() => Math.min(DEFAULT_COUNT, list.find(usable)?.notUsed ?? DEFAULT_COUNT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = count ?? 0;
  const over = n > left && chosen.length > 0;
  const tick = (ids: string[]) => {
    setTicked(ids);
    setError(null);
    // The box follows the ticks while it still holds the default.
    const nowLeft = list.filter(s => ids.includes(s.id) && usable(s)).reduce((m, s) => m + s.notUsed, 0);
    if (count === null || count === Math.min(DEFAULT_COUNT, left) || count > nowLeft) setCount(Math.min(DEFAULT_COUNT, nowLeft) || null);
  };
  const append = async () => {
    setBusy(true);
    const failed = await attempt(() =>
      takeExamples({
        projectId,
        picks: splitTake(
          n,
          chosen.map(s => ({id: s.id, left: s.notUsed})),
        ),
      }),
    );
    setBusy(false);
    if (failed) return setError(sourceError(failed, list));
    onClose();
  };
  return (
    <FormDialog
      title={t('Append examples')}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={n > 0 ? t('Append {n}', {n: n.toLocaleString('en-US')}) : t('Append')} variant="primary" isDisabled={!chosen.length || n < 1 || over} isLoading={busy} onClick={() => void append()} />
        </>
      }
    >
      <VStack gap={6}>
        <CheckboxList label={t('Data sources')} value={ticked} onChange={tick}>
          {list.map(s => (
            <CheckboxListItem
              key={s.id}
              value={s.id}
              label={sourceName(s)}
              isDisabled={!usable(s)}
              endContent={<SourceCount s={s} />}
            />
          ))}
        </CheckboxList>
        <NumberInput
          label={t('Examples to add')}
          description={t('Picked at random. Examples already in the dataset are skipped.')}
          value={count}
          onChange={v => (setCount(v ?? null), setError(null))}
          status={over ? {type: 'error', message: t('Only {n} are left in the ticked data sources.', {n: left.toLocaleString('en-US')})} : undefined}
          statusVariant="detached"
        />
        {error && <ErrorLine text={error} />}
      </VStack>
    </FormDialog>
  );
}

/** "18,400 IDs" at the end of a source's row; "Reading…" while its file is read; "All used" when nothing is left. */
function SourceCount({s}: {s: DataSourceSummary}) {
  if (s.state === 'reading' || s.importing)
    return (
      <HStack gap={1.5} vAlign="center">
        <Spinner size="sm" />
        <Text type="supporting" color="secondary">
          {t('Reading…')}
        </Text>
      </HStack>
    );
  if (s.state === 'failed')
    return (
      <Text type="supporting" color="secondary">
        {t("Can't read")}
      </Text>
    );
  return (
    <Text type="supporting" color="secondary" hasTabularNumbers>
      {s.notUsed ? t('{n} IDs left', {n: s.notUsed.toLocaleString('en-US')}) : t('All used')}
    </Text>
  );
}
