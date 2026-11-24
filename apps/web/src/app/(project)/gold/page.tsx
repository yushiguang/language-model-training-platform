'use client';

import {useState} from 'react';
import {PlusIcon, RectangleStackIcon} from '@heroicons/react/24/outline';
import type {PageContext} from '@yushiguang/sprint-contracts';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {useRuntime} from '@/components/session';
import {CreateSetsDialog, SetSettingsDialog} from '@/components/gold/dialogs';
import {LabelSets, useLabelSets, useMembers} from '@/components/gold/sets';
import type {LabelSetView, ProjectState} from '@/backend-api';
import {Button, Card, EmptyState, Grid, Heading, HStack, Icon, ProgressBar, Spinner, Text, VStack} from '@/ui/astryx';
import {PageTitle} from '@/ui';
import {ErrorLine} from '@/components/sources/dialogs';
import {t} from '@/i18n';

/**
 * Gold Labels (wireframes v346: W-Labeling, -Create, -Batch, -Settings): the dataset's label sets.
 * How much of the dataset is in a set, labeled and mismatched; then the sets, each opening the
 * page where its labeler labels it. Sets are made from the samples not in one yet, one at a time
 * or several at once.
 */
export default function GoldLabelsPage() {
  return (
    <ProjectPage node="gold" page={PAGE}>
      {({state}) => <GoldLabels state={state} />}
    </ProjectPage>
  );
}

const PAGE: PageContext = {label: 'Gold Labels', agent: 'front_desk', intent: 'answer', hint: 'Ask how to split the dataset between labelers.', context: {}};

/** What the label set reads hang on: a new revision of the project reads them again. */
const revisionOf = (s: ProjectState) => s.revision ?? `${s.examples.length}|${s.removals.length}|${Object.keys(s.gold).length}|${s.reports.length}`;

function GoldLabels({state}: {state: ProjectState}) {
  const {href} = useProject();
  const {info} = useRuntime();
  const {list, failed, reload} = useLabelSets(state.project.id, revisionOf(state));
  const members = useMembers();
  const [open, setOpen] = useState<{kind: 'create'} | {kind: 'settings'; set: LabelSetView} | null>(null);
  const create = () => setOpen({kind: 'create'});
  const createButton = <Button label={t('Create label sets')} variant="primary" icon={<Icon icon={PlusIcon} size="sm" />} onClick={create} isDisabled={!list?.unassigned} tooltip={list && !list.unassigned && list.sets.length ? t('Every example is already in a label set. Append examples on Dataset to make more.') : undefined} />;
  const setHref = (s: LabelSetView) => href('/gold/set', {set: s.id});
  const next = (list?.sets.reduce((n, s) => Math.max(n, s.number), 0) ?? 0) + 1;

  return (
    <Frame head={<PageTitle title={t('Gold Labels')} actions={list && (list.sets.length > 0 || list.unassigned > 0) ? createButton : undefined} />}>
      {failed ? (
        <Card padding={6}>
          <VStack gap={3}>
            <ErrorLine text={failed} />
            <HStack>
              <Button label={t('Retry')} variant="secondary" onClick={reload} />
            </HStack>
          </VStack>
        </Card>
      ) : !list ? (
        <HStack hAlign="center" paddingBlock={10}>
          <Spinner label={t('Loading')} />
        </HStack>
      ) : !state.snapshot || (list.sets.length === 0 && list.unassigned === 0) ? (
        <Card padding={10}>
          <EmptyState
            title={t('No examples to label yet')}
            description={t('Add examples on Dataset first, then split them into label sets here.')}
            icon={<Icon icon={RectangleStackIcon} size="lg" color="secondary" />}
            actions={<Button label={t('Open Dataset')} variant="secondary" href={href('/dataset')} />}
          />
        </Card>
      ) : (
        <VStack gap={8}>
          <DatasetCard inSets={list.sets.reduce((n, s) => n + s.samples, 0)} notInSet={list.unassigned} labeled={list.labeled} mismatch={list.mismatch} />
          {list.sets.length === 0 ? (
            <Card padding={10}>
              <EmptyState
                title={t('No label sets yet')}
                description={t('Split the dataset into label sets and give each one a labeler.')}
                icon={<Icon icon={RectangleStackIcon} size="lg" color="secondary" />}
                actions={createButton}
              />
            </Card>
          ) : (
            <LabelSets list={list} members={members} me={info?.user.id ?? null} setHref={setHref} onSettings={set => setOpen({kind: 'settings', set})} />
          )}
        </VStack>
      )}
      {open?.kind === 'create' && list && <CreateSetsDialog projectId={state.project.id} unassigned={list.unassigned} nextNumber={next} members={members} onClose={() => setOpen(null)} />}
      {open?.kind === 'settings' && <SetSettingsDialog projectId={state.project.id} set={open.set} members={members} onClose={() => setOpen(null)} />}
    </Frame>
  );
}

/** Dataset: how many examples are in a set and not, labeled and mismatched; then how much is in sets. */
function DatasetCard({inSets, notInSet, labeled, mismatch}: {inSets: number; notInSet: number; labeled: number; mismatch: number}) {
  const total = inSets + notInSet;
  const n = (x: number) => x.toLocaleString('en-US');
  return (
    <Card padding={6}>
      <VStack gap={6}>
        <Heading level={3}>{t('Dataset')}</Heading>
        <Grid columns={4} gap={6}>
          <Count label={t('In label sets')} value={n(inSets)} />
          <Count label={t('Not in a set')} value={n(notInSet)} />
          <Count label={t('Gold labeled')} value={n(labeled)} />
          <Count label={t('Mismatch')} value={n(mismatch)} />
        </Grid>
        <VStack gap={2}>
          <ProgressBar label={t('In label sets')} isLabelHidden value={inSets} max={Math.max(1, total)} />
          <Text type="supporting" color="secondary" hasTabularNumbers>
            {t('{n} of {total} examples are in a label set.', {n: n(inSets), total: n(total)})}
          </Text>
        </VStack>
      </VStack>
    </Card>
  );
}

function Count({label, value}: {label: string; value: string}) {
  return (
    <VStack gap={1}>
      <Text type="body" color="secondary">
        {label}
      </Text>
      <Text type="display-3" hasTabularNumbers>
        {value}
      </Text>
    </VStack>
  );
}
