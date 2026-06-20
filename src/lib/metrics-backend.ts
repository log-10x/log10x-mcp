/**
 * MetricsBackend — interface + factory for the log10x engine's metrics store.
 *
 * The MCP queries this for every metric tool (top_patterns, cost_drivers,
 * pattern_trend, event_lookup, etc.). Today's hardcoded path to
 * `prometheus.log10x.com` is replaced by a per-env discriminated union:
 * log10x hosted, customer's self-hosted Prometheus / Mimir / Cortex,
 * AMP, Datadog (Prom-compat), Grafana Cloud Prom, or GCP Managed Prom.
 *
 * The customer's 10x engine writes metrics through one of the engine's
 * output modules (`prometheus/remote-write`, `datadog`, `cloudwatch`,
 * etc.) to the same store the MCP queries here.
 *
 * Parallel to but distinct from `CustomerMetricsBackend` in
 * `customer-metrics.ts` (which targets the customer's cross-pillar APM
 * metrics, not log10x's own engine output). Both use Prometheus-shaped
 * reads; we keep the interfaces separate to reflect the different
 * schemas while sharing transport idioms.
 *
 * Phase 1 of the CUSTOMER-PROM-BACKEND design. No callers yet — this
 * file only defines the interface + adapters. Wiring tools to use it
 * happens in phase 4.
 */

import type { PrometheusResponse } from './api.js';
import { backendJsonFetch } from './backend-fetch.js';

// ── Config types ──────────────────────────────────────────────────────────

/** PromQL auth schemes for self-hosted backends (Prom / Mimir / Cortex). */
export type PromAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; user: string; password: string }
  | { type: 'header'; name: string; value: string };

/**
 * Discriminated union of all supported metrics backends.
 *
 * Each kind only carries the fields it needs; consumers narrow via
 * `switch (config.kind)`. Adding a new backend kind is a new variant
 * here plus an adapter class below.
 *
 * `log10x` is the hosted-log10x backend — `apiKey + envId` map to the
 * existing `X-10X-Auth: <apiKey>/<envId>` header against
 * `prometheus.log10x.com`. It's one option among many; the MCP never
 * picks it silently.
 */
export type MetricsBackendConfig =
  | { kind: 'log10x'; apiKey: string; envId: string }
  // Hosted log10x DEMO surface — a self-minted 14-day demo license JWT (no
  // api_key) reading its OWN demo tenant via `Authorization: Bearer` against
  // the `/api/v1/demo/*` routes. For not-signed-in users who installed with a
  // demo license. `endpoint` overrides the default prometheus.log10x.com base.
  | { kind: 'log10x_demo'; licenseJwt: string; endpoint?: string }
  | { kind: 'prometheus'; url: string; auth: PromAuth }
  | { kind: 'mimir'; url: string; auth: PromAuth; orgId?: string }
  | { kind: 'cortex'; url: string; auth: PromAuth; orgId: string }
  | { kind: 'amp'; url: string; region: string }
  | { kind: 'datadog'; site: string; apiKey: string; appKey: string }
  | { kind: 'grafana_cloud_prom'; url: string; user: string; apiKey: string }
  | {
      kind: 'gcp_managed_prom';
      // Full URL up to and including `/api/v1` is constructed from
      // projectId — pass an override only if your stack uses a non-default
      // base host (rare). Default constructed URL:
      //   https://monitoring.googleapis.com/v1/projects/<projectId>/location/global/prometheus
      url?: string;
      projectId: string;
      // Path to the service-account JSON key file (e.g. /tmp/gcp-sa.json).
      // The adapter reads it once and mints OAuth2 access tokens via the
      // JWT-bearer flow; tokens are cached and refreshed 60s before
      // expiry. Mutually exclusive with `accessToken`.
      serviceAccountKeyFile?: string;
      // OR pass a pre-minted access token directly (the operator is
      // responsible for refresh). Useful for short-lived shells.
      accessToken?: string;
    }
  | {
      kind: 'cloudwatch_metrics';
      region: string;
      namespace: string;
      // Optional explicit creds — when absent the SDK uses the ambient
      // chain (env vars, shared config, IAM role).
      awsAccessKeyId?: string;
      awsSecretAccessKey?: string;
    }
  | {
      kind: 'elastic_metrics';
      url: string;
      // Index name OR glob pattern that matches the Micrometer-ES default
      // `micrometer-metrics-YYYY-MM` rolling indices. Default:
      // `micrometer-metrics-*`.
      index?: string;
      // Optional auth (Basic OR API key). Falls back to no-auth when both omitted.
      user?: string;
      password?: string;
      apiKey?: string;
    }
  | {
      // OpenSearch shares the ES _search + _bulk wire protocol; the adapter
      // delegates to the ES backend internally. Separate kind for clarity in
      // logs / config / doctor output (so users see "opensearch" not "elastic").
      kind: 'opensearch_metrics';
      url: string;
      index?: string;
      user?: string;
      password?: string;
      apiKey?: string;
    };

export type MetricsBackendKind = MetricsBackendConfig['kind'];

// ── Runtime interface ─────────────────────────────────────────────────────

/**
 * Runtime backend instance. Tools call these methods instead of hitting
 * `api.ts` directly. Each concrete class wraps the auth + transport for
 * one backend kind.
 *
 * Mirrors the shape of `CustomerMetricsBackend` in `customer-metrics.ts`
 * minus `remoteWriteUrl()` — the 10x engine writes through its own
 * configured output module, not via the MCP, so MCP-side write paths
 * aren't needed here.
 */
export interface MetricsBackend {
  /** Discriminator matching `MetricsBackendConfig['kind']`. */
  readonly kind: MetricsBackendKind;
  /** Human-readable endpoint URL for logging / doctor output — never includes secrets. */
  readonly endpoint: string;

  queryInstant(promql: string): Promise<PrometheusResponse>;
  queryRange(promql: string, startSec: number, endSec: number, stepSec: number): Promise<PrometheusResponse>;
  listLabels(): Promise<string[]>;
  listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]>;
}

// ── ${VAR} resolution + literal-secret guard ──────────────────────────────

/**
 * Resolve a `${VAR}` reference in a config field from `process.env`. The
 * file format permits any auth field to be either a literal OR a
 * `${ENV_VAR_NAME}` reference. References are resolved at load time —
 * the literal token lives in the user's shell or password manager,
 * never in the config file.
 *
 * Throws if the referenced variable is unset; the caller surfaces the
 * error with the field name so the user knows which env var to export.
 */
export function resolveVarReference(value: string): string {
  const m = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!m) return value;
  const v = process.env[m[1]];
  if (v === undefined) {
    throw new MetricsBackendConfigError(
      `Config references ${value}, but environment variable ${m[1]} is unset. ` +
        `Either export ${m[1]} or replace the reference with a literal value ` +
        `(NOT recommended for secrets — use the env-var reference pattern).`
    );
  }
  return v;
}

/**
 * Detect a value that looks like a plaintext secret in a field that
 * should hold a `${VAR}` reference. Heuristic — meant to catch
 * copy-paste-once-then-forget mistakes that leak secrets into committed
 * dotfiles or backups.
 *
 * Triggers when ALL of:
 *   - length >= 32 (most API keys / tokens are at least this long)
 *   - mix of letters AND digits (random tokens almost always have both)
 *   - no `${...}` syntax (already a reference, not a literal)
 *   - no whitespace, slashes, or path separators (URLs / file paths
 *     excluded)
 *
 * False positives: a user explicitly putting a literal secret in the
 * file. They get an error pointing at the `${VAR}` pattern. Tradeoff
 * accepted — better than silently storing the secret.
 */
