/**
 * Log10x API client.
 *
 * Handles authentication, Prometheus queries, user settings,
 * and AI analysis via the Log10x REST API.
 *
 * All HTTP reads route through `fetchWithRetry` — 3 attempts with
 * exponential backoff + jitter. Retries fire on network errors and
 * 5xx / 429 responses; 4xx errors are surfaced immediately because they
 * indicate misconfiguration rather than transient failure.
 */

import type { EnvConfig } from './environments.js';
import { log } from './log.js';

const DEFAULT_BASE = 'https://prometheus.log10x.com';
const DEFAULT_COST_PER_GB = 2.50;
const RETRY_ATTEMPTS = 3;
/** Base backoff in ms. Override via LOG10X_RETRY_BASE_MS (tests set to 1). */
const RETRY_BASE_MS = parseInt(process.env.LOG10X_RETRY_BASE_MS || '250', 10) || 250;

function getBase(): string {
  return process.env.LOG10X_API_BASE || DEFAULT_BASE;
}

function authHeader(env: EnvConfig): string {
  return `${env.apiKey}/${env.envId}`;
}

/**
 * User-scoped auth header: just the API key, no envId.
 *
 * The backend authorizer (backend/lambdas/user-service-go/cmd/authorizer)
 * accepts `X-10X-Auth: <apiKey>` with no `/<envId>` suffix when routing
 * to user-scoped endpoints like GET /api/v1/user. The resolved user's
 * default env is used if downstream handlers need one.
 */
function userAuthHeader(apiKey: string): string {
  return apiKey;
}

/**
 * Wrap fetch with retry-on-transient-failure.
 *
 * Retries when:
 *   - the underlying fetch throws (network reset, DNS, connection refused)
 *   - the response is 5xx
 *   - the response is 429 (rate limited)
 *
 * Surfaces immediately on 4xx (other than 429) — these are caller errors
 * (auth, malformed query) and retrying won't help.
 */
export async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      // Retry on 5xx and 429; surface other 4xx immediately.
      if (res.status >= 500 || res.status === 429) {
        const body = await res.text().catch(() => '');
        lastErr = new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        log.warn(`api.${label}.retry`, { attempt, status: res.status });
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e as Error;
      log.warn(`api.${label}.retry`, { attempt, msg: lastErr.message });
    }
    if (attempt < RETRY_ATTEMPTS - 1) {
      const backoff = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
      await sleep(backoff);
    }
  }
  throw lastErr || new Error(`fetch failed after ${RETRY_ATTEMPTS} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raw Prometheus instant query. Returns parsed JSON response. */
export async function queryInstant(env: EnvConfig, promql: string): Promise<PrometheusResponse> {
  const url = new URL('/api/v1/query', getBase());
  url.searchParams.set('query', promql);
  url.searchParams.set('stats', 'all');

  const res = await fetchWithRetry(
    url.toString(),
    { headers: { 'X-10X-Auth': authHeader(env) } },
    'queryInstant'
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Prometheus HTTP ${res.status}: ${body}`);
  }

  return res.json() as Promise<PrometheusResponse>;
}

