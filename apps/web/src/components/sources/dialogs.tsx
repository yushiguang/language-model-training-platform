'use client';

import {useEffect, useRef, useState, type ReactNode} from 'react';
import {DocumentIcon, ExclamationCircleIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {createDataSourceFile, deleteDataSource, renameDataSource, UploadStopped, type DataSourceSummary} from '@/backend-api';
import {Button, Card, FileInput, HStack, Icon, IconButton, ProgressBar, StackItem, Text, TextInput, VStack} from '@/ui/astryx';
import {isAccessDenied} from '@/ui';
import {t} from '@/i18n';
import {FormDialog} from '../shell/dialogs';
import {attempt, fileKind, fileSize, nameFromFile, refuseSourceChange, SOURCE_ACCEPT, sourceHint} from '../sources';

/** A file in a dialog: its icon, name and "CSV · 9.1 MB", with an optional control at the end. */
function FileRow({file, end}: {file: File; end?: ReactNode}) {
  return (
    <Card padding={4} variant="muted">
      <HStack gap={3} vAlign="center">
        <Icon icon={DocumentIcon} size="md" color="secondary" />
        <StackItem size="fill" style={{minWidth: 0}}>
          <VStack gap={0}>
            <Text type="label" maxLines={1}>
              {file.name}
            </Text>
            <Text type="supporting" color="secondary">
              {fileKind(file.name)} · {fileSize(file.size)}
            </Text>
          </VStack>
        </StackItem>
        {end}
      </HStack>
    </Card>
  );
}

/** A line in red with an alert icon, for what went wrong in a dialog. */
export function ErrorLine({text}: {text: string}) {
  return (
    <HStack gap={2} vAlign="center" className="sp-error" role="alert">
      <Icon icon={ExclamationCircleIcon} size="sm" color="error" />
      <Text type="body" color="inherit">
        {text}
      </Text>
    </HStack>
  );
}

type Upload = {state: 'pick'} | {state: 'picked'} | {state: 'uploading'; share: number} | {state: 'failed'; why: string};

/**
 * Upload a data source (W-Sources-Upload, -Picked, -Uploading, -Failed): pick a CSV or JSONL file,
 * the name comes from the file name, then the upload with its progress and Stop upload. Once the
 * file is up the source exists and the dialog closes; reading it goes on in the list. A broken or
 * stopped upload saves nothing and can be tried again.
 */
export function UploadDialog({onClose, onCreated}: {onClose: () => void; onCreated?: (s: DataSourceSummary) => void}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [step, setStep] = useState<Upload>({state: 'pick'});
  const [nameError, setNameError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);

  const pick = (f: File | null) => {
    setFile(f);
    setFileError(null);
    setNameError(null);
    setName(f ? nameFromFile(f.name) : '');
    setStep({state: f ? 'picked' : 'pick'});
  };

  const upload = async () => {
    if (!file) return;
    if (!name.trim()) return setNameError(t('Give the data source a name.'));
    setNameError(null);
    setFileError(null);
    const ctl = new AbortController();
    stop.current = ctl;
    setStep({state: 'uploading', share: 0});
    try {
      const res = await createDataSourceFile(name.trim(), file, {signal: ctl.signal, onProgress: share => setStep({state: 'uploading', share})});
      if (res.error) {
        // The name is checked in its field; anything else is about the file.
        if (/name/i.test(res.error)) setNameError(t(res.error));
        else setFileError(t(res.error));
        return setStep({state: 'picked'});
      }
      if (res.source) onCreated?.(res.source);
      onClose();
    } catch (e) {
      if (isAccessDenied(e)) {
        onClose();
        return refuseSourceChange('add');
      }
      if (e instanceof UploadStopped && e.why === 'stopped') return setStep({state: 'picked'});
      const at = e instanceof UploadStopped ? e.share : 0;
      setStep({state: 'failed', why: t('The upload stopped at {n}%: the connection was lost. Nothing was saved.', {n: Math.round(at * 100)})});
    } finally {
      stop.current = null;
    }
  };

  const cancel = <Button label={t('Cancel')} variant="ghost" onClick={onClose} />;
  const title = t('Upload a data source');

  if (step.state === 'uploading')
    return (
      <FormDialog title={title} onClose={() => stop.current?.abort()} footer={<Button label={t('Stop upload')} variant="secondary" onClick={() => stop.current?.abort()} />}>
        <VStack gap={5}>
          {file && <FileRow file={file} />}
          <ProgressBar label={t('Uploading')} value={Math.round(step.share * 100)} max={100} hasValueLabel />
          <Text type="supporting" color="secondary">
            {t('Keep this page open until the upload finishes.')}
          </Text>
        </VStack>
      </FormDialog>
    );

  if (step.state === 'failed')
    return (
      <FormDialog
        title={title}
        onClose={onClose}
        footer={
          <>
            {cancel}
            <Button label={t('Try again')} variant="primary" onClick={() => void upload()} />
          </>
        }
      >
        <VStack gap={5}>
          {file && <FileRow file={file} />}
          <ErrorLine text={step.why} />
        </VStack>
      </FormDialog>
    );

  return (
    <FormDialog
      title={title}
      onClose={onClose}
      footer={
        <>
          {cancel}
          <Button label={t('Upload')} variant="primary" isDisabled={!file} onClick={() => void upload()} />
        </>
      }
    >
      {file ? (
        <VStack gap={5}>
          <FileRow file={file} end={<IconButton label={t('Remove file')} variant="ghost" size="sm" icon={<Icon icon={XMarkIcon} size="sm" />} onClick={() => pick(null)} />} />
          {fileError && <ErrorLine text={fileError} />}
          <TextInput label={t('Name')} value={name} onChange={v => (setName(v), setNameError(null))} status={nameError ? {type: 'error', message: nameError} : undefined} statusVariant="detached" />
        </VStack>
      ) : (
        <VStack gap={2}>
          <FileInput label={t('File')} isLabelHidden mode="dropzone" accept={SOURCE_ACCEPT} value={null} onChange={f => pick(Array.isArray(f) ? (f[0] ?? null) : f)} placeholder={t('Drop a file here, or choose one')} />
          <Text type="supporting" color="secondary">
            {sourceHint()}
          </Text>
        </VStack>
      )}
    </FormDialog>
  );
}

/** Rename a data source: the name is checked like a new one's, and a problem shows under the field. */
export function RenameDialog({source, onClose}: {source: {id: string; name: string}; onClose: () => void}) {
  const [name, setName] = useState(source.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) return setError(t('Give the data source a name.'));
    setSaving(true);
    let answer: string | undefined;
    const failed = await attempt(async () => {
      answer = (await renameDataSource({sourceId: source.id, name})).error;
    });
    setSaving(false);
    if (failed === '') return onClose();
    if (failed || answer) return setError(failed || t(answer!));
    onClose();
  };
  return (
    <FormDialog
      title={t('Rename data source')}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={t('Save')} variant="primary" isLoading={saving} onClick={() => void save()} />
        </>
      }
    >
      <TextInput label={t('Name')} value={name} hasAutoFocus onChange={v => (setName(v), setError(null))} status={error ? {type: 'error', message: error} : undefined} statusVariant="detached" />
    </FormDialog>
  );
}

