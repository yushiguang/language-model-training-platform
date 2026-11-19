import type {LockPort, LockStorePort} from '@yushiguang/sprint-contracts';
import {newId} from '@yushiguang/sprint-domain';

/**
 * The lock store stand-in: every lock's lease in this process's memory. Right for the browser and
 * one server process, and for tests that run several lock adapters against one store. Each method
 * runs to its end before the next starts (one thread), which is the atomicity a shared store gets
 * from `SET NX PX`, a script or a conditional update (see `LockStorePort` in the contracts).
 */
export function memoryLockStore(): LockStorePort {
  const locks = new Map<string, {owner: string; until: number}>();
  /** The lock's lease at `now`, dropping it (and answering none) once it has ended. */
  const live = (name: string, now: number) => {
    const e = locks.get(name);
    if (!e) return undefined;
    if (e.until <= now) {
      locks.delete(name);
      return undefined;
    }
    return e;
  };
  return {
    async acquire(name, owner, leaseMs, now) {
      if (live(name, now)) return false;
      locks.set(name, {owner, until: now + leaseMs});
      return true;
    },
    async renew(name, owner, leaseMs, now) {
      const e = live(name, now);
      if (!e || e.owner !== owner) return false;
      e.until = now + leaseMs;
      return true;
    },
    async release(name, owner) {
      if (locks.get(name)?.owner === owner) locks.delete(name);
    },
    async isHeld(name, now) {
      return !!live(name, now);
    },
  };
}

export interface LeaseLocksOptions {
  /** How long a lock's lease lasts without a renewal (default 30 s, as a job's lease). */
  leaseMs?: number;
  /** How often a running lock's lease is renewed (default a third of the lease, as a job's heartbeat). */
  renewMs?: number;
  /** The clock leases are taken and renewed by (tests pass a fixed one). Default `Date.now`. */
  clock?: () => number;
}

/**
 * The locks the apps take (`LockPort`: labeling's tasks and predictions, the Optimiser's runs, the
 * workflow's source locks), over a `LockStorePort` shared by every process — in a server
 * deployment the platform's `Platform.lockStore`, so a lock taken in one unit is seen (and waited
 * out) in every other. Each `run` takes the lock under a fresh owner, renews its lease while the
 * work runs, and releases it in `finally`; `run` returns null at once when someone else holds the
 * lock. A renewal that fails (the lease already ended, the store unreachable) cannot stop the work
 * in flight — the caller carries on and, where it matters, re-checks saved work before paying
 * again (the fencing limit `LockStorePort` documents). With no shared store a deployment locks in
 * one process instead (`browserLocks` / `memoryLocks` from `@yushiguang/sprint-labeling`).
 */
export function leaseLocks(store: LockStorePort, opts: LeaseLocksOptions = {}): LockPort {
  const leaseMs = opts.leaseMs ?? 30_000;
  const renewMs = opts.renewMs ?? Math.max(10, Math.floor(leaseMs / 3));
  const clock = opts.clock ?? Date.now;
  return {
    async run(name, fn) {
      const owner = newId('lock');
      if (!(await store.acquire(name, owner, leaseMs, clock()))) return null;
      const timer = setInterval(() => void store.renew(name, owner, leaseMs, clock()).catch(() => undefined), renewMs);
      (timer as {unref?: () => void}).unref?.();
      try {
        return await fn();
      } finally {
        clearInterval(timer);
        await store.release(name, owner).catch(() => undefined);
      }
    },
    isHeld: name => store.isHeld(name, clock()),
  };
}
