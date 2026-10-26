'use client';

import {createContext, useCallback, useContext, useEffect, useState, type ReactNode} from 'react';
import {InternationalizationProvider} from '@astryxdesign/core/i18n';
import {messages, type Locale, type MessageKey} from './messages';

const STORAGE_KEY = 'lmp.locale';

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
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

  return (
    <LocaleContext.Provider value={{locale, setLocale, t}}>
      <InternationalizationProvider locale={locale}>{children}</InternationalizationProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used inside LocaleProvider');
  return value;
}
