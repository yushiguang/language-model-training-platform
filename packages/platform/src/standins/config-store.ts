import type {ConfigPort} from '@yushiguang/sprint-contracts';

/**
 * The configuration platform's stand-in: a map in this process. `set` changes a value and tells
 * subscribers, as a platform's push would; `down(true)` makes every read throw, as an outage
 * does, so tests can check that the cache keeps the old values. A key set to null is unset.
 */
export interface MemoryConfig extends ConfigPort {
  getMany(keys: string[]): Promise<Record<string, string | null>>;
  subscribe(onChange: () => void): () => void;
  set(key: string, value: string | null): void;
  down(isDown: boolean): void;
}

export function memoryConfig(initial: Record<string, string> = {}): MemoryConfig {
  const values = new Map(Object.entries(initial));
  const listeners = new Set<() => void>();
  let isDown = false;
  const read = (key: string) => {
    if (isDown) throw new Error('configuration platform unavailable');
    return values.get(key) ?? null;
  };
  return {
    get: async key => read(key),
    getMany: async keys => Object.fromEntries(keys.map(k => [k, read(k)])),
    subscribe(onChange) {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
    set(key, value) {
      if (value === null) values.delete(key);
      else values.set(key, value);
      listeners.forEach(fn => fn());
    },
    down(d) {
      isDown = d;
    },
  };
}
