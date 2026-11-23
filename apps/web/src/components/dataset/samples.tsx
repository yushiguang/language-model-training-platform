'use client';

import {useEffect, useRef, useState, type ReactNode} from 'react';
import {CheckIcon, FunnelIcon, MagnifyingGlassIcon} from '@heroicons/react/24/outline';
import {listSamples, restoreExamples, type RemovalReason, type SampleFilter, type SamplePage, type SampleRow} from '@/backend-api';
import {Button, DropdownMenu, HStack, Icon, IconButton, InfoTip, Pagination, pixel, proportional, SegmentedControl, SegmentedControlItem, Spinner, StackItem, Table, Text, TextInput, Token, useTableSortable, VStack, type TableColumn, type TableSortState} from '@/ui/astryx';
import {isAccessDenied, reportAccessDenied} from '@/ui';
import {t} from '@/i18n';
import {shortDate} from '../sources';
import {ErrorLine} from '../sources/dialogs';

/** Rows a page (wireframes round 5: 10 rows a page). */
const PAGE_SIZE = 10;

export type SampleQuery = {filter: SampleFilter; query: string; sourceId: string | null; gold: string | null; sort: NonNullable<Parameters<typeof listSamples>[0]['sort']>; page: number};

/** A page of samples, with the tab it was read for (the last page stays up while the next one loads). */
export type SamplesData = {page: (SamplePage & {filter: SampleFilter}) | null; failed: string | null; reload: () => void};

export const FIRST_QUERY: SampleQuery = {filter: 'live', query: '', sourceId: null, gold: null, sort: 'number', page: 1};

/**
 * The dataset's samples for the table and the counts cards: read again whenever the query or the
 * project changes (`revision`). Keeps the last page while the next one loads.
 */
export function useSamples(projectId: string, q: SampleQuery, revision: string): SamplesData {
  const [page, setPage] = useState<(SamplePage & {filter: SampleFilter}) | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    listSamples({projectId, filter: q.filter, query: q.query || undefined, sourceId: q.sourceId ?? undefined, gold: q.gold ?? undefined, sort: q.sort, offset: (q.page - 1) * PAGE_SIZE, limit: PAGE_SIZE})
      .then(p => {
        if (mine !== seq.current) return;
        setPage({...p, filter: q.filter});
        setFailed(null);
      })
      .catch(e => mine === seq.current && setFailed(t('The samples could not load: {why}', {why: t((e as Error).message || 'the service did not answer')})));
  }, [projectId, q.filter, q.query, q.sourceId, q.gold, q.sort, q.page, revision, nonce]);
  return {page, failed, reload: () => setNonce(n => n + 1)};
}

const REASON: Record<RemovalReason, string> = {broken: 'Broken', out_of_scope: 'Out of scope', other: 'Other', downsample: 'Downsampled', excess_unlabeled: 'Unlabeled extra'};

const TABS: {key: SampleFilter; label: string}[] = [
  {key: 'live', label: 'All'},
  {key: 'no_label', label: 'No label'},
  {key: 'mismatch', label: 'Mismatch'},
  {key: 'removed', label: 'Removed'},
];

type Row = SampleRow & Record<string, unknown>;

/** A gold label or a model answer: one token per value, the same style for both (round 5). */
function Answer({a}: {a: string[] | null}) {
  if (!a?.length) return null;
  return (
    <HStack gap={1} wrap="wrap" vAlign="center">
      {a.map(v => (
        <Token key={v} size="sm" label={v} />
      ))}
    </HStack>
  );
}

