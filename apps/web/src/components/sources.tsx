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
