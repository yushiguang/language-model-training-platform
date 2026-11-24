'use client';

import {useCallback, useEffect, useState, type ReactNode} from 'react';
import {Cog6ToothIcon, CircleStackIcon, CpuChipIcon, ExclamationTriangleIcon, FolderPlusIcon, PlusIcon, UsersIcon} from '@heroicons/react/24/outline';
import {NODES} from '@yushiguang/sprint-domain';
import {deleteProject, getTenant, listProjectRows, newProject, projectDefaults, type NewProjectThresholds, type ProjectDefaults, type ProjectRow, type TenantDetail} from '@/backend-api';
import {TenantPage} from '@/components/Shell';
import {FormDialog} from '@/components/shell/dialogs';
import {ErrorLine} from '@/components/sources/dialogs';
import {addedWhen} from '@/components/sources';
import {hrefFor, tenantHref} from '@/components/ProjectContext';
import {ThresholdFields} from '@/components/thresholds';
import {TenantSettings, type TenantSettingsTab} from '@/components/TenantSettings';
import {useGo} from '@/components/nav';
import {useRuntime} from '@/components/session';
import {Avatar, Badge, Button, Card, ClickableCard, EmptyState, Grid, Heading, HStack, Icon, Link, MoreMenu, Pagination, pixel, proportional, SegmentedControl, SegmentedControlItem, Selector, Spinner, Table, Text, TextInput, VStack, type TableColumn} from '@/ui/astryx';
import {isAccessDenied, PageTitle, reportAccessDenied} from '@/ui';
import {t} from '@/i18n';

/**
 * The tenant page (wireframes v346: W-Projects, -Empty, -Create, -Delete; #103): the tenant's
 * projects with the step each is at, its best score, its running tasks and its last change, All or
 * only the caller's, 10 a page; New project; and for admins the Admin cards (data sources, models,
 * members, tenant settings). Delete asks for the project's exact name first.
 */
export default function Tenant() {
  return <TenantView />;
}

const PAGE_SIZE = 10;
type Row = ProjectRow & Record<string, unknown>;

function TenantView() {
  const {info} = useRuntime();
  const admin = info?.tenant?.role === 'admin';
  const name = info?.tenant?.name ?? '';
  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [defaults, setDefaults] = useState<ProjectDefaults | null>(null);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState<TenantSettingsTab | null>(null);
  // Bumped after a delete: the counts and the rows read again.
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    let live = true;
    getTenant().then(
      d => live && setTenant(d),
      () => undefined,
    );
    projectDefaults().then(
      d => live && setDefaults(d),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [changed]);
  const newButton = <Button label={t('New project')} variant="primary" icon={<Icon icon={PlusIcon} size="sm" />} onClick={() => setCreating(true)} />;

  return (
    <TenantPage head={<PageTitle title={name} subtitle={t('Everyone in {tenant} can open these projects.', {tenant: name})} />}>
      <VStack gap={10}>
        <Projects newButton={newButton} empty={tenant ? tenant.projects === 0 : null} onDeleted={() => setChanged(n => n + 1)} changed={changed} />
        {admin && tenant && <AdminCards tenant={tenant} noModels={!!defaults && defaults.models.length === 0} onOpen={setSettings} />}
      </VStack>
      {creating && <NewProject defaults={defaults} onClose={() => setCreating(false)} />}
      {settings && tenant && <TenantSettings tenant={tenant} me={info?.user.id} tab={settings} onClose={() => setSettings(null)} onChanged={() => setChanged(n => n + 1)} />}
    </TenantPage>
  );
}