/** A column header with a filter menu: "All …" and each value; the funnel is dark while a filter is on. */
function FilterHeader({label, all, options, value, onChange}: {label: string; all: string; options: {value: string; label: string}[]; value: string | null; onChange: (v: string | null) => void}) {
  const tickIf = (on: boolean) => (on ? <Icon icon={CheckIcon} size="sm" color="secondary" label={t('Current')} /> : undefined);
  return (
    <HStack gap={1} vAlign="center">
      <span>{label}</span>
      <DropdownMenu
        alignment="start"
        menuMaxHeight={320}
        items={[{id: '__all', label: all, endContent: tickIf(value === null), onClick: () => onChange(null)}, ...options.map(o => ({id: o.value, label: o.label, endContent: tickIf(value === o.value), onClick: () => onChange(o.value)}))]}
        renderTrigger={props => (
          <IconButton {...props} label={t('Filter {column}', {column: label})} variant="ghost" size="sm" icon={<Icon icon={FunnelIcon} size="sm" color={value === null ? 'secondary' : 'primary'} />} />
        )}
      />
    </HStack>
  );
}

/**
 * The samples table (W-EvalDataset, W-EvalDataset-Removed): tabs with their counts, a search by
 * sample ID or number, then a page of rows. Live tabs: number, sample ID, data source, gold label
 * and the model's answer, with Remove on hover. Removed: why, who and when, with Restore on hover.
 */