export function looksLikeLiteralSecret(value: string): boolean {
  if (value.length < 32) return false;
  if (value.includes('${')) return false;
  if (/[\s/\\]/.test(value)) return false;
  const hasLetter = /[A-Za-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  return hasLetter && hasDigit;
}

/**
 * Error class for config-time validation failures (unset `${VAR}`,
 * detected literal secret, missing required field, etc.). Distinct
 * from runtime backend errors so callers can choose to surface
 * configuration problems differently from transient HTTP errors.
 */
export class MetricsBackendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricsBackendConfigError';
  }
}

/**
 * Walk every string field in a backend config, resolve `${VAR}`
 * references, and refuse with an error if any auth-bearing field
 * appears to hold a literal secret instead of a reference.
 *
 * The `secretFields` allowlist is the set of paths that MUST be either
 * a `${VAR}` reference OR a short non-secret value. Bare URLs, region
 * strings, project IDs, etc. are not in this set and pass through.
 */
function normalizeAndGuard(config: MetricsBackendConfig): MetricsBackendConfig {
  // Paths in the union that hold credentials — these are the only
  // fields where `looksLikeLiteralSecret` fires.
  const c = config;
  switch (c.kind) {
    case 'log10x':
      return {
        ...c,
        apiKey: guardSecret('log10x.apiKey', c.apiKey),
        envId: resolveVarReference(c.envId),
      };
    case 'log10x_demo':
      // The license JWT is a short-lived (14-day) demo credential supplied via
      // env var or self-minted, never a committed account secret, so it is
      // resolved (for ${VAR} support) but exempt from the literal-secret guard
      // that long-lived account keys get.
      return { ...c, licenseJwt: resolveVarReference(c.licenseJwt) };
    case 'prometheus':
    case 'mimir':
    case 'cortex':
      return { ...c, url: resolveVarReference(c.url), auth: guardAuth(c.auth) } as MetricsBackendConfig;
    case 'amp':
      return { ...c, url: resolveVarReference(c.url), region: resolveVarReference(c.region) };
    case 'datadog':
      return {
        ...c,
        site: resolveVarReference(c.site),
        apiKey: guardSecret('datadog.apiKey', c.apiKey),
        appKey: guardSecret('datadog.appKey', c.appKey),
      };
    case 'grafana_cloud_prom':
      return {
        ...c,
        url: resolveVarReference(c.url),
        user: resolveVarReference(c.user),
        apiKey: guardSecret('grafana_cloud_prom.apiKey', c.apiKey),
      };
    case 'gcp_managed_prom':
      return {
        ...c,
        url: c.url ? resolveVarReference(c.url) : undefined,
        projectId: resolveVarReference(c.projectId),
        serviceAccountKeyFile: c.serviceAccountKeyFile ? resolveVarReference(c.serviceAccountKeyFile) : undefined,
        accessToken: c.accessToken ? guardSecret('gcp_managed_prom.accessToken', c.accessToken) : undefined,
      };
    case 'cloudwatch_metrics':
      return {
        ...c,
        region: resolveVarReference(c.region),
        namespace: resolveVarReference(c.namespace),
        awsAccessKeyId: c.awsAccessKeyId ? resolveVarReference(c.awsAccessKeyId) : undefined,
        awsSecretAccessKey: c.awsSecretAccessKey ? guardSecret('cloudwatch_metrics.awsSecretAccessKey', c.awsSecretAccessKey) : undefined,
      };
    case 'elastic_metrics':
      return {
        ...c,
        url: resolveVarReference(c.url),
        index: c.index ? resolveVarReference(c.index) : undefined,
        user: c.user ? resolveVarReference(c.user) : undefined,
        password: c.password ? guardSecret('elastic_metrics.password', c.password) : undefined,
        apiKey: c.apiKey ? guardSecret('elastic_metrics.apiKey', c.apiKey) : undefined,
      };
    case 'opensearch_metrics':
      return {
        ...c,
        url: resolveVarReference(c.url),
        index: c.index ? resolveVarReference(c.index) : undefined,
        user: c.user ? resolveVarReference(c.user) : undefined,
        password: c.password ? guardSecret('opensearch_metrics.password', c.password) : undefined,
        apiKey: c.apiKey ? guardSecret('opensearch_metrics.apiKey', c.apiKey) : undefined,
      };
  }
}

function guardSecret(fieldName: string, raw: string): string {
  const resolved = resolveVarReference(raw);
  // If the field used the ${VAR} form we already resolved; the user's
  // intent was to reference, so don't second-guess the resolved value.
  if (raw !== resolved) return resolved;
  if (looksLikeLiteralSecret(raw)) {
    throw new MetricsBackendConfigError(
      `Field ${fieldName} appears to hold a literal credential. ` +
        `Move the value into an environment variable and reference it as \`\${VAR_NAME}\` in your config. ` +
        `This prevents secrets from leaking into committed dotfiles or backups.`
    );
  }
  return raw;
}

