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
  clock?: () => number;
  /** Told about keys whose value does not parse, and about failed reads. Never throws. */
  onProblem?: (problem: {kind: 'invalid'; keys: string[]} | {kind: 'unavailable'; error: unknown}) => void;
}

export interface ConfigModule {
  /** Per-tenant reads for `Scope.config` and `JobControl.config`. */
  reader: ConfigReader;
  /**
   * Reads every process-level key and puts the result in force through `configureSystem`.
   * False when the platform could not be read: the values in force stay as they were.
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
  const clock = opts.clock ?? Date.now;
  const problem = (p: Parameters<NonNullable<ConfigOptions['onProblem']>>[0]) => {
    try {
      opts.onProblem?.(p);
    } catch {
      // A reporter that throws must not stop a read.
    }
  };
  const cache = new Map<string, {value: string | null; readAt: number}>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  /** The value of `key`: from the cache while fresh, else from the platform, else the stale one. */
  async function read(key: string): Promise<string | null> {
    const hit = cache.get(key);
    if (hit && clock() - hit.readAt < ttlMs) return hit.value;
    try {
      const value = await port.get(key);
      cache.set(key, {value, readAt: clock()});
      return value;
    } catch (error) {
      problem({kind: 'unavailable', error});
      if (hit) return hit.value;
      throw error;
    }
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
    const keys = systemConfigKeys();
    let values: Record<string, string | null>;
    try {
      values = port.getMany ? await port.getMany(keys) : Object.fromEntries(await Promise.all(keys.map(async k => [k, await port.get(k)] as const)));
    } catch (error) {
      problem({kind: 'unavailable', error});
      return false;
    }
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
          cache.clear();
          void refresh();
        }) ?? null;
      await refresh();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