export function Samples({
  projectId,
  q,
  setQ,
  data,
  sources,
  values,
  onRemove,
}: {
  projectId: string;
  q: SampleQuery;
  setQ: (q: SampleQuery) => void;
  data: SamplesData;
  sources: {id: string; name: string}[];
  values: string[];
  onRemove: (s: SampleRow) => void;
}) {
  const [search, setSearch] = useState(q.query);
  // The search runs a moment after typing stops.
  useEffect(() => {
    if (search.trim() === q.query) return;
    const id = setTimeout(() => setQ({...q, query: search.trim(), page: 1}), 300);
    return () => clearTimeout(id);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const page = data.page;
  // The columns follow the page on screen, which is the last tab's until the new one arrives.
  const removed = (page?.filter ?? q.filter) === 'removed';

  const sortState: TableSortState = [{sortKey: q.sort.replace('-', ''), direction: q.sort.startsWith('-') ? 'descending' : 'ascending'}];
  const sortable = useTableSortable<Row>({
    sort: sortState,
    onSortChange: s => {
      const e = s[0];
      const key = (e?.sortKey === 'externalId' ? 'externalId' : 'number') as 'number' | 'externalId';
      setQ({...q, sort: e?.direction === 'descending' ? `-${key}` : key, page: 1});
    },
  });

  const restore = async (r: SampleRow) => {
    setRestoreError(null);
    try {
      await restoreExamples({projectId, removalIds: [r.removal!.id]});
    } catch (e) {
      if (isAccessDenied(e)) return reportAccessDenied(e.permission);
      setRestoreError(t('Restoring #{n} failed: {why}', {n: r.number, why: t((e as Error).message || 'the service did not answer')}));
    }
  };

  const number: TableColumn<Row> = {key: 'number', header: '#', width: pixel(88), sortable: true, renderCell: r => <Text hasTabularNumbers>{r.number}</Text>};
  const externalId: TableColumn<Row> = {
    key: 'externalId',
    header: t('Example ID'),
    width: proportional(2, {minWidth: 140}),
    sortable: true,
    renderCell: r => (
      <Text maxLines={1} hasTabularNumbers>
        {r.externalId}
      </Text>
    ),
  };
  const end = (content: ReactNode): TableColumn<Row> => ({key: 'actions', header: '', width: pixel(112), align: 'end', renderCell: () => <span className="sp-row-actions">{content}</span>});
  const columns: TableColumn<Row>[] = removed
    ? [
        number,
        externalId,
        {
          key: 'reason',
          header: t('Reason'),
          width: proportional(1.4, {minWidth: 140}),
          renderCell: r => (
            <HStack gap={1} vAlign="center">
              <Token size="sm" label={t(REASON[r.removal!.reason])} />
              {r.removal!.note && <InfoTip content={r.removal!.note} label={t('Note')} />}
            </HStack>
          ),
        },
        {
          key: 'removedBy',
          header: t('Removed by'),
          width: proportional(2, {minWidth: 180}),
          renderCell: r => (
            <Text color="secondary" maxLines={1}>
              {r.removal!.removedBy} · {shortDate(r.removal!.removedAt)}
            </Text>
          ),
        },
        {...end(null), renderCell: r => <span className="sp-row-actions"><Button label={t('Restore')} variant="secondary" size="sm" onClick={() => void restore(r)} /></span>},
      ]
    : [
        number,
        externalId,
        {
          key: 'source',
          header: <FilterHeader label={t('Data source')} all={t('All data sources')} options={sources.map(s => ({value: s.id, label: s.name}))} value={q.sourceId} onChange={v => setQ({...q, sourceId: v, page: 1})} />,
          width: proportional(2, {minWidth: 160}),
          renderCell: r => (
            <Text color="secondary" maxLines={1}>
              {r.source ? (sources.find(s => s.id === r.source!.id)?.name ?? r.source.name) : '—'}
            </Text>
          ),
        },
        {
          key: 'gold',
          header: <FilterHeader label={t('Gold label')} all={t('All gold labels')} options={values.map(v => ({value: v, label: v}))} value={q.gold} onChange={v => setQ({...q, gold: v, page: 1})} />,
          width: proportional(1.5, {minWidth: 140}),
          renderCell: r => <Answer a={r.gold} />,
        },
        {
          key: 'model',
          header: page?.model ? t('Model ({version}, best)', {version: page.model.label}) : t('Model'),
          width: proportional(1.5, {minWidth: 140}),
          renderCell: r => <Answer a={r.model} />,
        },
        {...end(null), renderCell: r => <span className="sp-row-actions"><Button label={t('Remove')} variant="ghost" size="sm" onClick={() => onRemove(r)} /></span>},
      ];

  const counts = page?.counts;
  const tabLabel = (k: SampleFilter, label: string) => (counts ? `${t(label)} ${counts[k].toLocaleString('en-US')}` : t(label));
  const filtered = !!(q.query || q.sourceId || q.gold);
  return (
    <VStack gap={4}>
      <HStack gap={4} vAlign="center" hAlign="between" wrap="wrap">
        <SegmentedControl label={t('Show')} value={q.filter} onChange={v => setQ({...q, filter: v as SampleFilter, page: 1, ...(v === 'removed' ? {sourceId: null, gold: null} : {})})}>
          {TABS.map(tab => (
            <SegmentedControlItem key={tab.key} value={tab.key} label={tabLabel(tab.key, tab.label)} />
          ))}
        </SegmentedControl>
        <TextInput label={t('Search by example ID')} isLabelHidden placeholder={t('Search by example ID…')} value={search} onChange={setSearch} startIcon={MagnifyingGlassIcon} hasClear width={300} />
      </HStack>
      {data.failed && (
        <HStack gap={3} vAlign="center">
          <ErrorLine text={data.failed} />
          <Button label={t('Retry')} variant="secondary" size="sm" onClick={data.reload} />
        </HStack>
      )}
      {restoreError && <ErrorLine text={restoreError} />}
      {!page ? (
        <HStack hAlign="center" paddingBlock={10}>
          <Spinner label={t('Loading')} />
        </HStack>
      ) : (
        <div className="sp-rows sp-samples">
          <Table<Row> data={page.items as Row[]} columns={columns} idKey="exampleId" hasHover plugins={{sortable}} />
          {page.items.length === 0 && (
            <Text type="body" color="secondary" className="sp-samples-none">
              {filtered ? t('No samples match.') : removed ? t('Nothing is removed.') : q.filter === 'mismatch' ? t('No mismatches: the model agrees with every gold label.') : q.filter === 'no_label' ? t('Every sample has a gold label.') : t('No samples yet.')}
            </Text>
          )}
        </div>
      )}
      {page && page.total > PAGE_SIZE && (
        <HStack hAlign="end">
          <StackItem>
            <Pagination page={q.page} pageSize={PAGE_SIZE} totalItems={page.total} onChange={p => setQ({...q, page: p})} label={t('Pages')} />
          </StackItem>
        </HStack>
      )}
    </VStack>
  );
}