function guardAuth(auth: PromAuth): PromAuth {
  switch (auth.type) {
    case 'none':
      return auth;
    case 'bearer':
      return { type: 'bearer', token: guardSecret('auth.token', auth.token) };
    case 'basic':
      return {
        type: 'basic',
        user: resolveVarReference(auth.user),
        password: guardSecret('auth.password', auth.password),
      };
    case 'header':
      return {
        type: 'header',
        name: resolveVarReference(auth.name),
        value: guardSecret(`auth.${auth.name}`, auth.value),
      };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────

/**
 * Instantiate the right MetricsBackend implementation for a config.
 * Resolves `${VAR}` references on every string field, refuses to start
 * if any auth field looks like a literal secret.
 *
 * This is the only export tools should use. Direct construction of
 * the adapter classes bypasses the secret-detection guard.
 */
export function createMetricsBackend(config: MetricsBackendConfig): MetricsBackend {
  const safe = normalizeAndGuard(config);
  switch (safe.kind) {
    case 'log10x':
      return new Log10xBackend(safe);
    case 'log10x_demo':
      return new Log10xDemoBackend(safe);
    case 'prometheus':
      return new PrometheusBackend(safe);
    case 'mimir':
      return new MimirBackend(safe);
    case 'cortex':
      return new CortexBackend(safe);
    case 'amp':
      return new AmpBackend(safe);
    case 'datadog':
      return new DatadogBackend(safe);
    case 'grafana_cloud_prom':
      return new GrafanaCloudBackend(safe);
    case 'gcp_managed_prom':
      return new GcpManagedPromBackend(safe);
    case 'cloudwatch_metrics':
      return new CloudWatchMetricsBackend(safe);
    case 'elastic_metrics':
      return new ElasticMetricsBackend(safe);
    case 'opensearch_metrics':
      return new OpenSearchMetricsBackend(safe);
  }
}

// ── Adapter classes ───────────────────────────────────────────────────────

/**
 * Shared helper for the prom-compatible adapters. Builds auth headers
 * from a `PromAuth` value and runs a JSON fetch with consistent error
 * formatting.
 *
 * Delegates retry+timeout to `backend-fetch.ts`. Retry classes (5xx, 429,
 * network, AbortError → timeout) and the error envelope shape live there.
 * Tunable via env: LOG10X_RETRY_ATTEMPTS (default 3), LOG10X_RETRY_BASE_MS
 * (default 250), LOG10X_REQUEST_TIMEOUT_MS (default 30000).
 */
async function promJsonFetch<T>(
  kindLabel: string,
  url: URL,
  extraHeaders: Record<string, string>,
  authHeaders: Record<string, string>
): Promise<T> {
  const headers = { ...extraHeaders, ...authHeaders };
  return backendJsonFetch<T>(url.toString(), { headers }, { kindLabel });
}

function promAuthHeaders(auth: PromAuth): Record<string, string> {
  switch (auth.type) {
    case 'none':
      return {};
    case 'bearer':
      return { Authorization: `Bearer ${auth.token}` };
    case 'basic': {
      const b = Buffer.from(`${auth.user}:${auth.password}`).toString('base64');
      return { Authorization: `Basic ${b}` };
    }
    case 'header':
      return { [auth.name]: auth.value };
  }
}

/**
 * Hosted log10x — wraps the existing `api.ts` calls so phase 1 has zero
 * behavior change for log10x-backed envs. The function-level api.ts
 * exports stay; later phases switch tools to call through this adapter.
 */
class Log10xBackend implements MetricsBackend {
  readonly kind = 'log10x' as const;
  readonly endpoint = 'https://prometheus.log10x.com';
  private readonly auth: string;

  constructor(private readonly config: Extract<MetricsBackendConfig, { kind: 'log10x' }>) {
    this.auth = `${config.apiKey}/${config.envId}`;
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const url = new URL('/api/v1/query', this.endpoint);
    url.searchParams.set('query', promql);
    return promJsonFetch('log10x', url, {}, { 'X-10X-Auth': this.auth });
  }

  async queryRange(promql: string, startSec: number, endSec: number, stepSec: number): Promise<PrometheusResponse> {
    const url = new URL('/api/v1/query_range', this.endpoint);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', String(startSec));
    url.searchParams.set('end', String(endSec));
    url.searchParams.set('step', String(stepSec));
    return promJsonFetch('log10x', url, {}, { 'X-10X-Auth': this.auth });
  }

  async listLabels(): Promise<string[]> {
    const url = new URL('/api/v1/labels', this.endpoint);
    const res = await promJsonFetch<{ status: string; data: string[] }>('log10x', url, {}, { 'X-10X-Auth': this.auth });
    return res.data || [];
  }

  async listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]> {
    const url = new URL(`/api/v1/label/${encodeURIComponent(label)}/values`, this.endpoint);
    if (opts?.windowSeconds) {
      const nowS = Math.floor(Date.now() / 1000);
      url.searchParams.set('start', String(nowS - opts.windowSeconds));
      url.searchParams.set('end', String(nowS));
    }
    const res = await promJsonFetch<{ status: string; data: string[] }>('log10x', url, {}, { 'X-10X-Auth': this.auth });
    return res.data || [];
  }
}

/** 3h — must match the gateway's `demoMaxLookback` for the /api/v1/demo/* routes. */
const DEMO_WINDOW_SEC = 3 * 60 * 60;

/**
 * Hosted log10x DEMO backend — for a not-signed-in user who installed an
 * engine with an anonymous demo license JWT and has no api_key. It queries the
 * `/api/v1/demo/*` mirror of the read endpoints with `Authorization: Bearer
 * <licenseJwt>`, scoped server-side to that license's own demo tenant — so the
 * MCP reads exactly the data the same-license engine writes.
 *
 * Every read is bounded to the last `DEMO_WINDOW_SEC` seconds: the gateway
 * rejects demo reads older than that (HTTP 400), so we clamp the lower bound
 * client-side to stay inside the window. A range that is *entirely* older than
 * the window is refused locally with a clear message rather than bounced.
 */
class Log10xDemoBackend implements MetricsBackend {
  readonly kind = 'log10x_demo' as const;
  readonly endpoint: string;
  private readonly authHeaders: Record<string, string>;

  constructor(config: Extract<MetricsBackendConfig, { kind: 'log10x_demo' }>) {
    this.endpoint = config.endpoint || 'https://prometheus.log10x.com';
    this.authHeaders = { Authorization: `Bearer ${config.licenseJwt}` };
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const url = new URL('/api/v1/demo/query', this.endpoint);
    url.searchParams.set('query', promql);
    return this.demoFetch(url);
  }

  async queryRange(promql: string, startSec: number, endSec: number, stepSec: number): Promise<PrometheusResponse> {
    const nowS = Math.floor(Date.now() / 1000);
    const minStart = nowS - DEMO_WINDOW_SEC;
    const end = Math.min(endSec, nowS);
    if (end <= minStart) {
      throw new Error(
        `log10x_demo: the requested range ends outside the ${DEMO_WINDOW_SEC / 3600}h demo window — ` +
          `demo data only covers the last ${DEMO_WINDOW_SEC / 3600} hours. Sign in for full history.`
      );
    }
    const start = Math.max(startSec, minStart);
    const url = new URL('/api/v1/demo/query_range', this.endpoint);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', String(start));
    url.searchParams.set('end', String(end));
    url.searchParams.set('step', String(stepSec));
    return this.demoFetch(url);
  }

  async listLabels(): Promise<string[]> {
    const url = new URL('/api/v1/demo/labels', this.endpoint);
    const res = await this.demoFetch<{ status: string; data: string[] }>(url);
    return res.data || [];
  }

  async listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]> {
    const url = new URL(`/api/v1/demo/label/${encodeURIComponent(label)}/values`, this.endpoint);
    const nowS = Math.floor(Date.now() / 1000);
    // Always bound to the demo window; a wider requested window is clamped down.
    const windowSec = Math.min(opts?.windowSeconds ?? DEMO_WINDOW_SEC, DEMO_WINDOW_SEC);
    url.searchParams.set('start', String(nowS - windowSec));
    url.searchParams.set('end', String(nowS));
    const res = await this.demoFetch<{ status: string; data: string[] }>(url);
    return res.data || [];
  }

  // Wraps the shared fetch to give demo callers actionable messages on the two
  // demo-specific failures. The gateway's 400 body already explains the 3h
  // window, so it passes through unchanged.
  private async demoFetch<T = PrometheusResponse>(url: URL): Promise<T> {
    try {
      return await promJsonFetch<T>('log10x_demo', url, {}, this.authHeaders);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('HTTP 401') || msg.includes('HTTP 403')) {
        throw new Error(`log10x_demo: the demo license was rejected (expired or invalid) — mint a fresh one. (${msg})`);
      }
      if (msg.includes('HTTP 429')) {
        throw new Error(`log10x_demo: demo query rate limit hit — slow down, or sign in for higher limits. (${msg})`);
      }
      throw e;
    }
  }
}

/**
 * Generic Prometheus-compatible backend. Supports `none` / `bearer` /
 * `basic` / `header` auth. Endpoint must be the base URL of the
 * Prometheus API root — paths like `/api/v1/query` are appended.
 */
class PrometheusBackend implements MetricsBackend {
  readonly kind: MetricsBackendKind = 'prometheus';
  readonly endpoint: string;
  protected readonly auth: PromAuth;
  protected readonly extraHeaders: Record<string, string>;

