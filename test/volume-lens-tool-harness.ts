/**
 * Shared mock-Prometheus harness for the volume-lens rollout tool tests.
 *
 * Each lensed tool reads its byte basis from the env's MetricsBackend
 * (the injection seam — tools call queryInstant/queryRange which delegate
 * to env.metricsBackend). This harness builds a fake backend that
 * pattern-matches on the PromQL string and returns canned vectors, so the
 * full tool can run with zero network. Used to assert the four honesty
 * invariants (factor-1 byte-identical, factor-N scaling, ratios invariant,
 * stamp iff lensed).
 */

import type { EnvConfig } from '../src/lib/environments.js';
import type { LabelNameMap } from '../src/lib/promql.js';
import type { MetricsBackend, MetricsBackendKind } from '../src/lib/metrics-backend.js';
import type { PrometheusResponse, PrometheusResult } from '../src/lib/api.js';

export const GB = 1_000_000_000;

export const L: LabelNameMap = {
  pattern: 'message_pattern',
  service: 'tenx_user_service',
  severity: 'severity_level',
  env: 'tenx_env',
  hash: 'tenx_hash',
};

export function vec(results: PrometheusResult[]): PrometheusResponse {
  return { status: 'success', data: { resultType: 'vector', result: results } };
}

export function scalar(v: number): PrometheusResponse {
  return vec([{ metric: {}, value: [0, String(v)] }]);
}

export function empty(): PrometheusResponse {
  return { status: 'success', data: { resultType: 'vector', result: [] } };
}

export function matrix(values: [number, string][]): PrometheusResponse {
  return { status: 'success', data: { resultType: 'matrix', result: [{ metric: {}, values }] } };
}

/** A backend whose responses are decided by a query-string router. */
export class StubBackend implements MetricsBackend {
  readonly kind: MetricsBackendKind = 'prometheus';
  readonly endpoint = 'stub://test';
  constructor(
    private routeInstant: (q: string) => PrometheusResponse,
    private routeRange: (q: string) => PrometheusResponse = () => empty(),
  ) {}
  async queryInstant(promql: string): Promise<PrometheusResponse> { return this.routeInstant(promql); }
  async queryRange(promql: string): Promise<PrometheusResponse> { return this.routeRange(promql); }
  async listLabels(): Promise<string[]> { return []; }
  async listLabelValues(): Promise<string[]> { return []; }
}

export function makeEnv(backend: MetricsBackend): EnvConfig {
  return {
    nickname: 'test',
    metricsBackend: backend,
    labels: L,
    apiKey: '',
    envId: '',
    analyzer: 'splunk',
  } as EnvConfig;
}

/** Walk a (possibly nested) object to read source_disclosure. */
export function asRecord(x: unknown): Record<string, unknown> {
  return (x ?? {}) as Record<string, unknown>;
}
