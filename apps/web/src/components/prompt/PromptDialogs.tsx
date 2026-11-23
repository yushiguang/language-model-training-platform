'use client';

import {useEffect, useRef, useState, type ReactNode} from 'react';
import type {FeatureSelection, LabelValue, RuleGroup, Schema, StructuredPrompt} from '@yushiguang/sprint-contracts';
import {FEATURES, nextRuleGroupId} from '@yushiguang/sprint-domain';
import {Button, CheckboxInput, Divider, Grid, HStack, Icon, IconButton, SegmentedControl, SegmentedControlItem, StackItem, Text, TextArea, TextInput, VStack} from '@/ui/astryx';
import {PhotoIcon, PlusIcon, TrashIcon} from '@heroicons/react/24/outline';
import {FormDialog} from '@/components/shell/dialogs';
import {FEATURE_GROUPS} from './PromptSections';
import {t} from '@/i18n';

/*
 * Editing one part of the prompt at a time (wireframes v346, rounds 5 to 7): each part's Edit opens
 * a dialog; its Save puts the change on the page, and the page's Save keeps the version.
 */

export type PromptPart = 'persona' | 'features' | 'labels' | 'rules';

const TITLES: Record<PromptPart, string> = {persona: 'Persona & Task', features: 'Input Features', labels: 'Output Labels', rules: 'Rule Groups'};

export function PartDialog({part, prompt, onSave, onClose}: {part: PromptPart; prompt: StructuredPrompt; onSave: (p: StructuredPrompt) => void; onClose: () => void}) {
  const [draft, setDraft] = useState(prompt);
  const save = () => {
    onSave(draft);
    onClose();
  };
  return (
    <FormDialog
      title={t(TITLES[part])}
      width={part === 'persona' ? 640 : 720}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={t('Save')} variant="primary" onClick={save} />
        </>
      }
    >
      <div className="sp-pd-dlg">
        {part === 'persona' && <TextArea label={t('Persona & Task')} isLabelHidden rows={6} value={draft.taskSummary} placeholder={t('Who the model is, what the items are, and what the labels are for')} onChange={taskSummary => setDraft({...draft, taskSummary})} />}
        {part === 'features' && <FeaturesForm features={draft.features} onChange={features => setDraft({...draft, features})} />}
        {part === 'labels' && <LabelForm label={draft.label} onChange={label => setDraft({...draft, label})} />}
        {part === 'rules' && <RulesForm groups={draft.ruleGroups} onChange={ruleGroups => setDraft({...draft, ruleGroups})} />}
      </div>
    </FormDialog>
  );
}

/** The fixed catalogue, one block per example type, three to a row; picture features carry an icon. */
function FeaturesForm({features, onChange}: {features: FeatureSelection; onChange: (f: FeatureSelection) => void}) {
  return (
    <VStack gap={5}>
      {FEATURE_GROUPS.map(({group, name}) => (
        <VStack key={group} gap={2}>
          <Text type="label" weight="semibold">
            {t(name)}
          </Text>
          <Grid columns={3} gap={2}>
            {FEATURES[group].map(f => (
              <HStack key={f.key} gap={1} vAlign="center">
                <CheckboxInput
                  label={t(f.label)}
                  value={features[group].includes(f.key)}
                  onChange={on => onChange({...features, [group]: on ? [...features[group], f.key] : features[group].filter(k => k !== f.key)})}
                />
                {f.isImage && <Icon icon={PhotoIcon} size="sm" color="secondary" />}
              </HStack>
            ))}
          </Grid>
        </VStack>
      ))}
    </VStack>
  );
}

/** A text box with no frame that grows with its text: names and definitions are edited in place (round 7). */
function Quiet({value, onChange, label, placeholder, multiline, strong}: {value: string; onChange: (v: string) => void; label: string; placeholder?: string; multiline?: boolean; strong?: boolean}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  if (!multiline) return <input className={strong ? 'sp-quiet strong' : 'sp-quiet'} aria-label={label} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />;
  return <textarea ref={ref} rows={1} className="sp-quiet" aria-label={label} value={value} placeholder={placeholder} spellCheck={false} onChange={e => onChange(e.target.value)} />;
}

/** One card per value or rule group: its name on top, a divider, then its text. */
function ItemCard({name, text, onName, onText, onRemove, nameLabel, textLabel, namePlaceholder, textPlaceholder, extra}: {
  name: string;
  text: string;
  onName: (v: string) => void;
  onText: (v: string) => void;
  onRemove: () => void;
  nameLabel: string;
  textLabel: string;
  namePlaceholder: string;
  textPlaceholder: string;
  extra?: ReactNode;
}) {
  return (
    <div className="sp-pd-item">
      <HStack gap={2} vAlign="center" className="sp-pd-item-head">
        <StackItem size="fill">
          <Quiet strong label={nameLabel} value={name} placeholder={namePlaceholder} onChange={onName} />
        </StackItem>
        <IconButton label={t('Remove {name}', {name: name || nameLabel})} variant="ghost" size="sm" icon={<Icon icon={TrashIcon} size="sm" />} onClick={onRemove} />
      </HStack>
      <Divider />
      <div className="sp-pd-item-body">
        <VStack gap={2}>
          <Quiet multiline label={textLabel} value={text} placeholder={textPlaceholder} onChange={onText} />
          {extra}
        </VStack>
      </div>
    </div>
  );
}

