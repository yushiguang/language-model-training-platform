'use client';

import {useEffect, useState} from 'react';
import {listDataSources, subscribeChanges, type DataSourceSummary} from '@/backend-api';
import {isAccessDenied, reportAccessDenied} from '@/ui';
import {currentLocale, t} from '@/i18n';

/** The accepted files, as the file picker and its hint say (2026-11-22: CSV and JSONL only). */
export const SOURCE_ACCEPT = '.csv,.jsonl';
export const sourceHint = () => t('CSV or JSONL with one sample ID per row, in a field named id.');

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

/** A file's kind as the pages name it, from its extension. */
export const fileKind = (fileName: string) => (/\.jsonl$/i.test(fileName) ? 'JSONL' : /\.txt$/i.test(fileName) ? 'TXT' : 'CSV');

/** The name a new source gets from its file: the file name without its extension. */
export const nameFromFile = (fileName: string) => fileName.replace(/\.[^.]+$/, '');

/** A file's size, e.g. "9.1 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return t('{n} B', {n: bytes});
  if (bytes < 1024 * 1024) return t('{n} KB', {n: (bytes / 1024).toFixed(1)});
  return t('{n} MB', {n: (bytes / 1024 / 1024).toFixed(1)});
}

/** When a source was added: "Just now", "10 min ago" within the hour, else the date. */
export function addedWhen(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (ms < 60_000) return t('Just now');
  if (ms < 3_600_000) return t('{n} min ago', {n: Math.floor(ms / 60_000)});
  return shortDate(iso);
}

/** A date as "Nov 15, 2026" (2026年11月15日 in Chinese). */
export const shortDate = (iso: string) => new Intl.DateTimeFormat(currentLocale() === 'zh' ? 'zh-CN' : 'en-US', {dateStyle: 'medium'}).format(new Date(iso));

/** How many projects use a source: "2 projects", or null for none. */
export const usedByText = (n: number) => (n ? (n === 1 ? t('1 project') : t('{n} projects', {n})) : null);

/** "Only admins can add data sources" (W-NoAccess-Source): the access dialog with words for data sources. */
export const refuseSourceChange = (what: 'add' | 'change') =>
  reportAccessDenied('tenant_write', {
    title: what === 'add' ? t("You can't add data sources") : t("You can't change data sources"),
    why: what === 'add' ? t('Everyone can read data sources. Only admins can add them.') : t('Everyone can read data sources. Only admins can change them.'),
  });

/**
 * Runs a change; a refusal for a missing permission opens the access dialog, and any other
 * failure comes back as a sentence to show where the change was asked for.
 */
export async function attempt(fn: () => Promise<unknown>, what: 'add' | 'change' = 'change'): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (isAccessDenied(e)) {
      refuseSourceChange(what);
      return '';
    }
    const msg = e instanceof Error ? e.message : '';
    return /^[A-Z][^{}<>\n]{0,160}\.$/.test(msg) ? t(msg) : t('Check your connection and try again.');
  }
}

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
