'use client';

import {useEffect, useRef, useState} from 'react';
import {createLabelSet, createLabelSets, previewLabelSets, updateLabelSet, type LabelSetView, type LabelSetsPreview, type TenantMemberView} from '@/backend-api';
import {Avatar, Button, HStack, NumberInput, SegmentedControl, SegmentedControlItem, Selector, Spinner, StackItem, Text, TextInput, VStack} from '@/ui/astryx';
import {t} from '@/i18n';
import {FormDialog} from '../shell/dialogs';
import {ErrorLine} from '../sources/dialogs';
import {attempt} from '../dataset/dialogs';
import {rangeText, setName} from './sets';

/** How many samples a new set takes by default (W-Labeling-Create). */
const DEFAULT_SIZE = 100;

/** The labeler picker: anyone in the tenant, shown with their avatar; one per set for now. */
function LabelerPicker({members, value, onChange, label, description, isLabelHidden}: {members: TenantMemberView[]; value: string | null; onChange: (id: string | null) => void; label: string; description?: string; isLabelHidden?: boolean}) {
  return (
    <Selector
      label={label}
      isLabelHidden={isLabelHidden}
      description={description}
      placeholder={t('Choose a labeler')}
      options={members.map(m => ({value: m.userId, label: m.name, icon: <Avatar name={m.name} size="xsm" />}))}
      value={value ?? ''}
      onChange={(v?: string | null) => onChange(v || null)}
      hasClear={!!value}
      hasSearch={members.length > 8}
      searchPlaceholder={t('Search people…')}
      emptyText={t('Nobody in this tenant yet.')}
    />
  );
}

/**
 * What a create would cut now, read again a moment after the numbers change. `null` while the
 * first read is on its way.
 */
