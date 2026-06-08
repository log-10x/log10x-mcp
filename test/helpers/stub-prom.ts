/**
 * Tiny in-process Prometheus-API stub for integration tests of the
 * cross-pillar primitives (metrics_that_moved, rank_by_shape_similarity,
 * metric_overlay).
 *
 * Implements the subset of /api/v1 the primitives actually call:
 *   - /api/v1/query_range  → matrix response from configured fixtures
 *   - /api/v1/query        → instant response (vector of one sample)
 *   - /api/v1/labels       → static list
 *   - /api/v1/label/<name>/values
 *
 * Fixtures are keyed by the EXACT PromQL string the primitive sends.
 * If a query string isn't registered, the stub returns an empty matrix
 * (status=success, empty result[]) — same shape Prometheus returns for
 * a metric that simply has no data.
 *
 * For stress tests, the stub can be configured to inject:
 *   - per-query latency (delay before responding)
 *   - per-query 503 (a fraction of queries fail with HTTP 503)
 *
 * Real-world failure modes the stub mimics:
 *   - GenericPromBackend throws on non-2xx → primitive's catch path
 *     pushes the candidate into evaluation_failed[].
 *   - Empty matrix → < 6 buckets guard → evaluation_failed[].
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

/** [timestamp_seconds, value] pair, Prometheus matrix shape. */
export type StubSample = [number, number];

export interface StubFixture {
  /** Series labels (returned in the matrix as `metric`). */
  metric?: Record<string, string>;
  /** Sample points. */
  values: StubSample[];
}

export interface StubProm {
  /** Base URL, e.g. http://127.0.0.1:54321 — pass to LOG10X_CUSTOMER_METRICS_URL. */
  url: string;
  /** Register a fixture for an exact PromQL string. Overwrites any prior. */
  setFixture(promql: string, fixture: StubFixture): void;
  /** Inject a constant latency (ms) before every response. */
  setLatencyMs(ms: number): void;
  /**
   * Inject a per-request 503 failure rate (0..1). Uses a deterministic
   * counter, not Math.random, so failure positions are reproducible
   * across runs. Set to 0 to disable.
   */
  setFailureRate(rate: number): void;
  /** Total queries served (success + failure). */
  totalQueries(): number;
  /** Reset all fixtures + counters; leave server running. */
  reset(): void;
  /** Stop the server. Returns when fully closed. */
  close(): Promise<void>;
}

export async function startStubProm(): Promise<StubProm> {
  const fixtures = new Map<string, StubFixture>();
  let latencyMs = 0;
  let failureRate = 0;
  let counter = 0;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));

    counter += 1;
    // Deterministic failure schedule: fail when the cumulative count
    // crosses an integer multiple of 1/failureRate. Counter starts at 1
    // for the first request so floor((counter-1)*r) is well-defined
    // (avoids floor(-r) on the very first call).
    const isFailure =
      failureRate > 0 && Math.floor(counter * failureRate) > Math.floor((counter - 1) * failureRate);

    if (isFailure) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain');
      res.end('Service Unavailable (stub-injected)');
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/v1/query_range' || path === '/api/v1/query') {
      const promql = url.searchParams.get('query') || '';
      // rank_by_shape_similarity probes candidate existence with an
      // instant `count(<candidate>)` query before fetching the range.
      // Real Prometheus evaluates that against the inner series; the stub
      // keys fixtures by the bare metric expression, so unwrap a single
      // `count(...)` envelope and resolve against the inner fixture. The
      // count handler below returns a 1-sample vector when the inner
      // series exists, which is what the existence check needs.
      const countMatch = path === '/api/v1/query' ? /^count\((.+)\)$/.exec(promql.trim()) : null;
      const lookupKey = countMatch ? countMatch[1].trim() : promql;
      const fixture = fixtures.get(lookupKey);
      if (!fixture) {
        // Unknown query → empty matrix. Same shape Prometheus returns
        // for a real metric that has no data in the window.
        res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [] } }));
        return;
      }
      if (path === '/api/v1/query_range') {
        res.end(
          JSON.stringify({
            status: 'success',
            data: {
              resultType: 'matrix',
              result: [
                {
                  metric: fixture.metric || {},
                  values: fixture.values.map(([t, v]) => [t, String(v)]),
                },
              ],
            },
          }),
        );
      } else if (countMatch) {
        // count(<candidate>) existence probe → scalar-ish vector whose
        // value is the number of resolving series (1 for a single
        // fixture). The rank existence check requires totalCount > 0, so
        // a registered fixture must report a non-zero count regardless of
        // its last sample value (which can legitimately be 0).
        const last = fixture.values[fixture.values.length - 1];
        const ts = last ? last[0] : Math.floor(Date.now() / 1000);
        res.end(
          JSON.stringify({
            status: 'success',
            data: {
              resultType: 'vector',
              result: [{ metric: {}, value: [ts, '1'] }],
            },
          }),
        );
      } else {
        // Instant: last sample as a vector.
        const last = fixture.values[fixture.values.length - 1];
        res.end(
          JSON.stringify({
            status: 'success',
            data: {
              resultType: 'vector',
              result: last
                ? [{ metric: fixture.metric || {}, value: [last[0], String(last[1])] }]
                : [],
            },
          }),
        );
      }
      return;
    }

    if (path === '/api/v1/labels') {
      res.end(JSON.stringify({ status: 'success', data: ['__name__', 'job', 'instance'] }));
      return;
    }

    if (path.startsWith('/api/v1/label/')) {
      res.end(JSON.stringify({ status: 'success', data: [] }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ status: 'error', error: `unknown path ${path}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub-prom failed to bind');
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    setFixture(promql, fixture) {
      fixtures.set(promql, fixture);
    },
    setLatencyMs(ms) {
      latencyMs = ms;
    },
    setFailureRate(rate) {
      failureRate = rate;
    },
    totalQueries() {
      return counter;
    },
    reset() {
      fixtures.clear();
      latencyMs = 0;
      failureRate = 0;
      counter = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Build a step-aligned series of [ts, v] samples ending at `endTs`.
 * Convenience for test fixtures: callers don't have to compute the
 * timestamp grid by hand.
 *
 * `endTs` is rounded DOWN to the step grid first so the resulting
 * timestamps are all multiples of `stepSeconds`. Important: the
 * primitives round candidate timestamps to the step grid before
 * matching them against the anchor's raw timestamps in `inSetWithin`.
 * If anchor fixtures aren't grid-aligned, candidates can silently
 * miss the partition lookup and the candidate gets classified as
 * `failed` (n<2 on one side). Pinning grid-aligned fixtures here
 * avoids the false negative.
 */
export function buildSeries(values: number[], stepSeconds: number, endTs: number): StubSample[] {
  const alignedEnd = Math.floor(endTs / stepSeconds) * stepSeconds;
  const n = values.length;
  return values.map((v, i) => [alignedEnd - (n - 1 - i) * stepSeconds, v]);
}

/**
 * Construct a minimal EnvConfig-shaped object for tests that need to
 * pass `env` to the primitive but won't actually have the primitive
 * use it (i.e. anchor_type='customer_metric' paths). The cross-pillar
 * primitives only touch env when anchor_type='log10x_pattern'.
 *
 * Cast to any at the test site to skip EnvConfig's strict shape.
 */
export const STUB_ENV: unknown = {
  nickname: 'stub',
  metricsBackend: { kind: 'log10x', endpoint: 'http://stub-unused', apiKey: 'unused', envId: 'unused' },
  labels: {},
  apiKey: 'unused',
  envId: 'unused',
};