function Projects({newButton, empty, changed, onDeleted}: {newButton: ReactNode; empty: boolean | null; changed: number; onDeleted: () => void}) {
  const go = useGo();
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{rows: ProjectRow[]; total: number} | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<ProjectRow | null>(null);
  const [tries, setTries] = useState(0);

  const load = useCallback(async () => {
    setFailed(null);
    try {
      const got = await listProjectRows({mine, offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE});
      // A delete emptied the last page: show the one before.
      if (!got.rows.length && page > 1) return setPage(page - 1);
      setData(got);
    } catch (e) {
      setFailed(t('Projects could not load: {why}', {why: t((e as Error).message || 'the service did not answer')}));
    }
  }, [mine, page]);
  useEffect(() => {
    void load();
  }, [load, changed, tries]);

  const columns: TableColumn<Row>[] = [
    {
      key: 'name',
      header: t('Project'),
      width: proportional(3, {minWidth: 220}),
      renderCell: p => (
        <Link href={hrefFor(p.id, '/overview')} className="sp-row-link">
          <Text type="body" weight="semibold" maxLines={1} color="inherit">
            {p.name}
          </Text>
        </Link>
      ),
    },
    {key: 'step', header: t('Current step'), width: proportional(1.3, {minWidth: 120}), renderCell: p => <Text type="body">{t(NODES.find(n => n.id === p.step)?.label ?? '')}</Text>},
    {key: 'best', header: t('Best score'), width: proportional(1.3, {minWidth: 130}), renderCell: p => <Score best={p.best} />},
    {key: 'running', header: t('Running'), width: proportional(1.1, {minWidth: 100}), renderCell: p => <Running n={p.running} />},
    {
      key: 'createdBy',
      header: t('Created by'),
      width: proportional(1.5, {minWidth: 140}),
      renderCell: p => (
        <HStack gap={2} vAlign="center">
          <Avatar name={p.createdBy} size="xsm" />
          <Text type="body" maxLines={1}>
            {p.createdBy}
          </Text>
        </HStack>
      ),
    },
    {
      key: 'updatedAt',
      header: t('Updated'),
      width: proportional(1.2, {minWidth: 110}),
      renderCell: p => (
        <Text type="body" color="secondary">
          {addedWhen(p.updatedAt)}
        </Text>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: pixel(56),
      renderCell: p => (
        <span className="sp-row-actions">
          <MoreMenu
            label={t('Project actions')}
            size="sm"
            items={[
              {label: t('Open'), onClick: () => void go(hrefFor(p.id, '/overview'))},
              {label: t('Delete project'), onClick: () => setDoomed(p)},
            ]}
          />
        </span>
      ),
    },
  ];

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap">
        <HStack gap={4} vAlign="center">
          <Heading level={2}>{t('Projects')}</Heading>
          {empty === false && (
            <SegmentedControl label={t('Show projects')} value={mine ? 'mine' : 'all'} onChange={v => (setMine(v === 'mine'), setPage(1))}>
              <SegmentedControlItem value="all" label={t('All')} />
              <SegmentedControlItem value="mine" label={t('Created by me')} />
            </SegmentedControl>
          )}
        </HStack>
        {empty === false && newButton}
      </HStack>
      {failed ? (
        <Card padding={6}>
          <VStack gap={3}>
            <Text type="body" className="sp-error">
              {failed}
            </Text>
            <HStack>
              <Button label={t('Retry')} variant="secondary" onClick={() => setTries(n => n + 1)} />
            </HStack>
          </VStack>
        </Card>
      ) : !data || empty === null ? (
        <HStack hAlign="center" paddingBlock={10}>
          <Spinner label={t('Loading projects')} />
        </HStack>
      ) : empty ? (
        <Card padding={10}>
          <EmptyState title={t('No projects yet')} description={t('A project turns a labeling guide into a prompt that passes.')} icon={<Icon icon={FolderPlusIcon} size="lg" color="secondary" />} actions={newButton} />
        </Card>
      ) : data.total === 0 ? (
        <Card padding={10}>
          <EmptyState title={t('You have not created a project yet')} description={t('Projects others created are under All.')} />
        </Card>
      ) : (
        <VStack gap={4}>
          <div className="sp-rows">
            <Table<Row> data={data.rows as Row[]} columns={columns} idKey="id" hasHover />
          </div>
          {pages > 1 && (
            <HStack hAlign="end">
              <Pagination page={page} totalPages={pages} onChange={setPage} />
            </HStack>
          )}
        </VStack>
      )}
      {doomed && (
        <DeleteProject
          project={doomed}
          onClose={() => setDoomed(null)}
          onDeleted={() => {
            setDoomed(null);
            onDeleted();
          }}
        />
      )}
    </VStack>
  );
}

