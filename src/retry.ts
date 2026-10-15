/** Exponential backoff with jitter: `base * 2^attempt`, capped, spread by ±jitter. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitter: number,
  random: () => number,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  const spread = exp * jitter;
  return Math.max(0, exp - spread + random() * 2 * spread);
}

/** Parse a `Retry-After` header: seconds, or an HTTP date. Returns ms, or null. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Statuses worth retrying: timeout, rate limit, and server-side trouble. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Statuses that say "the service is struggling" and count against the circuit breaker. */
export function isServiceFailure(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
