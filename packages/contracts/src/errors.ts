/**
 * Shared error type for model calls. Platform adapters should throw `LlmCallError` so the gateway
 * can tell a busy endpoint (retry later) from a rejected request (never retry).
 * Any other thrown error is treated as `server` (retryable).
 */
export type LlmErrorKind = 'rate_limited' | 'server' | 'timeout' | 'rejected' | 'aborted';

export class LlmCallError extends Error {
  readonly kind: LlmErrorKind;
  /** HTTP status when the platform returned one. */
  readonly status?: number;
  /** Rate limited only: how long the endpoint asked us to wait. */
  readonly retryAfterMs?: number;

  constructor(kind: LlmErrorKind, message: string, opts: {status?: number; retryAfterMs?: number} = {}) {
    super(message);
    this.name = 'LlmCallError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Maps any thrown value to an error kind. HTTP-like `status` fields are honoured. */
export function errorKindOf(e: unknown): LlmErrorKind {
  if (e instanceof LlmCallError) return e.kind;
  const err = e as {name?: string; status?: number; code?: string};
  if (err?.name === 'AbortError') return 'aborted';
  if (err?.name === 'TimeoutError' || err?.code === 'ETIMEDOUT') return 'timeout';
  if (typeof err?.status === 'number') {
    if (err.status === 429) return 'rate_limited';
    if (err.status === 408) return 'timeout';
    if (err.status >= 400 && err.status < 500) return 'rejected';
  }
  return 'server';
}
