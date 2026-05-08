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
 * Explicit configuration (wins over any auto-detect):
 *   LOG10X_CUSTOMER_METRICS_URL           endpoint base URL
 *   LOG10X_CUSTOMER_METRICS_TYPE          backend type:
 *                                           grafana_cloud | amp | datadog_prom | generic_prom
 *                                         Default: generic_prom
 *   LOG10X_CUSTOMER_METRICS_AUTH          auth credential (format depends on type)
 *   LOG10X_CUSTOMER_METRICS_INSTANCE_ID   optional Grafana Cloud instance ID
 *                                         (numeric, used as HTTP basic auth username)
 *
 * Ambient auto-detect (tried in order when explicit URL is not set):
 *   1. Grafana Cloud        GRAFANA_CLOUD_API_KEY (+ GRAFANA_CLOUD_URL /
 *                                                    GRAFANA_CLOUD_INSTANCE_ID)
 *   2. Datadog Prometheus   DD_API_KEY + DD_APP_KEY (+ DD_SITE)
 *   3. AWS AMP              AWS_REGION + `aws amp list-workspaces` → single workspace
 *   4. GCP Managed Prom     GOOGLE_APPLICATION_CREDENTIALS + `gcloud config get project`
 *   5. Self-hosted          PROMETHEUS_URL
 *
 * When none of these resolve, the resolver returns `undefined` and the
 * cross-pillar tools return a structured "not configured" response that
 * lists every detection path that was tried.
 */

import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';
import type { PrometheusResponse } from './api.js';

const execFileP = promisify(execFile);

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

  /**
   * List distinct values for a specific label. When `window` is provided,
   * restrict the result to values observed inside `[now - window, now]`
   * via Prometheus's `start`/`end` query parameters. This filters out
   * stale label values from series that stopped receiving samples, which
   * is essential for join discovery — stale values drag the Jaccard down
   * and produce false-negative `no_join_available` results.
   */
  listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]>;

  /**
   * Return the Prometheus remote_write URL that corresponds to this
   * backend's read endpoint, if derivable. Returns `undefined` when the
   * backend has no natural write endpoint (e.g. Datadog uses its own
   * ingest API, not remote_write) or when the read URL cannot be mapped
   * to a write path automatically.
   *
   * Used by `log10x_backfill_metric` to avoid forcing users to configure
   * PROMETHEUS_REMOTE_WRITE_URL separately when the read endpoint is a
   * managed Prometheus with a well-known write path.
   */
  remoteWriteUrl(): string | undefined;
}

export class CustomerMetricsNotConfiguredError extends Error {
  constructor(diagnostic?: string) {
    const base =
      'Customer metrics backend not configured. The cross-pillar bridge cannot run until a ' +
      'backend is resolvable. Either set LOG10X_CUSTOMER_METRICS_URL + LOG10X_CUSTOMER_METRICS_TYPE ' +
      'explicitly, or expose one of the ambient-detect credential sets: ' +
      'GRAFANA_CLOUD_API_KEY | DD_API_KEY+DD_APP_KEY | AWS_REGION (AMP) | ' +
      'GOOGLE_APPLICATION_CREDENTIALS (GCP Managed Prometheus) | PROMETHEUS_URL.';
    super(diagnostic ? `${base}\n\nDetection trace:\n${diagnostic}` : base);
    this.name = 'CustomerMetricsNotConfiguredError';
  }
}

/**
 * Markdown form of the not-configured message for tools that participate
 * in autonomous chains. Throwing aborts the parent chain; returning
 * structured markdown lets the parent log "no cross-pillar data, continuing
 * without it" and complete the rest of the investigation.
 *
 * customer_metrics_query (the human escape-hatch tool) keeps the throw
 * behavior intentionally — a user-issued PromQL passthrough should fail
 * loudly when the backend isn't there. correlate_cross_pillar and
 * discover_join (chain participants) call this helper instead.
 */
