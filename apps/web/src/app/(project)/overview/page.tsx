'use client';

import {useEffect, useState, type ReactNode} from 'react';
import {Avatar, Badge, Button, Card, ClickableCard, Divider, Grid, Heading, HStack, Icon, Link, ProgressBar, StackItem, Text, VStack} from '@/ui/astryx';
import {ArrowRightIcon, Cog6ToothIcon} from '@heroicons/react/24/outline';
import {bestReport, DEFAULT_THRESHOLDS, NODES, versionLabel} from '@yushiguang/sprint-domain';
import type {JobQueuePlace, PageContext, ProjectActivity, ProjectEditor, ProjectOverview} from '@yushiguang/sprint-contracts';
import {getProjectOverview, listProjectEditors, stopOptimiser, stopRun, stopSampleDataset, type ProjectState} from '@/backend-api';
import {Frame, ProjectPage} from '@/components/Shell';
import {hrefFor, tenantHref} from '@/components/ProjectContext';
import {useSettings} from '@/components/ProjectSettings';
import {WithSide} from '@/components/shell/Page';
import {stepStates} from '@/components/steps';
import {shortDate} from '@/components/sources';
import {PageTitle, dateTime, reportFailure} from '@/ui';
import {t} from '@/i18n';

/**
 * The project overview (wireframe W-Overview, #123): where a project opens. The best score and
 * the next step, the work running now, what happened; beside them the project's details, who can
 * edit it, and the data sources its dataset came from.
 */
export default function OverviewPage() {
  return (
    <ProjectPage node="overview" page={PAGE}>
      {({state}) => <Overview state={state} />}
    </ProjectPage>
  );
}

const PAGE: PageContext = {label: 'Overview', agent: 'front_desk', intent: 'answer', hint: 'Ask what to do next in this project.', context: {}};

function Overview({state}: {state: ProjectState}) {
  const settings = useSettings();
  const p = state.project;
  const [view, setView] = useState<ProjectOverview | null>(null);
  const [editors, setEditors] = useState<ProjectEditor[] | null>(null);
  // Read again whenever the project's state is (every change): activity and editors follow it.
  useEffect(() => {
    let live = true;
    getProjectOverview({projectId: p.id}).then(v => live && setView(v), () => live && setView(null));
    listProjectEditors({projectId: p.id}).then(v => live && setEditors(v), () => live && setEditors(null));
    return () => {
      live = false;
    };
  }, [p.id, state]);
  return (
    <Frame head={<PageTitle title={p.name} actions={<Button label={t('Project settings')} variant="secondary" icon={<Icon icon={Cog6ToothIcon} size="sm" />} onClick={settings.open} />} />}>
      <WithSide sideWidth={360} side={<Side state={state} view={view} editors={editors} />}>
        <VStack gap={10}>
          <Grid columns={2} gap={4}>
            <BestScore state={state} />
            <NextStep state={state} />
          </Grid>
          <Tasks state={state} />
          <Activity lines={view?.activity ?? null} />
        </VStack>
      </WithSide>
    </Frame>
  );
}

/** A card that opens a page: a small label with an arrow, the big line, one line under it. */
function LinkCard({label, href, top, big, extra, line}: {label: string; href: string; top: string; big: ReactNode; extra?: ReactNode; line?: ReactNode}) {
  return (
    <ClickableCard label={label} href={href} padding={6} style={{height: '100%'}}>
      <VStack gap={4}>
        <HStack gap={2} vAlign="center" hAlign="between">
          <Text type="label" color="secondary">
            {top}
          </Text>
          <Icon icon={ArrowRightIcon} size="sm" color="secondary" />
        </HStack>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Text type="display-2" hasTabularNumbers style={{lineHeight: 1}}>
            {big}
          </Text>
          {extra}
        </HStack>
        {line != null && (
          <Text type="body" color="secondary">
            {line}
          </Text>
        )}
      </VStack>
    </ClickableCard>
  );
}

