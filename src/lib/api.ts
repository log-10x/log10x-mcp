/**
 * Log10x API client.
 *
 * Handles authentication, Prometheus queries, user settings,
 * and AI analysis via the Log10x REST API.
 */

import type { EnvConfig } from './environments.js';

const DEFAULT_BASE = 'https://prometheus.log10x.com';
const DEFAULT_COST_PER_GB = 2.50;

function getBase(): string {
  return process.env.LOG10X_API_BASE || DEFAULT_BASE;
}

function authHeader(env: EnvConfig): string {
  return `${env.apiKey}/${env.envId}`;
}

/** Raw Prometheus instant query. Returns parsed JSON response. */
export async function queryInstant(env: EnvConfig, promql: string): Promise<PrometheusResponse> {
  const url = new URL('/api/v1/query', getBase());
  url.searchParams.set('query', promql);
  url.searchParams.set('stats', 'all');

  const res = await fetch(url.toString(), {
    headers: { 'X-10X-Auth': authHeader(env) },
  });

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

  const res = await fetch(url.toString(), {
    headers: { 'X-10X-Auth': authHeader(env) },
  });

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

  const res = await fetch(url.toString(), {
    headers: { 'X-10X-Auth': authHeader(env) },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AI query HTTP ${res.status}: ${body}`);
  }

  const data = await res.json() as { status: string; data?: { ai?: string } };
  return data.data?.ai || '';
}

/**
 * Fetches the user's analyzer cost ($/GB) from the Log10x REST API.
 * Stored in Auth0 user_metadata.analyzer_cost, returned by GET /api/v1/user.
 * Falls back to DEFAULT_COST_PER_GB on failure.
 */
export async function fetchAnalyzerCost(env: EnvConfig): Promise<number> {
  try {
    const url = new URL('/api/v1/user', getBase());
    const res = await fetch(url.toString(), {
      headers: { 'X-10X-Auth': authHeader(env) },
    });

    if (!res.ok) return DEFAULT_COST_PER_GB;

    const data = await res.json() as { user?: { metadata?: { analyzer_cost?: number | string } } };
    const raw = data.user?.metadata?.analyzer_cost;

    if (raw === undefined || raw === null) return DEFAULT_COST_PER_GB;

    const cost = typeof raw === 'number' ? raw : parseFloat(raw);
    return cost > 0 ? cost : DEFAULT_COST_PER_GB;
  } catch {
    return DEFAULT_COST_PER_GB;
  }
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