export function customerMetricsNotConfiguredMessage(diagnostic?: string): string {
  const lines: string[] = [
    '## Cross-pillar metrics backend not configured',
    '',
    "This MCP server doesn't currently have a customer metrics backend configured. Cross-pillar correlation joins log-side patterns to the customer's APM / infrastructure metrics; without a configured backend, the bridge cannot run.",
    '',
    "**What's out of reach without the cross-pillar backend**:",
    '',
    '- Correlating a spiking log pattern to its upstream metric anomaly (gateway latency, dependency saturation, etc.)',
    '- Translating a customer-metric anomaly back to the log patterns that caused it',
    '- Discovering join keys between the log enrichment label set and the customer metrics label set',
    '',
    '**To configure**:',
    '',
    '- (a) Set explicit env vars: `LOG10X_CUSTOMER_METRICS_URL` + `LOG10X_CUSTOMER_METRICS_TYPE`.',
    '- (b) Or expose one of the ambient-detect credential sets: `GRAFANA_CLOUD_API_KEY`, `DD_API_KEY`+`DD_APP_KEY`, `AWS_REGION` (AMP), `GOOGLE_APPLICATION_CREDENTIALS` (GCP Managed Prometheus), `PROMETHEUS_URL`.',
    '',
    '**Continuing without cross-pillar**:',
    '',
    'The agent can still investigate using log-tier tools (event_lookup, pattern_trend, top_patterns, cost_drivers) and archive tools (retriever_query, retriever_series). Skip cross-pillar correlation in this chain and surface the missing-backend state in the synthesis.',
  ];
  if (diagnostic) {
    lines.push('');
    lines.push('**Detection trace**:');
    lines.push('');
    lines.push('```');
    lines.push(diagnostic);
    lines.push('```');
  }
  return lines.join('\n');
}

// ── Detection cascade ──

export type DetectionPath =
  | 'explicit_env'
  | 'grafana_cloud'
  | 'datadog_prom'
  | 'amp'
  | 'gcp_managed_prometheus'
  | 'prometheus_url';

export interface BackendResolution {
  backend?: CustomerMetricsBackend;
  /** Which detection path produced the backend, if any. */
  detectionPath?: DetectionPath;
  /** All paths tried, with a one-line reason each — feed to `log10x_doctor`. */
  trace: Array<{ path: DetectionPath; status: 'matched' | 'skipped' | 'failed'; reason: string }>;
}

/**
 * Resolve a customer-metrics backend from the ambient shell environment.
 *
 * Detection order (first hit wins):
 *   1. explicit `LOG10X_CUSTOMER_METRICS_URL`
 *   2. Grafana Cloud via `GRAFANA_CLOUD_API_KEY` / `GCLOUD_*` env or
 *      `~/.grafana/grafana-cli-config.yaml`
 *   3. Datadog Prometheus-compatible read API via `DD_API_KEY + DD_APP_KEY`
 *   4. AWS AMP via `AWS_REGION` + `aws amp list-workspaces`
 *   5. GCP Managed Prometheus via `GOOGLE_APPLICATION_CREDENTIALS` +
 *      `gcloud config get project`
 *   6. Self-hosted Prometheus via `PROMETHEUS_URL`
 */
