'use client';

import {createContext, Fragment, useCallback, useContext, useEffect, useState, type ReactNode} from 'react';
import type {Locale, Msg} from '@tsp/contracts';
import {hasKey, isLocale, translate} from '@tsp/domain';

/**
 * The site's language (spec 1.1.0, 2). English is the source: every text is its own key and
 * `t()` looks it up in the chosen language's catalog (`@tsp/domain`, `locales/`). The static
 * export is built in English; the saved choice is applied right after the first paint, and a
 * switch re-renders the whole tree in place.
 */
const KEY = 'tsp-locale';
let current: Locale = 'en';

/** Keys asked for in this session that the current catalog lacks (read by the browser check). */
const missing = new Set<string>();

/** The text of `key` in the current language, with `{name}` params filled in. */
export function t(key: string, params?: Msg['params']): string {
  if (current !== 'en' && !hasKey(current, key) && /[A-Za-z]{2}/.test(key.replace(/\{\w+\}/g, ''))) {
    missing.add(key);
    (globalThis as {__tspI18nMissing?: string[]}).__tspI18nMissing = [...missing];
  }
  return translate(current, key, params);
}

/** A text the services made: its `Msg` when it has one, else the English text looked up as a key. */
export const tm = (m: Msg | null | undefined, text?: string): string => (m ? t(m.key, m.params) : t(text ?? ''));

export const currentLocale = (): Locale => current;

function saved(): Locale | null {
  try {
    const v = localStorage.getItem(KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

/** The language to start in: the saved choice, else Chinese for a browser set to Chinese. */
function initial(): Locale {
  const s = saved();
  if (s) return s;
  return typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
}

function apply(l: Locale) {
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
}

const Ctx = createContext<{locale: Locale; setLocale: (l: Locale) => void}>({locale: 'en', setLocale: () => undefined});
export const useLocale = () => useContext(Ctx);

/** `keep` is rendered once and not re-rendered by a switch (page telemetry, so a switch is not a page view). */
export function LocaleProvider({children, keep, onChange}: {children: ReactNode; keep?: ReactNode; onChange?: (l: Locale) => void}) {
  const [locale, setState] = useState<Locale>('en');
  useEffect(() => {
    const l = initial();
    if (l !== 'en') {
      apply(l);
      setState(l);
    }
  }, []);
  const setLocale = useCallback(
    (l: Locale) => {
      try {
        localStorage.setItem(KEY, l);
      } catch {
        // private mode: the choice lasts for this page only
      }
      apply(l);
      setState(l);
      onChange?.(l);
    },
    [onChange],
  );
  // The key re-renders every page in the new language (texts are read at render time).
  return (
    <Ctx.Provider value={{locale, setLocale}}>
      {keep}
      <Fragment key={locale}>{children}</Fragment>
    </Ctx.Provider>
  );
}
