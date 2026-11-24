'use client';

import {useState} from 'react';
import {CircleStackIcon, PlusIcon} from '@heroicons/react/24/outline';
import type {PageContext} from '@yushiguang/sprint-contracts';
import {gate, labelBalance, systemConfig} from '@yushiguang/sprint-domain';
import {useGo} from '@/components/nav';
import {Frame, ProjectPage} from '@/components/Shell';
import {useProject} from '@/components/ProjectContext';
import {AppendDialog, RemoveDialog} from '@/components/dataset/dialogs';
import {DistributionCard} from '@/components/dataset/distribution';
import {FIRST_QUERY, Samples, useSamples, type SampleQuery} from '@/components/dataset/samples';
import {sourceError, sourceName, useDataSources} from '@/components/sources';
import {approveNode, stopSampleDataset, type ProjectState, type SampleRow} from '@/backend-api';
import {Banner, Button, Card, EmptyState, Grid, Heading, HStack, Icon, ProgressBar, Text, VStack} from '@/ui/astryx';
import {PageTitle} from '@/ui';
import {t, tm} from '@/i18n';

/**
 * Dataset (wireframes v346: W-EvalDataset, -Empty, -Remove, -Removed, -Append): the project's
 * samples, each with a number that never changes. Counts and how the gold labels spread over the
 * label's values on top; then the samples by tab (all, no gold label, mismatch with the best
 * version, removed), searchable, with Remove and Restore on hover. Append examples takes more
 * from the team's data sources.
 */
export default function DatasetPage() {
  return (
    <ProjectPage node="dataset" page={PAGE}>
      {({state}) => <Dataset state={state} />}
    </ProjectPage>
  );
}

const PAGE: PageContext = {label: 'Dataset', agent: 'front_desk', intent: 'answer', hint: 'Ask how many examples the eval dataset needs.', context: {}};

function Dataset({state}: {state: ProjectState}) {
  const [list] = useDataSources();
  const [open, setOpen] = useState<{kind: 'append'} | {kind: 'remove'; sample: SampleRow} | null>(null);
  const snap = state.snapshot;
  const task = state.samplingTask?.state === 'running' ? state.samplingTask : null;
  // The last take failed: why, until the next take (design: V-Dataset-Take-Failed).
  const failed = state.samplingTask?.state === 'failed' ? state.samplingTask : null;
  const append = () => setOpen({kind: 'append'});
  const appendButton = <Button label={t('Append examples')} variant="primary" icon={<Icon icon={PlusIcon} size="sm" />} onClick={append} isDisabled={!list} />;
  const head = <PageTitle title={t('Dataset')} actions={snap && !task ? <HStack gap={2}>{!state.project.approvedNodes.includes('dataset') && <NextButton state={state} />}{appendButton}</HStack> : undefined} />;

  return (
    <Frame head={head}>
      <VStack gap={6}>
        {failed && <Banner status="error" title={t('Taking examples failed: {why}', {why: sourceError(failed.error || 'the service did not answer', list ?? [])})} />}
        {task ? (
          <Card padding={6}>
            <VStack gap={4}>
              <Heading level={3}>{task.saving ? t('Saving the examples') : t('Taking {n} examples', {n: task.total.toLocaleString('en-US')})}</Heading>
              <ProgressBar label={t('Taken')} value={task.fetched} max={Math.max(1, task.total)} hasValueLabel />
              {!task.saving && (
                <HStack>
                  <Button label={t('Stop')} variant="secondary" onClick={() => void stopSampleDataset(state.project.id)} />
                </HStack>
              )}
            </VStack>
          </Card>
        ) : !snap ? (
          <Card padding={10}>
            <EmptyState
              title={t('No examples yet')}
              description={list && !list.length ? t('Your team has no data source yet. An admin uploads one on Data sources.') : undefined}
              icon={<Icon icon={CircleStackIcon} size="lg" color="secondary" />}
              actions={list && !list.length ? <Button label={t('Open Data sources')} variant="secondary" href="/sources/" /> : appendButton}
            />
          </Card>
        ) : (
          <Ready state={state} onRemove={sample => setOpen({kind: 'remove', sample})} />
        )}
      </VStack>
      {open?.kind === 'append' && list && <AppendDialog projectId={state.project.id} list={list} onClose={() => setOpen(null)} />}
      {open?.kind === 'remove' && <RemoveDialog projectId={state.project.id} sample={open.sample} onClose={() => setOpen(null)} />}
    </Frame>
  );
}

function NextButton({state}: {state: ProjectState}) {
  const go = useGo();
  const {href} = useProject();
  const g = gate('dataset', state.facts);
  return (
    <Button
      label={t('Next: Gold Labels')}
      variant="secondary"
      isDisabled={!g.ready}
      tooltip={g.msg ? tm(g.msg) : undefined}
      onClick={async () => {
        await approveNode(state.project.id, 'dataset');
        await go(href('/gold'));
      }}
    />
  );
}

/** What the samples reads hang on: a new revision of the project reads them again. */
const revisionOf = (s: ProjectState) => s.revision ?? `${s.examples.length}|${s.removals.length}|${Object.keys(s.gold).length}|${s.reports.length}|${s.versions.length}`;

function Ready({state, onRemove}: {state: ProjectState; onRemove: (s: SampleRow) => void}) {
  const [q, setQ] = useState<SampleQuery>(FIRST_QUERY);
  // The counts come from the whole dataset, whatever the table shows.
  const data = useSamples(state.project.id, q, revisionOf(state));
  const counts = data.page?.counts;
  const schema = state.setup?.schema ?? null;
  const evalEx = state.examples.filter(e => e.split === 'eval');
  const balance = schema ? labelBalance(schema, evalEx, state.gold) : null;
  const few = (counts?.live ?? evalEx.length) < systemConfig().dataset.minEvalRecommended;
  const sources = state.datasetSources.map(l => ({id: l.sourceId, name: sourceName(l)}));
  return (
    <VStack gap={8}>
      {few && <Banner status="warning" title={t('Fewer than {n} examples: scores will be rough until you add more examples.', {n: systemConfig().dataset.minEvalRecommended})} />}
      <Grid columns={balance ? 2 : 1} gap={6}>
        <ExamplesCard counts={counts ?? null} />
        {balance && <DistributionCard balance={balance} />}
      </Grid>
      <Samples projectId={state.project.id} q={q} setQ={setQ} data={data} sources={sources} values={schema?.values.map(v => v.name) ?? []} onRemove={onRemove} />
    </VStack>
  );
}

/** Examples: total, labeled, mismatch and removed, as the tabs count them. */
function ExamplesCard({counts}: {counts: {live: number; no_label: number; mismatch: number; removed: number} | null}) {
  const n = (x: number | undefined) => (x == null ? '—' : x.toLocaleString('en-US'));
  return (
    <Card padding={6} style={{height: '100%'}}>
      <VStack gap={5}>
        <Heading level={3}>{t('Examples')}</Heading>
        <Grid columns={2} gap={6}>
          <Count label={t('Total')} value={n(counts?.live)} />
          <Count label={t('Gold labeled')} value={n(counts ? counts.live - counts.no_label : undefined)} />
          <Count label={t('Mismatch')} value={n(counts?.mismatch)} />
          <Count label={t('Removed')} value={n(counts?.removed)} />
        </Grid>
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