/** "81.4%" with Passed or Below; a score on too few gold labels says it is a rough reading. */
function Score({best}: {best: ProjectRow['best']}) {
  if (!best) return <Text color="secondary">—</Text>;
  return (
    <HStack gap={2} vAlign="center">
      <Text type="body" hasTabularNumbers>
        {(best.macroF1 * 100).toFixed(1)}%
      </Text>
      {best.rough ? <Badge variant="neutral" label={t('Rough reading')} /> : best.passed ? <Badge variant="success" label={t('Passed')} /> : <Badge variant="warning" label={t('Below')} />}
    </HStack>
  );
}

function Running({n}: {n: number}) {
  if (!n) return <Text color="secondary">—</Text>;
  return (
    <HStack gap={2} vAlign="center">
      <Spinner size="sm" />
      <Text type="body">{n === 1 ? t('1 task') : t('{n} tasks', {n})}</Text>
    </HStack>
  );
}

/** Delete a project (W-Projects-Delete): its exact name typed first. Without edit access, the access dialog. */
function DeleteProject({project, onClose, onDeleted}: {project: ProjectRow; onClose: () => void; onDeleted: () => void}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await deleteProject({projectId: project.id});
      onDeleted();
    } catch (e) {
      if (isAccessDenied(e)) {
        onClose();
        return reportAccessDenied(e.permission, undefined, {id: project.id, name: project.name});
      }
      const msg = e instanceof Error ? e.message : '';
      setError(/^[A-Z][^{}<>\n]{0,160}\.$/.test(msg) ? t(msg) : t('Check your connection and try again.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      title={t('Delete {name}?', {name: project.name})}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={t('Delete project')} variant="destructive" isDisabled={typed !== project.name} isLoading={busy} onClick={() => void remove()} />
        </>
      }
    >
      <VStack gap={5}>
        <Text type="body" color="secondary">
          {t('Its prompt versions, datasets, label sets and scores are removed. Data sources stay. This cannot be undone.')}
        </Text>
        <TextInput label={t('Type the project name to confirm')} value={typed} onChange={setTyped} />
        {error && <ErrorLine text={error} />}
      </VStack>
    </FormDialog>
  );
}

/**
 * New project (W-Projects-Create): a name, the labeling model (the tenant's default first) and the
 * three thresholds, saved as the project's settings. The project opens on Prompt Design.
 */
