'use client';

import {Button, Card, ClickableCard, Heading, HStack, Icon, Text, VStack} from '@/ui/astryx';
import {ArrowRightIcon, Cog6ToothIcon} from '@heroicons/react/24/outline';
import {NODES} from '@yushiguang/sprint-domain';
import type {PageContext} from '@yushiguang/sprint-contracts';
import type {ProjectState} from '@/backend-api';
import {Frame, ProjectPage} from '@/components/Shell';
import {hrefFor} from '@/components/ProjectContext';
import {useSettings} from '@/components/ProjectSettings';
import {WithSide} from '@/components/shell/Page';
import {stepStates} from '@/components/steps';
import {PageTitle, dateTime} from '@/ui';
import {t} from '@/i18n';

/**
 * The project overview (wireframe W-Overview): where a project opens. This is the frame the
 * project-page lane fills in: the next step to work on, the project's details, and Project settings.
 * The best score, running tasks and activity come with that lane.
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
  return (
    <Frame head={<PageTitle title={p.name} actions={<Button label={t('Project settings')} variant="secondary" icon={<Icon icon={Cog6ToothIcon} size="sm" />} onClick={settings.open} />} />}>
      <WithSide side={<Details state={state} />}>
        <NextStep state={state} />
      </WithSide>
    </Frame>
  );
}

/** The first step that is not finished; Prompt Tuning once they all are. */
function NextStep({state}: {state: ProjectState}) {
  const st = stepStates(state);
  const next = NODES.find(n => st[n.id] !== 'done') ?? NODES[NODES.length - 1];
  return (
    <ClickableCard label={t('Next: {step}', {step: t(next.label)})} href={hrefFor(state.project.id, next.path)} padding={6}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" hAlign="between">
          <Text type="supporting" color="secondary">
            {t('Next')}
          </Text>
          <Icon icon={ArrowRightIcon} size="sm" color="secondary" />
        </HStack>
        <Heading level={2}>{t(next.label)}</Heading>
      </VStack>
    </ClickableCard>
  );
}

function Details({state}: {state: ProjectState}) {
  const p = state.project;
  const rows: [string, string][] = [
    [t('Created by'), p.createdBy],
    [t('Created'), dateTime(p.createdAt)],
  ];
  return (
    <Card padding={6}>
      <VStack gap={4}>
        <Heading level={3}>{t('Details')}</Heading>
        <VStack gap={2}>
          {rows.map(([k, v]) => (
            <HStack key={k} gap={4} vAlign="center">
              <Text type="body" color="secondary" style={{width: 124, flex: 'none'}}>
                {k}
              </Text>
              <Text type="body">{v}</Text>
            </HStack>
          ))}
        </VStack>
      </VStack>
    </Card>
  );
}
