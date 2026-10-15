import { CircuitBreaker, type BreakerState } from "./breaker.ts";
import { CircuitOpenError, HttpError, NetworkError, TimeoutError } from "./errors.ts";
import { backoffDelay, isRetryableStatus, isServiceFailure, parseRetryAfter } from "./retry.ts";

export interface GuardOptions {
  /** Per-attempt timeout. Default 10s. */
  timeoutMs?: number;
  /** Extra attempts after the first. Default 3. */
  retries?: number;
  /** First backoff delay. Default 500ms. */
  baseDelayMs?: number;
  /** Backoff cap. Default 15s. */
  maxDelayMs?: number;
  /** Jitter fraction, 0..1. Default 0.2. */
  jitter?: number;
  /** Consecutive failed requests per host before the circuit opens. Default 8. */
  breakerThreshold?: number;
  /** Time the circuit stays open. Default 30s. */
  breakerCooldownMs?: number;
  /** Called for every notable event (retry, breaker change): wire it to your logger. */
  onEvent?: (event: GuardEvent) => void;
  // Injection points, mostly for tests.
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface RequestOptions extends Omit<RequestInit, "signal"> {
  timeoutMs?: number;
  retries?: number;
  /**
   * Skip the circuit breaker for this call. Reserve it for the critical path, such as reading the
   * price of an open position: being blind is worse than insisting on a degraded API.
   */
  critical?: boolean;
  /** Statuses meaning "nothing there, but valid" (e.g. 404): resolve with `null`, don't retry. */
  treatAsEmpty?: number[];
  /** Caller's own cancellation signal. Aborting is never retried. */
  signal?: AbortSignal;
}

export type GuardEvent =
  | { type: "retry"; url: string; attempt: number; delayMs: number; reason: string }
  | { type: "circuit"; host: string; state: BreakerState };

const DEFAULTS = {
  timeoutMs: 10_000,
  retries: 3,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitter: 0.2,
  breakerThreshold: 8,
  breakerCooldownMs: 30_000,
};

export interface Guard {
  /** Returns the `Response` (2xx only). Throws `HttpError`, `TimeoutError`, `NetworkError` or `CircuitOpenError`. */
  request(url: string, options?: RequestOptions): Promise<Response | null>;
  /** GET/POST and parse JSON. `null` when the status is in `treatAsEmpty`. */
  json<T = unknown>(url: string, options?: RequestOptions): Promise<T | null>;
  text(url: string, options?: RequestOptions): Promise<string | null>;
  /** Per-host breaker state, handy for health endpoints. */
  breakers(): Record<string, { state: BreakerState; failures: number; retryAfterMs: number }>;
}

export function createGuard(options: GuardOptions = {}): Guard {
  const cfg = { ...DEFAULTS, ...stripUndefined(options) };
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const emit = options.onEvent ?? (() => {});
  const breakers = new Map<string, CircuitBreaker>();

  function breakerFor(host: string): CircuitBreaker {
    let b = breakers.get(host);
    if (!b) {
      b = new CircuitBreaker({ threshold: cfg.breakerThreshold, cooldownMs: cfg.breakerCooldownMs }, now);
      breakers.set(host, b);
    }
    return b;
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return "invalid";
    }
  }

  async function attemptOnce(url: string, opts: RequestOptions, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { timeoutMs: _t, retries: _r, critical: _c, treatAsEmpty: _e, signal: _s, ...init } = opts;
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (opts.signal?.aborted) throw err; // caller cancelled: propagate untouched
      if (timedOut) throw new TimeoutError(url, timeoutMs);
      throw new NetworkError(url, err);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async function request(url: string, opts: RequestOptions = {}): Promise<Response | null> {
    const host = hostOf(url);
    const breaker = breakerFor(host);
    const critical = opts.critical === true;
    const retries = opts.retries ?? cfg.retries;
    const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
    const before = breaker.state();

    if (!critical && !breaker.tryAcquire()) {
      throw new CircuitOpenError(host, breaker.retryAfterMs() || cfg.breakerCooldownMs);
    }

    const finish = (ok: boolean): void => {
      if (critical) return; // critical calls neither trip nor heal the breaker
      if (ok) breaker.success();
      else breaker.failure();
      const after = breaker.state();
      if (after !== before) emit({ type: "circuit", host, state: after });
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let waitMs = backoffDelay(attempt, cfg.baseDelayMs, cfg.maxDelayMs, cfg.jitter, random);
      let reason: string;
      try {
        const res = await attemptOnce(url, opts, timeoutMs);
        if (res.ok) {
          finish(true);
          return res;
        }
        if (opts.treatAsEmpty?.includes(res.status)) {
          finish(true);
          return null;
        }
        lastError = new HttpError(res.status, url);
        reason = `HTTP ${res.status}`;
        if (!isRetryableStatus(res.status)) {
          finish(!isServiceFailure(res.status)); // a 4xx means the API is up
          throw lastError;
        }
        const hinted = parseRetryAfter(res.headers.get("retry-after"), now());
        if (hinted !== null) waitMs = Math.min(hinted, cfg.maxDelayMs * 4);
        await res.body?.cancel().catch(() => {});
      } catch (err) {
        if (err === lastError && err instanceof HttpError && !isRetryableStatus(err.status)) throw err;
        if (opts.signal?.aborted) {
          if (!critical) breaker.release();
          throw err;
        }
        if (!(err instanceof TimeoutError || err instanceof NetworkError)) throw err;
        lastError = err;
        reason = err.name;
      }
      if (attempt === retries) break;
      emit({ type: "retry", url: new URL(url).origin + new URL(url).pathname, attempt: attempt + 1, delayMs: waitMs, reason });
      await sleep(waitMs);
    }
    finish(false);
    throw lastError!;
  }

  return {
    request,
    async json<T>(url: string, opts?: RequestOptions) {
      const res = await request(url, opts);
      return res ? ((await res.json()) as T) : null;
    },
    async text(url: string, opts?: RequestOptions) {
      const res = await request(url, opts);
      return res ? await res.text() : null;
    },
    breakers() {
      return Object.fromEntries([...breakers].map(([host, b]) => [host, b.snapshot()]));
    },
  };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
