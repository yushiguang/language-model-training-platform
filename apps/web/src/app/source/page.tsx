'use client';

import {useSearchParams} from 'next/navigation';
import {Suspense, useEffect, useState} from 'react';
import {TenantPage} from '@/components/Shell';
import {SignedIn} from '@/components/session';
import {SOURCE_ACCEPT, sourceHint, sourceName} from '@/components/sources';
import {addSourceFileFile, getDataSource, subscribeChanges, type DataSourceDetail, type SourceFile} from '@/backend-api';
import {Badge, Banner, Button, Card, dateTime, FileInput, Hov, Icon, Metric, Metrics, num, One, PageHead, Progress, Table} from '@/ui';
import {t} from '@/i18n';

/**
 * One data source (#29; design: V-Source-Files). No versions: every file uploaded to it counts.
 * Its counts on top (items, taken by datasets, not used, projects), its files below, and Add a
 * file beside them; items already in the source are counted as repeats and left out.
 */
export default function SourcePage() {
  return (
    <SignedIn>
      <Suspense>
        <Source />
      </Suspense>
    </SignedIn>
  );
}

/** File, Items, Bad rows, Repeats, Uploaded by, Uploaded (the card is 706 wide). */
const WIDTHS: (number | 'auto')[] = ['auto', 96, 84, 84, 110, 140];

function Source() {
  const id = useSearchParams().get('id') ?? '';
  const [d, setD] = useState<DataSourceDetail | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
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
  const title = d ? sourceName(d.source) : t('Data Source');
  return (
    <TenantPage head={<PageHead title={title} back={{label: t('Data Source'), href: '/sources/'}} />}>
      {failed ? (
        <Banner tone="err" text={failed} style={{margin: 0, width: 706}} action={<Button label={t('Retry')} size="sm" onClick={load} />} />
      ) : d === null ? (
        <Banner tone="err" text={t('This data source does not exist.')} style={{margin: 0, width: 706}} />
      ) : (
        d && (
          <div className="row" style={{gap: 32, alignItems: 'flex-start'}}>
            <Files d={d} />
            {!d.source.builtIn && <AddFile sourceId={d.source.id} />}
          </div>
        )
      )}
    </TenantPage>
  );
}

function Files({d}: {d: DataSourceDetail}) {
  return (
    <Card title={t('Files')} style={{width: 706, flex: 'none'}}>
      <Metrics>
        <Metric label={t('Items')} value={num(d.source.items)} />
        <Metric label={<Hov text={t('Taken by datasets')} tip={t('Items given to datasets, of every project. Each item goes to one dataset only.')} />} value={num(d.taken)} />
        <Metric label={t('Not used')} value={num(d.source.notUsed)} />
        <Metric label={t('Projects')} value={num(d.projects)} />
      </Metrics>
      <Table
        cols={[
          {label: t('File')},
          {label: t('Items')},
          {label: <Hov text={t('Bad rows')} tip={t('Rows with no usable item ID.')} />},
          {label: <Hov text={t('Repeats')} tip={t('Item IDs already in this file or this data source, left out.')} />},
          {label: t('Uploaded by')},
          {label: t('Uploaded')},
        ]}
        widths={WIDTHS}
        rows={d.files.map(f => ({
          key: f.id,
          cells: [
            <One key="n" text={f.name} />,
            <FileItems key="i" f={f} />,
            num(f.bad),
            num(f.repeats),
            <One key="b" text={f.uploadedBy} />,
            <span key="u" className="t-3">
              {dateTime(f.uploadedAt)}
            </span>,
          ],
        }))}
      />
    </Card>
  );
}

function FileItems({f}: {f: SourceFile}) {
  if (f.state === 'importing') return <Progress done={f.done} total={f.start == null ? f.rows - f.bad - f.repeats : f.items} />;
  if (f.state === 'failed')
    return (
      <span title={f.error ? t(f.error) : undefined}>
        <Badge text={t('Failed')} tone="err" />
      </span>
    );
  return <>{num(f.items)}</>;
}

/** Add a file: its new items join the source, after every item there. */
function AddFile({sourceId}: {sourceId: string}) {
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    if (!file) return;
    setErr(null);
    try {
      const res = await addSourceFileFile(sourceId, file);
      if (res.error) return setErr(res.error);
      setFile(null);
    } catch (e) {
      // A refused call (the service is down, the data source is busy) shows here too.
      setErr((e as Error).message || 'Something went wrong. Try again.');
    }
  };
  return (
    <Card title={t('Add a file')} className="form" style={{flex: '1 1 0', minWidth: 320, maxWidth: 542}}>
      <FileInput label={t('File')} hint={sourceHint()} accept={SOURCE_ACCEPT} file={file} onFile={f => (setErr(null), setFile(f))} />
      {err && (
        <p className="t-err" style={{margin: 0}} role="alert">
          <Icon name="alert" /> {t(err)}
        </p>
      )}
      <div className="row" style={{justifyContent: 'space-between'}}>
        <span className="t-3" style={{fontSize: 13}}>
          {t('Items already in this data source are counted as repeats and left out.')}
        </span>
        <Button label={t('Add file')} kind="primary" disabled={!file} onClick={add} />
      </div>
    </Card>
  );
}
