/**
 * Prometheus oracle — direct PromQL queries against the demo env's
 * gateway, used for ground-truth cross-validation of MCP outputs.
 *
 * The point: MCP tools READ Prometheus, render answers, and emit
 * NEXT_ACTIONS. Without an independent oracle, "tool returned the right
 * pattern" is just "tool returned a pattern that matches a regex". The
 * oracle answers the same question via raw PromQL and asserts that the
 * MCP's answer agrees.
 *
 * Auth pattern matches build/lib/api.ts: header `X-10X-Auth: <key>/<env>`,
 * gateway is process.env.LOG10X_API_BASE (defaults to prometheus.log10x.com).
 *
 * Important note on the demo env: it replays the OTel sample at 1000 eps
 * continuously, so cost_drivers-style growth math always returns
 * "no movement". The oracle should validate against TOP_PATTERNS-style
 * absolute-rank queries, not week-over-week deltas.
 */
import type { EvalEnv } from './env.js';

const DEFAULT_BASE = 'https://prometheus.log10x.com';

export interface PromValue {
  metric: Record<string, string>;
  value?: [number, string];
}

export interface PromResponse {
  status: 'success' | 'error';
  data: { resultType: string; result: PromValue[] };
  error?: string;
}

function authHeader(env: EvalEnv): string {
  return `${env.apiKey}/${env.envId}`;
}

function gatewayBase(env: EvalEnv): string {
  return env.apiBase || process.env.LOG10X_API_BASE || DEFAULT_BASE;
}

