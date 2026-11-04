import {EVENT_PROP_KEYS, LABEL_VALUES, METRICS, type EventName, type EventProps, type Labels, type MetricName, type TelemetryContext, type TelemetryEvent, type TelemetryPort, type TelemetrySink} from '@tsp/contracts';

export interface TelemetryOptions {
  sink: TelemetrySink;
  appVersion?: string;
  env?: string;
  /** How often buffered events and metrics are sent. */
  flushMs?: number;
  /** Events kept while the sink is slow; the oldest are dropped beyond this. */
  maxBuffered?: number;
  now?: () => number;
  random?: () => string;
}

/** Which app a metric belongs to, from its name: becomes the `app` label. */
function appOf(name: string): string {
  if (name.startsWith('tsp_llm_')) return 'llm_gateway';
  if (name.startsWith('tsp_labeling_')) return 'labeling';
  if (name.startsWith('tsp_agent_') || name.startsWith('tsp_optimiser_')) return 'agents';
  if (name.startsWith('tsp_catalog_') || name.startsWith('tsp_storage_') || name.startsWith('tsp_files_')) return 'catalog';
  if (name.startsWith('tsp_web_')) return 'web';
  return 'bff';
}

/** Never allowed as a label value, even when an app declares it: ids, emails, free text. */
const NOT_A_LABEL = /^[a-z]{2,3}_[0-9a-z]+$|^[0-9a-f-]{16,}$|[\s@]/;
/** A string event prop: a short token (id, enum, page, language), never text. */
const TOKEN = /^[A-Za-z0-9_.:\/-]{0,64}$/;