export async function resolveBackend(): Promise<BackendResolution> {
  const trace: BackendResolution['trace'] = [];

  // 1. Explicit URL.
  if (process.env.LOG10X_CUSTOMER_METRICS_URL) {
    try {
      const backend = buildExplicitBackend();
      if (backend) {
        trace.push({
          path: 'explicit_env',
          status: 'matched',
          reason: `LOG10X_CUSTOMER_METRICS_URL set; backend type ${backend.backendType}`,
        });
        return { backend, detectionPath: 'explicit_env', trace };
      }
    } catch (e) {
      // Malformed explicit config — surface the error rather than silently
      // falling through to auto-detect. Users who set the explicit var want
      // it to win; silent fallback would mask configuration bugs.
      throw e;
    }
  } else {
    trace.push({ path: 'explicit_env', status: 'skipped', reason: 'LOG10X_CUSTOMER_METRICS_URL not set' });
  }

  // 2. Grafana Cloud.
  {
    const gc = tryDetectGrafanaCloud();
    if (gc.backend) {
      trace.push({ path: 'grafana_cloud', status: 'matched', reason: gc.reason });
      return { backend: gc.backend, detectionPath: 'grafana_cloud', trace };
    }
    trace.push({ path: 'grafana_cloud', status: 'skipped', reason: gc.reason });
  }

  // 3. Datadog Prometheus-compatible read API.
  {
    const dd = tryDetectDatadog();
    if (dd.backend) {
      trace.push({ path: 'datadog_prom', status: 'matched', reason: dd.reason });
      return { backend: dd.backend, detectionPath: 'datadog_prom', trace };
    }
    trace.push({ path: 'datadog_prom', status: 'skipped', reason: dd.reason });
  }

  // 4. AWS AMP.
  {
    const amp = await tryDetectAmp();
    if (amp.backend) {
      trace.push({ path: 'amp', status: 'matched', reason: amp.reason });
      return { backend: amp.backend, detectionPath: 'amp', trace };
    }
    trace.push({ path: 'amp', status: amp.failed ? 'failed' : 'skipped', reason: amp.reason });
  }

  // 5. GCP Managed Prometheus.
  {
    const gcp = await tryDetectGcp();
    if (gcp.backend) {
      trace.push({ path: 'gcp_managed_prometheus', status: 'matched', reason: gcp.reason });
      return { backend: gcp.backend, detectionPath: 'gcp_managed_prometheus', trace };
    }
    trace.push({ path: 'gcp_managed_prometheus', status: gcp.failed ? 'failed' : 'skipped', reason: gcp.reason });
  }

  // 6. Self-hosted Prometheus.
  if (process.env.PROMETHEUS_URL) {
    const url = process.env.PROMETHEUS_URL;
    trace.push({ path: 'prometheus_url', status: 'matched', reason: `PROMETHEUS_URL=${url}` });
    return {
      backend: new GenericPromBackend({ endpoint: url, bearerToken: process.env.PROMETHEUS_BEARER_TOKEN }),
      detectionPath: 'prometheus_url',
      trace,
    };
  }
  trace.push({ path: 'prometheus_url', status: 'skipped', reason: 'PROMETHEUS_URL not set' });

  return { trace };
}

/**
 * Back-compat facade. Resolves the ambient environment and returns the
 * backend (or undefined). Callers that need the detection trace should
 * call `resolveBackend()` directly.
 */
export async function loadBackendFromEnv(): Promise<CustomerMetricsBackend | undefined> {
  const res = await resolveBackend();
  return res.backend;
}

/** Render a detection trace as human-readable bullets for error messages. */
export function formatDetectionTrace(trace: BackendResolution['trace']): string {
  if (!trace.length) return '(no detection attempts logged)';
  return trace
    .map((t) => `  - ${t.path}: ${t.status} — ${t.reason}`)
    .join('\n');
}

function buildExplicitBackend(): CustomerMetricsBackend | undefined {
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

    case 'datadog_prom': {
      const apiKey = auth || process.env.DD_API_KEY || process.env.DATADOG_API_KEY;
      const appKey = process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY;
      if (!apiKey || !appKey) {
        throw new Error(
          'datadog_prom backend requires DD_API_KEY and DD_APP_KEY (API + Application keys). ' +
            'Set LOG10X_CUSTOMER_METRICS_AUTH as the API key and export DD_APP_KEY separately.'
        );
      }
      return new DatadogPromBackend({ endpoint: url, apiKey, appKey });
    }

    case 'amp': {
      const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
      if (!region) {
        throw new Error('amp backend requires AWS_REGION to be set for SigV4 signing.');
      }
      return new AmpBackend({ endpoint: url, region });
    }

    case 'mock':
      throw new Error(
        'mock backend cannot be loaded from env vars. Instantiate MockBackend directly in tests.'
      );

    default:
      throw new Error(
        `Unknown LOG10X_CUSTOMER_METRICS_TYPE: ${rawType}. ` +
          'Supported: grafana_cloud, amp, datadog_prom, generic_prom.'
      );
  }
}

// ── Grafana Cloud auto-detect ──