/** Prometheus range query. Returns parsed JSON response. */
export async function queryRange(
  env: EnvConfig,
  promql: string,
  start: number,
  end: number,
  step: number
): Promise<PrometheusResponse> {
  const url = new URL('/api/v1/query_range', getBase());
  url.searchParams.set('query', promql);
  url.searchParams.set('start', start.toString());
  url.searchParams.set('end', end.toString());
  url.searchParams.set('step', step.toString());

  const res = await fetchWithRetry(
    url.toString(),
    { headers: { 'X-10X-Auth': authHeader(env) } },
    'queryRange'
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Prometheus HTTP ${res.status}: ${body}`);
  }

  return res.json() as Promise<PrometheusResponse>;
}

/** AI analysis query. Returns the AI text response. */
export async function queryAi(
  env: EnvConfig,
  queryResult: string,
  prompt: string,
  ingestionCost: number
): Promise<string> {
  const url = new URL('/api/v1/query_ai', getBase());
  url.searchParams.set('query', 'vector(0)');
  url.searchParams.set('query_result', queryResult);
  url.searchParams.set('prompt', prompt);
  url.searchParams.set('ingestion_cost', ingestionCost.toString());
  url.searchParams.set('total_volume', '0');
  url.searchParams.set('output_table', 'false');
  url.searchParams.set('prompt_timeout', '15000');

  const res = await fetchWithRetry(
    url.toString(),
    { headers: { 'X-10X-Auth': authHeader(env) } },
    'queryAi'
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AI query HTTP ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { status: string; data?: { ai?: string } };
  return data.data?.ai || '';
}

/** Prometheus /api/v1/labels — list all label names in the workspace. */
export async function fetchLabels(env: EnvConfig): Promise<string[]> {
  const url = new URL('/api/v1/labels', getBase());
  const res = await fetchWithRetry(
    url.toString(),
    { headers: { 'X-10X-Auth': authHeader(env) } },
    'fetchLabels'
  );
  if (!res.ok) throw new Error(`Prometheus /labels HTTP ${res.status}`);
  const data = (await res.json()) as { status: string; data: string[] };
  return data.data || [];
}

/**
 * Prometheus /api/v1/label/{name}/values — list distinct values for a label.
 *
 * Without `opts.windowSeconds`, returns all values ever seen (bounded by
 * Prometheus retention). That means stale series whose last sample was
 * minutes-to-hours ago still contribute values.
 *
 * **Important**: Prometheus's `start`/`end` params on this endpoint filter
 * by BLOCK intersection, not by active sample presence. The current 2h
 * block still contains old label values from services that stopped
 * emitting, so `windowSeconds` here does NOT produce a truly-live set.
 *
 * For a truly-live set (label values with samples in the last N seconds),
 * use `fetchActiveLabelValues()` below — it runs a PromQL `group by` over
 * an `increase()` window, which is the correct "currently active"
 * semantic.
 */
export async function fetchLabelValues(
  env: EnvConfig,
  labelName: string,
  opts?: { windowSeconds?: number }
): Promise<string[]> {
  const url = new URL(`/api/v1/label/${encodeURIComponent(labelName)}/values`, getBase());
  if (opts?.windowSeconds) {
    const nowS = Math.floor(Date.now() / 1000);
    url.searchParams.set('start', String(nowS - opts.windowSeconds));
    url.searchParams.set('end', String(nowS));
  }
  const res = await fetchWithRetry(
    url.toString(),
    { headers: { 'X-10X-Auth': authHeader(env) } },
    'fetchLabelValues'
  );
  if (!res.ok) throw new Error(`Prometheus /label/${labelName}/values HTTP ${res.status}`);
  const data = (await res.json()) as { status: string; data: string[] };
  return data.data || [];
}

/**
 * Returns the distinct label values that have had at least one sample in
 * the last `windowSeconds` seconds — i.e., currently active, not stale.
 *
 * Implementation: `group by (<label>) (increase(all_events_summaryBytes_total[<window>]) > 0)`.
 * This is the correct semantic for "what labels are alive right now",
 * because it requires at least one non-zero sample in the window — which
 * is exactly the staleness filter `/label/values?start=&end=` fails to
 * provide (see fetchLabelValues docstring).
 *
 * Used by join-discovery to compute Jaccard over only active label values,
 * so stale replay data / decommissioned pods don't drag the similarity
 * score down and cause false `no_join_available` refusals.
 */
export async function fetchActiveLabelValues(
  env: EnvConfig,
  labelName: string,
  windowSeconds: number
): Promise<string[]> {
  const range = `${windowSeconds}s`;
  // Note: requires Log10x pattern metric. If not present (e.g., no Reporter),
  // this returns empty, which causes join-discovery to fall back naturally.
  const promql = `group by (${labelName}) (increase(all_events_summaryBytes_total{tenx_env=~"edge|cloud"}[${range}]) > 0)`;
  const url = new URL('/api/v1/query', getBase());
  url.searchParams.set('query', promql);
  const res = await fetchWithRetry(
    url.toString(),
    { headers: { 'X-10X-Auth': authHeader(env) } },
    'fetchActiveLabelValues'
  );
  if (!res.ok) return [];
  const data = (await res.json()) as {
    status: string;
    data: { resultType: string; result: Array<{ metric: Record<string, string> }> };
  };
  const out = new Set<string>();
  for (const r of data.data?.result || []) {
    const v = r.metric?.[labelName];
    if (v) out.add(v);
  }
  return Array.from(out);
}

/**
 * Fetches the user's analyzer cost ($/GB) from the Log10x REST API.
 * Stored in Auth0 user_metadata.analyzer_cost, returned by GET /api/v1/user.
 * Falls back to DEFAULT_COST_PER_GB on failure.
 */
export async function fetchAnalyzerCost(env: EnvConfig): Promise<number> {
  try {
    const url = new URL('/api/v1/user', getBase());
    const res = await fetchWithRetry(
      url.toString(),
      { headers: { 'X-10X-Auth': authHeader(env) } },
      'fetchAnalyzerCost'
    );

    if (!res.ok) return DEFAULT_COST_PER_GB;

    const data = (await res.json()) as { user?: { metadata?: { analyzer_cost?: number | string } } };
    const raw = data.user?.metadata?.analyzer_cost;

    if (raw === undefined || raw === null) return DEFAULT_COST_PER_GB;

    const cost = typeof raw === 'number' ? raw : parseFloat(raw);
    return cost > 0 ? cost : DEFAULT_COST_PER_GB;
  } catch {
    return DEFAULT_COST_PER_GB;
  }
}

// ── User profile / env autodiscovery ──

/**
 * Permission level assigned to a user for a given environment.
 * Mirrors backend/lambdas/user-service-go/internal/models/environment.go.
 *   - OWNER: full rights
 *   - WRITE: can query + write
 *   - READ : can query but not modify (e.g. shared demo env)
 */
export type Permission = 'OWNER' | 'WRITE' | 'READ';

export interface RemoteTenXEnv {
  envId: string;
  name: string;
  owner: string;
  isDefault: boolean;
  permissions: Permission;
}

export interface RemoteUserProfile {
  userId: string;
  username: string;
  tier?: string;
  userType?: string;
  environments: RemoteTenXEnv[];
  metadata: Record<string, unknown>;
}

/**
 * Fetch the user profile — identity, tier, and the full list of
 * environments the API key grants access to — via GET /api/v1/user.
 *
 * This is a USER-scoped call (authed with apiKey only, no envId). The
 * authorizer at backend/lambdas/user-service-go/cmd/authorizer/main.go
 * accepts `X-10X-Auth: <apiKey>` when envId is omitted and resolves
 * the user by apiKey alone.
 *
 * Throws on network or non-2xx failures. Callers that want fallback
 * behavior should catch and decide.
 */
export async function fetchUserProfile(apiKey: string): Promise<RemoteUserProfile> {
  const url = new URL('/api/v1/user', getBase());
  const res = await fetchWithRetry(
    url.toString(),
    { headers: { 'X-10X-Auth': userAuthHeader(apiKey) } },
    'fetchUserProfile'
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GET /api/v1/user returned HTTP ${res.status}: ${body.slice(0, 300)}`
    );
  }

  const data = (await res.json()) as {
    user?: {
      user_id?: string;
      username?: string;
      tier?: string;
      user_type?: string;
      environments?: Array<{
        env_id: string;
        name: string;
        owner: string;
        is_default: boolean;
        permissions: Permission;
      }>;
      metadata?: Record<string, unknown>;
    };
  };

  const u = data.user;
  if (!u || !Array.isArray(u.environments)) {
    throw new Error(
      `GET /api/v1/user returned an unexpected shape: missing user.environments.`
    );
  }

  return {
    userId: u.user_id ?? '',
    username: u.username ?? '',
    tier: u.tier,
    userType: u.user_type,
    environments: u.environments.map((e) => ({
      envId: e.env_id,
      name: e.name,
      owner: e.owner,
      isDefault: e.is_default,
      permissions: e.permissions,
    })),
    metadata: u.metadata ?? {},
  };
}

