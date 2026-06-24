/**
 * Tiny single-flight semaphore / concurrency limiter.
 *
 * Used by log10x_investigate's correlation engine to fan out lag-analysis
 * queries in parallel while respecting max_parallel_promql_queries without
 * adding a p-limit dependency.
 *
 * Usage:
 *   const limit = createLimiter(30);
 *   const results = await Promise.all(tasks.map((t) => limit(() => t())));
 *
 * The limiter also supports a soft deadline: tasks enqueued after the
 * deadline resolve immediately with `undefined` so upstream code can tell
 * whether a slot was filled or skipped.
 */

export interface Limiter {
  <T>(fn: () => Promise<T>): Promise<T | undefined>;
  /** Number of tasks currently running. */
  active(): number;
  /** Number of tasks waiting in the queue. */
  pending(): number;
  /** Mark the limiter as soft-expired — new tasks resolve to undefined. */
  softExpire(): void;
  isSoftExpired(): boolean;
}

export function createLimiter(concurrency: number, softDeadlineMs?: number): Limiter {
  if (concurrency <= 0) throw new Error(`Concurrency must be > 0, got ${concurrency}`);
  let running = 0;
  const queue: Array<() => void> = [];
  let softExpired = false;
  const deadline = softDeadlineMs ? Date.now() + softDeadlineMs : Infinity;

  const checkDeadline = () => {
    if (!softExpired && Date.now() >= deadline) softExpired = true;
  };

  const next = () => {
    checkDeadline();
    if (running >= concurrency) return;
    const task = queue.shift();
    if (task) task();
  };

  const limiter = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    checkDeadline();
    if (softExpired) return undefined;

    return new Promise<T | undefined>((resolve, reject) => {
      const run = async () => {
        if (softExpired) {
          resolve(undefined);
          return;
        }
        running += 1;
        try {
          const result = await fn();
          resolve(result);
        } catch (e) {
          reject(e);
        } finally {
          running -= 1;
          next();
        }
      };
      if (running < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };

  limiter.active = () => running;
  limiter.pending = () => queue.length;
  limiter.softExpire = () => {
    softExpired = true;
  };
  limiter.isSoftExpired = () => softExpired;

  return limiter as Limiter;
}

/**
 * Race a promise against a deadline. Resolves to `null` if `ms` elapses before
 * `p` settles. Promoted from the offload-status partial-result pattern so every
 * interactive caller can bound a slow leg uniformly. Note: a client-side race
 * does not cancel `p` — pair it with a backend-level timeout (the threaded
 * `timeoutMs` on queryInstant/queryRange) when you also need the in-flight
 * request aborted.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fan out `fn` over `items` with bounded concurrency and a per-leg deadline,
 * degrading any slow / failed / soft-expired leg to `null` instead of sinking
 * the whole batch. The fix for the N+1 / serial-loop query patterns (first-seen,
 * drift, rank-by-shape, metrics-that-moved, commitment per-week, preview-filter):
 * a bare `for (const x of xs) await query(x)` over 100 items is a multi-minute
 * hang even with a per-leg timeout; this caps both the width and each leg.
 *
 * Result order matches `items`. `null` means that leg did not produce a value
 * (timed out, threw, or was skipped after the soft deadline) — callers map it
 * to their existing unknown/skip handling.
 */
export async function boundedFanout<I, O>(
  items: I[],
  fn: (item: I, index: number) => Promise<O>,
  opts: { concurrency: number; timeoutMs?: number; softDeadlineMs?: number }
): Promise<Array<O | null>> {
  const limit = createLimiter(opts.concurrency, opts.softDeadlineMs);
  const tasks = items.map((item, i) =>
    limit(() => (opts.timeoutMs ? withTimeout(fn(item, i), opts.timeoutMs) : fn(item, i)))
      .then((r) => (r === undefined ? null : r))
      .catch(() => null)
  );
  return (await Promise.all(tasks)) as Array<O | null>;
}