function tryDetectGrafanaCloud(): { backend?: CustomerMetricsBackend; reason: string } {
  const apiKey =
    process.env.GRAFANA_CLOUD_API_KEY ||
    process.env.GCLOUD_API_KEY ||
    process.env.GRAFANA_CLOUD_TOKEN;

  let url = process.env.GRAFANA_CLOUD_URL || process.env.GCLOUD_PROMETHEUS_URL;
  let instanceId = process.env.GRAFANA_CLOUD_INSTANCE_ID || process.env.GCLOUD_PROMETHEUS_USERNAME;

  // Fall back to the grafana-cli config file when env vars are partial.
  if (apiKey && (!url || !instanceId)) {
    const cfg = readGrafanaCliConfig();
    if (cfg) {
      url = url || cfg.prometheusUrl;
      instanceId = instanceId || cfg.prometheusUser;
    }
  }

  if (!apiKey) return { reason: 'no GRAFANA_CLOUD_API_KEY / GCLOUD_API_KEY' };
  if (!url) {
    return {
      reason:
        'GRAFANA_CLOUD_API_KEY set but no GRAFANA_CLOUD_URL / grafana-cli-config.yaml — unable to infer Prometheus endpoint',
    };
  }
  return {
    backend: new GrafanaCloudBackend({ endpoint: url, apiKey, instanceId }),
    reason: `GRAFANA_CLOUD_API_KEY + endpoint ${url}${instanceId ? ` (basic auth instance ${instanceId})` : ' (bearer)'}`,
  };
}

interface GrafanaCliConfig {
  prometheusUrl?: string;
  prometheusUser?: string;
}

function readGrafanaCliConfig(): GrafanaCliConfig | undefined {
  try {
    const path = joinPath(homedir(), '.grafana', 'grafana-cli-config.yaml');
    if (!existsSync(path)) return undefined;
    const text = readFileSync(path, 'utf8');
    // Minimal YAML subset — grafana-cli uses a flat key/value file. We grep
    // the prometheus_url / prometheus_user keys rather than pull in a full
    // YAML parser for a single file.
    const urlMatch = text.match(/^\s*prometheus_url\s*:\s*(.+?)\s*$/m);
    const userMatch = text.match(/^\s*prometheus_user\s*:\s*(.+?)\s*$/m);
    return {
      prometheusUrl: urlMatch ? stripYamlQuotes(urlMatch[1]) : undefined,
      prometheusUser: userMatch ? stripYamlQuotes(userMatch[1]) : undefined,
    };
  } catch {
    return undefined;
  }
}

function stripYamlQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// ── Datadog auto-detect ──

function tryDetectDatadog(): { backend?: CustomerMetricsBackend; reason: string } {
  const apiKey = process.env.DD_API_KEY || process.env.DATADOG_API_KEY;
  const appKey = process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY;
  const site = process.env.DD_SITE || process.env.DATADOG_SITE || 'datadoghq.com';

  if (!apiKey) return { reason: 'no DD_API_KEY / DATADOG_API_KEY' };
  if (!appKey) {
    return {
      reason:
        'DD_API_KEY set but no DD_APP_KEY — Datadog Prometheus read API needs both API and Application keys',
    };
  }
  const endpoint = `https://api.${site}`;
  return {
    backend: new DatadogPromBackend({ endpoint, apiKey, appKey }),
    reason: `DD_API_KEY + DD_APP_KEY (site ${site})`,
  };
}

// ── AMP auto-detect ──

async function tryDetectAmp(): Promise<{ backend?: CustomerMetricsBackend; reason: string; failed?: boolean }> {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!region) return { reason: 'no AWS_REGION / AWS_DEFAULT_REGION' };

  // Workspace URL can also be supplied directly for CI or scripted setups.
  const explicitWorkspace = process.env.AMP_WORKSPACE_URL;
  if (explicitWorkspace) {
    return {
      backend: new AmpBackend({ endpoint: explicitWorkspace, region }),
      reason: `AMP_WORKSPACE_URL + AWS_REGION=${region}`,
    };
  }

  try {
    const { stdout } = await execFileP(
      'aws',
      ['amp', 'list-workspaces', '--region', region, '--output', 'json'],
      { timeout: 8_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout) as {
      workspaces?: Array<{ workspaceId: string; prometheusEndpoint?: string; status?: { statusCode?: string } }>;
    };
    const active = (parsed.workspaces || []).filter((w) => w.prometheusEndpoint && (!w.status || w.status.statusCode === 'ACTIVE'));
    if (active.length === 0) {
      return {
        reason: `aws amp list-workspaces returned 0 active workspaces in ${region}`,
      };
    }
    if (active.length > 1) {
      return {
        reason: `${active.length} AMP workspaces in ${region}; set AMP_WORKSPACE_URL to disambiguate (found: ${active.map((w) => w.workspaceId).join(', ')})`,
      };
    }
    const ws = active[0];
    // prometheusEndpoint is the workspace URL ending in /workspaces/<id>/
    return {
      backend: new AmpBackend({ endpoint: ws.prometheusEndpoint!, region }),
      reason: `AWS_REGION=${region}; aws amp list-workspaces → single workspace ${ws.workspaceId}`,
    };
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return {
      failed: true,
      reason: `aws amp list-workspaces failed (${err.code || 'unknown'}): ${(err.message || '').slice(0, 160)}`,
    };
  }
}