/** The best current score and its verdict, on which version and how many examples; opens Prompt Tuning. */
function BestScore({state}: {state: ProjectState}) {
  const best = bestReport(state);
  const v = best ? state.versions.find(x => x.id === best.promptVersionId) : undefined;
  const href = hrefFor(state.project.id, '/prompt');
  if (!best) return <LinkCard label={t('Open Prompt Tuning')} href={href} top={t('Best score')} big="—" line={t('No version has a score yet.')} />;
  const verdict = best.rough ? <Badge variant="neutral" label={t('Rough reading')} /> : best.passed ? <Badge variant="success" label={t('Passed')} /> : <Badge variant="warning" label={t('Below')} />;
  const line = v ? t('Prompt {version} · on {n} labeled examples', {version: versionLabel(v), n: best.metrics.n.toLocaleString()}) : undefined;
  return <LinkCard label={t('Open Prompt Tuning')} href={href} top={t('Best score')} big={`${(best.metrics.macroF1 * 100).toFixed(1)}%`} extra={verdict} line={line} />;
}

/** The first step that is not finished; Prompt Tuning once they all are. */
function NextStep({state}: {state: ProjectState}) {
  const st = stepStates(state);
  const next = NODES.find(n => st[n.id] !== 'done') ?? NODES[NODES.length - 1];
  let line: string | undefined;
  if (next.id === 'prompt' && state.reports.length) {
    const passing = bestReport(state, true);
    const v = passing ? state.versions.find(x => x.id === passing.promptVersionId) : undefined;
    line = v ? t('{version} meets the thresholds.', {version: versionLabel(v)}) : t('No version meets the thresholds yet.');
  }
  return <LinkCard label={t('Continue to {step}', {step: t(next.label)})} href={hrefFor(state.project.id, next.path)} top={t('Next')} big={t(next.label)} line={line} />;
}

const busy = (r: {state: string; queue?: JobQueuePlace}) => r.state === 'running' || !!r.queue;
const queued = (q: JobQueuePlace) => (q.ahead ? t('{n} ahead', {n: q.ahead}) : t('Next in line'));

interface Task {
  key: string;
  title: string;
  where: string;
  progress?: {done: number; total: number};
  stop?: {label: string; run: () => Promise<unknown>};
}

/** The work running or waiting now: labeling by version, the Optimiser, adding examples. */
function tasks(state: ProjectState): Task[] {
  const out: Task[] = [];
  const pid = state.project.id;
  const sampling = state.samplingTask;
  if (sampling?.state === 'running') {
    out.push({
      key: sampling.id,
      title: t('Adding {n} examples', {n: sampling.total.toLocaleString()}),
      where: `${t('Dataset')} · ${t('{done} of {total}', {done: sampling.fetched.toLocaleString(), total: sampling.total.toLocaleString()})}`,
      progress: {done: sampling.fetched, total: sampling.total},
      ...(sampling.saving ? {} : {stop: {label: t('Stop'), run: () => stopSampleDataset(pid)}}),
    });
  }
  for (const o of state.optimisation.filter(busy)) {
    out.push({
      key: o.id,
      title: o.queue ? `${t('Optimiser')} · ${t('Queued')}` : `${t('Optimiser')} · ${t('Round {n}', {n: o.round})}`,
      where: o.queue ? `${t('Prompt Tuning')} · ${queued(o.queue)}` : `${t('Prompt Tuning')} · ${t('{done} of {total} rounds', {done: o.round, total: o.maxRounds})}`,
      ...(o.queue ? {} : {progress: {done: o.round, total: o.maxRounds}}),
      stop: {label: o.queue ? t('Cancel') : t('Stop'), run: () => stopOptimiser({projectId: pid, runId: o.id})},
    });
  }
  // A version's labeling runs as one task; the Optimiser's own runs belong to it.
  const byVersion = new Map<string, typeof state.runs>();
  for (const r of state.runs.filter(r => busy(r) && r.purpose !== 'optimiser')) byVersion.set(r.promptVersionId, [...(byVersion.get(r.promptVersionId) ?? []), r]);
  for (const [versionId, runs] of byVersion) {
    const v = state.versions.find(x => x.id === versionId);
    const name = v ? versionLabel(v) : t('Prompt');
    const wait = runs.every(r => r.queue) ? runs.find(r => r.queue)?.queue : undefined;
    const done = runs.reduce((n, r) => n + r.done, 0);
    const total = runs.reduce((n, r) => n + r.total, 0);
    const stopAll = () => Promise.all(runs.map(r => stopRun({projectId: pid, runId: r.id})));
    out.push(
      wait
        ? {key: versionId, title: `${name} · ${t('Queued')}`, where: `${t('Prompt Tuning')} · ${queued(wait)}`, stop: {label: t('Cancel'), run: stopAll}}
        : {key: versionId, title: `${name} · ${t('Labeling')}`, where: `${t('Prompt Tuning')} · ${t('{done} of {total}', {done: done.toLocaleString(), total: total.toLocaleString()})}`, progress: {done, total}, stop: {label: t('Stop'), run: stopAll}},
    );
  }
  return out;
}

