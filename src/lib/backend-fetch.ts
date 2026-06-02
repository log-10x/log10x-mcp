/**
 * backend-fetch — shared retry+timeout primitive for every PromQL-compatible
 * backend the MCP talks to.
 *
 * Replaces the per-backend bespoke `fetch(...)` blocks that previously lived
 * inside metrics-backend.ts and customer-metrics.ts. The contract:
 *
 *   - Default 3 attempts (`LOG10X_RETRY_ATTEMPTS` override).
 *   - 250ms base backoff, exponential with jitter (`LOG10X_RETRY_BASE_MS`).
 *   - 30s per-attempt timeout via AbortController (`LOG10X_REQUEST_TIMEOUT_MS`).
 *   - Retry classes: network exception, AbortError (→ timeout), HTTP 5xx, HTTP 429.
 *   - Non-retryable: any other 4xx — surfaced immediately with kind-labelled body.
 *   - AMP path: `reSignPerAttempt` callback rebuilds the signed init each
 *     attempt so SigV4 timestamps stay fresh.
 *
 * Error envelope:
 *   `${kindLabel} HTTP <status> <statusText>: <body.slice(0,400)>`
 *   `${kindLabel}: request timed out after ${timeoutMs}ms`
 *   `${kindLabel}: fetch failed after ${attempts} attempts`
 *
 * Consumed by promJsonFetch (metrics-backend.ts) and all six customer-metrics
 * backends. tool-errors.ts widens its transient-failure regex to match the
 * new error tails (FIX C).
 */

const DEFAULT_ATTEMPTS = parseInt(process.env.LOG10X_RETRY_ATTEMPTS || '3', 10) || 3;
const DEFAULT_BASE_MS = parseInt(process.env.LOG10X_RETRY_BASE_MS || '250', 10) || 250;
const DEFAULT_TIMEOUT_MS = parseInt(process.env.LOG10X_REQUEST_TIMEOUT_MS || '30000', 10) || 30000;

export interface BackendFetchOpts {
  /** Short identifier for error envelopes + console.warn lines. */
  kindLabel: string;
  /** Per-attempt timeout. Defaults to LOG10X_REQUEST_TIMEOUT_MS or 30000. */
  timeoutMs?: number;
  /** Max attempts (1 = no retry). Defaults to LOG10X_RETRY_ATTEMPTS or 3. */
  attempts?: number;
  /** Exponential backoff base. Defaults to LOG10X_RETRY_BASE_MS or 250. */
  baseMs?: number;
  /**
   * AMP-style: rebuild a freshly-signed init each attempt. When provided,
   * the caller-supplied `init` is ignored and replaced per attempt with
   * the return value of `reSignPerAttempt()`. The `signal` from the
   * per-attempt AbortController is merged in.
   */
  reSignPerAttempt?: () => Promise<RequestInit>;
}

type RetryReason = 'network' | 'timeout' | 'http 5xx' | 'http 429';

function mergeSignal(init: RequestInit | undefined, signal: AbortSignal): RequestInit {
  return { ...(init || {}), signal };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message));
}

/**
 * Core fetch primitive. Returns the Response on success (2xx). Throws on:
 *   - retryable exhaustion (5xx / 429 / network / timeout × attempts)
 *   - non-retryable 4xx (status < 500, status !== 429) — immediately.
 */
export async function backendFetch(
  url: string,
  init: RequestInit,
  opts: BackendFetchOpts
): Promise<Response> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const kindLabel = opts.kindLabel;

  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let attemptInit: RequestInit;
    if (opts.reSignPerAttempt) {
      const signed = await opts.reSignPerAttempt();
      attemptInit = mergeSignal(signed, controller.signal);
    } else {
      attemptInit = mergeSignal(init, controller.signal);
    }

    let res: Response;
    let reason: RetryReason | undefined;

    try {
      try {
        res = await fetch(url, attemptInit);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const err = e as Error;
      if (isAbortError(err)) {
        lastErr = new Error(`${kindLabel}: request timed out after ${timeoutMs}ms`);
        reason = 'timeout';
      } else {
        lastErr = err;
        reason = 'network';
      }
      if (attempt < attempts - 1) {
        const delayMs = baseMs * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
        console.warn(
          `[backend-fetch] ${kindLabel} attempt ${attempt + 1}/${attempts} failed (${reason}); retrying in ${delayMs}ms`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
      continue;
    }

    if (res.ok) return res;

    // Non-retryable 4xx (anything other than 429) — surface immediately.
    if (res.status < 500 && res.status !== 429) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `${kindLabel} HTTP ${res.status} ${res.statusText}: ${body.slice(0, 400)}`
      );
    }

    // 5xx and 429 are retryable.
    const body = await res.text().catch(() => '');
    lastErr = new Error(
      `${kindLabel} HTTP ${res.status} ${res.statusText}: ${body.slice(0, 400)}`
    );
    reason = res.status === 429 ? 'http 429' : 'http 5xx';

    if (attempt < attempts - 1) {
      const delayMs = baseMs * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
      console.warn(
        `[backend-fetch] ${kindLabel} attempt ${attempt + 1}/${attempts} failed (${reason}); retrying in ${delayMs}ms`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr || new Error(`${kindLabel}: fetch failed after ${attempts} attempts`);
}

/**
 * JSON wrapper. Parses .json() on success. Error envelope on non-ok was
 * already thrown by backendFetch. Network/timeout failures bubble up
 * unchanged.
 */
export async function backendJsonFetch<T>(
  url: string,
  init: RequestInit,
  opts: BackendFetchOpts
): Promise<T> {
  const res = await backendFetch(url, init, opts);
  return (await res.json()) as T;
}
