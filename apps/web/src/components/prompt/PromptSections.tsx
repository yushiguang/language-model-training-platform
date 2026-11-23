'use client';

import {useState, type ReactNode} from 'react';
import type {FeatureSelection, LabelValue, Schema, StructuredPrompt} from '@yushiguang/sprint-contracts';
import {diffWords, FEATURES, labelOf, matchRuleGroup, withReasons, type MarkSeg} from '@yushiguang/sprint-domain';
import {Badge, Button, Heading, HStack, Icon, Text, Token, VStack} from '@/ui/astryx';
import {PencilSquareIcon} from '@heroicons/react/24/outline';
import {t} from '@/i18n';

/*
 * The prompt as people read it on Prompt Design (wireframes v346, W-PromptDesign): the object view
 * in authoring order (Persona & Task, Input Features, Output Labels, Rule Groups) with no XML tags,
 * and the same parts with word marks against the version it was made from (Changes).
 */

type Part = 'persona' | 'features' | 'labels' | 'rules';

export const FEATURE_GROUPS: {group: keyof FeatureSelection; name: string}[] = [
  {group: 'video', name: 'Video'},
  {group: 'photo_text', name: 'Photo & text'},
  {group: 'metadata', name: 'Metadata'},
];

/** "topic · Single selection". */
export const labelLine = (l: Schema) => `${l.name} · ${l.kind === 'multi' ? t('Multiple selection') : t('Single selection')}`;

/** A part's title, a tag beside it, and Edit on the right (when the page lets people edit). */
function PartHead({title, badge, onEdit}: {title: string; badge?: ReactNode; onEdit?: () => void}) {
  return (
    <HStack gap={2} vAlign="center" hAlign="between" minHeight={32}>
      <HStack gap={2} vAlign="center">
        <Heading level={3}>{title}</Heading>
        {badge}
      </HStack>
      {onEdit && <Button label={t('Edit')} variant="ghost" size="sm" icon={<Icon icon={PencilSquareIcon} size="sm" />} onClick={onEdit} />}
    </HStack>
  );
}

/** Long text: its first three lines, then Show more (round 5). */
function LongText({children, long}: {children: ReactNode; long: boolean}) {
  const [open, setOpen] = useState(false);
  return (
    <VStack gap={1}>
      <div className={long && !open ? 'sp-pd-text clamp' : 'sp-pd-text'}>
        <Text type="body">{children}</Text>
      </div>
      {long && (
        <button type="button" className="sp-pd-more" onClick={() => setOpen(!open)}>
          {open ? t('Show less') : t('Show more')}
        </button>
      )}
    </VStack>
  );
}

const isLong = (text: string) => text.split('\n').length > 3 || text.length > 240;

/** Word marks: added words green, removed words red and struck. */
function Marked({segs}: {segs: MarkSeg[]}) {
  return (
    <>
      {segs.map((m, i) =>
        m.kind === 'same' ? (
          <span key={i}>{m.text}</span>
        ) : m.kind === 'add' ? (
          <ins key={i} className={m.reason ? 'sp-pd-ins why' : 'sp-pd-ins'} title={m.reason}>
            {m.text}
          </ins>
        ) : (
          <del key={i} className="sp-pd-del">
            {m.text}
          </del>
        ),
      )}
    </>
  );
}

const plain = (text: string): MarkSeg[] => [{kind: 'same', text}];

/** Input Features, one row per example type; with `base`, added ones green and removed ones struck. */
function FeatureRows({features, base}: {features: FeatureSelection; base?: FeatureSelection}) {
  return (
    <VStack gap={2}>
      {FEATURE_GROUPS.map(({group, name}) => {
        const keys = FEATURES[group].map(f => f.key).filter(k => features[group].includes(k) || base?.[group].includes(k));
        return (
          <HStack key={group} gap={3} vAlign="center" minHeight={28}>
            <span className="sp-pd-key">
              <Text type="body" color="secondary">
                {t(name)}
              </Text>
            </span>
            {keys.length ? (
              <HStack gap={1} wrap="wrap">
                {keys.map(k => {
                  const now = features[group].includes(k);
                  const was = base ? base[group].includes(k) : now;
                  if (now && was) return <Token key={k} label={t(labelOf(k))} size="sm" />;
                  return (
                    <span key={k} className={now ? 'sp-pd-pill sp-pd-ins' : 'sp-pd-pill sp-pd-del'}>
                      {t(labelOf(k))}
                    </span>
                  );
                })}
              </HStack>
            ) : (
              <Text type="body" color="secondary">
                {t('None')}
              </Text>
            )}
          </HStack>
        );
      })}
    </VStack>
  );
}

/** A titled block of long text: a value and its definition, or a rule group. */
function Block({title, tag, segs, text}: {title: string; tag?: ReactNode; segs?: MarkSeg[]; text: string}) {
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center">
        <Text type="label" weight="semibold">
          {title}
        </Text>
        {tag}
      </HStack>
      <LongText long={!segs && isLong(text)}>{segs ? <Marked segs={segs} /> : text}</LongText>
    </VStack>
  );
}

