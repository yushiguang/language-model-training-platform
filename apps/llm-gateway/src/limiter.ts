import type {LimiterLimits, LimiterStats, LimiterStorePort} from '@sprint/contracts';
import {newId} from '@sprint/domain';

/**
 * Rate limiter for one endpoint: requests per minute, tokens per minute and calls in flight
 * (deployment readiness spec, 5). The counts live in a `LimiterStorePort` that every replica of
 * every caller shares, so an endpoint has one budget however many processes call it.
 *
 * A call first reserves its estimated tokens; when it finishes, the reservation is corrected to
 * the real usage. A call that would go over QPM or TPM waits in the store's FIFO queue until the
 * window frees up; nothing is ever sent over the limit. After a 429 the endpoint's concurrency is
 * halved and every call is held for the time the endpoint asked; each quiet window adds one call
 * back. A permit's slot is leased and renewed while the call runs, so a process that dies frees
 * its slots when the lease ends.
 *
 * Waiters in this process wake at once when a slot here frees up; for slots freed by another
 * process they ask the store again every `pollMs`, or when the store says the window frees.
 */
export interface LimiterOptions {
  store: LimiterStorePort;
  /** The endpoint's key in the store (its registry id). */
  key: string;
  qpm: number;
  tpm: number;
  maxConcurrency: number;
  /** Length of the rate window. One minute in production; shorter in tests. */
  windowMs?: number;
  /** How long a permit holds its slot without a renewal (default 60 s; renewed every third). */
  leaseMs?: number;
  /** How often a waiter asks the store again when nothing here wakes it (default 250 ms). */
  pollMs?: number;
  now?: () => number;
}

export interface Permit {
  /** Call when the request finished, with the real token count when known. */
  release(actualTokens?: number): void;
}

export class EndpointLimiter {
  readonly qpm: number;
  readonly tpm: number;
  readonly maxConcurrency: number;
  private readonly store: LimiterStorePort;
  private readonly key: string;
  private readonly limits: LimiterLimits;
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  /** Store writes from this limiter, in order: a hold lands before the release that follows it. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Waiters here, woken when a slot here frees up. */
  private wakers = new Set<() => void>();

  constructor(o: LimiterOptions) {
    this.qpm = o.qpm;
    this.tpm = o.tpm;
    this.maxConcurrency = Math.max(1, o.maxConcurrency);
    this.store = o.store;
    this.key = o.key;
    this.limits = {qpm: o.qpm, tpm: o.tpm, maxConcurrency: this.maxConcurrency, windowMs: o.windowMs ?? 60_000};
    this.leaseMs = o.leaseMs ?? 60_000;
    this.pollMs = o.pollMs ?? 250;
    this.now = o.now ?? Date.now;
  }

  /** One store call after the ones before it. */
  private op<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private wakeAll() {
    for (const w of [...this.wakers]) w();
  }

  /** Current state across every process, for gauges and tests. */
  stats(): Promise<LimiterStats> {
    return this.op(() => this.store.stats(this.key, this.limits, this.now()));
  }

  async acquire(estimatedTokens: number, signal?: AbortSignal): Promise<Permit> {
    const stopped = () => new DOMException('Stopped', 'AbortError');
    if (signal?.aborted) throw stopped();
    const ticket = newId('wait');
    const tokens = Math.max(1, Math.round(estimatedTokens));
    try {
      for (;;) {
        const r = await this.op(() => this.store.tryAcquire(this.key, {ticket, tokens, limits: this.limits, leaseMs: this.leaseMs, ticketTtlMs: this.pollMs * 4, now: this.now()}));
        if (r.granted) return this.permit(r.permitId);
        if (signal?.aborted) throw stopped();
        await this.wait(r.waitMs < 0 ? this.pollMs : Math.min(Math.max(1, r.waitMs), this.pollMs), signal);
        if (signal?.aborted) throw stopped();
      }
    } catch (e) {
      // The waiter behind this one may go now.
      await this.op(() => this.store.leave(this.key, ticket)).catch(() => undefined);
      this.wakeAll();
      throw e;
    }
  }

  /** Waits `ms`, or less when a slot here frees up or the caller stops. */
  private wait(ms: number, signal?: AbortSignal) {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(t);
        this.wakers.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.add(done);
      signal?.addEventListener('abort', done, {once: true});
    });
  }

  private permit(permitId: string): Permit {
    // A long call renews its lease, so its slot is not handed out under it.
    const renewal = setInterval(() => void this.op(() => this.store.renew(this.key, permitId, this.leaseMs, this.now())).catch(() => undefined), Math.max(10, Math.floor(this.leaseMs / 3)));
    let released = false;
    return {
      release: (actual?: number) => {
        if (released) return;
        released = true;
        clearInterval(renewal);
        void this.op(() => this.store.release(this.key, permitId, actual != null && actual >= 0 ? actual : null, this.now()))
          .catch(() => undefined)
          .then(() => this.wakeAll());
      },
    };
  }

  /** The endpoint said "too many requests": slow down and hold calls for a while, in every process. */
  onRateLimited(retryAfterMs: number): Promise<void> {
    const out = this.op(() => this.store.penalize(this.key, retryAfterMs, this.limits, this.now()));
    // Waiters here sleep until the hold ends instead of on their old wakeup.
    void out.then(() => this.wakeAll(), () => undefined);
    return out;
  }
}
