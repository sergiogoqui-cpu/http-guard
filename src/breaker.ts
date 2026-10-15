export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerOptions {
  /** Consecutive failed requests before the circuit opens. */
  threshold: number;
  /** How long it stays open before allowing one probe request. */
  cooldownMs: number;
}

/** Classic circuit breaker for one host: closed -> open -> half-open -> closed. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private probing = false;
  private readonly opts: BreakerOptions;
  private readonly now: () => number;

  constructor(opts: BreakerOptions, now: () => number = Date.now) {
    this.opts = opts;
    this.now = now;
  }

  state(): BreakerState {
    if (this.failures < this.opts.threshold) return "closed";
    return this.now() < this.openUntil ? "open" : "half-open";
  }

  /** Milliseconds until a probe is allowed (0 if requests may go through). */
  retryAfterMs(): number {
    return this.state() === "open" ? this.openUntil - this.now() : 0;
  }

  /** Returns true if a request may proceed. In half-open state only one probe at a time. */
  tryAcquire(): boolean {
    const s = this.state();
    if (s === "closed") return true;
    if (s === "open") return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.probing = false;
  }

  failure(): void {
    this.failures += 1;
    this.probing = false;
    if (this.failures >= this.opts.threshold) this.openUntil = this.now() + this.opts.cooldownMs;
  }

  /** Release a half-open probe slot without counting it (e.g. a bypassed or cancelled call). */
  release(): void {
    this.probing = false;
  }

  snapshot(): { state: BreakerState; failures: number; retryAfterMs: number } {
    return { state: this.state(), failures: this.failures, retryAfterMs: this.retryAfterMs() };
  }
}