/** The object view (Sections). `onEdit` opens a part's dialog; left out, the parts are read only. */
export function SectionsView({prompt, onEdit}: {prompt: StructuredPrompt; onEdit?: (part: Part) => void}) {
  const edit = (p: Part) => (onEdit ? () => onEdit(p) : undefined);
  return (
    <VStack gap={8}>
      <VStack gap={2}>
        <PartHead title={t('Persona & Task')} onEdit={edit('persona')} />
        <LongText long={isLong(prompt.taskSummary)}>{prompt.taskSummary || <Empty />}</LongText>
      </VStack>
      <VStack gap={3}>
        <PartHead title={t('Input Features')} onEdit={edit('features')} />
        <FeatureRows features={prompt.features} />
      </VStack>
      <VStack gap={3}>
        <PartHead title={t('Output Labels')} badge={prompt.label.name ? <Token label={labelLine(prompt.label)} size="sm" /> : undefined} onEdit={edit('labels')} />
        <VStack gap={4}>
          {prompt.label.values.length ? prompt.label.values.map((v, i) => <Block key={i} title={v.name} text={v.definition} />) : <Empty />}
        </VStack>
      </VStack>
      <VStack gap={3}>
        <PartHead title={t('Rule Groups')} onEdit={edit('rules')} />
        <VStack gap={4}>{prompt.ruleGroups.length ? prompt.ruleGroups.map(g => <Block key={g.id} title={g.title} text={g.content} />) : <Empty />}</VStack>
      </VStack>
    </VStack>
  );
}

function Empty() {
  return (
    <Text type="body" color="secondary">
      {t('None yet')}
    </Text>
  );
}

/** The value in `base` that `v` continues: the same name, else the value at the same place (a rename). */
function baseValue(v: LabelValue, i: number, base: LabelValue[], values: LabelValue[]): LabelValue | undefined {
  const named = base.find(x => x.name === v.name);
  if (named) return named;
  const at = base[i];
  return at && !values.some(x => x.name === at.name) ? at : undefined;
}

const NewTag = () => <Badge label={t('New')} variant="success" />;
const RemovedTag = () => <Badge label={t('Removed')} variant="error" />;

/**
 * Changes: every part against `base`, the version this one was made from (round 7). A helper's
 * draft carries its reasons: each shows on hover over the words it added (dashed underline).
 */
export function ChangesView({prompt, base, reasons}: {prompt: StructuredPrompt; base: StructuredPrompt; reasons?: {text: string; reason: string}[]}) {
  const marks = (was: string, now: string) => (was === now ? plain(now) : withReasons(diffWords(was, now), reasons ?? []));
  const values = prompt.label.values;
  const kept = values.map((v, i) => baseValue(v, i, base.label.values, values));
  const goneValues = base.label.values.filter(b => !kept.includes(b));
  const goneGroups = base.ruleGroups.filter(b => !prompt.ruleGroups.some(g => matchRuleGroup(g, [b])));
  const labelChanged = labelLine(prompt.label) !== labelLine(base.label);
  return (
    <VStack gap={8}>
      <VStack gap={2}>
        <PartHead title={t('Persona & Task')} />
        <LongText long={false}>
          <Marked segs={marks(base.taskSummary, prompt.taskSummary)} />
        </LongText>
      </VStack>
      <VStack gap={3}>
        <PartHead title={t('Input Features')} />
        <FeatureRows features={prompt.features} base={base.features} />
      </VStack>
      <VStack gap={3}>
        <PartHead
          title={t('Output Labels')}
          badge={
            <HStack gap={1} vAlign="center">
              {labelChanged && <del className="sp-pd-pill sp-pd-del">{labelLine(base.label)}</del>}
              <Token label={labelLine(prompt.label)} size="sm" />
            </HStack>
          }
        />
        <VStack gap={4}>
          {values.map((v, i) => {
            const was = kept[i];
            return <Block key={i} title={v.name} tag={!was ? <NewTag /> : undefined} text={v.definition} segs={marks(was?.definition ?? '', v.definition)} />;
          })}
          {goneValues.map((v, i) => (
            <Block key={`gone-${i}`} title={v.name} tag={<RemovedTag />} text={v.definition} segs={[{kind: 'del', text: v.definition}]} />
          ))}
        </VStack>
      </VStack>
      <VStack gap={3}>
        <PartHead title={t('Rule Groups')} />
        <VStack gap={4}>
          {prompt.ruleGroups.map(g => {
            const was = matchRuleGroup(g, base.ruleGroups);
            return <Block key={g.id} title={g.title} tag={!was ? <NewTag /> : undefined} text={g.content} segs={marks(was?.content ?? '', g.content)} />;
          })}
          {goneGroups.map(g => (
            <Block key={`gone-${g.id}`} title={g.title} tag={<RemovedTag />} text={g.content} segs={[{kind: 'del', text: g.content}]} />
          ))}
          {!prompt.ruleGroups.length && !goneGroups.length && <Empty />}
        </VStack>
      </VStack>
    </VStack>
  );
}