/** Keeps only the props declared for the event; strings must be tokens, numbers finite. */
function cleanProps(name: EventName, props: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const given = (props ?? {}) as Record<string, unknown>;
  for (const k of EVENT_PROP_KEYS[name] ?? []) {
    const v = given[k];
    if (v === undefined) continue;
    if (v === null || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : null;
    else if (typeof v === 'string') out[k] = TOKEN.test(v) ? v : 'other';
  }
  return out;
}
const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

interface Hist {
  buckets: number[];
  sum: number;
  count: number;
}

const SESSION_IDLE_MS = 30 * 60_000;

/**
 * The telemetry app: one in-memory Prometheus registry plus an event buffer, behind
 * `TelemetryPort`. It sends to the platform's sink; it never throws and never blocks callers.
 */
export function createTelemetry(opts: TelemetryOptions): TelemetryPort & {stop(): void} {
  const now = opts.now ?? Date.now;
  const rand = opts.random ?? (() => Math.random().toString(16).slice(2, 10) + now().toString(16));
  const env = opts.env ?? 'dev';
  const max = opts.maxBuffered ?? 500;
  const series = new Map<MetricName, Map<string, {labels: Record<string, string>; value: number | Hist}>>();
  let events: TelemetryEvent[] = [];
  let ctx: Required<TelemetryContext> = {userId: null, projectId: null, page: null};
  let session = rand();
  let lastEventAt = now();
  let flushing: Promise<void> | null = null;
  // Each label's allowed values; anything else is counted as `other`.
  const allowed = new Map(Object.entries(LABEL_VALUES).map(([k, v]) => [k, new Set(v)]));
  const labelValue = (label: string, v: string | number | boolean) => {
    const s = String(v);
    return allowed.get(label)?.has(s) ? s : 'other';
  };

  const keyOf = (name: MetricName, labels: Labels = {}) => {
    const spec = METRICS[name];
    const clean: Record<string, string> = {app: appOf(name), env};
    for (const l of spec.labels) if (labels[l] !== undefined) clean[l] = labelValue(l, labels[l]);
    const key = Object.entries(clean)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    let m = series.get(name);
    if (!m) series.set(name, (m = new Map()));
    return {m, key, clean};
  };

  const safe = (fn: () => void) => {
    try {
      fn();
    } catch {
      // telemetry never breaks the app
    }
  };

  const port: TelemetryPort & {stop(): void} = {
    counter: (name, labels, by = 1) =>
      safe(() => {
        if (!(by >= 0) || !Number.isFinite(by)) return;
        const {m, key, clean} = keyOf(name, labels);
        const s = m.get(key);
        if (s) (s.value as number) += by;
        else m.set(key, {labels: clean, value: by});
      }),
    gauge: (name, value, labels) =>
      safe(() => {
        if (!Number.isFinite(value)) return;
        const {m, key, clean} = keyOf(name, labels);
        m.set(key, {labels: clean, value});
      }),
    histogram: (name, value, labels) =>
      safe(() => {
        if (!Number.isFinite(value)) return;
        const bounds = (METRICS[name] as {buckets?: readonly number[]}).buckets ?? [];
        const {m, key, clean} = keyOf(name, labels);
        let s = m.get(key);
        if (!s) m.set(key, (s = {labels: clean, value: {buckets: bounds.map(() => 0), sum: 0, count: 0}}));
        const h = s.value as Hist;
        bounds.forEach((b, i) => value <= b && h.buckets[i]++);
        h.sum += value;
        h.count++;
      }),
    event: <E extends EventName>(name: E, props: EventProps[E]) =>
      safe(() => {
        const t = now();
        if (t - lastEventAt > SESSION_IDLE_MS) session = rand();
        lastEventAt = t;
        if (!(name in EVENT_PROP_KEYS)) return;
        const clean = cleanProps(name, props) as EventProps[E];
        events.push({event: name, ts: new Date(t).toISOString(), event_id: rand(), session_id: session, user_id: ctx.userId, project_id: ctx.projectId, page: ctx.page, app_version: opts.appVersion ?? 'dev', props: clean});
        if (events.length > max) events = events.slice(events.length - max);
      }),
    setContext: c => {
      ctx = {...ctx, ...c} as Required<TelemetryContext>;
    },
    allowLabelValues: (label, values) =>
      safe(() => {
        let set = allowed.get(label);
        if (!set) allowed.set(label, (set = new Set()));
        for (const v of values) if (v && v.length <= 48 && !NOT_A_LABEL.test(v)) set.add(v);
      }),
    render() {
      const out: string[] = [];
      for (const name of Object.keys(METRICS) as MetricName[]) {
        const m = series.get(name);
        if (!m?.size) continue;
        const spec = METRICS[name];
        out.push(`# HELP ${name} ${spec.help}`, `# TYPE ${name} ${spec.type}`);
        for (const {labels, value} of m.values()) {
          const fmt = (extra: Record<string, string> = {}) =>
            '{' +
            Object.entries({...labels, ...extra})
              .map(([k, v]) => `${k}="${escape(v)}"`)
              .join(',') +
            '}';
          if (typeof value === 'number') out.push(`${name}${fmt()} ${value}`);
          else {
            const bounds = (spec as {buckets?: readonly number[]}).buckets ?? [];
            bounds.forEach((b, i) => out.push(`${name}_bucket${fmt({le: String(b)})} ${value.buckets[i]}`));
            out.push(`${name}_bucket${fmt({le: '+Inf'})} ${value.count}`, `${name}_sum${fmt()} ${value.sum}`, `${name}_count${fmt()} ${value.count}`);
          }
        }
      }
      return out.join('\n') + (out.length ? '\n' : '');
    },
    flush() {
      // A flush asked for while one is sending runs after it, so events buffered meanwhile are
      // sent too (a caller on page hide can rely on what it awaited).
      const prev = flushing ?? Promise.resolve();
      const mine: Promise<void> = prev.then(async () => {
        const batch = events;
        events = [];
        try {
          if (batch.length) await opts.sink.pushEvents(batch);
          await opts.sink.pushMetrics(port.render());
        } catch {
          // lost: telemetry may drop data, the audit log is the record
        } finally {
          if (flushing === mine) flushing = null;
        }
      });
      flushing = mine;
      return mine;
    },
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };

  const timer = opts.flushMs === 0 ? null : setInterval(() => void port.flush(), opts.flushMs ?? 10_000);
  (timer as {unref?: () => void} | null)?.unref?.();
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void port.flush();
    });
  return port;
}
