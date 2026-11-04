/**
 * One runner per task. In the browser this uses the Web Locks API, which covers every tab of the
 * same site in this browser; elsewhere (Node tests) it falls back to an in-memory lock.
 * Two different computers are not coordinated in the MVP (see docs/architecture.md).
 */
export interface TaskLocks {
  /** Runs fn while holding the lock, or returns null at once when someone else holds it. */
  run<T>(name: string, fn: () => Promise<T>): Promise<T | null>;
  isHeld(name: string): Promise<boolean>;
}

interface LockManagerLike {
  request(name: string, options: {ifAvailable: boolean}, cb: (lock: unknown) => Promise<unknown>): Promise<unknown>;
  query(): Promise<{held?: {name?: string}[]}>;
}

export function memoryLocks(): TaskLocks {
  const held = new Set<string>();
  return {
    async run(name, fn) {
      if (held.has(name)) return null;
      held.add(name);
      try {
        return await fn();
      } finally {
        held.delete(name);
      }
    },
    isHeld: async name => held.has(name),
  };
}

export function browserLocks(): TaskLocks {
  const locks = (globalThis as {navigator?: {locks?: LockManagerLike}}).navigator?.locks;
  if (!locks) return memoryLocks();
  return {
    async run<T>(name: string, fn: () => Promise<T>) {
      let ran = false;
      const out = await locks.request(name, {ifAvailable: true}, async lock => {
        if (!lock) return null;
        ran = true;
        return fn();
      });
      return ran ? (out as T) : null;
    },
    async isHeld(name) {
      const state = await locks.query();
      return !!state.held?.some(l => l.name === name);
    },
  };
}
