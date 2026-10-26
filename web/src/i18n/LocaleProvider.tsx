'use client';

import {createContext, useCallback, useContext, useEffect, useState, type ReactNode} from 'react';
import {InternationalizationProvider} from '@astryxdesign/core/i18n';
import zhCN from '@astryxdesign/core/locales/zh-CN.generated.js';
import {messages, type Locale, type MessageKey} from './messages';
import type {T} from './text';

const STORAGE_KEY = 'lmp.locale';
// Astryx ships English built in; its own strings (e.g. "New messages") need the zh-CN catalog.
const ASTRYX_MESSAGES = {'zh-CN': zhCN};

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** UI chrome strings, looked up by key. */
  t: (key: MessageKey) => string;
  /** Inline bilingual copy from mock data and the story script. */
  tr: (text: T) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({children}: {children: ReactNode}) {
  const [locale, setLocaleState] = useState<Locale>('en');

  // The choice is a per-viewer convenience; storage can be unavailable, so the page works without it.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'en' || saved === 'zh-CN') setLocaleState(saved);
    } catch {}
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }, []);

  const t = useCallback((key: MessageKey) => messages[locale][key], [locale]);
  const tr = useCallback((text: T) => (locale === 'en' ? text.en : text.zh), [locale]);

  return (
    <LocaleContext.Provider value={{locale, setLocale, t, tr}}>
      <InternationalizationProvider locale={locale} messages={ASTRYX_MESSAGES}>{children}</InternationalizationProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used inside LocaleProvider');
  return value;
}
