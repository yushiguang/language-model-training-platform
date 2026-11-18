'use client';

import Link from 'next/link';
import {useState} from 'react';
import {TenantIsland} from '@/components/Shell';
import {SignedIn} from '@/components/session';
import {useGo} from '@/components/nav';
import {createDataSourceFile, type DataSourceSummary} from '@/backend-api';
import {SOURCE_ACCEPT, sourceHint, useDataSources} from '@/components/sources';
import {Badge, Banner, Button, Card, dateTime, Field, FileInput, Icon, num, One, PageHead, Progress, Table} from '@/ui';
import {t} from '@/i18n';

/**
 * Data Source (#29; design: V-Sources): the tenant's files of item ids, shared by its projects.
 * The list on the left, a new data source (a name and its first file) on the right. A source
 * being imported shows its progress in the Items column.
 */
export default function SourcesPage() {
  return (
    <SignedIn>
      <Sources />
    </SignedIn>
  );
}

/** Data source, Files, Items, Not used, Created by, Updated (the card is 706 wide). */
const WIDTHS: (number | 'auto')[] = ['auto', 64, 120, 96, 110, 140];

function Sources() {
  const [list, failed, load] = useDataSources();
  return (
    <div className="k app b">
      <div className="b-body">
        <main className="b-main">
          <TenantIsland current="sources" />
          <div className="b-head">
            <div className="container">
              <PageHead title={t('Data Source')} />
            </div>
          </div>
          <div className="container">
            <div className="row" style={{gap: 32, alignItems: 'flex-start'}}>
              <Card title={t('Data sources')} style={{width: 706, flex: 'none'}}>
                {failed ? (
                  <Banner tone="err" text={failed} style={{margin: 0}} action={<Button label={t('Retry')} size="sm" onClick={load} />} />
                ) : (
                  <SourceTable list={list} />
                )}
              </Card>
              <NewSource />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function SourceTable({list}: {list: DataSourceSummary[] | null}) {
  const cols = [{label: t('Data source')}, {label: t('Files')}, {label: t('Items')}, {label: t('Not used')}, {label: t('Created by')}, {label: t('Updated')}];
  if (!list)
    return (
      <Table
        cols={cols}
        widths={WIDTHS}
        rows={[160, 120, 180].map((w, i) => ({key: String(i), cells: [<span key="a" className="skel" style={{width: w}} />, null, <span key="c" className="skel" style={{width: 60}} />, null, null, null]}))}
      />
    );
  return (
    <Table
      cols={cols}
      widths={WIDTHS}
      rows={list.map(s => ({
        key: s.id,
        cells: [
          <span key="n" className="row" style={{gap: 8, minWidth: 0}}>
            <Link className="one" href={`/source/?id=${encodeURIComponent(s.id)}`} title={s.name}>
              {s.builtIn ? t(s.name) : s.name}
            </Link>
            {s.builtIn && <Badge text={t('Built in')} icon={false} />}
          </span>,
          num(s.files),
          s.importing ? <Progress key="p" done={s.importing.done} total={s.importing.total} /> : num(s.items),
          s.importing ? '—' : num(s.notUsed),
          <One key="b" text={s.builtIn ? 'Sprint' : s.createdBy} />,
          <span key="u" className="t-3">
            {dateTime(s.updatedAt)}
          </span>,
        ],
      }))}
    />
  );
}

/** A new data source: its name and its first file. It opens on its own page once created. */
function NewSource() {
  const go = useGo();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    if (!file) return;
    setErr(null);
    const res = await createDataSourceFile(name, file);
    if (res.error || !res.source) return setErr(res.error ?? 'Something went wrong. Try again.');
    await go(`/source/?id=${encodeURIComponent(res.source.id)}`);
  };
  return (
    <Card title={t('New data source')} className="form" style={{width: 542, flex: 'none'}}>
      <Field label={t('Name')}>
        <input className="input" value={name} placeholder={t('Weekly feed sample')} onChange={e => setName(e.target.value)} />
      </Field>
      <FileInput label={t('File')} hint={sourceHint()} accept={SOURCE_ACCEPT} file={file} onFile={f => (setErr(null), setFile(f))} />
      {err && (
        <p className="t-err" style={{margin: 0}} role="alert">
          <Icon name="alert" /> {t(err)}
        </p>
      )}
      <div className="row" style={{justifyContent: 'flex-end'}}>
        <Button label={t('Create data source')} kind="primary" disabled={!name.trim() || !file} onClick={create} />
      </div>
    </Card>
  );
}
