'use client';

import {useEffect, useState} from 'react';
import {Badge, Button, Card, ClickableCard, Grid, Heading, HStack, Icon, Text, TextInput, VStack} from '@/ui/astryx';
import {ArrowRightIcon} from '@heroicons/react/20/solid';
import {NODES} from '@yushiguang/sprint-domain';
import {createTenant, listTenants, rememberTenant, type TenantSummary} from '@/backend-api';
import {HomeFrame} from '@/components/Shell';
import {FormDialog} from '@/components/shell/dialogs';
import {tenantHref} from '@/components/ProjectContext';
import {useGo} from '@/components/nav';
import {forgetRuntime} from '@/components/session';
import {t} from '@/i18n';

/**
 * Home (wireframes W-Home, W-Home-Empty, W-Home-Create*): what Sprint does, the tenants the user
 * is in (#94), and the four steps of a project. Anyone signed in may create a tenant and becomes
 * its admin; a blank or taken name is shown under the name field.
 */
export default function Home() {
  const [creating, setCreating] = useState(false);
  return (
    <HomeFrame>
      <div className="sp-page sp-home">
        <VStack gap={10}>
          <VStack gap={6} hAlign="center" className="sp-hero">
            <VStack gap={3} hAlign="center">
              <Heading level={1}>{t('Turn a labeling guide into a passing prompt')}</Heading>
              <Text type="body" color="secondary">
                {t('You bring what each label means and a few hundred labels from people. Sprint writes, scores and improves the prompt.')}
              </Text>
            </VStack>
            <HStack gap={3}>
              <Button label={t('Create a tenant')} variant="primary" endContent={<Icon icon={ArrowRightIcon} size="sm" color="inherit" />} onClick={() => setCreating(true)} />
              <Button label={t('How it works')} variant="secondary" onClick={() => document.getElementById('how')?.scrollIntoView({behavior: 'smooth', block: 'start'})} />
            </HStack>
          </VStack>
          <Tenants />
          <VStack gap={4}>
            <span id="how" className="sp-anchor">
              <Heading level={2}>{t('How a project goes')}</Heading>
            </span>
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
      {creating && <CreateTenant onClose={() => setCreating(false)} />}
    </HomeFrame>
  );
}

const STEP_LINES: Record<(typeof NODES)[number]['id'], string> = {
  prompt_design: 'Tell the AI helper what to label. It drafts the prompt.',
  dataset: 'Take a batch of examples from your data.',
  gold: 'People label the examples. These are the right answers.',
  prompt: 'See the score. Let the Optimiser improve the prompt until it passes.',
};

/** The tenants the user is in, by name; one line when there are none yet. */
function Tenants() {
  const [list, setList] = useState<TenantSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    listTenants().then(
      l => live && setList(l),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [tries]);
  if (failed)
    return (
      <HStack gap={3} vAlign="center">
        <Text type="body" color="secondary">
          {t('Your tenants could not load.')}
        </Text>
        <Button label={t('Retry')} variant="secondary" size="sm" onClick={() => setTries(n => n + 1)} />
      </HStack>
    );
  if (!list) return null;
  if (!list.length)
    return (
      <Text type="body" color="secondary">
        {t('You are not in a tenant yet. Create one, or ask a tenant admin to add you.')}
      </Text>
    );
  return (
    <VStack gap={4}>
      <Heading level={2}>{t('Your tenants')}</Heading>
      <Grid columns={{minWidth: 280, max: 3}} gap={3}>
        {list.map(tn => (
          <ClickableCard key={tn.id} label={t('Open {name}', {name: tn.name})} href={tenantHref('/tenant/', tn.id)} padding={5}>
            <VStack gap={2}>
              <HStack gap={2} vAlign="center" hAlign="between">
                <span className="sp-one" title={tn.name}>
                  <Heading level={3}>{tn.name}</Heading>
                </span>
                <Badge label={tn.role === 'admin' ? t('Admin') : t('Member')} />
              </HStack>
              <Text type="body" color="secondary">
                {tn.projects === 1 ? t('1 project') : t('{n} projects', {n: tn.projects})}
              </Text>
            </VStack>
          </ClickableCard>
        ))}
      </Grid>
    </VStack>
  );
}

/** Create a tenant (W-Home-Create): the name only; the new tenant opens on its tenant page. */
function CreateTenant({onClose}: {onClose: () => void}) {
  const go = useGo();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (!name.trim()) return setError('Enter a name. Spaces alone are not a name.');
    setBusy(true);
    try {
      const r = await createTenant({name});
      if (!r.tenant) return setError(r.error ?? 'The tenant could not be created. Try again.');
      rememberTenant(r.tenant.id);
      forgetRuntime();
      await go(tenantHref('/tenant/', r.tenant.id));
    } catch (e) {
      setError((e as Error).message || 'The tenant could not be created. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      title={t('Create a tenant')}
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={t('Create')} variant="primary" isDisabled={!!error} isLoading={busy} onClick={() => void create()} />
        </>
      }
    >
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!error && !busy) void create();
        }}
      >
        <TextInput
          label={t('Tenant name')}
          placeholder={t('For example: Content Safety')}
          value={name}
          onChange={v => (setName(v), setError(null))}
          hasAutoFocus
          status={error ? {type: 'error', message: t(error)} : undefined}
        />
      </form>
    </FormDialog>
  );
}