// ── Account / env mutations ──
//
// These all use user-scoped auth (apiKey only — the lambda authorizer
// resolves the user from the key alone, no envId required even for env
// CRUD because the env is identified by `env_id` in the request body).

/**
 * Update user metadata. Wraps `POST /api/v1/user`. Idempotent — repeated
 * calls with the same payload converge to the same state. The response
 * contains the full updated user profile.
 *
 * Use cases include analyzer-cost ($/GB) update, AI provider settings
 * (`ai_provider`, `ai_api_key`, etc.), display-name / company changes.
 * The set of accepted metadata keys is governed by the backend; the MCP
 * passes through whatever the caller supplies.
 */
export async function updateUserMetadata(
  apiKey: string,
  metadata: Record<string, unknown>
): Promise<RemoteUserProfile> {
  const url = new URL('/api/v1/user', getBase());
  const res = await fetchWithRetry(
    url.toString(),
    {
      method: 'POST',
      headers: {
        'X-10X-Auth': userAuthHeader(apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ metadata }),
    },
    'updateUserMetadata'
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST /api/v1/user returned HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { user?: unknown };
  return parseRemoteUserProfile(data);
}

/**
 * Create a new environment. Wraps `POST /api/v1/user/env`. NOT
 * idempotent — calling twice with the same name returns 409 Conflict
 * from the backend. Returns the full updated user profile so the
 * caller can see the new env in the list.
 */
export async function createEnvironment(
  apiKey: string,
  name: string,
  isDefault?: boolean
): Promise<RemoteUserProfile> {
  const url = new URL('/api/v1/user/env', getBase());
  const body: Record<string, unknown> = { name };
  if (isDefault !== undefined) body.is_default = isDefault;
  const res = await fetchWithRetry(
    url.toString(),
    {
      method: 'POST',
      headers: {
        'X-10X-Auth': userAuthHeader(apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    'createEnvironment'
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`POST /api/v1/user/env returned HTTP ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = (await res.json()) as { user?: unknown };
  return parseRemoteUserProfile(data);
}

/**
 * Update an existing environment. Wraps `PUT /api/v1/user/env`.
 * Idempotent. Caller passes `env_id` (from `/api/v1/user`) and the
 * fields to change (name, is_default).
 *
 * NOTE: requires the backend gateway to have the PUT route configured.
 * Without it the call fails at the API Gateway layer with a 4xx before
 * reaching the lambda — see the `fix(gateway)` PR on the backend repo.
 */
export async function updateEnvironment(
  apiKey: string,
  envId: string,
  changes: { name?: string; is_default?: boolean }
): Promise<RemoteUserProfile> {
  const url = new URL('/api/v1/user/env', getBase());
  const body = { env_id: envId, ...changes };
  const res = await fetchWithRetry(
    url.toString(),
    {
      method: 'PUT',
      headers: {
        'X-10X-Auth': userAuthHeader(apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    'updateEnvironment'
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`PUT /api/v1/user/env returned HTTP ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = (await res.json()) as { user?: unknown };
  return parseRemoteUserProfile(data);
}

/**
 * Delete an environment. Wraps `DELETE /api/v1/user/env`. Irreversible.
 * The backend rejects the call with 401 if the caller is not the env
 * owner (`existing.Owner != user.Username()` check in the lambda).
 */
export async function deleteEnvironment(
  apiKey: string,
  envId: string
): Promise<RemoteUserProfile> {
  const url = new URL('/api/v1/user/env', getBase());
  const res = await fetchWithRetry(
    url.toString(),
    {
      method: 'DELETE',
      headers: {
        'X-10X-Auth': userAuthHeader(apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ env_id: envId }),
    },
    'deleteEnvironment'
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`DELETE /api/v1/user/env returned HTTP ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = (await res.json()) as { user?: unknown };
  return parseRemoteUserProfile(data);
}

/**
 * Rotate the API key. Wraps `POST /api/v1/user/rotate-key`. Returns
 * BOTH the new api_key (returned only here, never via subsequent
 * `/api/v1/user` reads) and the user profile.
 *
 * The previous key is invalidated immediately on success; clients
 * holding the old key — including this MCP server itself if it doesn't
 * pivot to the new one — will start receiving 401 on the next request.
 *
 * Demo accounts get 403 Forbidden.
 */
export async function rotateApiKey(
  apiKey: string
): Promise<{ apiKey: string; profile: RemoteUserProfile }> {
  const url = new URL('/api/v1/user/rotate-key', getBase());
  const res = await fetchWithRetry(
    url.toString(),
    {
      method: 'POST',
      headers: { 'X-10X-Auth': userAuthHeader(apiKey) },
    },
    'rotateApiKey'
  );
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(
      `POST /api/v1/user/rotate-key returned HTTP ${res.status}: ${errBody.slice(0, 300)}`
    );
  }
  const data = (await res.json()) as { user?: unknown; api_key?: string };
  if (typeof data.api_key !== 'string' || !data.api_key) {
    throw new Error('rotate-key response missing `api_key` field');
  }
  return { apiKey: data.api_key, profile: parseRemoteUserProfile(data) };
}

/**
 * Internal helper: parse the `user` field of an account-mutating API
 * response into a `RemoteUserProfile`. Mirrors the parsing in
 * `fetchUserProfile`. The backend returns the same `{ user: {...} }`
 * envelope from POST /user, all /user/env verbs, and /user/rotate-key.
 */
function parseRemoteUserProfile(data: { user?: unknown }): RemoteUserProfile {
  const u = data.user as
    | {
        user_id?: string;
        username?: string;
        tier?: string;
        user_type?: string;
        environments?: Array<{
          env_id: string;
          name: string;
          owner: string;
          is_default: boolean;
          permissions: Permission;
        }>;
        metadata?: Record<string, unknown>;
      }
    | undefined;
  if (!u || !Array.isArray(u.environments)) {
    throw new Error('Response missing user.environments');
  }
  return {
    userId: u.user_id ?? '',
    username: u.username ?? '',
    tier: u.tier,
    userType: u.user_type,
    environments: u.environments.map((e) => ({
      envId: e.env_id,
      name: e.name,
      owner: e.owner,
      isDefault: e.is_default,
      permissions: e.permissions,
    })),
    metadata: u.metadata ?? {},
  };
}

// ── Types ──

export interface PrometheusResult {
  metric: Record<string, string>;
  value?: [number, string];
  values?: [number, string][];
}

export interface PrometheusResponse {
  status: string;
  data: {
    resultType: string;
    result: PrometheusResult[];
  };
}
