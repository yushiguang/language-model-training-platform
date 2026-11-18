'use client';

import {useEffect, useState} from 'react';
import {listDataSources, subscribeChanges, type DataSourceSummary} from '@/backend-api';
import {t} from '@/i18n';

/** The accepted files, as the file picker and its hint say. */
export const SOURCE_ACCEPT = '.csv,.jsonl,.txt';
export const sourceHint = () => t('CSV, JSONL or TXT · one item ID per row · up to 100,000 rows');

/** The tenant's data sources, read again on every change. */
export function useDataSources(): [DataSourceSummary[] | null, string | null, () => Promise<void>] {
  const [list, setList] = useState<DataSourceSummary[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = async () => {
    try {
      setList(await listDataSources());
      setFailed(null);
    } catch (e) {
      setFailed(t('Data sources could not load: {why}', {why: t((e as Error).message || 'the service did not answer')}));
    }
  };
  useEffect(() => {
    void load();
    return subscribeChanges(() => void load());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return [list, failed, load];
}

/** A source's name as shown: the built-in sample data's is translated, a team's own never is. */
export const sourceName = (s: {name: string; builtIn?: boolean}) => (s.builtIn ? t(s.name) : s.name);

/**
 * A data source error from the server, translated. The count error carries numbers and a name, so
 * it is matched and translated with them; a built-in source's name in it is translated too.
 */
export function sourceError(message: string, list: {name: string; builtIn?: boolean}[] = []): string {
  const m = /^Only (\d+) unused items are left in (.+); (\d+) were asked for\.$/.exec(message);
  if (!m) return t(message);
  const name = list.some(s => s.builtIn && s.name === m[2]) ? t(m[2]) : m[2];
  return t('Only {n} unused items are left in {name}; {count} were asked for.', {n: Number(m[1]).toLocaleString(), name, count: Number(m[3]).toLocaleString()});
}
