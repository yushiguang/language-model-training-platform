import type {SharedStatePort} from '@sprint/contracts';

/**
 * The shared-state stand-in: a map in this process, with TTL expiry. Right for the browser (one
 * process per tab) and for tests; a server deployment backs `SharedStatePort` with a shared store
 * so every replica sees the same keys. Values go through JSON, as they would through a store, so
 * code never counts on keeping a reference to what it wrote.
 */
export function memorySharedState(clock: () => number = Date.now): SharedStatePort {
  const kept = new Map<string, {json: string; until: number}>();
  return {
    async get<T>(key: string) {
      const e = kept.get(key);
      if (!e) return null;
      if (e.until <= clock()) {
        kept.delete(key);
        return null;
      }
      return JSON.parse(e.json) as T;
    },
    async set(key, value, ttlMs) {
      kept.set(key, {json: JSON.stringify(value), until: clock() + ttlMs});
    },
    async delete(key) {
      kept.delete(key);
    },
  };
}
