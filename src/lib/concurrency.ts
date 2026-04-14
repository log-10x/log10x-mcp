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