  constructor(config: Extract<MetricsBackendConfig, { kind: 'prometheus' | 'mimir' | 'cortex' }>) {
    this.endpoint = config.url.replace(/\/+$/, '');
    this.auth = config.auth;
    this.extraHeaders = {};
  }

  protected get authHeaders(): Record<string, string> {
    return promAuthHeaders(this.auth);
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const url = new URL(`${this.endpoint}/api/v1/query`);
    url.searchParams.set('query', promql);
    return promJsonFetch(this.kind, url, this.extraHeaders, this.authHeaders);
  }

  async queryRange(promql: string, startSec: number, endSec: number, stepSec: number): Promise<PrometheusResponse> {
    const url = new URL(`${this.endpoint}/api/v1/query_range`);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', String(startSec));
    url.searchParams.set('end', String(endSec));
    url.searchParams.set('step', String(stepSec));
    return promJsonFetch(this.kind, url, this.extraHeaders, this.authHeaders);
  }

  async listLabels(): Promise<string[]> {
    const url = new URL(`${this.endpoint}/api/v1/labels`);
    const res = await promJsonFetch<{ status: string; data: string[] }>(this.kind, url, this.extraHeaders, this.authHeaders);
    return res.data || [];
  }

  async listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]> {
    const url = new URL(`${this.endpoint}/api/v1/label/${encodeURIComponent(label)}/values`);
    if (opts?.windowSeconds) {
      const nowS = Math.floor(Date.now() / 1000);
      url.searchParams.set('start', String(nowS - opts.windowSeconds));
      url.searchParams.set('end', String(nowS));
    }
    const res = await promJsonFetch<{ status: string; data: string[] }>(this.kind, url, this.extraHeaders, this.authHeaders);
    return res.data || [];
  }
}

/**
 * Mimir — Prometheus-compatible with optional tenant scoping via
 * `X-Scope-OrgID`. Standard read API is at `/prometheus/api/v1/...`
 * when behind the Mimir gateway, but many deployments expose
 * `/api/v1/...` directly. The endpoint URL the user provides governs;
 * we just append paths to it.
 */
class MimirBackend extends PrometheusBackend {
  override readonly kind: MetricsBackendKind = 'mimir';

  constructor(config: Extract<MetricsBackendConfig, { kind: 'mimir' }>) {
    super({ kind: 'prometheus', url: config.url, auth: config.auth });
    if (config.orgId) this.extraHeaders['X-Scope-OrgID'] = config.orgId;
  }
}

/**
 * Cortex — like Mimir, but `orgId` is mandatory (Cortex always
 * multi-tenant; no implicit single-tenant mode).
 */
class CortexBackend extends PrometheusBackend {
  override readonly kind: MetricsBackendKind = 'cortex';

  constructor(config: Extract<MetricsBackendConfig, { kind: 'cortex' }>) {
    super({ kind: 'prometheus', url: config.url, auth: config.auth });
    this.extraHeaders['X-Scope-OrgID'] = config.orgId;
  }
}

/**
 * AWS Managed Prometheus (AMP). PromQL-compatible read API requires
 * SigV4 signing against the `aps` service. AWS credentials come from
 * the ambient AWS SDK credential chain (env vars / AWS_PROFILE / IAM
 * role / SSO / IRSA) — the MCP never reads them itself, never persists
 * them to config.
 */
class AmpBackend implements MetricsBackend {
  readonly kind = 'amp' as const;
  readonly endpoint: string;
  private readonly region: string;

