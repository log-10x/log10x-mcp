/**
 * Shared retry / sleep / stop helpers for SIEM connectors.
 *
 * Everything here is deliberately tiny and stateless so connectors can
 * orchestrate retries and stop conditions without pulling in a full
 * retry library. The AWS SDK / Elasticsearch SDK / Azure SDK each have
 * their own built-in retry; this file wraps user-facing operations
 * (pagination loops, transient failures) where the SDK doesn't retry
 * for us.
 */

/** Sleep for N milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Jittered exponential backoff — ms = base * 2^attempt +/- up to 20%. */
export function backoffMs(attempt: number, baseMs = 500, capMs = 20_000): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, attempt));
  const jitter = exp * 0.4 * (Math.random() - 0.5); // +/-20%
  return Math.max(100, Math.floor(exp + jitter));
}

/**
 * Parse a window expression like `1h`, `24h`, `7d`, `30d` into milliseconds.
 * Accepts minute/hour/day suffixes. Throws on invalid input.
 *
 * Lives here (not in the registry index) to avoid circular imports between
 * connectors and the registry.
 */
export function parseWindowMs(expr: string): number {
  const m = expr.trim().match(/^(\d+)([smhd])$/i);
  if (!m) throw new Error(`Invalid window "${expr}". Expected format like "1h", "24h", "7d".`);
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      throw new Error(`Invalid window unit in "${expr}"`);
  }
}

/** Stop-condition: either deadline reached or event target reached. */
export function shouldStop(deadline: number, fetched: number, target: number): boolean {
  if (fetched >= target) return true;
  if (Date.now() >= deadline) return true;
  return false;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  /** Hook to decide whether a specific error is retryable (default: everything). */
  isRetryable?: (err: unknown) => boolean;
  /** Called after each retry attempt with the attempt number and error. */
  onRetry?: (attempt: number, err: unknown, waitMs: number) => void;
  /** Respect `Retry-After` header if the error exposes it (429 handling). */
  extractRetryAfterMs?: (err: unknown) => number | undefined;
}

/**
 * Run `fn` with bounded exponential backoff. Up to maxAttempts tries; returns
 * the last error when all attempts fail. The caller should catch and decide
 * whether the failure is fatal (bail out of the pull) or per-page (move on).
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const capMs = opts.capMs ?? 20_000;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = opts.isRetryable ? opts.isRetryable(e) : defaultIsRetryable(e);
      if (!retryable || attempt === maxAttempts - 1) throw e;
      const retryAfter = opts.extractRetryAfterMs ? opts.extractRetryAfterMs(e) : defaultExtractRetryAfterMs(e);
      const wait = retryAfter ?? backoffMs(attempt, baseMs, capMs);
      if (opts.onRetry) opts.onRetry(attempt + 1, e, wait);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function defaultIsRetryable(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number }; statusCode?: number };
  const code = e.code || e.name || '';
  // Common transient signals across vendor SDKs:
  if (/ThrottlingException|Throttled|TooManyRequests|RequestLimitExceeded/i.test(code)) return true;
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/i.test(code)) return true;
  if (/TimeoutError/i.test(code)) return true;
  const status = e.$metadata?.httpStatusCode ?? e.statusCode;
  if (typeof status === 'number' && (status === 429 || (status >= 500 && status < 600))) return true;
  return false;
}

/**
 * Extract a `Retry-After` value (in ms) from common error shapes:
 *   - AWS SDK: `$response.headers['retry-after']`
 *   - fetch / undici: `err.response.headers.get('retry-after')`
 *   - Datadog: `err.response.headers['retry-after']`
 *   - Elastic: `err.meta.headers['retry-after']`
 *
 * Returns undefined when no header is present.
 */
function defaultExtractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const candidates: unknown[] = [
    (e.response as Record<string, unknown> | undefined)?.headers,
    (e as { $response?: { headers?: Record<string, string> } }).$response?.headers,
    (e.meta as Record<string, unknown> | undefined)?.['headers'],
    (e as { headers?: Record<string, string> }).headers,
  ];
  for (const h of candidates) {
    if (!h) continue;
    const headers = h as Record<string, string | number | undefined> & {
      get?: (key: string) => string | undefined;
    };
    let value: string | number | undefined;
    if (typeof headers.get === 'function') {
      value = headers.get('retry-after') ?? headers.get('Retry-After');
    } else {
      value = headers['retry-after'] ?? headers['Retry-After'];
    }
    if (value === undefined || value === null) continue;
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    if (Number.isFinite(n) && n > 0) {
      // Retry-After can be seconds OR a timestamp; very small values are seconds.
      // Cap at 60s to avoid a runaway sleep.
      const secs = Math.min(60, n);
      return Math.floor(secs * 1000);
    }
  }
  return undefined;
}
