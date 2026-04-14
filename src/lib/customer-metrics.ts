/**
 * Customer metric backend abstraction for the v1.4 cross-pillar bridge.
 *
 * The cross-pillar correlation tools need to read PromQL-compatible metrics
 * from wherever the customer's existing metrics live — Grafana Cloud / Mimir,
 * AWS Managed Prometheus, self-hosted Prometheus, VictoriaMetrics, Thanos,
 * Datadog's Prometheus-compatible read API, etc.
 *
 * This module exposes a pluggable backend interface so the higher-level
 * tools (discover_join, correlate_cross_pillar, translate_metric_to_patterns)
 * don't carry per-backend conditionals. A backend instance is constructed
 * from env vars at tool-call time and cached per-process.
 *
 * Configuration via env vars:
 *   LOG10X_CUSTOMER_METRICS_URL           endpoint base URL
 *   LOG10X_CUSTOMER_METRICS_TYPE          backend type:
 *                                           grafana_cloud | amp | datadog_prom | generic_prom
 *                                         Default: generic_prom
 *   LOG10X_CUSTOMER_METRICS_AUTH          auth credential (format depends on type)
 *   LOG10X_CUSTOMER_METRICS_INSTANCE_ID   optional Grafana Cloud instance ID
 *                                         (numeric, used as HTTP basic auth username)
 *
 * When none of these are set, the backend resolver returns undefined and
 * the cross-pillar tools return a structured "not configured" response.
 */

import type { PrometheusResponse } from './api.js';

export type CustomerMetricsBackendType =
  | 'grafana_cloud'
  | 'amp'
  | 'datadog_prom'
  | 'generic_prom'
  | 'mock';

export interface CustomerMetricsBackend {
  /** Backend type identifier for output metadata. */
  readonly backendType: CustomerMetricsBackendType;

  /** Human-readable base URL for output metadata (no credentials). */
  readonly endpoint: string;

  /** Instant PromQL query. */
  queryInstant(promql: string): Promise<PrometheusResponse>;

  /** Range PromQL query. */
  queryRange(
    promql: string,
    start: number,
    end: number,
    step: number
  ): Promise<PrometheusResponse>;

  /** List all label names present in the backend. */
  listLabels(): Promise<string[]>;

  /** List distinct values for a specific label. */
  listLabelValues(label: string): Promise<string[]>;
}

export class CustomerMetricsNotConfiguredError extends Error {
  constructor() {
    super(
      'Customer metrics backend not configured. Set LOG10X_CUSTOMER_METRICS_URL and ' +
        'LOG10X_CUSTOMER_METRICS_TYPE to enable the cross-pillar bridge. ' +
        'Supported types: grafana_cloud, amp, datadog_prom, generic_prom.'
    );
    this.name = 'CustomerMetricsNotConfiguredError';
  }
}

/**
 * Build a backend instance from environment variables. Returns `undefined`
 * when `LOG10X_CUSTOMER_METRICS_URL` is unset; throws when it's set but
 * the configuration is malformed (unknown type, missing auth for a type
 * that requires it).
 */
export function loadBackendFromEnv(): CustomerMetricsBackend | undefined {
  const url = process.env.LOG10X_CUSTOMER_METRICS_URL;
  if (!url) return undefined;

  const rawType = (process.env.LOG10X_CUSTOMER_METRICS_TYPE || 'generic_prom').toLowerCase();
  const auth = process.env.LOG10X_CUSTOMER_METRICS_AUTH;
  const instanceId = process.env.LOG10X_CUSTOMER_METRICS_INSTANCE_ID;

  switch (rawType) {
    case 'grafana_cloud':
      if (!auth) {
        throw new Error(
          'grafana_cloud backend requires LOG10X_CUSTOMER_METRICS_AUTH (API key with MetricsReader scope).'
        );
      }
      return new GrafanaCloudBackend({ endpoint: url, apiKey: auth, instanceId });

    case 'generic_prom':
      return new GenericPromBackend({ endpoint: url, bearerToken: auth });

    case 'mock':
      throw new Error(
        'mock backend cannot be loaded from env vars. Instantiate MockBackend directly in tests.'
      );

    case 'amp':
    case 'datadog_prom':
      throw new Error(
        `${rawType} backend is specified in v1.4 but not yet implemented. Shipping in v1.4.1. ` +
          'For now set LOG10X_CUSTOMER_METRICS_TYPE=generic_prom against a Prometheus-compatible endpoint.'
      );

    default:
      throw new Error(
        `Unknown LOG10X_CUSTOMER_METRICS_TYPE: ${rawType}. ` +
          'Supported: grafana_cloud, amp, datadog_prom, generic_prom.'
      );
  }
}

// ── Grafana Cloud ──

/**
 * Grafana Cloud Prometheus endpoint client.
 *
 * Grafana Cloud's hosted Prometheus (backed by Mimir) uses HTTP basic
 * auth with the numeric instance ID as the username and the API key as
 * the password. The base URL looks like:
 *
 *   https://prometheus-prod-XX-prod-us-central-0.grafana.net/api/prom
 *
 * Instance ID is available from the Grafana Cloud portal under
 * "Prometheus" → "Details". It's numeric (e.g., "123456").
 *
 * When instanceId is omitted, the backend falls back to Bearer auth
 * with the API key, which works for self-hosted Mimir / Thanos / other
 * Prometheus-compatible backends configured behind an authenticating
 * proxy.
 */