  constructor(config: Extract<MetricsBackendConfig, { kind: 'amp' }>) {
    this.endpoint = config.url.replace(/\/+$/, '');
    this.region = config.region;
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const url = new URL(`${this.endpoint}/api/v1/query`);
    url.searchParams.set('query', promql);
    return this.signedFetch<PrometheusResponse>(url);
  }
  async queryRange(promql: string, startSec: number, endSec: number, stepSec: number): Promise<PrometheusResponse> {
    const url = new URL(`${this.endpoint}/api/v1/query_range`);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', String(startSec));
    url.searchParams.set('end', String(endSec));
    url.searchParams.set('step', String(stepSec));
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

  private async signedFetch<T>(url: URL): Promise<T> {
    // Lazy import to avoid pulling customer-metrics in unless AMP is actually used.
    const cm = await import('./customer-metrics.js');
    const creds = cm.awsCredentials();
    if (!creds) {
      throw new Error(
        'AMP backend needs AWS credentials in the environment. Export AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional AWS_SESSION_TOKEN), use AWS_PROFILE / AWS SSO, or run inside a pod with IRSA. The MCP never reads or persists these credentials itself.'
      );
    }
    const headers = cm.sigV4Sign({
      method: 'GET',
      url,
      region: this.region,
      service: 'aps',
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      body: '',
    });
    // SigV4 canonical query string uses RFC 3986 encoding (spaces as %20).
    // URL.toString() uses application/x-www-form-urlencoded for the query
    // (spaces as +). The fetch send-path must match the signed string, so
    // we rebuild the URL with %20 instead of +. Without this, AWS rejects
    // with HTTP 403 / SignatureDoesNotMatch on any query that contains a
    // space (e.g., `topk(5, sum by (...)...)`).
    const rfc3986Query = url.searchParams.toString().replace(/\+/g, '%20');
    const fetchUrl = `${url.origin}${url.pathname}${rfc3986Query ? '?' + rfc3986Query : ''}`;
    const res = await fetch(fetchUrl, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`amp HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * Datadog backend with PromQL→DD translation.
 *
 * Datadog's `/api/v1/query` does NOT accept PromQL — it accepts
 * Datadog's native syntax (`sum:metric{tag} by {dim}.as_count()`).
 * This adapter translates the MCP's PromQL queries via
 * `promql-to-datadog.ts` and reshapes Datadog's response back into a
 * Prometheus-shaped envelope so the rest of the MCP doesn't need to
 * care.
 *
 * Endpoint is constructed from the `site` field (e.g.,
 * `us5.datadoghq.com` → `https://api.us5.datadoghq.com`). Auth is
 * `DD-API-KEY` + `DD-APPLICATION-KEY` headers.
 *
 * The translator targets the closed set of query shapes the MCP
 * tools actually issue — not arbitrary PromQL. See
 * `src/lib/promql-to-datadog.ts` for the supported subset.
 *
 * Datadog has no native equivalent for `/api/v1/labels` and
 * `/api/v1/label/{name}/values` — those endpoints are documented to
 * exist but reject any non-trivial input. We fall back to running a
 * `group by(label)` translated query and extracting distinct values
 * from the response.
 */
class DatadogBackend implements MetricsBackend {
  readonly kind = 'datadog' as const;
  readonly endpoint: string;
  private readonly headers: Record<string, string>;

  constructor(config: Extract<MetricsBackendConfig, { kind: 'datadog' }>) {
    this.endpoint = `https://api.${config.site.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
    this.headers = {
      'DD-API-KEY': config.apiKey,
      'DD-APPLICATION-KEY': config.appKey,
    };
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    // Lazy-load translator so the module only pays the cost when DD is in use.
    const { promqlToDatadog, PromQLTranslationError } = await import('./promql-to-datadog.js');
    let ddQuery: string;
    try {
      ddQuery = promqlToDatadog(promql);
    } catch (e) {
      if (e instanceof PromQLTranslationError) {
        throw new Error(
          `datadog: cannot translate PromQL — ${e.message}. Source query: ${promql.slice(0, 200)}`
        );
      }
      throw e;
    }
    const now = Math.floor(Date.now() / 1000);
    const url = new URL('/api/v1/query', this.endpoint);
    url.searchParams.set('query', ddQuery);
    url.searchParams.set('from', String(now - 900));
    url.searchParams.set('to', String(now));
    const res = await ddJsonFetch(url, this.headers);
    return ddSeriesToPromResponse(res);
  }

  async queryRange(promql: string, startSec: number, endSec: number, _stepSec: number): Promise<PrometheusResponse> {
    const { promqlToDatadog } = await import('./promql-to-datadog.js');
    const ddQuery = promqlToDatadog(promql);
    const url = new URL('/api/v1/query', this.endpoint);
    url.searchParams.set('query', ddQuery);
    url.searchParams.set('from', String(startSec));
    url.searchParams.set('to', String(endSec));
    const res = await ddJsonFetch(url, this.headers);
    return ddSeriesToPromResponse(res, { matrix: true });
  }

  async listLabels(): Promise<string[]> {
    // Datadog doesn't expose a Prom-compatible label-enumeration API.
    // We emit a synthetic list derived from `all_events_summaryBytes`
    // tags. This is best-effort; callers that absolutely need the full
    // label universe should query a known metric and inspect the tag
    // dimensions on the response.
    const now = Math.floor(Date.now() / 1000);
    const url = new URL('/api/v1/query', this.endpoint);
    url.searchParams.set('query', 'sum:all_events_summaryBytes{*}');
    url.searchParams.set('from', String(now - 900));
    url.searchParams.set('to', String(now));
    const res = await ddJsonFetch(url, this.headers);
    const tags = new Set<string>();
    for (const s of res.series || []) {
      for (const t of s.tag_set || []) {
        const [k] = t.split(':');
        if (k) tags.add(k);
      }
    }
    return Array.from(tags).sort();
  }

  async listLabelValues(label: string, _opts?: { windowSeconds?: number }): Promise<string[]> {
    // Use group-by to enumerate distinct values for a label.
    const now = Math.floor(Date.now() / 1000);
    const url = new URL('/api/v1/query', this.endpoint);
    url.searchParams.set('query', `min:all_events_summaryBytes{*} by {${label}}`);
    url.searchParams.set('from', String(now - 900));
    url.searchParams.set('to', String(now));
    const res = await ddJsonFetch(url, this.headers);
    const values = new Set<string>();
    for (const s of res.series || []) {
      for (const t of s.tag_set || []) {
        if (t.startsWith(`${label}:`)) {
          values.add(t.slice(label.length + 1));
        }
      }
    }
    return Array.from(values).sort();
  }
}

interface DatadogQueryResponse {
  status: string;
  series?: Array<{
    metric?: string;
    scope?: string;
    tag_set?: string[];
    pointlist?: Array<[number, number]>;
    expression?: string;
  }>;
  error?: string;
  message?: string;
}

async function ddJsonFetch(url: URL, headers: Record<string, string>): Promise<DatadogQueryResponse> {
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`datadog HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as DatadogQueryResponse;
  if (json.status === 'error') {
    throw new Error(`datadog query error: ${json.error || json.message || '(no message)'}`);
  }
  return json;
}

/**
 * Reshape a Datadog query response into a Prometheus-shaped response
 * envelope so the rest of the MCP (which expects PrometheusResponse)
 * works unchanged.
 *
 * For `matrix: true` (range queries), we emit all points. Otherwise
 * we emit the last point per series.
 */
function ddSeriesToPromResponse(
  ddResp: DatadogQueryResponse,
  opts: { matrix?: boolean } = {}
): PrometheusResponse {
  const result = (ddResp.series || []).map((s) => {
    const metric: Record<string, string> = {};
    for (const t of s.tag_set || []) {
      const idx = t.indexOf(':');
      if (idx > 0) metric[t.slice(0, idx)] = t.slice(idx + 1);
    }
    if (opts.matrix) {
      // Range / matrix shape: full pointlist.
      const values: Array<[number, string]> = (s.pointlist || [])
        .filter(([, v]) => v !== null && !Number.isNaN(v))
        .map(([ts, v]) => [Math.floor(ts / 1000), String(v)]);
      return { metric, values };
    }
    // Instant shape: SUM the pointlist over the window — Prometheus's
    // `increase(M[range])` returns one scalar per series representing
    // the total increase over the range. Datadog's response is a
    // time-series of `.as_count()` values (one per bucket); summing
    // them recovers the windowed total. Taking last-point would
    // return only the most-recent bucket, which is often 0 or partial.
    const points = (s.pointlist || []).filter(([, v]) => v !== null && !Number.isNaN(v));
    if (points.length === 0) return { metric };
    const total = points.reduce((sum, [, v]) => sum + v, 0);
    const lastTs = points[points.length - 1][0];
    return { metric, value: [Math.floor(lastTs / 1000), String(total)] as [number, string] };
  });
  return {
    status: 'success',
    data: {
      resultType: opts.matrix ? 'matrix' : 'vector',
      result,
    },
  };
}

/**
 * Grafana Cloud Prometheus. Authenticated via HTTP Basic with the
 * grafana.com instance ID as the user and an API key as the password.
 * Same wire protocol as a plain Prometheus with basic auth — just
 * different conventions for what goes in user vs password.
 */
class GrafanaCloudBackend extends PrometheusBackend {
  override readonly kind: MetricsBackendKind = 'grafana_cloud_prom';

  constructor(config: Extract<MetricsBackendConfig, { kind: 'grafana_cloud_prom' }>) {
    super({
      kind: 'prometheus',
      url: config.url,
      auth: { type: 'basic', user: config.user, password: config.apiKey },
    });
  }
}

/**
 * GCP Managed Prometheus (GMP). Reads via the standard Prometheus
 * PromQL API exposed at
 *   `monitoring.googleapis.com/v1/projects/<P>/location/global/prometheus`.
 * Auth: OAuth2 Bearer token from a service-account JSON via the JWT-
 * bearer flow (no external deps — uses Node crypto for RS256).
 *
 * Tokens are cached and refreshed 60s before expiry. The adapter
 * accepts either:
 *   - `serviceAccountKeyFile`: path to SA JSON; adapter mints + refreshes
 *   - `accessToken`: pre-minted token; operator is responsible for refresh
 */
class GcpManagedPromBackend implements MetricsBackend {
  readonly kind = 'gcp_managed_prom' as const;
  readonly endpoint: string;
  private readonly projectId: string;
  private readonly staticAccessToken?: string;
  private readonly saKeyFile?: string;
  // Cached token state when minting from SA JSON.
  private cachedToken?: string;
  private cachedTokenExpiresAt = 0;
  private cachedSa?: { client_email: string; private_key: string };

  constructor(config: Extract<MetricsBackendConfig, { kind: 'gcp_managed_prom' }>) {
    this.projectId = config.projectId;
    const baseUrl = config.url
      ? config.url.replace(/\/+$/, '')
      : `https://monitoring.googleapis.com/v1/projects/${this.projectId}/location/global/prometheus`;
    this.endpoint = baseUrl;
    this.staticAccessToken = config.accessToken;
    this.saKeyFile = config.serviceAccountKeyFile;
    if (!this.staticAccessToken && !this.saKeyFile) {
      throw new MetricsBackendConfigError(
        'gcp_managed_prom requires either `accessToken` (pre-minted) or `serviceAccountKeyFile` (SA JSON path).'
      );
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.staticAccessToken) return this.staticAccessToken;
    if (!this.saKeyFile) throw new Error('gcp_managed_prom: no auth source configured');
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && now < this.cachedTokenExpiresAt - 60) {
      return this.cachedToken;
    }
    if (!this.cachedSa) {
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(this.saKeyFile, 'utf-8');
      const sa = JSON.parse(raw) as { client_email?: string; private_key?: string };
      if (!sa.client_email || !sa.private_key) {
        throw new Error(`gcp_managed_prom: SA file ${this.saKeyFile} missing client_email or private_key`);
      }
      this.cachedSa = { client_email: sa.client_email, private_key: sa.private_key };
    }
    const { createSign } = await import('node:crypto');
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: this.cachedSa.client_email,
      scope: 'https://www.googleapis.com/auth/monitoring.read',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };
    const b64u = (o: object): string =>
      Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const signingInput = `${b64u(header)}.${b64u(payload)}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const sig = signer.sign(this.cachedSa.private_key).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const assertion = `${signingInput}.${sig}`;
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!tokRes.ok) {
      const body = await tokRes.text().catch(() => '');
      throw new Error(`gcp_managed_prom token exchange HTTP ${tokRes.status}: ${body.slice(0, 400)}`);
    }
    const tok = (await tokRes.json()) as { access_token?: string; expires_in?: number };
    if (!tok.access_token) throw new Error('gcp_managed_prom token exchange: no access_token in response');
    this.cachedToken = tok.access_token;
    this.cachedTokenExpiresAt = now + (tok.expires_in ?? 3600);
    return this.cachedToken;
  }

  private async gmpJsonFetch(path: string, params?: URLSearchParams): Promise<PrometheusResponse> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.endpoint}${path}`);
    if (params) {
      for (const [k, v] of params.entries()) url.searchParams.append(k, v);
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`gcp_managed_prom HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as PrometheusResponse;
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const params = new URLSearchParams({ query: promql });
    return this.gmpJsonFetch('/api/v1/query', params);
  }

  async queryRange(
    promql: string,
    startSec: number,
    endSec: number,
    stepSec: number
  ): Promise<PrometheusResponse> {
    const params = new URLSearchParams({
      query: promql,
      start: String(startSec),
      end: String(endSec),
      step: String(stepSec),
    });
    return this.gmpJsonFetch('/api/v1/query_range', params);
  }

  async listLabels(): Promise<string[]> {
    const resp = await this.gmpJsonFetch('/api/v1/labels');
    // /labels returns { status, data: string[] }
    const data = (resp as unknown as { data?: string[] }).data;
    return Array.isArray(data) ? data : [];
  }

  async listLabelValues(label: string): Promise<string[]> {
    const resp = await this.gmpJsonFetch(`/api/v1/label/${encodeURIComponent(label)}/values`);
    const data = (resp as unknown as { data?: string[] }).data;
    return Array.isArray(data) ? data : [];
  }
}

// ── CloudWatch Metrics adapter ────────────────────────────────────────────

/**
 * AWS CloudWatch Metrics backend. Reads metrics that were written to a
 * specific CW namespace (via PutMetricData) and reshapes responses into
 * Prometheus envelopes so the existing MCP tools can render them.
 *
 * CW doesn't speak PromQL; it speaks Metric Math + GetMetricData /
 * GetMetricStatistics. This adapter accepts a closed set of PromQL
 * shapes the MCP issues and translates each to the equivalent CW API
 * calls. Unsupported shapes throw a clear error rather than fabricating
 * a result.
 *
 * Auth: SDK ambient chain by default (env vars, shared config, IAM
 * role). When awsAccessKeyId + awsSecretAccessKey are set explicitly,
 * those override the ambient chain. The secret-guard at config-load
 * time prevents committing literal secrets.
 */
class CloudWatchMetricsBackend implements MetricsBackend {
  readonly kind = 'cloudwatch_metrics' as const;
  readonly endpoint: string;
  private readonly region: string;
  private readonly namespace: string;
  private readonly awsAccessKeyId?: string;
  private readonly awsSecretAccessKey?: string;
  private clientCache: unknown;

  constructor(config: Extract<MetricsBackendConfig, { kind: 'cloudwatch_metrics' }>) {
    this.region = config.region;
    this.namespace = config.namespace;
    this.awsAccessKeyId = config.awsAccessKeyId;
    this.awsSecretAccessKey = config.awsSecretAccessKey;
    this.endpoint = `cloudwatch://${this.region}/${this.namespace}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async client(): Promise<any> {
    if (this.clientCache) return this.clientCache;
    const sdk = await import('@aws-sdk/client-cloudwatch');
    const credentials = this.awsAccessKeyId && this.awsSecretAccessKey
      ? { accessKeyId: this.awsAccessKeyId, secretAccessKey: this.awsSecretAccessKey }
      : undefined;
    const cached = {
      CloudWatchClient: sdk.CloudWatchClient,
      ListMetricsCommand: sdk.ListMetricsCommand,
      GetMetricDataCommand: sdk.GetMetricDataCommand,
      instance: new sdk.CloudWatchClient({
        region: this.region,
        maxAttempts: 3,
        ...(credentials ? { credentials } : {}),
      }),
    };
    this.clientCache = cached;
    return cached;
  }

  async listLabels(): Promise<string[]> {
    const { instance, ListMetricsCommand } = await this.client();
    const dims = new Set<string>();
    let NextToken: string | undefined;
    do {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await (instance as { send: (c: unknown) => Promise<unknown> }).send(
        new ListMetricsCommand({ Namespace: this.namespace, NextToken })
      );
      for (const m of resp.Metrics || []) {
        for (const d of m.Dimensions || []) {
          if (d.Name) dims.add(d.Name);
        }
      }
      NextToken = resp.NextToken;
    } while (NextToken);
    return Array.from(dims);
  }

  async listLabelValues(label: string): Promise<string[]> {
    const { instance, ListMetricsCommand } = await this.client();
    const values = new Set<string>();
    let NextToken: string | undefined;
    do {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await (instance as { send: (c: unknown) => Promise<unknown> }).send(
        new ListMetricsCommand({ Namespace: this.namespace, NextToken })
      );
      for (const m of resp.Metrics || []) {
        for (const d of m.Dimensions || []) {
          if (d.Name === label && d.Value) values.add(d.Value);
        }
      }
      NextToken = resp.NextToken;
    } while (NextToken);
    return Array.from(values);
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    // Closed set of PromQL shapes the MCP issues. Each translates to a
    // specific CW operation. Unknown shapes throw — never silently
    // succeed with a fake answer.
    const trimmed = promql.trim();

    // Shape 1: count(<metric>) — series count for a metric.
    const countMatch = trimmed.match(/^count\(([a-zA-Z_:][a-zA-Z0-9_:]*)\)$/);
    if (countMatch) {
      const metricName = countMatch[1];
      const count = await this.countMetricSeries(metricName);
      return {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: {}, value: [Math.floor(Date.now() / 1000), String(count)] }],
        },
      };
    }

    // Shape 2: bare metric selector <metric> or <metric>{<label>="<value>",...}
    // → return latest datapoint per series in the namespace.
    const selectorMatch = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?$/);
    if (selectorMatch) {
      const metricName = selectorMatch[1];
      const filters = parsePromLabelFilters(selectorMatch[2] || '');
      const series = await this.getRecentSeries(metricName, filters);
      return { status: 'success', data: { resultType: 'vector', result: series } };
    }

