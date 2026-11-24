'use client';

import {useRef, useState} from 'react';
import {ArrowUpTrayIcon} from '@heroicons/react/24/outline';
import type {GoldUploadResult} from '@yushiguang/sprint-contracts';
import {uploadGoldFile} from '@/backend-api';
import {Banner, Button, Icon} from '@/ui/astryx';
import {num} from '@/ui';
import {t} from '@/i18n';

/** Refused rows named in the upload result line; more are counted. */
const REFUSED_SHOWN = 3;

/**
 * The result of Upload labels (#31) in one line: what was saved, what was skipped and why, and the
 * first refused rows by number.
 */
export function uploadSummary(r: GoldUploadResult): {text: string; err: boolean} {
  if (r.error) return {text: t(r.error), err: true};
  const parts = [r.replaced ? t('Saved {n} labels; {r} replaced earlier ones.', {n: num(r.saved), r: num(r.replaced)}) : r.saved === 1 ? t('Saved 1 label.') : t('Saved {n} labels.', {n: num(r.saved)})];
  if (r.unchanged) parts.push(r.unchanged === 1 ? t('1 row already had this label.') : t('{n} rows already had this label.', {n: num(r.unchanged)}));
  if (r.notInDataset) parts.push(r.notInDataset === 1 ? t('1 item is not in the dataset and was skipped; uploading labels never adds examples.') : t('{n} items are not in the dataset and were skipped; uploading labels never adds examples.', {n: num(r.notInDataset)}));
  const refused = r.refused ?? [];
  for (const f of refused.slice(0, REFUSED_SHOWN)) parts.push(f.externalId ? t('Row {row} (item {id}) was refused: {reason}.', {row: num(f.row), id: f.externalId, reason: f.reason}) : t('Row {row} was refused: {reason}.', {row: num(f.row), reason: f.reason}));
  if (refused.length > REFUSED_SHOWN) parts.push(t('{n} more rows were refused.', {n: num(refused.length - REFUSED_SHOWN)}));
  return {text: parts.join(' '), err: refused.length > 0 || !!r.notInDataset};
}

/** Upload labels: a file of item IDs and answers for examples already in the dataset (#31). */
export function UploadLabels({projectId, onResult}: {projectId: string; onResult: (r: GoldUploadResult) => void}) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (f: File) => {
    setBusy(true);
    try {
      onResult(await uploadGoldFile(projectId, f));
    } catch (e) {
      onResult({saved: 0, skipped: 0, error: (e as Error).message});
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <>
      <Button label={t('Upload labels')} variant="secondary" icon={<Icon icon={ArrowUpTrayIcon} size="sm" />} isLoading={busy} tooltip={t('A CSV or JSONL file of item IDs and answers, for examples already in the dataset.')} onClick={() => file.current?.click()} />
      <input ref={file} type="file" className="sr-only" accept=".csv,.jsonl,.json" aria-label={t('Upload labels')} onChange={e => e.target.files?.[0] && void upload(e.target.files[0])} />
    </>
  );
}

/** What the last upload did, until dismissed. */
export function UploadResult({result, onDismiss}: {result: GoldUploadResult; onDismiss: () => void}) {
  const {text, err} = uploadSummary(result);
  return <Banner status={err ? 'warning' : 'info'} title={text} isDismissable dismissLabel={t('Dismiss')} onDismiss={onDismiss} />;
}
