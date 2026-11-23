'use client';

import {useEffect, useState} from 'react';
import {Badge, Card, ClickableCard, Grid, Heading, HStack, Text, VStack} from '@/ui/astryx';
import {NODES} from '@yushiguang/sprint-domain';
import {listProjects} from '@/backend-api';
import {HomeFrame} from '@/components/Shell';
import {useRuntime} from '@/components/session';
import {t} from '@/i18n';

/**
 * Home (wireframe W-Home): what Sprint does, the tenants the user belongs to, and the four steps
 * of a project. One tenant for now: switching and creating tenants come with the tenant pages.
 */
export default function Home() {
  return (
    <HomeFrame>
      <div className="sp-page sp-home">
        <VStack gap={10}>
          <VStack gap={3} hAlign="center" className="sp-hero">
            <Heading level={1}>{t('Turn a labeling guide into a passing prompt')}</Heading>
            <Text type="body" color="secondary">
              {t('You bring what each label means and a few hundred labels from people. Sprint writes, scores and improves the prompt.')}
            </Text>
          </VStack>
          <Tenants />
          <VStack gap={4}>
            <Heading level={2}>{t('How a project goes')}</Heading>
            <Grid columns={{minWidth: 220, max: 4}} gap={3}>
              {NODES.map((n, i) => (
                <Card key={n.id} padding={5}>
                  <VStack gap={1}>
                    <Text type="supporting" color="secondary">
                      {t('Step {n}', {n: i + 1})}
                    </Text>
                    <Text type="label">{t(n.label)}</Text>
                    <Text type="body" color="secondary">
                      {t(STEP_LINES[n.id])}
                    </Text>
                  </VStack>
                </Card>
              ))}
            </Grid>
          </VStack>
        </VStack>
      </div>
    </HomeFrame>
  );
}

const STEP_LINES: Record<(typeof NODES)[number]['id'], string> = {
  prompt_design: 'Tell the AI helper what to label. It drafts the prompt.',
  dataset: 'Take a batch of examples from your data.',
  gold: 'People label the examples. These are the right answers.',
  prompt: 'See the score. Let the Optimiser improve the prompt until it passes.',
};

function Tenants() {
  const {info} = useRuntime();
  const tenant = info?.tenant;
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    listProjects().then(
      list => live && setCount(list.length),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  if (!tenant) return null;
  return (
    <VStack gap={4}>
      <Heading level={2}>{t('Your tenants')}</Heading>
      <Grid columns={{minWidth: 280, max: 3}} gap={3}>
        <ClickableCard label={tenant.name} href="/tenant/" padding={5}>
          <VStack gap={2}>
            <HStack gap={2} vAlign="center" hAlign="between">
              <Heading level={3}>{tenant.name}</Heading>
              <Badge label={tenant.role === 'admin' ? t('Admin') : t('Member')} />
            </HStack>
            <Text type="body" color="secondary">
              {count == null ? ' ' : count === 1 ? t('1 project') : t('{n} projects', {n: count})}
            </Text>
          </VStack>
        </ClickableCard>
      </Grid>
    </VStack>
  );
}