function NewProject({defaults, onClose}: {defaults: ProjectDefaults | null; onClose: () => void}) {
  const go = useGo();
  const [name, setName] = useState('');
  const [model, setModel] = useState<string | null>(defaults?.model ?? null);
  const [thresholds, setThresholds] = useState<NewProjectThresholds | null>(defaults?.thresholds ?? null);
  const [error, setError] = useState<{field: 'name' | 'form'; text: string} | null>(null);
  const [busy, setBusy] = useState(false);
  // The defaults may arrive after the dialog opened.
  useEffect(() => {
    if (!defaults) return;
    setModel(m => m ?? defaults.model);
    setThresholds(th => th ?? defaults.thresholds);
  }, [defaults]);

  const create = async () => {
    if (!name.trim()) return setError({field: 'name', text: t('Enter a name. Spaces alone are not a name.')});
    setBusy(true);
    try {
      const r = await newProject({name, ...(model ? {model} : {}), ...(thresholds ? {thresholds} : {})});
      if (!r.project) return setError({field: r.error?.startsWith('Enter a name') ? 'name' : 'form', text: t(r.error ?? 'The project could not be created. Try again.')});
      await go(hrefFor(r.project.id, '/prompt-design'));
    } catch (e) {
      if (isAccessDenied(e)) return (onClose(), reportAccessDenied(e.permission));
      const msg = e instanceof Error ? e.message : '';
      setError({field: 'form', text: /^[A-Z][^{}<>\n]{0,160}\.$/.test(msg) ? t(msg) : t('Check your connection and try again.')});
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      title={t('New project')}
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button label={t('Create')} variant="primary" isDisabled={error?.field === 'name' || !model} isLoading={busy} onClick={() => void create()} />
        </>
      }
    >
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!busy && error?.field !== 'name') void create();
        }}
      >
        <VStack gap={6}>
          <TextInput
            label={t('Name')}
            placeholder={t('For example: Video topic tagging')}
            value={name}
            onChange={v => (setName(v), setError(null))}
            hasAutoFocus
            status={error?.field === 'name' ? {type: 'error', message: error.text} : undefined}
          />
          <Selector
            label={t('Labeling model')}
            options={(defaults?.models ?? []).map(m => ({value: m.id, label: m.name}))}
            value={model ?? ''}
            onChange={v => (setModel(v), setError(null))}
            placeholder={defaults ? t('No models yet') : t('Loading')}
            isDisabled={!defaults?.models.length}
          />
          {thresholds && <ThresholdFields value={thresholds} onChange={th => (setThresholds(th), setError(null))} />}
          {error?.field === 'form' && <ErrorLine text={error.text} />}
        </VStack>
      </form>
    </FormDialog>
  );
}

/**
 * Admin (W-Projects): data sources open their page; models, members and tenant settings live in
 * the tenant settings dialog. A tenant with no data sources, or no model at all, says it needs them.
 */
function AdminCards({tenant, noModels, onOpen}: {tenant: TenantDetail; noModels: boolean; onOpen: (tab: TenantSettingsTab) => void}) {
  const cards: {key: string; title: string; icon: typeof UsersIcon; line: string; needed?: boolean; href?: string; tab?: TenantSettingsTab}[] = [
    {
      key: 'sources',
      title: t('Data sources'),
      icon: CircleStackIcon,
      line: tenant.dataSources ? (tenant.dataSources === 1 ? t('1 source') : t('{n} sources', {n: tenant.dataSources})) : t('No data sources yet'),
      needed: !tenant.dataSources,
      href: tenantHref('/sources/'),
    },
    {key: 'models', title: t('Models'), icon: CpuChipIcon, line: tenant.models ? (tenant.models === 1 ? t('1 model') : t('{n} models', {n: tenant.models})) : t('No models yet'), needed: noModels, tab: 'models'},
    ...(tenant.members != null ? [{key: 'members', title: t('Members'), icon: UsersIcon, line: tenant.members === 1 ? t('1 member') : t('{n} members', {n: tenant.members}), tab: 'members' as const}] : []),
    {key: 'settings', title: t('Tenant settings'), icon: Cog6ToothIcon, line: '', tab: 'general'},
  ];
  return (
    <VStack gap={4}>
      <Heading level={2}>{t('Admin')}</Heading>
      <Grid columns={{minWidth: 240, max: 4}} gap={3}>
        {cards.map(c => {
          const body = (
            <VStack gap={1}>
              <HStack gap={2} vAlign="center">
                <Icon icon={c.icon} size="sm" color="secondary" />
                <Heading level={4}>{c.title}</Heading>
                {c.needed && (
                  <span title={t('Needed before a project can run')} className="sp-needed">
                    <Icon icon={ExclamationTriangleIcon} size="sm" color="inherit" />
                  </span>
                )}
              </HStack>
              <div style={{minHeight: 20}}>
                <Text type="supporting" color="secondary">
                  {c.line}
                </Text>
              </div>
            </VStack>
          );
          // Models, members and tenant settings open the tenant settings dialog at their section (#111).
          return (
            <ClickableCard key={c.key} label={c.title} {...(c.href ? {href: c.href} : {onClick: () => onOpen(c.tab!)})} padding={5}>
              {body}
            </ClickableCard>
          );
        })}
      </Grid>
    </VStack>
  );
}