/** The label (its name and single or multiple selection), then its values as cards. */
function LabelForm({label, onChange}: {label: Schema; onChange: (l: Schema) => void}) {
  const values = label.values;
  const multi = label.kind === 'multi';
  const setValue = (i: number, patch: Partial<LabelValue>) => onChange({...label, values: values.map((v, k) => (k === i ? {...v, ...patch} : v))});
  const setKind = (k: string) => {
    const {min: _a, max: _b, ...rest} = label;
    onChange(k === 'multi' ? {...rest, kind: 'multi', min: label.min ?? 1, max: label.max ?? Math.max(1, Math.min(3, values.length))} : {...rest, kind: 'single', values: values.map(({exclusive: _e, ...v}) => v)});
  };
  const bound = (s: string) => Math.max(1, parseInt(s, 10) || 1);
  return (
    <VStack gap={6}>
      <VStack gap={3}>
        <Text type="label" weight="semibold">
          {t('Label')}
        </Text>
        <HStack gap={4} vAlign="center" wrap="wrap">
          <StackItem size="fill">
            <TextInput label={t('Label')} isLabelHidden value={label.name} placeholder="topic" onChange={name => onChange({...label, name: name.replace(/\s+/g, '_')})} />
          </StackItem>
          <SegmentedControl label={t('Selection')} value={multi ? 'multi' : 'single'} onChange={setKind}>
            <SegmentedControlItem value="single" label={t('Single selection')} />
            <SegmentedControlItem value="multi" label={t('Multiple selection')} />
          </SegmentedControl>
        </HStack>
        {multi && (
          <HStack gap={2} vAlign="center">
            <Text type="body" color="secondary">
              {t('Choose')}
            </Text>
            <TextInput label={t('At least')} isLabelHidden width={64} inputMode="numeric" value={String(label.min ?? 1)} onChange={v => onChange({...label, min: bound(v)})} />
            <Text type="body" color="secondary">
              {t('to')}
            </Text>
            <TextInput label={t('At most')} isLabelHidden width={64} inputMode="numeric" value={String(label.max ?? values.length)} onChange={v => onChange({...label, max: bound(v)})} />
          </HStack>
        )}
      </VStack>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Text type="label" weight="semibold">
            {t('Values')}
          </Text>
          <Text type="supporting" color="secondary">
            {values.length}
          </Text>
        </HStack>
        {values.map((v, i) => (
          <ItemCard
            key={i}
            name={v.name}
            text={v.definition}
            nameLabel={t('Value name')}
            textLabel={t('Definition of {value}', {value: v.name || t('Value')})}
            namePlaceholder={t('Value name')}
            textPlaceholder={t('When this value applies and when it does not: one condition per line')}
            onName={name => setValue(i, {name})}
            onText={definition => setValue(i, {definition})}
            onRemove={() => onChange({...label, values: values.filter((_, k) => k !== i)})}
            extra={multi ? <CheckboxInput label={t('Only on its own')} description={t('An answer with this value holds no other value, for example None')} value={!!v.exclusive} onChange={on => setValue(i, {exclusive: on || undefined})} /> : undefined}
          />
        ))}
        <HStack>
          <Button label={t('Add value')} variant="ghost" size="sm" icon={<Icon icon={PlusIcon} size="sm" />} onClick={() => onChange({...label, values: [...values, {name: '', definition: ''}]})} />
        </HStack>
      </VStack>
    </VStack>
  );
}

/** Rule groups as cards, in order: a title, then the rules. */
function RulesForm({groups, onChange}: {groups: RuleGroup[]; onChange: (g: RuleGroup[]) => void}) {
  const set = (i: number, patch: Partial<RuleGroup>) => onChange(groups.map((g, k) => (k === i ? {...g, ...patch} : g)));
  return (
    <VStack gap={3}>
      {groups.map((g, i) => (
        <ItemCard
          key={g.id}
          name={g.title}
          text={g.content}
          nameLabel={t('Rule group title')}
          textLabel={t('Rules of {group}', {group: g.title || t('Rule group')})}
          namePlaceholder={t('Group title, for example Label priority')}
          textPlaceholder={t('Paragraphs, or one rule per line')}
          onName={title => set(i, {title})}
          onText={content => set(i, {content})}
          onRemove={() => onChange(groups.filter((_, k) => k !== i))}
        />
      ))}
      <HStack>
        <Button label={t('Add rule group')} variant="ghost" size="sm" icon={<Icon icon={PlusIcon} size="sm" />} onClick={() => onChange([...groups, {id: nextRuleGroupId(groups), title: '', content: ''}])} />
      </HStack>
    </VStack>
  );
}
