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
  | { kind: 'prometheus'; url: string; auth: PromAuth }
  | { kind: 'mimir'; url: string; auth: PromAuth; orgId?: string }
  | { kind: 'cortex'; url: string; auth: PromAuth; orgId: string }
  | { kind: 'amp'; url: string; region: string }
  | { kind: 'datadog'; site: string; apiKey: string; appKey: string }
  | { kind: 'grafana_cloud_prom'; url: string; user: string; apiKey: string }
  | { kind: 'gcp_managed_prom'; url: string; projectId: string };

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
        url: resolveVarReference(c.url),
        projectId: resolveVarReference(c.projectId),
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
  }
}

// ── Adapter classes ───────────────────────────────────────────────────────

/**
 * Shared helper for the prom-compatible adapters. Builds auth headers
 * from a `PromAuth` value and runs a JSON fetch with consistent error
 * formatting.
 *
 * Wraps the fetch in retry-on-transient: 5xx or 429 → exponential
 * backoff with jitter, up to RETRY_ATTEMPTS. 4xx (other than 429) is
 * surfaced immediately because retrying won't help (auth, bad query).
 * Mirrors the retry semantics api.ts has always used for
 * prometheus.log10x.com.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = parseInt(process.env.LOG10X_RETRY_BASE_MS || '250', 10) || 250;

async function promJsonFetch<T>(
  kindLabel: string,
  url: URL,
  extraHeaders: Record<string, string>,
  authHeaders: Record<string, string>
): Promise<T> {
  const headers = { ...extraHeaders, ...authHeaders };
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url.toString(), { headers });
    } catch (e) {
      lastErr = e as Error;
      if (attempt < RETRY_ATTEMPTS - 1) {
        const backoff = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    const body = await res.text().catch(() => '');
    // 4xx (other than 429) is a caller error — auth, bad query. Don't retry.
    if (res.status < 500 && res.status !== 429) {
      throw new Error(`${kindLabel} HTTP ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
    }
    // 5xx and 429 are retryable.
    lastErr = new Error(`${kindLabel} HTTP ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
    if (attempt < RETRY_ATTEMPTS - 1) {
      const backoff = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw lastErr || new Error(`${kindLabel}: fetch failed after ${RETRY_ATTEMPTS} attempts`);
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
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`amp HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * Datadog Prometheus-compatible read API. Endpoint is constructed from
 * the `site` field (e.g., `us5` → `https://api.us5.datadoghq.com`).
 * Auth is `DD-API-KEY` + `DD-APPLICATION-KEY` headers.
 *
 * Datadog's Prom-compat endpoint supports a SUBSET of PromQL. Common
 * queries (topk, sum by, increase, rate, label filters) work; some
 * edge cases (specific functions, complex subqueries) may not. Phase
 * 4 testing validates every MCP tool's queries against a live Datadog
 * account.
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
    const url = new URL('/api/v1/query', this.endpoint);
    url.searchParams.set('query', promql);
    return promJsonFetch('datadog', url, this.headers, {});
  }

  async queryRange(promql: string, startSec: number, endSec: number, stepSec: number): Promise<PrometheusResponse> {
    const url = new URL('/api/v1/query_range', this.endpoint);
    url.searchParams.set('query', promql);
    url.searchParams.set('start', String(startSec));
    url.searchParams.set('end', String(endSec));
    url.searchParams.set('step', String(stepSec));
    return promJsonFetch('datadog', url, this.headers, {});
  }

  async listLabels(): Promise<string[]> {
    const url = new URL('/api/v1/labels', this.endpoint);
    const res = await promJsonFetch<{ status: string; data: string[] }>('datadog', url, this.headers, {});
    return res.data || [];
  }

  async listLabelValues(label: string, opts?: { windowSeconds?: number }): Promise<string[]> {
    const url = new URL(`/api/v1/label/${encodeURIComponent(label)}/values`, this.endpoint);
    if (opts?.windowSeconds) {
      const nowS = Math.floor(Date.now() / 1000);
      url.searchParams.set('start', String(nowS - opts.windowSeconds));
      url.searchParams.set('end', String(nowS));
    }
    const res = await promJsonFetch<{ status: string; data: string[] }>('datadog', url, this.headers, {});
    return res.data || [];
  }
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
 * GCP Managed Prometheus. Authenticated via Google OAuth2 access
 * tokens — credentials come from the ambient Google SDK chain
 * (GOOGLE_APPLICATION_CREDENTIALS service-account JSON or
 * `gcloud auth application-default login`).
 *
 * Phase 1 stub — full impl arrives in a subsequent commit. Throws on
 * any call until then.
 */
class GcpManagedPromBackend implements MetricsBackend {
  readonly kind = 'gcp_managed_prom' as const;
  readonly endpoint: string;
  private readonly projectId: string;

  constructor(config: Extract<MetricsBackendConfig, { kind: 'gcp_managed_prom' }>) {
    this.endpoint = config.url.replace(/\/+$/, '');
    this.projectId = config.projectId;
  }

  async queryInstant(): Promise<PrometheusResponse> {
    throw new Error('GcpManagedPromBackend not yet implemented in phase 1 — see customer-metrics.ts:GcpManagedPrometheusBackend for the OAuth2 pattern.');
  }
  async queryRange(): Promise<PrometheusResponse> {
    throw new Error('GcpManagedPromBackend not yet implemented in phase 1.');
  }
  async listLabels(): Promise<string[]> {
    throw new Error('GcpManagedPromBackend not yet implemented in phase 1.');
  }
  async listLabelValues(): Promise<string[]> {
    throw new Error('GcpManagedPromBackend not yet implemented in phase 1.');
  }
}