// ── GCP Managed Prometheus auto-detect ──

async function tryDetectGcp(): Promise<{ backend?: CustomerMetricsBackend; reason: string; failed?: boolean }> {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) return { reason: 'no GOOGLE_APPLICATION_CREDENTIALS' };
  const explicitProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  let project: string | undefined = explicitProject;
  if (!project) {
    try {
      const { stdout } = await execFileP('gcloud', ['config', 'get-value', 'project'], {
        timeout: 5_000,
      });
      project = stdout.trim();
    } catch (e) {
      return {
        failed: true,
        reason: `gcloud config get-value project failed: ${(e as Error).message.slice(0, 120)}`,
      };
    }
  }
  if (!project) return { failed: true, reason: 'gcloud config returned empty project' };

  const endpoint = `https://monitoring.googleapis.com/v1/projects/${project}/location/global/prometheus`;
  return {
    backend: new GcpManagedPrometheusBackend({ endpoint, project }),
    reason: `GOOGLE_APPLICATION_CREDENTIALS + project=${project}`,
  };
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

  async listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]> {
    const url = new URL(
      `/api/prom/api/v1/label/${encodeURIComponent(label)}/values`,
      this.endpoint
    );
    if (opts?.windowSeconds) {
      const nowS = Math.floor(Date.now() / 1000);
      url.searchParams.set('start', String(nowS - opts.windowSeconds));
      url.searchParams.set('end', String(nowS));
    }
    const res = await this.fetchJson<{ status: string; data: string[] }>(url.toString());
    return res.data || [];
  }

  remoteWriteUrl(): string | undefined {
    // Grafana Cloud Prometheus write path is /api/prom/push.
    return `${this.endpoint}/api/prom/push`;
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

  async listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]> {
    const url = new URL(`/api/v1/label/${encodeURIComponent(label)}/values`, this.endpoint);
    if (opts?.windowSeconds) {
      const nowS = Math.floor(Date.now() / 1000);
      url.searchParams.set('start', String(nowS - opts.windowSeconds));
      url.searchParams.set('end', String(nowS));
    }
    const res = await this.fetchJson<{ status: string; data: string[] }>(url.toString());
    return res.data || [];
  }

  remoteWriteUrl(): string | undefined {
    // Standard Prometheus remote_write path when --web.enable-remote-write-receiver
    // is configured server-side. Caller gets a clear HTTP error if the server
    // doesn't accept the path; we can't distinguish that from here.
    return `${this.endpoint}/api/v1/write`;
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

// ── Datadog Prometheus-compatible read API ──

/**
 * Datadog's `/api/v1/query` and `/api/v1/query_range` endpoints accept a
 * PromQL expression and return a Prometheus-shaped response. Auth is
 * `DD-API-KEY` + `DD-APPLICATION-KEY` headers — the same keys used for
 * the rest of the Datadog API.
 *
 * The backend does NOT implement `remoteWriteUrl()` because Datadog's
 * ingest path is its own `/api/v2/series` endpoint (covered by the
 * `datadog` destination in `log10x_backfill_metric`) rather than
 * Prometheus remote_write.
 */
export class DatadogPromBackend implements CustomerMetricsBackend {
  readonly backendType = 'datadog_prom';
  readonly endpoint: string;
  private headers: Record<string, string>;

  constructor(config: { endpoint: string; apiKey: string; appKey: string }) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.headers = {
      'DD-API-KEY': config.apiKey,
      'DD-APPLICATION-KEY': config.appKey,
    };
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

  async listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]> {
    const url = new URL(`/api/v1/label/${encodeURIComponent(label)}/values`, this.endpoint);
    if (opts?.windowSeconds) {
      const nowS = Math.floor(Date.now() / 1000);
      url.searchParams.set('start', String(nowS - opts.windowSeconds));
      url.searchParams.set('end', String(nowS));
    }
    const res = await this.fetchJson<{ status: string; data: string[] }>(url.toString());
    return res.data || [];
  }

  remoteWriteUrl(): string | undefined {
    // Datadog ingests metrics via /api/v2/series, not Prometheus remote_write.
    // The `log10x_backfill_metric` Datadog destination handles that path
    // directly; nothing to derive here.
    return undefined;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`datadog_prom HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }
}

// ── AWS Managed Prometheus (AMP) ──

/**
 * AWS Managed Prometheus backend. The endpoint must include the workspace
 * prefix, e.g. `https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-abc/`.
 * All requests are SigV4-signed against the `aps` service.
 *
 * Credentials are resolved from the ambient environment:
 *   - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional AWS_SESSION_TOKEN)
 *
 * IMDS-based credential resolution is NOT implemented here. Users running
 * inside EKS/EC2 without exported credentials can either run
 * `aws configure export-credentials --format env-no-export` or point
 * LOG10X_CUSTOMER_METRICS_URL at a sigv4-proxy sidecar instead.
 */
export class AmpBackend implements CustomerMetricsBackend {
  readonly backendType = 'amp';
  readonly endpoint: string;
  private region: string;

  constructor(config: { endpoint: string; region: string }) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.region = config.region;
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const url = new URL(`${this.endpoint}/api/v1/query`);
    url.searchParams.set('query', promql);
    return this.signedFetch<PrometheusResponse>(url);
  }

  async queryRange(
    promql: string,
    start: number,
    end: number,
    step: number
  ): Promise<PrometheusResponse> {
    const url = new URL(`${this.endpoint}/api/v1/query_range`);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', start.toString());
    url.searchParams.set('end', end.toString());
    url.searchParams.set('step', step.toString());
    return this.signedFetch<PrometheusResponse>(url);
  }

  async listLabels(): Promise<string[]> {
    const url = new URL(`${this.endpoint}/api/v1/labels`);
    const res = await this.signedFetch<{ status: string; data: string[] }>(url);
    return res.data || [];
  }

  async listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]> {
    const url = new URL(`${this.endpoint}/api/v1/label/${encodeURIComponent(label)}/values`);
    if (opts?.windowSeconds) {
      const nowS = Math.floor(Date.now() / 1000);
      url.searchParams.set('start', String(nowS - opts.windowSeconds));
      url.searchParams.set('end', String(nowS));
    }
    const res = await this.signedFetch<{ status: string; data: string[] }>(url);
    return res.data || [];
  }

  remoteWriteUrl(): string | undefined {
    // AMP workspace URLs end with `/workspaces/<id>/` and the write path is
    // sibling to the `api/v1/query` read path.
    return `${this.endpoint}/api/v1/remote_write`;
  }

  private async signedFetch<T>(url: URL): Promise<T> {
    const creds = awsCredentials();
    if (!creds) {
      throw new Error(
        'AMP backend needs AWS credentials in the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, ' +
          'optionally AWS_SESSION_TOKEN). In-cluster pods can run ' +
          '`aws configure export-credentials --format env-no-export` to populate the env, ' +
          'or route through a sigv4-proxy sidecar and set LOG10X_CUSTOMER_METRICS_URL to it.'
      );
    }
    const headers = sigV4Sign({
      method: 'GET',
      url,
      region: this.region,
      service: 'aps',
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      body: '',
    });
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`amp HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }
}