function Tasks({state}: {state: ProjectState}) {
  const list = tasks(state);
  return (
    <VStack gap={4}>
      <Heading level={2}>{t('Tasks')}</Heading>
      {list.length === 0 ? (
        <Text type="body" color="secondary">
          {t('Nothing is running now.')}
        </Text>
      ) : (
        <VStack gap={3}>
          {list.map(x => (
            <Card key={x.key} padding={5}>
              <HStack gap={4} vAlign="center">
                <StackItem size="fill" style={{minWidth: 0}}>
                  <VStack gap={1}>
                    <Text type="body">{x.title}</Text>
                    <Text type="supporting" color="secondary">
                      {x.where}
                    </Text>
                  </VStack>
                </StackItem>
                <HStack gap={3} vAlign="center">
                  {x.progress && (
                    <div style={{width: 160}}>
                      <ProgressBar label={x.title} isLabelHidden value={x.progress.done} max={Math.max(1, x.progress.total)} />
                    </div>
                  )}
                  {x.stop && <Button label={x.stop.label} variant="secondary" size="sm" onClick={() => x.stop!.run().catch(e => reportFailure(e, x.stop!.label))} />}
                </HStack>
              </HStack>
            </Card>
          ))}
        </VStack>
      )}
    </VStack>
  );
}

const examples = (n = 0) => (n === 1 ? t('1 example') : t('{n} examples', {n: n.toLocaleString()}));

/** One activity line's words after the name. */
function said(a: ProjectActivity): string {
  const x = a.text ?? '';
  switch (a.kind) {
    case 'project_created':
      return t('created the project');
    case 'project_renamed':
      return t('renamed the project to {name}', {name: x});
    case 'settings_saved':
      return t('changed the project settings');
    case 'examples_added':
      return t('added {examples} to the dataset', {examples: examples(a.count)});
    case 'examples_removed':
      return t('removed {examples} from the dataset', {examples: examples(a.count)});
    case 'examples_restored':
      return t('restored {examples}', {examples: examples(a.count)});
    case 'examples_labeled':
      return t('labeled {examples}', {examples: examples(a.count)});
    case 'gold_uploaded':
      return a.count === 1 ? t('uploaded 1 gold label') : t('uploaded {n} gold labels', {n: (a.count ?? 0).toLocaleString()});
    case 'label_sets_created':
      return a.count === 1 ? t('made 1 label set') : t('made {n} label sets', {n: a.count ?? 0});
    case 'version_saved':
      return t('saved {version}', {version: x});
    case 'step_finished': {
      const node = NODES.find(n => n.id === x);
      return t('finished {step}', {step: node ? t(node.label) : x});
    }
    case 'editor_added':
      return t('let {name} edit the project', {name: x});
    case 'editor_removed':
      return t('took edit access from {name}', {name: x});
    case 'ai_suggested':
      return t('made a suggestion: {text}', {text: x});
  }
}

/** "08:40" today, "Yesterday 16:10", else the date and time. */
function when(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => x.toDateString();
  const time = dateTime(iso).slice(-5);
  if (day(d) === day(now)) return time;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (day(d) === day(y)) return t('Yesterday {time}', {time});
  return dateTime(iso);
}

