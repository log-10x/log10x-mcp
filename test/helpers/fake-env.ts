/**
 * In-memory MetricsBackend + EnvConfig fakes for the cross-cutting
 * invariant harness (test/invariants.test.ts).
 *
 * WHY THIS, NOT stub-prom.ts
 *
 * stub-prom.ts boots a real HTTP server used by the cross-pillar
 * primitives (which resolve a customer metrics URL and speak HTTP). The
 * analytical tools (services / top_patterns / estimate_savings / …) never
 * touch HTTP directly: lib/api.ts `queryInstant`/`queryRange` delegate to
 * `env.metricsBackend.queryInstant(...)`. So an in-process object that
 * implements the MetricsBackend interface is a deterministic, server-free
 * seam — hand a tool a fake EnvConfig whose `metricsBackend` is one of
 * these and the tool is fully reproducible.
 *
 * The stub counts every backend call (`.calls`) so the harness can assert
 * `performance.query_count === stub.calls` (real_telemetry — query_count
 * must reflect real work, not a hardcoded 0).
 */

import type { MetricsBackend, MetricsBackendKind } from '../../src/lib/metrics-backend.js';
import type { PrometheusResponse } from '../../src/lib/api.js';
import type { EnvConfig } from '../../src/lib/environments.js';
import { DEFAULT_LABELS } from '../../src/lib/promql.js';

/** A single labelled sample a fixture can return. */
export interface StubSeries {
  /** Metric labels (message_pattern / tenx_user_service / severity_level / …). */
  metric?: Record<string, string>;
  /** Scalar value for a vector sample. */
  value: number;
}

/** Matrix series (range query). */
export interface StubMatrixSeries {
  metric?: Record<string, string>;
  /** [ts, value] pairs. */
  values: Array<[number, number]>;
}

export interface StubInstantRule {
  /** Substring or RegExp matched against the PromQL string. */
  match: string | RegExp;
  /** One or more series to return as a vector. */
  series: StubSeries[];
}

export interface StubRangeRule {
  match: string | RegExp;
  series: StubMatrixSeries[];
}

export interface StubBackendOpts {
  instant?: StubInstantRule[];
  range?: StubRangeRule[];
  labels?: string[];
  labelValues?: Record<string, string[]>;
  /**
   * When true every queryInstant/queryRange rejects with a 503-style
   * Error — drives the structured_error invariant (a tool must turn a
   * backend failure into a structured envelope, never reject the promise).
   */
  fail?: boolean;
  /** Backend kind reported on the interface. */
  kind?: MetricsBackendKind;
}

export type StubBackend = MetricsBackend & { calls: number };

const nowSec = (): number => Math.floor(Date.now() / 1000);

function matches(rule: { match: string | RegExp }, promql: string): boolean {
  return typeof rule.match === 'string'
    ? promql.includes(rule.match)
    : rule.match.test(promql);
}

function emptyVector(): PrometheusResponse {
  return { status: 'success', data: { resultType: 'vector', result: [] } };
}

function emptyMatrix(): PrometheusResponse {
  return { status: 'success', data: { resultType: 'matrix', result: [] } };
}

/**
 * Build an in-memory MetricsBackend.
 *
 * queryInstant scans `instant` rules in order; the FIRST whose `match`
 * hits the PromQL wins and its series are returned as a vector. No match
 * → empty vector (the shape Prometheus returns for a metric with no data
 * in the window — same as stub-prom.ts). Every call (matched or not, plus
 * range/labels/labelValues) increments `.calls`.
 */
export function makeStubBackend(opts: StubBackendOpts = {}): StubBackend {
  const instant = opts.instant ?? [];
  const range = opts.range ?? [];
  const labels = opts.labels ?? ['__name__', 'message_pattern', 'tenx_user_service', 'severity_level'];
  const labelValues = opts.labelValues ?? {};
  const fail = opts.fail ?? false;
  const kind: MetricsBackendKind = opts.kind ?? 'log10x';

  const backend = {
    kind,
    endpoint: 'http://stub-in-memory',
    calls: 0,

    async queryInstant(promql: string): Promise<PrometheusResponse> {
      this.calls += 1;
      if (fail) throw new Error('stub backend 503 (queryInstant)');
      const rule = instant.find((r) => matches(r, promql));
      if (!rule) return emptyVector();
      const ts = nowSec();
      return {
        status: 'success',
        data: {
          resultType: 'vector',
          result: rule.series.map((s) => ({
            metric: s.metric ?? {},
            value: [ts, String(s.value)] as [number, string],
          })),
        },
      };
    },

    async queryRange(
      promql: string,
      _startSec: number,
      _endSec: number,
      _stepSec: number,
    ): Promise<PrometheusResponse> {
      this.calls += 1;
      if (fail) throw new Error('stub backend 503 (queryRange)');
      const rule = range.find((r) => matches(r, promql));
      if (!rule) return emptyMatrix();
      return {
        status: 'success',
        data: {
          resultType: 'matrix',
          result: rule.series.map((s) => ({
            metric: s.metric ?? {},
            values: s.values.map(([t, v]) => [t, String(v)] as [number, string]),
          })),
        },
      };
    },

    async listLabels(): Promise<string[]> {
      this.calls += 1;
      if (fail) throw new Error('stub backend 503 (listLabels)');
      return labels.slice();
    },

    async listLabelValues(label: string, _opts?: { windowSeconds?: number }): Promise<string[]> {
      this.calls += 1;
      if (fail) throw new Error('stub backend 503 (listLabelValues)');
      return (labelValues[label] ?? []).slice();
    },
  };

  return backend as StubBackend;
}

/**
 * Build a fake EnvConfig wrapping a stub backend. Mirrors STUB_ENV in
 * stub-prom.ts + makeTestBackend in environments.test.ts, but carries a
 * REAL stub backend so api.ts delegation lands on it.
 *
 * `analyzerCost` is set by default so the shared rate resolver
 * (lib/rate-resolution.ts) yields a deterministic, non-null $/GB — money
 * and decimal-GB invariants need a known rate.
 */
export function makeFakeEnv(backend: StubBackend, overrides: Partial<EnvConfig> = {}): EnvConfig {
  const env: EnvConfig = {
    nickname: 'stub',
    metricsBackend: backend,
    labels: { ...DEFAULT_LABELS },
    apiKey: 'test-key',
    envId: 'test-env',
    isDefault: true,
    permissions: 'OWNER',
    analyzerCost: 2.0,
    ...overrides,
  };
  return env;
}