export async function promQuery(env: EvalEnv, promql: string): Promise<PromResponse> {
  const url = new URL('/api/v1/query', gatewayBase(env));
  url.searchParams.set('query', promql);
  const res = await fetch(url.toString(), {
    headers: { 'X-10X-Auth': authHeader(env) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Prometheus HTTP ${res.status} on query "${promql.slice(0, 80)}...": ${body.slice(0, 300)}`);
  }
  return (await res.json()) as PromResponse;
}

export async function promLabelValues(env: EvalEnv, label: string): Promise<string[]> {
  const url = new URL(`/api/v1/label/${encodeURIComponent(label)}/values`, gatewayBase(env));
  const res = await fetch(url.toString(), {
    headers: { 'X-10X-Auth': authHeader(env) },
  });
  if (!res.ok) throw new Error(`labelValues(${label}) HTTP ${res.status}`);
  const json = (await res.json()) as { data: string[] };
  return json.data ?? [];
}

// ─── High-level oracle queries ──────────────────────────────────────────

/**
 * Get the top-N patterns by current 24h cost. The MCP env labels are
 * `tenx_env` (edge / cloud / streamer); the demo env uses both edge and
 * cloud reporters writing to the same tenant. We aggregate across env
 * to match what `log10x_top_patterns` does internally.
 *
 * Returns null pattern hashes filtered out so callers don't have to.
 */
export async function topPatterns(
  env: EvalEnv,
  range: string = '24h',
  limit: number = 10
): Promise<Array<{ hash: string; service: string; severity: string; bytes: number }>> {
  // Aggregate across edge + cloud — both tiers write to the same
  // tenant on the demo. The MCP normally resolves a single tier via
  // `resolveMetricsEnv`; the oracle deliberately pulls both because
  // ground truth should not depend on which tier the MCP picked.
  const promql =
    `topk(${limit}, sum by (message_pattern, tenx_user_service, severity_level) ` +
    `(increase(all_events_summaryBytes_total{tenx_env=~"edge|cloud"}[${range}])))`;
  const r = await promQuery(env, promql);
  if (r.status !== 'success') return [];
  return r.data.result
    .map((row) => ({
      hash: row.metric.message_pattern || '',
      service: row.metric.tenx_user_service || '',
      severity: row.metric.severity_level || '',
      bytes: row.value ? parseFloat(row.value[1]) : 0,
    }))
    .filter((r) => r.hash);
}

/**
 * Verify a pattern hash exists in Prometheus metrics (i.e., the MCP
 * isn't fabricating a pattern name). Returns the bytes count or 0 if
 * not found.
 *
 * Falls back to a regex anchor match if the exact lookup fails — the
 * production engine normalizes punctuation differently from the local
 * tenx CLI in some edge cases (e.g. consecutive underscore collapse,
 * placeholder `$` handling), and a regex round-trip is sufficient
 * proof that the pattern made it into the metric universe.
 */
export async function patternExists(env: EvalEnv, hash: string, range: string = '24h'): Promise<number> {
  const safe = hash.replace(/"/g, '\\"').replace(/\\/g, '\\\\');
  const exact = `sum(increase(all_events_summaryBytes_total{message_pattern="${safe}"}[${range}]))`;
  const exactRes = await promQuery(env, exact);
  if (exactRes.status === 'success' && exactRes.data.result.length > 0) {
    const v = parseFloat(exactRes.data.result[0].value?.[1] ?? '0');
    if (v > 0) return v;
  }
  // Fallback: regex on the snake_case skeleton. We use the longest
  // alphanumeric tokens as anchors — the engine's normalization
  // sometimes inserts/collapses underscores around placeholders.
  const tokens = hash.split(/[^A-Za-z0-9]+/).filter((t) => t.length >= 4);
  if (tokens.length === 0) return 0;
  const skeleton = tokens.join('.*');
  const regex = `sum(increase(all_events_summaryBytes_total{message_pattern=~"${skeleton}"}[${range}]))`;
  const regexRes = await promQuery(env, regex);
  if (regexRes.status !== 'success' || regexRes.data.result.length === 0) return 0;
  return parseFloat(regexRes.data.result[0].value?.[1] ?? '0');
}

/**
 * Distinct services with at least one pattern emitting in the window.
 */
export async function services(env: EvalEnv, range: string = '24h'): Promise<string[]> {
  const promql =
    `count by (tenx_user_service) ` +
    `(sum by (tenx_user_service, message_pattern) (increase(all_events_summaryBytes_total[${range}])) > 0)`;
  const r = await promQuery(env, promql);
  if (r.status !== 'success') return [];
  return r.data.result.map((row) => row.metric.tenx_user_service).filter(Boolean);
}

/**
 * Total volume in the window across the env (bytes).
 */
export async function totalVolume(env: EvalEnv, range: string = '24h'): Promise<number> {
  const promql = `sum(increase(all_events_summaryBytes_total{tenx_env=~"edge|cloud"}[${range}]))`;
  const r = await promQuery(env, promql);
  if (r.status !== 'success' || r.data.result.length === 0) return 0;
  return parseFloat(r.data.result[0].value?.[1] ?? '0');
}

/**
 * Pattern count (cardinality) — how many distinct patterns have fired
 * in the window.
 */
export async function patternCardinality(env: EvalEnv, range: string = '24h'): Promise<number> {
  const promql =
    `count(count by (message_pattern) (increase(all_events_summaryBytes_total{tenx_env=~"edge|cloud"}[${range}]) > 0))`;
  const r = await promQuery(env, promql);
  if (r.status !== 'success' || r.data.result.length === 0) return 0;
  return parseFloat(r.data.result[0].value?.[1] ?? '0');
}

/**
 * Top-N label values by volume — the oracle equivalent of
 * `log10x_list_by_label`.
 */
export async function topByLabel(
  env: EvalEnv,
  label: string,
  range: string = '24h',
  limit: number = 5
): Promise<Array<{ value: string; bytes: number }>> {
  const promql =
    `topk(${limit}, sum by (${label}) ` +
    `(increase(all_events_summaryBytes_total{tenx_env=~"edge|cloud"}[${range}])))`;
  const r = await promQuery(env, promql);
  if (r.status !== 'success') return [];
  return r.data.result.map((row) => ({
    value: row.metric[label] || '(empty)',
    bytes: row.value ? parseFloat(row.value[1]) : 0,
  }));
}

/**
 * Grab a few real templateHash values that are currently active. Used
 * by the cross-validation harness to feed real Prometheus identifiers
 * to MCP tools and see if they round-trip correctly.
 */
export async function activeTemplateHashes(env: EvalEnv, limit: number = 3): Promise<string[]> {
  const top = await topPatterns(env, '1h', limit);
  return top.map((p) => p.hash);
}
