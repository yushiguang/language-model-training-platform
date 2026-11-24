'use client';

import {useEffect, useRef, useState} from 'react';
import {Cog6ToothIcon, MagnifyingGlassIcon} from '@heroicons/react/24/outline';
import {listLabelSets, listTenantMembers, subscribeChanges, type LabelSetList, type LabelSetView, type TenantMemberView} from '@/backend-api';
import {Avatar, HStack, Icon, IconButton, Link, pixel, ProgressBar, proportional, SegmentedControl, SegmentedControlItem, StackItem, Table, Text, TextInput, VStack, type TableColumn} from '@/ui/astryx';
import {t} from '@/i18n';

/** A set's name as shown: the one people gave it, else "Set 3". */
export const setName = (s: {name: string; number: number}) => s.name || t('Set {n}', {n: s.number});

/** A range of sample numbers, "#1–100" (one sample: "#7"). */
export const rangeText = (first: number, last: number) => (first === last ? `#${first.toLocaleString('en-US')}` : `#${first.toLocaleString('en-US')}–${last.toLocaleString('en-US')}`);

/** The project's label sets, read again whenever the project changes (`revision`) or anything is saved. */
export function useLabelSets(projectId: string, revision: string): {list: LabelSetList | null; failed: string | null; reload: () => void} {
  const [list, setList] = useState<LabelSetList | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const seq = useRef(0);
  const load = () => {
    const mine = ++seq.current;
    listLabelSets(projectId)
      .then(l => {
        if (mine !== seq.current) return;
        setList(l);
        setFailed(null);
      })
      .catch(e => mine === seq.current && setFailed(t('The label sets could not load: {why}', {why: t((e as Error).message || 'the service did not answer')})));
  };
  useEffect(() => {
    load();
    return subscribeChanges(() => load());
  }, [projectId, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  return {list, failed, reload: load};
}

/** The tenant's members, the people a set can be given to; empty until read (and when it fails). */
export function useMembers(): TenantMemberView[] {
  const [members, setMembers] = useState<TenantMemberView[]>([]);
  useEffect(() => {
    let live = true;
    listTenantMembers()
      .then(m => live && setMembers(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return members;
}

/** A person: avatar and name. */
export function Person({name}: {name: string}) {
  return (
    <HStack gap={2} vAlign="center">
      <Avatar name={name} size="xsm" />
      <Text type="body" maxLines={1}>
        {name}
      </Text>
    </HStack>
  );
}

type Row = LabelSetView & Record<string, unknown>;

/**
 * The label sets (W-Labeling): All or Mine (sets I label), a search by set or labeler, then one row
 * per set: name and range, samples, labeler, how far labeling is, mismatches; settings on hover.
 */
export function LabelSets({
  list,
  members,
  me,
  setHref,
  onSettings,
}: {
  list: LabelSetList;
  members: TenantMemberView[];
  me: string | null;
  setHref: (s: LabelSetView) => string;
  onSettings: (s: LabelSetView) => void;
}) {
  const [show, setShow] = useState<'all' | 'mine'>('all');
  const [query, setQuery] = useState('');
  const nameOf = (id: string) => members.find(m => m.userId === id)?.name ?? (id === me ? t('You') : id);
  const mine = list.sets.filter(s => !!me && s.labelerIds.includes(me));
  const q = query.trim().toLowerCase();
  const shown = (show === 'mine' ? mine : list.sets).filter(s => !q || setName(s).toLowerCase().includes(q) || s.labelerIds.some(id => nameOf(id).toLowerCase().includes(q)));

  const columns: TableColumn<Row>[] = [
    {
      key: 'name',
      header: t('Label set'),
      width: proportional(2, {minWidth: 180}),
      renderCell: s => (
        <HStack gap={2} vAlign="center">
          <Link href={setHref(s)} className="sp-row-link">
            <Text type="body" weight="semibold" maxLines={1} color="inherit">
              {setName(s)}
            </Text>
          </Link>
          <Text type="body" color="secondary" hasTabularNumbers>
            {rangeText(s.first, s.last)}
          </Text>
        </HStack>
      ),
    },
    {key: 'samples', header: t('Examples'), width: proportional(0.9, {minWidth: 90}), renderCell: s => <Text hasTabularNumbers>{s.samples.toLocaleString('en-US')}</Text>},
    {
      key: 'labeler',
      header: t('Labeler'),
      width: proportional(1.6, {minWidth: 150}),
      renderCell: s =>
        s.labelerIds.length ? (
          <VStack gap={1}>
            {s.labelerIds.map(id => (
              <Person key={id} name={nameOf(id)} />
            ))}
          </VStack>
        ) : (
          <Text color="secondary">{t('No labeler')}</Text>
        ),
    },
    {
      key: 'labeled',
      header: t('Gold labeled'),
      width: proportional(1.6, {minWidth: 170}),
      renderCell: s => (
        <HStack gap={3} vAlign="center">
          <StackItem size="fill" style={{minWidth: 60}}>
            <ProgressBar label={t('Gold labeled')} isLabelHidden value={s.labeled} max={Math.max(1, s.samples)} />
          </StackItem>
          <Text type="supporting" color="secondary" hasTabularNumbers>
            {s.labeled.toLocaleString('en-US')} / {s.samples.toLocaleString('en-US')}
          </Text>
        </HStack>
      ),
    },
    {key: 'mismatch', header: t('Mismatch'), width: proportional(0.8, {minWidth: 90}), renderCell: s => <Text hasTabularNumbers>{s.mismatch.toLocaleString('en-US')}</Text>},
    {
      key: 'actions',
      header: '',
      width: pixel(56),
      align: 'end',
      renderCell: s => (
        <span className="sp-row-actions">
          <IconButton label={t('Settings for {set}', {set: setName(s)})} variant="ghost" size="sm" icon={<Icon icon={Cog6ToothIcon} size="sm" />} onClick={() => onSettings(s)} />
        </span>
      ),
    },
  ];

  return (
    <VStack gap={4}>
      <HStack gap={4} vAlign="center" hAlign="between" wrap="wrap">
        <SegmentedControl label={t('Show')} value={show} onChange={v => setShow(v as 'all' | 'mine')}>
          <SegmentedControlItem value="all" label={`${t('All')} ${list.sets.length}`} />
          <SegmentedControlItem value="mine" label={`${t('Mine')} ${mine.length}`} />
        </SegmentedControl>
        <TextInput label={t('Search label sets')} isLabelHidden placeholder={t('Search by set or labeler…')} value={query} onChange={setQuery} startIcon={MagnifyingGlassIcon} hasClear width={300} />
      </HStack>
      <div className="sp-rows sp-samples">
        <Table<Row> data={shown as Row[]} columns={columns} idKey="id" hasHover />
        {shown.length === 0 && (
          <Text type="body" color="secondary" className="sp-samples-none">
            {q ? t('No label sets match.') : show === 'mine' ? t('No label set is yours to label.') : t('No label sets yet.')}
          </Text>
        )}
      </div>
    </VStack>
  );
}