/**
 * Delete a data source (W-Source-Delete): names the projects using it and says their examples stay;
 * the name must be typed to confirm. Cannot be undone.
 */
export function DeleteDialog({source, usedBy, onClose, onDeleted}: {source: {id: string; name: string}; usedBy: string[]; onClose: () => void; onDeleted?: () => void}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    const failed = await attempt(() => deleteDataSource({sourceId: source.id}));
    setBusy(false);
    if (failed === '') return onClose();
    if (failed) return setError(failed);
    onClose();
    onDeleted?.();
  };
  const what = usedBy.length
    ? usedBy.length === 1
      ? t("{project} uses it. Examples already in that project's dataset stay; new examples can't come from it. This cannot be undone.", {project: usedBy[0]})
      : t("{projects} use it. Examples already in their datasets stay; new examples can't come from it. This cannot be undone.", {projects: usedBy.join(t(', '))})
    : t('No project uses it. This cannot be undone.');
  return (
    <FormDialog
      title={t('Delete {name}?', {name: source.name})}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={t('Delete data source')} variant="destructive" isDisabled={typed !== source.name} isLoading={busy} onClick={() => void remove()} />
        </>
      }
    >
      <VStack gap={5}>
        <Text type="body" color="secondary">
          {what}
        </Text>
        <TextInput label={t('Type the data source name to confirm')} value={typed} onChange={setTyped} />
        {error && <ErrorLine text={error} />}
      </VStack>
    </FormDialog>
  );
}