    throw new Error(
      `CloudWatchMetricsBackend: PromQL shape not supported yet: ${trimmed.slice(0, 200)}. ` +
        `Supported: \`count(metric)\`, bare metric selector \`metric{label=\"v\"}\`. ` +
        `CW Metric Math doesn't accept PromQL; extending this adapter means adding a new ` +
        `case in queryInstant for the specific shape.`
    );
  }

  async queryRange(
    promql: string,
    startSec: number,
    endSec: number,
    stepSec: number
  ): Promise<PrometheusResponse> {
    const trimmed = promql.trim();
    const selectorMatch = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?$/);
    if (!selectorMatch) {
      throw new Error(
        `CloudWatchMetricsBackend.queryRange: only bare selector supported; got: ${trimmed.slice(0, 200)}`
      );
    }
    const metricName = selectorMatch[1];
    const filters = parsePromLabelFilters(selectorMatch[2] || '');
    const matrix = await this.getSeriesRange(metricName, filters, startSec, endSec, stepSec);
    return { status: 'success', data: { resultType: 'matrix', result: matrix } };
  }

  private async countMetricSeries(metricName: string): Promise<number> {
    const { instance, ListMetricsCommand } = await this.client();
    let count = 0;
    let NextToken: string | undefined;
    do {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await (instance as { send: (c: unknown) => Promise<unknown> }).send(
        new ListMetricsCommand({
          Namespace: this.namespace,
          MetricName: metricName,
          NextToken,
        })
      );
      count += (resp.Metrics || []).length;
      NextToken = resp.NextToken;
    } while (NextToken);
    return count;
  }

  private async listMetricsMatching(
    metricName: string,
    filters: Record<string, string>
  ): Promise<Array<{ Name: string; Value: string }[]>> {
    const { instance, ListMetricsCommand } = await this.client();
    const matching: Array<{ Name: string; Value: string }[]> = [];
    let NextToken: string | undefined;
    do {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await (instance as { send: (c: unknown) => Promise<unknown> }).send(
        new ListMetricsCommand({
          Namespace: this.namespace,
          MetricName: metricName,
          NextToken,
        })
      );
      for (const m of resp.Metrics || []) {
        const dims = (m.Dimensions || []) as Array<{ Name: string; Value: string }>;
        const ok = Object.entries(filters).every(([k, v]) =>
          dims.some((d) => d.Name === k && d.Value === v)
        );
        if (ok) matching.push(dims);
      }
      NextToken = resp.NextToken;
    } while (NextToken);
    return matching;
  }

  private async getRecentSeries(
    metricName: string,
    filters: Record<string, string>
  ): Promise<Array<{ metric: Record<string, string>; value: [number, string] }>> {
    const seriesDims = await this.listMetricsMatching(metricName, filters);
    if (seriesDims.length === 0) return [];

    const { instance, GetMetricDataCommand } = await this.client();
    const now = Math.floor(Date.now() / 1000);
    const start = now - 600; // last 10 minutes
    // CW caps GetMetricData at 500 queries per call; chunk if needed.
    const out: Array<{ metric: Record<string, string>; value: [number, string] }> = [];
    for (let i = 0; i < seriesDims.length; i += 500) {
      const chunk = seriesDims.slice(i, i + 500);
      const queries = chunk.map((dims, idx) => ({
        Id: `q${idx}`,
        MetricStat: {
          Metric: {
            Namespace: this.namespace,
            MetricName: metricName,
            Dimensions: dims,
          },
          Period: 60,
          Stat: 'Sum',
        },
        ReturnData: true,
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await (instance as { send: (c: unknown) => Promise<unknown> }).send(
        new GetMetricDataCommand({
          StartTime: new Date(start * 1000),
          EndTime: new Date(now * 1000),
          MetricDataQueries: queries,
        })
      );
      for (let j = 0; j < (resp.MetricDataResults || []).length; j++) {
        const r = resp.MetricDataResults[j];
        const dims = chunk[j];
        const metric: Record<string, string> = { __name__: metricName };
        for (const d of dims) metric[d.Name] = d.Value;
        const lastVal = (r.Values || []).slice(-1)[0];
        const lastTs = (r.Timestamps || []).slice(-1)[0];
        if (lastVal !== undefined && lastTs) {
          out.push({
            metric,
            value: [Math.floor(new Date(lastTs).getTime() / 1000), String(lastVal)],
          });
        }
      }
    }
    return out;
  }

  private async getSeriesRange(
    metricName: string,
    filters: Record<string, string>,
    startSec: number,
    endSec: number,
    stepSec: number
  ): Promise<Array<{ metric: Record<string, string>; values: Array<[number, string]> }>> {
    const seriesDims = await this.listMetricsMatching(metricName, filters);
    if (seriesDims.length === 0) return [];
    const { instance, GetMetricDataCommand } = await this.client();
    const period = Math.max(60, Math.floor(stepSec));
    const out: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> = [];
    for (let i = 0; i < seriesDims.length; i += 500) {
      const chunk = seriesDims.slice(i, i + 500);
      const queries = chunk.map((dims, idx) => ({
        Id: `q${idx}`,
        MetricStat: {
          Metric: { Namespace: this.namespace, MetricName: metricName, Dimensions: dims },
          Period: period,
          Stat: 'Sum',
        },
        ReturnData: true,
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await (instance as { send: (c: unknown) => Promise<unknown> }).send(
        new GetMetricDataCommand({
          StartTime: new Date(startSec * 1000),
          EndTime: new Date(endSec * 1000),
          MetricDataQueries: queries,
        })
      );
      for (let j = 0; j < (resp.MetricDataResults || []).length; j++) {
        const r = resp.MetricDataResults[j];
        const dims = chunk[j];
        const metric: Record<string, string> = { __name__: metricName };
        for (const d of dims) metric[d.Name] = d.Value;
        const values: Array<[number, string]> = [];
        const ts = r.Timestamps || [];
        const vs = r.Values || [];
        for (let k = 0; k < ts.length; k++) {
          values.push([Math.floor(new Date(ts[k]).getTime() / 1000), String(vs[k])]);
        }
        out.push({ metric, values });
      }
    }
    return out;
  }
}

// ── Elasticsearch Metrics adapter ─────────────────────────────────────────

/**
 * Elasticsearch metrics backend. Reads documents written by the
 * Micrometer-ES registry to `micrometer-metrics-YYYY-MM` indices and
 * reshapes them into Prometheus envelopes.
 *
 * Document shape (from Micrometer-ES source):
 *   { "@timestamp": ISO8601, "name": <metric>, "type": "counter|gauge|...",
 *     <tag1>: <val1>, ..., "count"|"value"|"sum"|...: <number> }
 *
 * Like the CW adapter, this V1 implements a closed subset of PromQL —
 * `count(metric)` and bare selectors with `=` label filters. Unsupported
 * shapes throw rather than fabricate.
 */
class ElasticMetricsBackend implements MetricsBackend {
  readonly kind: MetricsBackendKind = 'elastic_metrics';
  readonly endpoint: string;
  private readonly url: string;
  private readonly index: string;
  private readonly authHeader: string | undefined;

  // Reserved field names in the Micrometer-ES doc shape — anything else
  // is treated as a tag (a Prom-style label).
  private static readonly RESERVED_FIELDS = new Set([
    '@timestamp',
    'name',
    'type',
    'count',
    'value',
    'sum',
    'mean',
    'max',
    'min',
    'activeTasks',
    'duration',
  ]);

  constructor(config: Extract<MetricsBackendConfig, { kind: 'elastic_metrics' }>) {
    this.url = config.url.replace(/\/+$/, '');
    this.index = config.index || 'micrometer-metrics-*';
    this.endpoint = `${this.url}/${this.index}`;
    if (config.apiKey) {
      this.authHeader = `ApiKey ${config.apiKey}`;
    } else if (config.user && config.password) {
      const b = Buffer.from(`${config.user}:${config.password}`).toString('base64');
      this.authHeader = `Basic ${b}`;
    } else {
      this.authHeader = undefined;
    }
  }

  private async esSearch(body: Record<string, unknown>): Promise<{
    hits: { total: { value: number }; hits: Array<{ _source: Record<string, unknown> }> };
    aggregations?: Record<string, unknown>;
  }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) headers.Authorization = this.authHeader;
    const res = await fetch(`${this.url}/${encodeURIComponent(this.index)}/_search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`elastic_metrics HTTP ${res.status} ${res.statusText}: ${errBody.slice(0, 400)}`);
    }
    return (await res.json()) as never;
  }

  async listLabels(): Promise<string[]> {
    // Sample N recent docs, gather all field names not in RESERVED_FIELDS.
    const r = await this.esSearch({
      size: 100,
      sort: [{ '@timestamp': 'desc' }],
      query: { match_all: {} },
    });
    const names = new Set<string>();
    for (const h of r.hits.hits) {
      for (const k of Object.keys(h._source)) {
        if (!ElasticMetricsBackend.RESERVED_FIELDS.has(k)) names.add(k);
      }
    }
    return Array.from(names);
  }

  async listLabelValues(label: string): Promise<string[]> {
    const r = await this.esSearch({
      size: 0,
      aggs: { uniq: { terms: { field: `${label}.keyword`, size: 1000 } } },
    });
    const buckets = (r.aggregations?.uniq as { buckets?: Array<{ key: string }> } | undefined)?.buckets || [];
    return buckets.map((b) => String(b.key));
  }

  async queryInstant(promql: string): Promise<PrometheusResponse> {
    const trimmed = promql.trim();

    // Shape 1: count(<metric>) — count of docs for that metric.
    const countMatch = trimmed.match(/^count\(([a-zA-Z_:][a-zA-Z0-9_:]*)\)$/);
    if (countMatch) {
      const metricName = countMatch[1];
      const r = await this.esSearch({
        size: 0,
        query: { term: { 'name.keyword': metricName } },
      });
      return {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: {}, value: [Math.floor(Date.now() / 1000), String(r.hits.total.value)] }],
        },
      };
    }

    // Shape 2: bare metric selector — return one Prom-shape entry per
    // distinct (tag combo) for that metric, with latest doc's count/value.
    const selectorMatch = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?$/);
    if (selectorMatch) {
      const metricName = selectorMatch[1];
      const filters = parsePromLabelFilters(selectorMatch[2] || '');
      const filterClauses: Array<Record<string, unknown>> = [
        { term: { 'name.keyword': metricName } },
      ];
      for (const [k, v] of Object.entries(filters)) {
        filterClauses.push({ term: { [`${k}.keyword`]: v } });
      }
      const r = await this.esSearch({
        size: 100,
        sort: [{ '@timestamp': 'desc' }],
        query: { bool: { must: filterClauses } },
      });
      // Group by distinct tag combos; keep the most-recent doc per combo.
      const seen = new Map<string, { metric: Record<string, string>; tsMs: number; value: number }>();
      for (const h of r.hits.hits) {
        const src = h._source as Record<string, unknown>;
        const metric: Record<string, string> = { __name__: metricName };
        for (const [k, v] of Object.entries(src)) {
          if (ElasticMetricsBackend.RESERVED_FIELDS.has(k)) continue;
          if (typeof v === 'string') metric[k] = v;
        }
        const tsMs = Date.parse(String(src['@timestamp']));
        // Prefer `count` (counter), then `value` (gauge).
        const numericVal = Number(src.count ?? src.value);
        if (!Number.isFinite(numericVal)) continue;
        const key = Object.entries(metric).sort().map(([k, v]) => `${k}=${v}`).join('\x00');
        const prev = seen.get(key);
        if (!prev || tsMs > prev.tsMs) {
          seen.set(key, { metric, tsMs, value: numericVal });
        }
      }
      return {
        status: 'success',
        data: {
          resultType: 'vector',
          result: Array.from(seen.values()).map((s) => ({
            metric: s.metric,
            value: [Math.floor(s.tsMs / 1000), String(s.value)] as [number, string],
          })),
        },
      };
    }

    throw new Error(
      `ElasticMetricsBackend: PromQL shape not supported yet: ${trimmed.slice(0, 200)}. ` +
        `Supported: \`count(metric)\`, bare metric selector \`metric{label=\"v\"}\`.`
    );
  }

  async queryRange(promql: string): Promise<PrometheusResponse> {
    throw new Error(
      `ElasticMetricsBackend.queryRange not yet implemented for: ${promql.slice(0, 200)}. ` +
        `V1 supports queryInstant for count() + bare selectors only.`
    );
  }
}

// ── OpenSearch Metrics adapter ────────────────────────────────────────────

/**
 * OpenSearch metrics backend. OS shares the `_search` + `_bulk` wire
 * protocol with Elasticsearch, so this is a thin subclass that reuses
 * the ES adapter logic verbatim. The separate `kind` gives users a
 * distinct label in config + logs (otherwise their "opensearch" cluster
 * would surface as "elastic" everywhere, which is confusing).
 */
class OpenSearchMetricsBackend extends ElasticMetricsBackend {
  override readonly kind: MetricsBackendKind = 'opensearch_metrics';

  constructor(config: Extract<MetricsBackendConfig, { kind: 'opensearch_metrics' }>) {
    super({
      kind: 'elastic_metrics',
      url: config.url,
      index: config.index,
      user: config.user,
      password: config.password,
      apiKey: config.apiKey,
    });
  }
}

/** Parse Prometheus label filter syntax like `{label="value",other="x"}` → record. */
function parsePromLabelFilters(filterStr: string): Record<string, string> {
  if (!filterStr) return {};
  const inner = filterStr.replace(/^\{|\}$/g, '');
  if (!inner.trim()) return {};
  const out: Record<string, string> = {};
  // Only handle `=` (exact) for now. `=~`, `!=`, `!~` are CW-incompatible
  // (no regex support on dimension values) and would need to throw.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*,?\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    out[m[1]] = m[2].replace(/\\"/g, '"');
  }
  return out;
}
