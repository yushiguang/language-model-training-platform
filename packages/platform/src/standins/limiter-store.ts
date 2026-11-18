import type {LimiterLimits, LimiterStats, LimiterStorePort, LimiterTry} from '@yushiguang/sprint-contracts';

interface Entry {
  at: number;
  tokens: number;
}

interface Endpoint {
  /** The sliding window, oldest first. */
  window: Entry[];
  /** Permits holding a slot: their window entry and when their lease ends. */
  permits: Map<string, {entry: Entry; until: number}>;
  concurrency: number;
  holdUntil: number;
  lastPenalty: number;
  /** Waiters, first in first out, each with when its ticket expires. */
  queue: {ticket: string; until: number}[];
}

/**
 * The limiter store stand-in: every endpoint's limiter state in this process's memory. Right for
 * the browser and one gateway process, and for tests that run several limiters against one store.
 * Each method runs to its end before the next starts (one thread), which is the atomicity a shared
 * store gets from a script or a transaction.
 */
export function memoryLimiterStore(): LimiterStorePort {
  const endpoints = new Map<string, Endpoint>();
  let seq = 0;

  const state = (key: string, limits?: LimiterLimits): Endpoint => {
    let e = endpoints.get(key);
    if (!e) {
      e = {window: [], permits: new Map(), concurrency: Math.max(1, limits?.maxConcurrency ?? 1), holdUntil: 0, lastPenalty: 0, queue: []};
      endpoints.set(key, e);
    }
    return e;
  };

  /** Drops expired entries, leases and tickets, and gives back one slot per quiet window. */
  function tidy(e: Endpoint, limits: LimiterLimits, now: number) {
    const cutoff = now - limits.windowMs;
    while (e.window.length && e.window[0].at <= cutoff) e.window.shift();
    // A permit whose lease ended frees its slot; its window entry stays as estimated.
    for (const [id, p] of e.permits) if (p.until <= now) e.permits.delete(id);
    e.queue = e.queue.filter(w => w.until > now);
    const max = Math.max(1, limits.maxConcurrency);
    if (e.concurrency > max) e.concurrency = max;
    if (e.concurrency < max && now - e.lastPenalty >= limits.windowMs) {
      e.concurrency++;
      e.lastPenalty = now;
    }
  }

  const used = (e: Endpoint) => e.window.reduce((n, x) => n + x.tokens, 0);

  return {
    async tryAcquire(key, {ticket, tokens, limits, leaseMs, ticketTtlMs, now}): Promise<LimiterTry> {
      const e = state(key, limits);
      tidy(e, limits, now);
      const mine = e.queue.find(w => w.ticket === ticket);
      if (mine) mine.until = now + ticketTtlMs;
      else e.queue.push({ticket, until: now + ticketTtlMs});
      if (now < e.holdUntil) return {granted: false, waitMs: e.holdUntil - now};
      // First in, first out: only the waiter at the front may take a slot.
      if (e.queue[0].ticket !== ticket) return {granted: false, waitMs: -1};
      if (e.permits.size >= e.concurrency) return {granted: false, waitMs: -1};
      const total = used(e);
      const fitsWindow = e.window.length < limits.qpm && (total + tokens <= limits.tpm || (total === 0 && e.permits.size === 0));
      if (!fitsWindow) return {granted: false, waitMs: e.window.length ? e.window[0].at + limits.windowMs - now + 1 : -1};
      e.queue.shift();
      const entry = {at: now, tokens};
      e.window.push(entry);
      const permitId = `permit_${++seq}`;
      e.permits.set(permitId, {entry, until: now + leaseMs});
      return {granted: true, permitId};
    },
    async leave(key, ticket) {
      const e = endpoints.get(key);
      if (e) e.queue = e.queue.filter(w => w.ticket !== ticket);
    },
    async release(key, permitId, actualTokens) {
      const p = endpoints.get(key)?.permits.get(permitId);
      if (!p) return;
      if (actualTokens != null && actualTokens >= 0) p.entry.tokens = actualTokens;
      endpoints.get(key)!.permits.delete(permitId);
    },
    async renew(key, permitId, leaseMs, now) {
      const p = endpoints.get(key)?.permits.get(permitId);
      if (!p || p.until <= now) return false;
      p.until = now + leaseMs;
      return true;
    },
    async penalize(key, retryAfterMs, limits, now) {
      const e = state(key, limits);
      e.concurrency = Math.max(1, Math.floor(e.concurrency / 2));
      e.holdUntil = Math.max(e.holdUntil, now + retryAfterMs);
      e.lastPenalty = now;
    },
    async stats(key, limits, now): Promise<LimiterStats> {
      const e = state(key, limits);
      tidy(e, limits, now);
      return {inFlight: e.permits.size, concurrency: e.concurrency, requestsInWindow: e.window.length, tokensInWindow: used(e), waiting: e.queue.length};
    },
  };
}