export class GrafanaCloudBackend implements CustomerMetricsBackend {
  readonly backendType = 'grafana_cloud';
  readonly endpoint: string;
  private authHeader: string;

  constructor(config: { endpoint: string; apiKey: string; instanceId?: string }) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    if (config.instanceId) {
      // HTTP basic: base64(instanceId:apiKey)
      const token = Buffer.from(`${config.instanceId}:${config.apiKey}`).toString('base64');
      this.authHeader = `Basic ${token}`;
    } else {
      this.authHeader = `Bearer ${config.apiKey}`;
    }
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const url = new URL('/api/prom/api/v1/query', this.endpoint);
    url.searchParams.set('query', promql);
    return this.fetchJson<PrometheusResponse>(url.toString());
  }

  async queryRange(
    promql: string,
    start: number,
    end: number,
    step: number
  ): Promise<PrometheusResponse> {
    const url = new URL('/api/prom/api/v1/query_range', this.endpoint);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', start.toString());
    url.searchParams.set('end', end.toString());
    url.searchParams.set('step', step.toString());
    return this.fetchJson<PrometheusResponse>(url.toString());
  }

  async listLabels(): Promise<string[]> {
    const url = new URL('/api/prom/api/v1/labels', this.endpoint);
    const res = await this.fetchJson<{ status: string; data: string[] }>(url.toString());
    return res.data || [];
  }

  async listLabelValues(label: string): Promise<string[]> {
    const url = new URL(
      `/api/prom/api/v1/label/${encodeURIComponent(label)}/values`,
      this.endpoint
    );
    const res = await this.fetchJson<{ status: string; data: string[] }>(url.toString());
    return res.data || [];
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { Authorization: this.authHeader } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`grafana_cloud HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }
}

// ── Generic Prometheus-compatible ──

/**
 * Catch-all backend for any Prometheus-compatible endpoint with optional
 * Bearer auth or no auth at all. Used for self-hosted Prometheus,
 * VictoriaMetrics, Thanos, Cortex, or any custom endpoint.
 *
 * Expects the standard Prometheus API path (`/api/v1/query`, etc.) at
 * the configured base URL. If the customer's endpoint is prefixed (e.g.,
 * Grafana Cloud's `/api/prom`), include the prefix in the base URL.
 */
export class GenericPromBackend implements CustomerMetricsBackend {
  readonly backendType = 'generic_prom';
  readonly endpoint: string;
  private authHeader: string | undefined;

  constructor(config: { endpoint: string; bearerToken?: string }) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.authHeader = config.bearerToken ? `Bearer ${config.bearerToken}` : undefined;
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const url = new URL('/api/v1/query', this.endpoint);
    url.searchParams.set('query', promql);
    return this.fetchJson<PrometheusResponse>(url.toString());
  }

  async queryRange(
    promql: string,
    start: number,
    end: number,
    step: number
  ): Promise<PrometheusResponse> {
    const url = new URL('/api/v1/query_range', this.endpoint);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', start.toString());
    url.searchParams.set('end', end.toString());
    url.searchParams.set('step', step.toString());
    return this.fetchJson<PrometheusResponse>(url.toString());
  }

  async listLabels(): Promise<string[]> {
    const url = new URL('/api/v1/labels', this.endpoint);
    const res = await this.fetchJson<{ status: string; data: string[] }>(url.toString());
    return res.data || [];
  }

  async listLabelValues(label: string): Promise<string[]> {
    const url = new URL(`/api/v1/label/${encodeURIComponent(label)}/values`, this.endpoint);
    const res = await this.fetchJson<{ status: string; data: string[] }>(url.toString());
    return res.data || [];
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.authHeader) headers['Authorization'] = this.authHeader;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`generic_prom HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }
}

// ── Mock backend for tests ──

/**
 * In-process backend that returns pre-seeded responses. Used by the
 * cross-pillar test suite to verify correlation, join discovery, and
 * structural validation without hitting a real Prometheus endpoint.
 */
export class MockBackend implements CustomerMetricsBackend {
  readonly backendType = 'mock';
  readonly endpoint = 'mock://in-process';

  labels: string[] = [];
  labelValues: Record<string, string[]> = {};
  instantResponses: Record<string, PrometheusResponse> = {};
  rangeResponses: Record<string, PrometheusResponse> = {};

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const res = this.instantResponses[promql];
    if (res) return res;
    return { status: 'success', data: { resultType: 'vector', result: [] } };
  }

  async queryRange(
    promql: string,
    start: number,
    end: number,
    step: number
  ): Promise<PrometheusResponse> {
    // Key by promql only for test simplicity; start/end/step can be ignored or
    // included in the key if a test needs to distinguish by window.
    const res = this.rangeResponses[promql];
    if (res) return res;
    // Unused params are intentional — signature matches the interface.
    void start;
    void end;
    void step;
    return { status: 'success', data: { resultType: 'matrix', result: [] } };
  }

  async listLabels(): Promise<string[]> {
    return [...this.labels];
  }

  async listLabelValues(label: string): Promise<string[]> {
    return [...(this.labelValues[label] || [])];
  }
}