// ── GCP Managed Prometheus ──

/**
 * GCP Managed Prometheus (Monarch) exposes a PromQL-compatible read API
 * under `https://monitoring.googleapis.com/v1/projects/<project>/location/global/prometheus/api/v1/…`.
 *
 * Auth uses Google OAuth2 access tokens. This backend shells out to
 * `gcloud auth print-access-token` on each request to avoid pulling in the
 * googleapis SDK. Tokens are cached for ~55 minutes between refreshes.
 *
 * Remote write is NOT a native concept for Managed Prometheus — customers
 * typically push via the GMP collector. `remoteWriteUrl()` returns
 * undefined; callers must set PROMETHEUS_REMOTE_WRITE_URL explicitly.
 */
export class GcpManagedPrometheusBackend implements CustomerMetricsBackend {
  readonly backendType = 'generic_prom'; // GMP presents a Prometheus-compatible surface
  readonly endpoint: string;
  private tokenCache: { token: string; expiresAt: number } | undefined;

  constructor(config: { endpoint: string; project: string }) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    void config.project;
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const url = new URL(`${this.endpoint}/api/v1/query`);
    url.searchParams.set('query', promql);
    return this.authedFetch<PrometheusResponse>(url);
  }

  async queryRange(
    promql: string,
    start: number,
    end: number,
    step: number
  ): Promise<PrometheusResponse> {
    const url = new URL(`${this.endpoint}/api/v1/query_range`);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', start.toString());
    url.searchParams.set('end', end.toString());
    url.searchParams.set('step', step.toString());
    return this.authedFetch<PrometheusResponse>(url);
  }

  async listLabels(): Promise<string[]> {
    const url = new URL(`${this.endpoint}/api/v1/labels`);
    const res = await this.authedFetch<{ status: string; data: string[] }>(url);
    return res.data || [];
  }

  async listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]> {
    const url = new URL(`${this.endpoint}/api/v1/label/${encodeURIComponent(label)}/values`);
    if (opts?.windowSeconds) {
      const nowS = Math.floor(Date.now() / 1000);
      url.searchParams.set('start', String(nowS - opts.windowSeconds));
      url.searchParams.set('end', String(nowS));
    }
    const res = await this.authedFetch<{ status: string; data: string[] }>(url);
    return res.data || [];
  }

  remoteWriteUrl(): string | undefined {
    return undefined;
  }

  private async authedFetch<T>(url: URL): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`gcp_managed_prometheus HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now) return this.tokenCache.token;
    const { stdout } = await execFileP('gcloud', ['auth', 'print-access-token'], { timeout: 5_000 });
    const token = stdout.trim();
    this.tokenCache = { token, expiresAt: now + 55 * 60_000 };
    return token;
  }
}

// ── AWS SigV4 helper ──

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function awsCredentials(): AwsCreds | undefined {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

export function sigV4Sign(opts: {
  method: string;
  url: URL;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  body?: string;
  now?: Date;
}): Record<string, string> {
  const {
    method,
    url,
    region,
    service,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    body = '',
    now = new Date(),
  } = opts;

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = url.pathname || '/';
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [awsUriEncode(k, true), awsUriEncode(v, true)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const headersToSign: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
  };
  if (sessionToken) headersToSign['x-amz-security-token'] = sessionToken;

  const signedHeaderNames = Object.keys(headersToSign).sort();
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalHeaders =
    signedHeaderNames.map((k) => `${k}:${headersToSign[k].trim()}\n`).join('');

  const payloadHash = createHash('sha256').update(body).digest('hex');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...headersToSign, Authorization: authorization };
}

function awsUriEncode(s: string, encodeSlash: boolean): string {
  // RFC 3986 unreserved: A-Z a-z 0-9 - _ . ~
  let out = '';
  for (const ch of s) {
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') ||
        ch === '-' || ch === '_' || ch === '.' || ch === '~') {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
      out += ch;
    } else {
      out += encodeURIComponent(ch).replace(/!/g, '%21');
    }
  }
  return out;
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
  /** Override the remote_write URL derivation. Undefined by default so tests
   *  can assert the "no derivation available" path. */
  remoteWriteOverride?: string;

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

  async listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]> {
    void opts; // Mock backend doesn't simulate windowed queries; tests that
    // need windowed semantics should set up distinct label value sets.
    return [...(this.labelValues[label] || [])];
  }

  remoteWriteUrl(): string | undefined {
    return this.remoteWriteOverride;
  }
}
