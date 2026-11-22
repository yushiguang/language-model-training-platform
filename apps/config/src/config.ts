import type {ConfigPort, ConfigReader, DeepPartial, JobLimitTarget, SystemConfig, TenantConfig} from '@yushiguang/sprint-contracts';
import {configureSystem, jobLimitKeys, mergeConfig, parseJobLimit, parseSystemConfig, processJobLimit, systemConfigKeys, tenantKey} from '@yushiguang/sprint-domain';

export interface ConfigOptions {
  /** The configuration platform. */
  port: ConfigPort;
  /** Fixed overrides under the platform's values (`Platform.config`). */
  base?: DeepPartial<SystemConfig>;
  /** How long a value read for a tenant is used before it is read again (default 30 s). */
  ttlMs?: number;
  /** How often `start` refreshes the process-level values (default 30 s). */
  refreshMs?: number;
  /** After a failed read, how long the old value is used before the platform is asked again (default 5 s). */
  retryMs?: number;
  clock?: () => number;
  /** Told about keys whose value does not parse, and about failed reads. Never throws. */
  onProblem?: (problem: {kind: 'invalid'; keys: string[]} | {kind: 'unavailable'; error: unknown}) => void;
}

export interface ConfigModule {
  /** Per-tenant reads for `Scope.config` and `JobControl.config`. */
  reader: ConfigReader;
  /**
   * Reads every process-level key and puts the result in force through `configureSystem`.
   * False when the platform could not be read, or a newer refresh (or `stop`) came first: the
   * values in force stay as they were.
   */
  refresh(): Promise<boolean>;
  /** Refreshes now and then every `refreshMs`, and on the platform's change pushes. */
  start(): Promise<void>;
  stop(): void;
}

/**
 * The configuration module (docs/design/server.md, 7). Two layers:
 *
 * - Process-level values: every `SystemConfig` leaf, read as one key each, refreshed on a timer
 *   and applied with `configureSystem`, so `systemConfig()` stays synchronous and pure code
 *   (`packages/domain`) never does I/O.
 * - Tenant overrides: read on demand through `reader.forTenant(tenantId)`, cached per key for
 *   `ttlMs`. When the platform fails, the last value read is used.
 */
export function createConfig(opts: ConfigOptions): ConfigModule {
  const {port} = opts;
  const ttlMs = opts.ttlMs ?? 30_000;
  const refreshMs = opts.refreshMs ?? 30_000;
  const retryMs = opts.retryMs ?? 5000;
  const clock = opts.clock ?? Date.now;
  const problem = (p: Parameters<NonNullable<ConfigOptions['onProblem']>>[0]) => {
    try {
      opts.onProblem?.(p);
    } catch {
      // A reporter that throws must not stop a read.
    }
  };
  /** `freshUntil`: when the platform is asked again. A push sets it to 0 but keeps the value. */
  const cache = new Map<string, {value: string | null; freshUntil: number}>();
  /** One read per key at a time: callers during a read wait for it. */
  const inFlight = new Map<string, Promise<string | null>>();
  /** Bumped by a push: a read started before it does not write its older answer to the cache. */
  let generation = 0;
  /** Bumped by every refresh and by `stop`: only the newest refresh may apply its answer. */
  let refreshSeq = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  /** The value of `key`: from the cache while fresh, else from the platform, else the stale one. */
  function read(key: string): Promise<string | null> {
    const hit = cache.get(key);
    if (hit && clock() < hit.freshUntil) return Promise.resolve(hit.value);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const gen = generation;
    const p = (async () => {
      try {
        const value = await port.get(key);
        if (gen === generation) cache.set(key, {value, freshUntil: clock() + ttlMs});
        return value;
      } catch (error) {
        problem({kind: 'unavailable', error});
        const old = cache.get(key);
        if (!old) throw error;
        // Use the old value for a while instead of waiting on a failing platform every call.
        old.freshUntil = Math.max(old.freshUntil, clock() + retryMs);
        return old.value;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  }

  /** A push: every cached value is read again on next use, and kept for an outage. */
  function invalidate() {
    generation++;
    inFlight.clear();
    for (const e of cache.values()) e.freshUntil = 0;
  }

  function forTenant(tenantId: string | undefined): TenantConfig {
    return {
      async get(key) {
        return tenantId ? read(tenantKey(tenantId, key)) : null;
      },
      async jobLimit(target: JobLimitTarget) {
        for (const key of jobLimitKeys(tenantId, target)) {
          const raw = await read(key).catch(() => null);
          const n = parseJobLimit(raw);
          if (n !== null) return n;
          if (raw !== null) problem({kind: 'invalid', keys: [key]});
        }
        return processJobLimit(target);
      },
    };
  }

  async function refresh(): Promise<boolean> {
    const seq = ++refreshSeq;
    const keys = systemConfigKeys();
    let values: Record<string, string | null>;
    try {
      values = port.getMany ? await port.getMany(keys) : Object.fromEntries(await Promise.all(keys.map(async k => [k, await port.get(k)] as const)));
    } catch (error) {
      problem({kind: 'unavailable', error});
      return false;
    }
    // A newer refresh started (or `stop` ran) while this one read: its answer is older, drop it.
    if (seq !== refreshSeq) return false;
    const {overrides, invalid} = parseSystemConfig(values);
    if (invalid.length) problem({kind: 'invalid', keys: invalid});
    configureSystem(mergeConfig(opts.base ?? {}, overrides));
    return true;
  }

  return {
    reader: {forTenant},
    refresh,
    async start() {
      if (timer) return;
      timer = setInterval(() => void refresh(), refreshMs);
      // A server process must not stay up just for this timer.
      (timer as {unref?: () => void}).unref?.();
      unsubscribe =
        port.subscribe?.(() => {
          invalidate();
          void refresh();
        }) ?? null;
      await refresh();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
      refreshSeq++;
    },
  };
}
