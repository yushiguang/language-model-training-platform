import type {ClientDiagnostics} from '@tsp/contracts';
import {newId, systemConfig} from '@tsp/domain';

/**
 * The browser's rolling record for problem reports (spec 1.1.0, 3.2): the last pages, failed
 * backend calls and script errors. It sits on the client side of the wire and goes with each Ask
 * AI message; nothing here is what the user typed.
 */
type Entry<T> = T & {at: string};
const pages: Entry<{path: string}>[] = [];
const failedCalls: Entry<{method: string; callId: string; message: string}>[] = [];
const errors: Entry<{message: string; source?: string}>[] = [];
let listening = false;

const keep = <T,>(list: T[], item: T) => {
  list.push(item);
  const n = systemConfig().reports.diagnosticsKeep;
  if (list.length > n) list.splice(0, list.length - n);
};
const cut = (s: string) => {
  const n = systemConfig().reports.messageMaxChars;
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const now = () => new Date().toISOString();

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('error', e => {
    const el = e.target && e.target !== window ? (e.target as Element) : null;
    if (el) keep(errors, {at: now(), message: `Could not load a ${el.tagName?.toLowerCase() ?? 'resource'}`, source: (el as HTMLImageElement).src ? new URL((el as HTMLImageElement).src, location.href).pathname : undefined});
    else keep(errors, {at: now(), message: cut(e.message || 'Script error'), source: e.filename ? `${new URL(e.filename, location.href).pathname}:${e.lineno}` : undefined});
  }, true);
  window.addEventListener('unhandledrejection', e => keep(errors, {at: now(), message: cut(String((e.reason as Error)?.message ?? e.reason ?? 'Unhandled rejection'))}));
}

/** A new call id: an HTTP client sends it as `X-Request-Id`, so server logs match the ticket. */
export const callId = () => newId('rq');

/** Records a page the user opened (path and query: ids only). */
export function pageOpened(path: string): void {
  listen();
  if (pages.at(-1)?.path !== path) keep(pages, {at: now(), path});
}

/** Records a backend call that failed. */
export function callFailed(method: string, id: string, error: unknown): void {
  keep(failedCalls, {at: now(), method, callId: id, message: cut((error as Error)?.message ?? String(error))});
}

/** The record as it stands, for the next Ask AI message. */
export function snapshot(): ClientDiagnostics | undefined {
  if (typeof window === 'undefined') return undefined;
  listen();
  return {
    url: location.pathname + location.search,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${screen.width}x${screen.height}`,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown',
    language: navigator.language || 'unknown',
    at: now(),
    pages: [...pages],
    failedCalls: [...failedCalls],
    errors: [...errors],
  };
}
