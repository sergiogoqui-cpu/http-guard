/** Strip credentials and query string so errors and logs can't leak API keys. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "invalid-url";
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string, message?: string) {
    super(message ?? `HTTP ${status} from ${safeUrl(url)}`);
    this.name = "HttpError";
    this.status = status;
    this.url = safeUrl(url);
  }
}

export class TimeoutError extends Error {
  readonly url: string;
  constructor(url: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms: ${safeUrl(url)}`);
    this.name = "TimeoutError";
    this.url = safeUrl(url);
  }
}

export class NetworkError extends Error {
  readonly url: string;
  constructor(url: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Network error for ${safeUrl(url)}: ${reason}`);
    this.name = "NetworkError";
    this.url = safeUrl(url);
    this.cause = cause;
  }
}

export class CircuitOpenError extends Error {
  readonly host: string;
  readonly retryAfterMs: number;
  constructor(host: string, retryAfterMs: number) {
    super(`Circuit open for ${host}; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CircuitOpenError";
    this.host = host;
    this.retryAfterMs = retryAfterMs;
  }
}
