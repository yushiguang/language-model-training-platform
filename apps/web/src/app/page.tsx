'use client';

import {useEffect, useMemo, useState} from 'react';
import {Avatar, Badge, Button, Card, ClickableCard, Grid, Heading, HStack, Icon, IconButton, Text, TextInput, Typeahead, VStack, type SearchableItem, type SearchSource} from '@/ui/astryx';
import {ArrowRightIcon} from '@heroicons/react/20/solid';
import {MagnifyingGlassIcon, UserPlusIcon, XMarkIcon} from '@heroicons/react/24/outline';
import type {Msg, Person} from '@yushiguang/sprint-contracts';
import {NODES} from '@yushiguang/sprint-domain';
import {createTenant, listTenants, rememberTenant, searchPeople, type TenantSummary} from '@/backend-api';
import {HomeFrame} from '@/components/Shell';
import {FormDialog} from '@/components/shell/dialogs';
import {tenantHref} from '@/components/ProjectContext';
import {useGo} from '@/components/nav';
import {forgetRuntime, useRuntime} from '@/components/session';
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

type PersonItem = SearchableItem<Person>;

/** Create a tenant (W-Home-Create): the name, plus initial co-admins when deployment policy requires them. */
function CreateTenant({onClose}: {onClose: () => void}) {
  const go = useGo();
  const {info} = useRuntime();
  const minAdmins = Math.min(50, Math.max(1, Math.floor(info?.minTenantAdmins ?? 1)));
  const extraNeeded = Math.max(0, minAdmins - 1);
  const [name, setName] = useState('');
  const [coAdmins, setCoAdmins] = useState<Person[]>([]);
  const [picked, setPicked] = useState<PersonItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);

  const excluded = useMemo(() => {
    const s = new Set(coAdmins.map(p => p.id));
    if (info?.user.id) s.add(info.user.id);
    return s;
  }, [coAdmins, info?.user.id]);
  const source = useMemo<SearchSource<PersonItem>>(
    () => ({
      search: async q => (await searchPeople({query: q})).filter(p => !excluded.has(p.id)).map(p => ({id: p.id, label: p.name, auxiliaryData: p})),
      bootstrap: () => [],
    }),
    [excluded],
  );
  const addAdmin = () => {
    const p = picked?.auxiliaryData;
    if (!p) return;
    setCoAdmins(a => (a.some(x => x.id === p.id) ? a : [...a, p]));
    setPicked(null);
    setAdminError(null);
  };
  const create = async () => {
    if (!name.trim()) return setError('Enter a name. Spaces alone are not a name.');
    if (extraNeeded > 0 && coAdmins.length < extraNeeded) {
      return setAdminError(extraNeeded === 1 ? {key: 'Pick at least one other admin.'} : {key: 'Pick at least {n} other admins.', params: {n: extraNeeded}});
    }
    setBusy(true);
    try {
      const r = await createTenant({name, ...(coAdmins.length ? {adminIds: coAdmins.map(p => p.id)} : {})});
      if (!r.tenant) {
        if (r.error && /^Pick at least /.test(r.error)) {
          return setAdminError(extraNeeded === 1 ? {key: 'Pick at least one other admin.'} : {key: 'Pick at least {n} other admins.', params: {n: extraNeeded}});
        }
        return setError(r.error ?? 'The tenant could not be created. Try again.');
      }
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
        <VStack gap={4}>
          <TextInput
            label={t('Tenant name')}
            placeholder={t('For example: Content Safety')}
            value={name}
            onChange={v => (setName(v), setError(null))}
            hasAutoFocus
            status={error ? {type: 'error', message: t(error)} : undefined}
          />
          {extraNeeded > 0 && (
            <VStack gap={3}>
              <VStack gap={1}>
                <HStack gap={2} vAlign="end">
                  <div style={{flex: 1, minWidth: 0}}>
                    <Typeahead<PersonItem>
                      label={extraNeeded === 1 ? t('Additional admin') : t('Additional admins')}
                      placeholder={t('Search by name or email')}
                      startIcon={MagnifyingGlassIcon}
                      searchSource={source}
                      value={picked}
                      onChange={v => (setPicked(v), setAdminError(null))}
                      renderItem={p => (
                        <HStack gap={2} vAlign="center">
                          <Avatar name={p.label} size="xsm" />
                          <VStack gap={0}>
                            <Text type="body">{p.label}</Text>
                            {p.auxiliaryData?.email && (
                              <Text type="supporting" color="secondary">
                                {p.auxiliaryData.email}
                              </Text>
                            )}
                          </VStack>
                        </HStack>
                      )}
                      emptySearchText={t('Nobody found.')}
                    />
                  </div>
                  <Button label={t('Add')} variant="secondary" icon={<Icon icon={UserPlusIcon} size="sm" />} isDisabled={!picked || busy} onClick={addAdmin} />
                </HStack>
                <Text type="supporting" color="secondary">
                  {extraNeeded === 1 ? t('You are the first admin. Pick at least 1 other person as an admin.') : t('You are the first admin. Pick at least {n} other people as admins.', {n: extraNeeded})}
                </Text>
              </VStack>
              {coAdmins.length > 0 && (
                <VStack gap={2}>
                  {coAdmins.map(p => (
                    <HStack key={p.id} gap={2} vAlign="center" hAlign="between">
                      <HStack gap={2} vAlign="center">
                        <Avatar name={p.name} size="xsm" />
                        <VStack gap={0}>
                          <Text type="label">{p.name}</Text>
                          {p.email && (
                            <Text type="supporting" color="secondary">
                              {p.email}
                            </Text>
                          )}
                        </VStack>
                      </HStack>
                      <IconButton
                        label={t('Remove {name}', {name: p.name})}
                        variant="ghost"
                        size="sm"
                        icon={<Icon icon={XMarkIcon} size="sm" />}
                        onClick={() => setCoAdmins(a => a.filter(x => x.id !== p.id))}
                      />
                    </HStack>
                  ))}
                </VStack>
              )}
              {adminError && (
                <Text type="supporting" className="sp-error" role="alert">
                  {t(adminError.key, adminError.params)}
                </Text>
              )}
            </VStack>
          )}
        </VStack>
      </form>
    </FormDialog>
  );
}
