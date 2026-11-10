import type {EventName, EventProps, TelemetryPort} from '@tsp/contracts';
import {pageFromPath} from '@tsp/domain';

/**
 * Browser-side telemetry: page views, page load and interaction times, script errors and failed
 * backend calls. Only page names, counts and times leave the page; never what the user typed.
 */
export function webTelemetry(tm: TelemetryPort) {
  let page: string | null = null;
  let shownAt = 0;
  let lastInput = 0;
  let idleMs = 0;
  let started = false;

  const leave = () => {
    if (!page) return;
    const visible = (Date.now() - shownAt) / 1000;
    tm.event('page_left', {seconds_visible: Math.round(visible), seconds_idle: Math.round(idleMs / 1000)});
  };

  function start() {
    if (started || typeof window === 'undefined') return;
    started = true;
    const w = window.innerWidth;
    tm.event('session_started', {viewport: w < 640 ? 'phone' : w < 1024 ? 'tablet' : 'desktop', language: navigator.language || 'unknown'});
    window.addEventListener('error', e => {
      // A missing image or script reports on its element, not as a script error.
      const kind = e.target && e.target !== window ? 'asset' : 'script';
      tm.counter('tsp_web_errors_total', {page: page ?? 'other', kind});
    }, true);
    window.addEventListener('unhandledrejection', () => tm.counter('tsp_web_errors_total', {page: page ?? 'other', kind: 'script'}));
    const markInput = () => {
      const t = Date.now();
      if (lastInput && t - lastInput > 60_000) idleMs += t - lastInput - 60_000;
      lastInput = t;
    };
    for (const ev of ['pointerdown', 'keydown', 'scroll']) window.addEventListener(ev, markInput, {passive: true});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') leave();
      else shownAt = Date.now();
    });
    observe('largest-contentful-paint', entries => {
      const last = entries[entries.length - 1];
      if (last) tm.histogram('tsp_web_page_load_seconds', last.startTime / 1000, {page: page ?? 'other'});
    });
    observe('event', entries => {
      for (const e of entries) if (e.duration >= 40) tm.histogram('tsp_web_interaction_seconds', e.duration / 1000, {page: page ?? 'other'});
    });
  }

  return {
    /** Call on every route change. */
    pageViewed(pathname: string, search: string) {
      start();
      const next = pageFromPath(pathname);
      if (next === page) return;
      leave();
      const params = new URLSearchParams(search);
      tm.setContext({projectId: params.get('p'), page: next});
      tm.counter('tsp_web_page_views_total', {page: next});
      const slot = params.get('slot');
      tm.event('page_viewed', {
        from_page: page,
        ...(params.get('v') ? {version_id: params.get('v')!} : {}),
        ...(slot === 'A' || slot === 'B' ? {slot} : {}),
      });
      page = next;
      shownAt = Date.now();
      idleMs = 0;
    },
    track<E extends EventName>(event: E, props: EventProps[E]) {
      tm.event(event, props);
    },
    backendError() {
      tm.counter('tsp_web_errors_total', {page: page ?? 'other', kind: 'backend'});
    },
    crossTab() {
      tm.counter('tsp_web_cross_tab_updates_total', {});
    },
  };
}

function observe(type: string, fn: (entries: PerformanceEntry[] & {duration: number; startTime: number}[]) => void) {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes(type)) return;
  try {
    new PerformanceObserver(list => fn(list.getEntries() as never)).observe({type, buffered: true} as PerformanceObserverInit);
  } catch {
    // Older browsers: no timing metrics.
  }
}