function usePreview(projectId: string, req: {count?: number; sets?: number; perSet?: number} | null): LabelSetsPreview | null {
  const [preview, setPreview] = useState<LabelSetsPreview | null>(null);
  const seq = useRef(0);
  const key = JSON.stringify(req);
  useEffect(() => {
    if (!req) return;
    const mine = ++seq.current;
    const id = setTimeout(() => {
      previewLabelSets({projectId, ...req})
        .then(p => mine === seq.current && setPreview(p))
        .catch(() => mine === seq.current && setPreview(null));
    }, 200);
    return () => clearTimeout(id);
  }, [projectId, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return preview;
}

/**
 * Create label sets (W-Labeling-Create, W-Labeling-Batch). One set: a name, how many samples (the
 * next ones in order) and a labeler. Several sets: how many sets or how many samples each (the
 * other follows), then each set with its range and its own labeler.
 */
export function CreateSetsDialog({projectId, unassigned, nextNumber, members, onClose}: {projectId: string; unassigned: number; nextNumber: number; members: TenantMemberView[]; onClose: () => void}) {
  const [mode, setMode] = useState<'one' | 'several'>('one');
  const defaultName = t('Set {n}', {n: nextNumber});
  const [name, setName_] = useState(defaultName);
  const [count, setCount] = useState<number | null>(Math.min(DEFAULT_SIZE, unassigned));
  const [labeler, setLabeler] = useState<string | null>(null);
  // Several: the number last typed drives the split, the other follows.
  const [by, setBy] = useState<'sets' | 'perSet'>('perSet');
  const [perSet, setPerSet] = useState<number | null>(Math.min(DEFAULT_SIZE, unassigned));
  const [sets, setSets] = useState<number | null>(Math.max(1, Math.ceil(unassigned / Math.max(1, Math.min(DEFAULT_SIZE, unassigned)))));
  const [labelers, setLabelers] = useState<(string | null)[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const req = mode === 'one' ? (count && count > 0 ? {count} : null) : by === 'sets' ? (sets && sets > 0 ? {sets} : null) : perSet && perSet > 0 ? {perSet} : null;
  const preview = usePreview(projectId, req);
  const planned = preview && !preview.error ? preview.sets : [];
  const refused = preview?.error ?? null;

  const typeSets = (v: number | null) => {
    setBy('sets');
    setSets(v);
    if (v && v > 0) setPerSet(Math.ceil(unassigned / v));
    setError(null);
  };
  const typePerSet = (v: number | null) => {
    setBy('perSet');
    setPerSet(v);
    if (v && v > 0) setSets(Math.ceil(unassigned / v));
    setError(null);
  };

  const create = async () => {
    setBusy(true);
    const failed = await attempt(() =>
      mode === 'one'
        ? createLabelSet({projectId, count: count!, ...(name.trim() && name.trim() !== defaultName ? {name: name.trim()} : {}), ...(labeler ? {labelerIds: [labeler]} : {})})
        : createLabelSets({projectId, ...(by === 'sets' ? {sets: sets!} : {perSet: perSet!}), labelers: planned.map((_, i) => labelers[i] ?? null)}),
    );
    setBusy(false);
    if (failed !== null) return failed && setError(failed);
    onClose();
  };

  const ready = !!req && !!preview && !refused && planned.length > 0;
  const createLabel = mode === 'one' ? t('Create') : planned.length === 1 ? t('Create 1 set') : t('Create {n} sets', {n: planned.length || '…'});
  const range = mode === 'one' && planned[0] ? rangeText(planned[0].first, planned[0].last) : null;

  return (
    <FormDialog
      title={t('Create label sets')}
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={createLabel} variant="primary" isDisabled={!ready} isLoading={busy} onClick={() => void create()} />
        </>
      }
    >
      <VStack gap={6}>
        <SegmentedControl label={t('How many')} value={mode} onChange={v => (setMode(v as 'one' | 'several'), setError(null))}>
          <SegmentedControlItem value="one" label={t('One set')} />
          <SegmentedControlItem value="several" label={t('Several sets')} />
        </SegmentedControl>
        {mode === 'one' ? (
          <VStack gap={5}>
            <TextInput label={t('Name')} value={name} onChange={setName_} />
            <NumberInput
              label={t('Examples')}
              description={range ? t('{n} not in a set. Takes the next ones in order: {range}', {n: unassigned.toLocaleString('en-US'), range}) : t('{n} not in a set. Takes the next ones in order.', {n: unassigned.toLocaleString('en-US')})}
              value={count}
              onChange={v => (setCount(v ?? null), setError(null))}
              status={refused ? {type: 'error', message: t(refused)} : undefined}
              statusVariant="detached"
            />
            <LabelerPicker label={t('Labeler')} description={t('Anyone in the tenant. Sprint gives them edit access to this project.')} members={members} value={labeler} onChange={setLabeler} />
          </VStack>
        ) : (
          <VStack gap={5}>
            <VStack gap={2}>
              <HStack gap={4} vAlign="start">
                <StackItem size="fill">
                  <NumberInput label={t('Number of sets')} value={sets} onChange={v => typeSets(v ?? null)} />
                </StackItem>
                <StackItem size="fill">
                  <NumberInput label={t('Examples per set')} value={perSet} onChange={v => typePerSet(v ?? null)} />
                </StackItem>
              </HStack>
              <Text type="supporting" color="secondary">
                {t('Splits the {n} examples not in a set. Change either number; the other follows.', {n: unassigned.toLocaleString('en-US')})}
              </Text>
              {refused && <ErrorLine text={t(refused)} />}
            </VStack>
            {planned.length > 0 && (
              <VStack gap={3}>
                <Text type="label">{t('Label sets to create')}</Text>
                <div className="sp-plan">
                  {planned.map((p, i) => (
                    <HStack key={p.number} gap={4} vAlign="center" className="sp-plan-row">
                      <StackItem size="fill" style={{minWidth: 0}}>
                        <VStack gap={0.5}>
                          <Text type="body" weight="semibold">
                            {setName({name: '', number: p.number})}
                          </Text>
                          <Text type="supporting" color="secondary" hasTabularNumbers>
                            {rangeText(p.first, p.last)} · {t('{n} examples', {n: p.samples.toLocaleString('en-US')})}
                          </Text>
                        </VStack>
                      </StackItem>
                      <div style={{width: 220}}>
                        <LabelerPicker
                          label={t('Labeler of {set}', {set: setName({name: '', number: p.number})})}
                          isLabelHidden
                          members={members}
                          value={labelers[i] ?? null}
                          onChange={id => setLabelers(l => Object.assign([...l], {[i]: id}))}
                        />
                      </div>
                    </HStack>
                  ))}
                </div>
              </VStack>
            )}
            {req && !preview && (
              <HStack hAlign="center" paddingBlock={2}>
                <Spinner size="sm" label={t('Loading')} />
              </HStack>
            )}
          </VStack>
        )}
        {error && <ErrorLine text={error} />}
      </VStack>
    </FormDialog>
  );
}

/** A set's settings (W-Labeling-Settings): its name and labeler; its range never changes. */
export function SetSettingsDialog({projectId, set, members, onClose}: {projectId: string; set: LabelSetView; members: TenantMemberView[]; onClose: () => void}) {
  const [name, setName_] = useState(setName(set));
  const [labeler, setLabeler] = useState<string | null>(set.labelerIds[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    const typed = name.trim();
    // Left as the shown default ("Set 3"), the set keeps no name of its own, so it reads in either language.
    const nextName = typed === setName({name: '', number: set.number}) ? '' : typed;
    const failed = await attempt(() => updateLabelSet({projectId, labelSetId: set.id, ...(nextName !== set.name ? {name: nextName} : {}), labelerIds: labeler ? [labeler] : []}));
    setBusy(false);
    if (failed !== null) return failed && setError(failed);
    onClose();
  };
  return (
    <FormDialog
      title={t('{set} settings', {set: setName(set)})}
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={t('Save')} variant="primary" isLoading={busy} onClick={() => void save()} />
        </>
      }
    >
      <VStack gap={5}>
        <TextInput label={t('Name')} value={name} onChange={setName_} />
        <TextInput label={t('Examples')} value={`${rangeText(set.first, set.last)} · ${set.samples.toLocaleString('en-US')}`} isReadOnly description={t('Fixed once created.')} onChange={() => undefined} />
        <LabelerPicker label={t('Labeler')} description={t('One labeler per set. Sprint gives them edit access to this project.')} members={members} value={labeler} onChange={setLabeler} />
        {error && <ErrorLine text={error} />}
      </VStack>
    </FormDialog>
  );
}
