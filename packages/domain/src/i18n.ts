import type {Locale, Msg} from '@tsp/contracts';
import {ZH, ZH_NAME} from './locales/zh.ts';

/**
 * Languages (spec 1.1.0, 2). English is the source language: every text is its own catalog key,
 * written with `{name}` placeholders. Other languages map those keys to their text; a key a
 * catalog lacks is shown in English, so nothing is ever blank.
 */
const CATALOGS: Record<Locale, Readonly<Record<string, string>> | null> = {en: null, zh: ZH};

/** The languages the switch offers, each named in its own language. */
export const LOCALES: readonly {id: Locale; name: string}[] = [
  {id: 'en', name: 'English'},
  {id: 'zh', name: ZH_NAME},
];

export const isLocale = (x: unknown): x is Locale => x === 'en' || x === 'zh';

/**
 * Params whose string values are words of the site (a helper, a page, a step), so they are
 * translated too. Any other param (a version label, a field name, a count) is shown as given.
 */
const TERM_PARAMS = new Set(['who', 'page', 'step', 'helper', 'term']);

const isMsg = (x: unknown): x is Msg => typeof x === 'object' && x !== null && typeof (x as Msg).key === 'string';

/** `text` with each `{name}` replaced by its param (a nested `Msg` in English); unknown placeholders stay. */
export function fill(text: string, params?: Msg['params']): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (all, k: string) => {
    if (!(k in params)) return all;
    const v = params[k]!;
    return isMsg(v) ? fill(v.key, v.params) : String(v);
  });
}

/** A service-made text as a catalog key and its params. */
export const msg = (key: string, params?: Msg['params']): Msg => (params ? {key, params} : {key});

/** The English text of a `Msg`. */
export const msgText = (m: Msg): string => fill(m.key, m.params);

/** Whether a language's catalog has this key (English has every key). */
export function hasKey(locale: Locale, key: string): boolean {
  const cat = CATALOGS[locale];
  return !cat || key in cat;
}

/** The text of `key` in a language, with its params filled in (and term params translated). */
export function translate(locale: Locale, key: string, params?: Msg['params']): string {
  const cat = CATALOGS[locale];
  if (!cat) return fill(key, params);
  const tr = (s: string) => cat[s] ?? s;
  const ps = params ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, isMsg(v) ? translate(locale, v.key, v.params) : typeof v === 'string' && TERM_PARAMS.has(k) ? tr(v) : v])) : undefined;
  return fill(tr(key), ps);
}

/** Every key of a language's catalog (for checks). */
export const catalogKeys = (locale: Locale): string[] => Object.keys(CATALOGS[locale] ?? {});
