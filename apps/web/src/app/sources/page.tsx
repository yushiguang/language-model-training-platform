'use client';

import {useState} from 'react';
import {ArrowUpTrayIcon, CircleStackIcon} from '@heroicons/react/24/outline';
import {TenantPage} from '@/components/Shell';
import {useRuntime} from '@/components/session';
import {tenantHref} from '@/components/ProjectContext';
import {useGo} from '@/components/nav';
import {DeleteDialog, RenameDialog, UploadDialog} from '@/components/sources/dialogs';
import {addedWhen, refuseSourceChange, sourceName, usedByText, useDataSources} from '@/components/sources';
import {getDataSource, type DataSourceSummary} from '@/backend-api';
import {Avatar, Button, Card, EmptyState, HStack, Icon, InfoTip, Link, MoreMenu, pixel, proportional, Spinner, Table, Text, VStack, type TableColumn} from '@/ui/astryx';
import {PageTitle} from '@/ui';
import {t} from '@/i18n';

/**
 * Data sources (wireframes v346: W-Sources, -Empty, -Reading, W-NoAccess-Source): the tenant's
 * data sources, one per uploaded file of sample IDs. Everyone reads them; only admins upload,
 * rename and delete (anyone else gets the access dialog). A new source shows "Reading…" while its
 * file is read, or "Can't read" with the reason on hover.
 */
export default function SourcesPage() {
  return <Sources />;
}

type Row = DataSourceSummary & Record<string, unknown>;
type Open = {kind: 'upload'} | {kind: 'rename'; source: DataSourceSummary} | {kind: 'delete'; source: DataSourceSummary; usedBy: string[]} | null;

function Sources() {
  const go = useGo();
  const {info} = useRuntime();
  const admin = info?.tenant?.role === 'admin';
  const [list, failed, load] = useDataSources();
  const [open, setOpen] = useState<Open>(null);
  const tenant = info?.tenant?.name ?? '';

  const upload = () => (admin ? setOpen({kind: 'upload'}) : refuseSourceChange('add'));
  const rename = (s: DataSourceSummary) => (admin ? setOpen({kind: 'rename', source: s}) : refuseSourceChange('change'));
  const remove = async (s: DataSourceSummary) => {
    if (!admin) return refuseSourceChange('change');
    const d = await getDataSource(s.id).catch(() => null);
    setOpen({kind: 'delete', source: s, usedBy: d?.usedByProjects.map(p => p.name) ?? []});
  };
  const uploadButton = <Button label={t('Upload file')} variant="primary" icon={<Icon icon={ArrowUpTrayIcon} size="sm" />} onClick={upload} />;
  const href = (s: DataSourceSummary) => `/source/?id=${encodeURIComponent(s.id)}`;

  const columns: TableColumn<Row>[] = [
    {
      key: 'name',
      header: t('Name'),
      width: proportional(3, {minWidth: 220}),
      renderCell: s => (
        <Link href={href(s)} className="sp-row-link">
          <Text type="body" weight="semibold" maxLines={1} color="inherit">
            {sourceName(s)}
          </Text>
        </Link>
      ),
    },
    {key: 'items', header: t('Sample IDs'), width: proportional(1.2, {minWidth: 110}), renderCell: s => <Items s={s} />},
    {
      key: 'usedBy',
      header: t('Used by'),
      width: proportional(1.2, {minWidth: 100}),
      renderCell: s => (usedByText(s.usedBy) ? <Text type="body">{usedByText(s.usedBy)}</Text> : <Text color="secondary">—</Text>),
    },
    {
      key: 'createdBy',
      header: t('Added by'),
      width: proportional(1.6, {minWidth: 140}),
      renderCell: s => (
        <HStack gap={2} vAlign="center">
          <Avatar name={s.builtIn ? 'Sprint' : s.createdBy} size="xsm" />
          <Text type="body" maxLines={1}>
            {s.builtIn ? 'Sprint' : s.createdBy}
          </Text>
        </HStack>
      ),
    },
    {
      key: 'createdAt',
      header: t('Added on'),
      width: proportional(1.4, {minWidth: 120}),
      renderCell: s => (
        <Text type="body" color="secondary">
          {addedWhen(s.createdAt)}
        </Text>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: pixel(56),
      renderCell: s => (
        <span className="sp-row-actions">
          <MoreMenu
            label={t('Data source actions')}
            size="sm"
            alignment="end"
            items={[
              {label: t('Open'), onClick: () => void go(href(s))},
              ...(s.builtIn ? [] : [{label: t('Rename'), onClick: () => rename(s)}, {label: t('Delete'), onClick: () => void remove(s)}]),
            ]}
          />
        </span>
      ),
    },
  ];

  return (
    <TenantPage
      head={
        <PageTitle
          title={t('Data sources')}
          subtitle={t('Each file you upload is one data source: a list of sample IDs. Everyone can read them.')}
          back={{label: tenant || t('Projects'), href: tenantHref()}}
          actions={list && list.length > 0 ? uploadButton : undefined}
        />
      }
    >
      {failed ? (
        <Card padding={6}>
          <VStack gap={3}>
            <Text type="body" className="sp-error">
              {failed}
            </Text>
            <HStack>
              <Button label={t('Retry')} variant="secondary" onClick={() => void load()} />
            </HStack>
          </VStack>
        </Card>
      ) : !list ? (
        <HStack hAlign="center" paddingBlock={10}>
          <Spinner label={t('Loading data sources')} />
        </HStack>
      ) : list.length === 0 ? (
        <Card padding={10}>
          <EmptyState title={t('No data sources yet')} description={t('Upload a CSV or JSONL file with one sample ID per row.')} icon={<Icon icon={CircleStackIcon} size="lg" color="secondary" />} actions={uploadButton} />
        </Card>
      ) : (
        <div className="sp-rows">
          <Table<Row> data={list as Row[]} columns={columns} idKey="id" hasHover />
        </div>
      )}
      {open?.kind === 'upload' && <UploadDialog onClose={() => setOpen(null)} />}
      {open?.kind === 'rename' && <RenameDialog source={open.source} onClose={() => setOpen(null)} />}
      {open?.kind === 'delete' && <DeleteDialog source={open.source} usedBy={open.usedBy} onClose={() => setOpen(null)} />}
    </TenantPage>
  );
}

/** The Sample IDs cell: the count, "Reading…" while the file is read, or "Can't read" with why on hover. */
function Items({s}: {s: DataSourceSummary}) {
  if (s.state === 'reading')
    return (
      <HStack gap={2} vAlign="center">
        <Spinner size="sm" />
        <Text type="body">{t('Reading…')}</Text>
      </HStack>
    );
  if (s.state === 'failed')
    return (
      <HStack gap={1} vAlign="center">
        <Text type="body" color="inherit" className="sp-error">
          {t("Can't read")}
        </Text>
        <InfoTip content={s.error ? t(s.error) : t('The file could not be read. Fix it and upload it again.')} />
      </HStack>
    );
  return (
    <Text type="body" hasTabularNumbers>
      {s.items.toLocaleString('en-US')}
    </Text>
  );
}
