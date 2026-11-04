/**
 * Rate limiter for one endpoint: requests per minute, tokens per minute and calls in flight.
 *
 * A call first reserves its estimated tokens; when it finishes, the reservation is corrected to
 * the real usage. A call that would go over QPM or TPM waits in a FIFO queue until the window
 * frees up; nothing is ever sent over the limit. After a 429 the limiter halves its concurrency
 * and holds all calls for the time the endpoint asked; each quiet window adds one call back.
 */

export interface LimiterOptions {
  qpm: number;
  tpm: number;
  maxConcurrency: number;
  /** Length of the rate window. One minute in production; shorter in tests. */
  windowMs?: number;
  now?: () => number;
}

export interface Permit {
  /** Call when the request finished, with the real token count when known. */
  release(actualTokens?: number): void;
}

interface Entry {
  at: number;
  tokens: number;
}

interface Waiter {
  tokens: number;
  resolve: (p: Permit) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class EndpointLimiter {
  readonly qpm: number;
  readonly tpm: number;
  readonly maxConcurrency: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private window: Entry[] = [];
  private inFlight = 0;
  private concurrency: number;
  private holdUntil = 0;
  private lastPenalty = 0;
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(o: LimiterOptions) {
    this.qpm = o.qpm;
    this.tpm = o.tpm;
    this.maxConcurrency = Math.max(1, o.maxConcurrency);
    this.concurrency = this.maxConcurrency;
    this.windowMs = o.windowMs ?? 60_000;
    this.now = o.now ?? Date.now;
  }

  /** Current state, for tests and diagnostics. */
  stats() {
    this.prune();
    return {
      inFlight: this.inFlight,
      concurrency: this.concurrency,
      requestsInWindow: this.window.length,
      tokensInWindow: this.window.reduce((n, e) => n + e.tokens, 0),
      waiting: this.queue.length,
    };
  }

  acquire(estimatedTokens: number, signal?: AbortSignal): Promise<Permit> {
    if (signal?.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
    return new Promise<Permit>((resolve, reject) => {
      const w: Waiter = {tokens: Math.max(1, Math.round(estimatedTokens)), resolve, reject, signal};
      if (signal) {
        w.onAbort = () => {
          this.queue = this.queue.filter(x => x !== w);
          reject(new DOMException('Stopped', 'AbortError'));
        };
        signal.addEventListener('abort', w.onAbort, {once: true});
      }
      this.queue.push(w);
      this.pump();
    });
  }

  /** The endpoint said "too many requests": slow down and hold calls for a while. */
  onRateLimited(retryAfterMs: number) {
    const t = this.now();
    this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
    this.holdUntil = Math.max(this.holdUntil, t + retryAfterMs);
    this.lastPenalty = t;
    this.schedule(retryAfterMs);
  }

  private prune() {
    const cutoff = this.now() - this.windowMs;
    while (this.window.length && this.window[0].at <= cutoff) this.window.shift();
  }

  private recover() {
    const t = this.now();
    if (this.concurrency < this.maxConcurrency && t - this.lastPenalty >= this.windowMs) {
      this.concurrency++;
      this.lastPenalty = t;
    }
  }

  private fits(tokens: number): boolean {
    if (this.inFlight >= this.concurrency) return false;
    if (this.window.length >= this.qpm) return false;
    const used = this.window.reduce((n, e) => n + e.tokens, 0);
    // A single call larger than the whole TPM may still go alone, so it never waits forever.
    return used + tokens <= this.tpm || (used === 0 && this.inFlight === 0);
  }

  private pump() {
    this.prune();
    this.recover();
    const t = this.now();
    if (t < this.holdUntil) return this.schedule(this.holdUntil - t);
    while (this.queue.length && this.fits(this.queue[0].tokens)) {
      const w = this.queue.shift()!;
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      const entry: Entry = {at: this.now(), tokens: w.tokens};
      this.window.push(entry);
      this.inFlight++;
      let released = false;
      w.resolve({
        release: (actual?: number) => {
          if (released) return;
          released = true;
          if (actual != null && actual >= 0) entry.tokens = actual;
          this.inFlight--;
          this.pump();
        },
      });
    }
    // Still waiting on the window (not on a call in flight): wake when the oldest entry expires.
    if (this.queue.length && this.inFlight < this.concurrency && this.window.length) {
      this.schedule(this.window[0].at + this.windowMs - this.now() + 1);
    }
  }

  private schedule(ms: number) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, ms));
  }
}
