'use client';

import {useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useState} from 'react';
import {CalendarIcon} from '@heroicons/react/24/outline';
import {TenantPage} from '@/components/Shell';
import {useRuntime} from '@/components/session';
import {useGo} from '@/components/nav';
import {WithSide, SectionTitle} from '@/components/shell/Page';
import {hrefFor} from '@/components/ProjectContext';
import {DeleteDialog, ErrorLine, RenameDialog} from '@/components/sources/dialogs';
import {fileKind, refuseSourceChange, shortDate, sourceName} from '@/components/sources';
import {getDataSource, subscribeChanges, type DataSourceDetail} from '@/backend-api';
import {Avatar, Button, Card, Divider, Grid, Heading, HStack, Icon, Link, MetadataList, MetadataListItem, MoreMenu, Spinner, Text, Token, VStack} from '@/ui/astryx';
import {PageTitle} from '@/ui';
import {t} from '@/i18n';

/**
 * One data source (wireframes v346: W-Source, W-Source-Delete): one uploaded file of sample IDs.
 * Its counts (sample IDs, repeats kept once, rows without an ID), the projects that use it, its
 * file, and who can change it. Admins rename and delete it; anyone else gets the access dialog.
 */
export default function SourcePage() {
  return (
    <Suspense>
      <Source />
    </Suspense>
  );
}

function Source() {
  const id = useSearchParams().get('id') ?? '';
  const go = useGo();
  const {info} = useRuntime();
  const admin = info?.tenant?.role === 'admin';
  const [d, setD] = useState<DataSourceDetail | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<'rename' | 'delete' | null>(null);
  const load = async () => {
    try {
      setD(await getDataSource(id));
      setFailed(null);
    } catch (e) {
      setFailed(t('This data source could not load: {why}', {why: t((e as Error).message || 'the service did not answer')}));
    }
  };
  useEffect(() => {
    void load();
    return subscribeChanges(() => void load());
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = {label: t('Data sources'), href: '/sources/'};
  const s = d?.source;
  const change = (what: 'rename' | 'delete') => (admin ? setOpen(what) : refuseSourceChange('change'));
  const actions =
    s && !s.builtIn ? (
      <>
        <Button label={t('Rename')} variant="secondary" onClick={() => change('rename')} />
        <MoreMenu label={t('More actions')} alignment="end" items={[{label: t('Delete data source'), onClick: () => change('delete')}]} />
      </>
    ) : undefined;

  return (
    <TenantPage head={<PageTitle title={s ? sourceName(s) : t('Data source')} back={back} subtitle={s ? <Byline d={d!} /> : undefined} actions={actions} />}>
      {failed ? (
        <Card padding={6}>
          <VStack gap={3}>
            <ErrorLine text={failed} />
            <HStack>
              <Button label={t('Retry')} variant="secondary" onClick={() => void load()} />
            </HStack>
          </VStack>
        </Card>
      ) : d === null ? (
        <Card padding={6}>
          <Text type="body">{t('This data source does not exist.')}</Text>
        </Card>
      ) : !d ? (
        <HStack hAlign="center" paddingBlock={10}>
          <Spinner label={t('Loading')} />
        </HStack>
      ) : (
        <WithSide sideWidth={300} side={<Side d={d} />}>
          <VStack gap={4}>
            <SectionTitle title={t('Sample IDs')} />
            <Counts d={d} />
          </VStack>
        </WithSide>
      )}
      {s && open === 'rename' && <RenameDialog source={s} onClose={() => setOpen(null)} />}
      {s && open === 'delete' && <DeleteDialog source={s} usedBy={d!.usedByProjects.map(p => p.name)} onClose={() => setOpen(null)} onDeleted={() => void go('/sources/')} />}
    </TenantPage>
  );
}

/** "CSV · 6,500 sample IDs · (avatar) Mei Wang · (calendar) Nov 15, 2026". */
function Byline({d}: {d: DataSourceDetail}) {
  const s = d.source;
  const who = s.builtIn ? 'Sprint' : s.createdBy;
  const what = s.state === 'ready' ? t('{kind} · {n} sample IDs', {kind: fileKind(s.fileName), n: s.items.toLocaleString('en-US')}) : fileKind(s.fileName);
  const dot = (
    <Text type="supporting" color="secondary">
      ·
    </Text>
  );
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Text type="body">{what}</Text>
      {dot}
      <HStack gap={1.5} vAlign="center">
        <Avatar name={who} size="sm" />
        <Text type="body">{who}</Text>
      </HStack>
      {dot}
      <HStack gap={1.5} vAlign="center">
        <Icon icon={CalendarIcon} size="sm" color="secondary" />
        <Text type="body">{shortDate(s.createdAt)}</Text>
      </HStack>
    </HStack>
  );
}

/** The file's counts in one card; while it is read, a spinner; when it could not be read, why. */
function Counts({d}: {d: DataSourceDetail}) {
  const s = d.source;
  if (s.state === 'reading')
    return (
      <Card padding={6}>
        <HStack gap={2} vAlign="center">
          <Spinner size="sm" />
          <Text type="body">{t('Reading the file…')}</Text>
        </HStack>
      </Card>
    );
  if (s.state === 'failed')
    return (
      <Card padding={6}>
        <VStack gap={2}>
          <ErrorLine text={t("Can't read this file.")} />
          <Text type="body" color="secondary">
            {s.error ? t(s.error) : t('Fix the file and upload it again.')}
          </Text>
        </VStack>
      </Card>
    );
  const repeats = d.files.reduce((n, f) => n + f.repeats, 0);
  const bad = d.files.reduce((n, f) => n + f.bad, 0);
  return (
    <Card padding={6}>
      <Grid columns={3} gap={6}>
        <Count label={t('Sample IDs')} value={s.items} />
        <Count label={t('Repeated, kept once')} value={repeats} />
        <Count label={t('Rows without an ID')} value={bad} />
      </Grid>
    </Card>
  );
}

function Count({label, value}: {label: string; value: number}) {
  return (
    <VStack gap={1}>
      <Text type="body" color="secondary">
        {label}
      </Text>
      <Text type="display-3" hasTabularNumbers>
        {value.toLocaleString('en-US')}
      </Text>
    </VStack>
  );
}

/** Used by, the file, and who can change it. */
function Side({d}: {d: DataSourceDetail}) {
  return (
    <Card padding={5}>
      <VStack gap={5}>
        <VStack gap={2}>
          <Heading level={4}>{t('Used by')}</Heading>
          {d.usedByProjects.length ? (
            d.usedByProjects.map(p => (
              <Link key={p.id} href={hrefFor(p.id, '/overview')}>
                {p.name}
              </Link>
            ))
          ) : (
            <Text type="body" color="secondary">
              {t('No project yet')}
            </Text>
          )}
        </VStack>
        <Divider />
        <VStack gap={2}>
          <Heading level={4}>{t('File')}</Heading>
          <MetadataList>
            <MetadataListItem label={t('Name')}>
              <Text type="body" maxLines={1}>
                {d.source.fileName}
              </Text>
            </MetadataListItem>
          </MetadataList>
        </VStack>
        <Divider />
        <VStack gap={2}>
          <Heading level={4}>{t('Who can change it')}</Heading>
          <HStack gap={1} wrap="wrap">
            <Token size="sm" label={d.source.builtIn ? t('Nobody: it ships with Sprint') : t('Admins')} />
          </HStack>
        </VStack>
      </VStack>
    </Card>
  );
}