function Activity({lines}: {lines: ProjectActivity[] | null}) {
  return (
    <VStack gap={6}>
      <Heading level={2}>{t('Activity')}</Heading>
      {lines && lines.length === 0 && (
        <Text type="body" color="secondary">
          {t('Nothing has happened yet.')}
        </Text>
      )}
      {lines && lines.length > 0 && (
        <VStack gap={4}>
          {lines.map(a => {
            const name = a.by.kind === 'person' ? a.by.name : a.by.kind === 'ai' ? (a.by.name === 'Optimiser' ? t('Optimiser') : t('AI')) : 'Sprint';
            return (
              <HStack key={a.id} gap={3} vAlign="center">
                <Avatar name={name} size="sm" />
                <StackItem size="fill" style={{minWidth: 0}}>
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text type="body">{name}</Text>
                    {a.by.kind === 'ai' && <Badge variant="ai" label={t('AI')} />}
                    <Text type="body" color="secondary">
                      {said(a)}
                    </Text>
                  </HStack>
                </StackItem>
                <Text type="supporting" color="secondary" style={{flex: 'none'}}>
                  {when(a.at)}
                </Text>
              </HStack>
            );
          })}
        </VStack>
      )}
    </VStack>
  );
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

function Side({state, view, editors}: {state: ProjectState; view: ProjectOverview | null; editors: ProjectEditor[] | null}) {
  const p = state.project;
  const setup = state.setup;
  const schema = setup?.schema ?? null;
  const model = setup?.models[0];
  const th = setup?.thresholds ?? DEFAULT_THRESHOLDS;
  const thresholds = [`Macro-F1 ${pct(th.macroF1)}`];
  if (th.mode === 'custom' && th.precision != null) thresholds.push(`${t('Precision')} ${pct(th.precision)}`);
  if (th.mode === 'custom' && th.recall != null) thresholds.push(`${t('Recall')} ${pct(th.recall)}`);
  const rows: [string, ReactNode][] = [
    [t('Type'), t('Prompt optimisation')],
    [t('Created by'), p.createdBy],
    [t('Created'), shortDate(p.createdAt)],
    [t('Labeling model'), (model && state.endpoints.find(e => e.id === model.endpoint)?.name) ?? model?.endpoint ?? '—'],
    [t('Label'), schema ? `${schema.name} · ${schema.kind === 'multi' ? t('several answers') : t('one answer')}` : '—'],
    [t('Answers'), schema?.values.length ? schema.values.map(v => v.name).join(', ') : '—'],
    [t('Thresholds'), thresholds.join(' · ')],
    [t('Your access'), view ? (view.canEdit ? t('Can edit') : t('Can view')) : '—'],
  ];
  return (
    <Card padding={6}>
      <VStack gap={5}>
        <VStack gap={4}>
          <Heading level={3}>{t('Details')}</Heading>
          <div style={{display: 'grid', gridTemplateColumns: '112px 1fr', gap: 12, alignItems: 'baseline'}}>
            {rows.map(([k, v]) => (
              <Row key={k} k={k} v={v} />
            ))}
          </div>
        </VStack>
        <Divider variant="subtle" />
        <VStack gap={4}>
          <Heading level={3}>{t('Members')}</Heading>
          {editors && (
            <HStack gap={1} vAlign="center" wrap="wrap" aria-label={t('People who can edit')}>
              {editors.map(e => (
                <Avatar key={e.userId} name={e.name} size="md" />
              ))}
            </HStack>
          )}
        </VStack>
        {state.datasetSources.length > 0 && (
          <>
            <Divider variant="subtle" />
            <VStack gap={4}>
              <Heading level={3}>{t('Data sources')}</Heading>
              <VStack gap={3}>
                {state.datasetSources.map(s => (
                  <VStack key={s.sourceId} gap={0}>
                    <Link href={sourceHref(s.sourceId)}>{s.builtIn ? t(s.name) : s.name}</Link>
                    <Text type="supporting" color="secondary">
                      {t('{examples} in the dataset', {examples: examples(s.examples)})}
                    </Text>
                  </VStack>
                ))}
              </VStack>
            </VStack>
          </>
        )}
      </VStack>
    </Card>
  );
}

function Row({k, v}: {k: string; v: ReactNode}) {
  return (
    <>
      <Text type="body" color="secondary">
        {k}
      </Text>
      <Text type="body">{v}</Text>
    </>
  );
}

/** A data source's page, in the page's tenant. */
function sourceHref(id: string) {
  const base = tenantHref('/source/');
  return `${base}${base.includes('?') ? '&' : '?'}${new URLSearchParams({id})}`;
}
