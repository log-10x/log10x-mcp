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
  // Retry on 5xx (gateway 500 / 502 / 503 / 504 are transient on the
  // demo env's prometheus). 2 retries with brief backoff keeps the
  // oracle resilient without masking real bugs.
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url.toString(), { headers: { 'X-10X-Auth': authHeader(env) } });
    if (res.ok) return (await res.json()) as PromResponse;
    const body = await res.text();
    lastErr = `HTTP ${res.status}: ${body.slice(0, 300)}`;
    if (res.status < 500) break; // not transient — fail immediately
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`Prometheus query "${promql.slice(0, 80)}..." failed after retries: ${lastErr}`);
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
export async function patternExists(
  env: EvalEnv,
  hash: string,
  range: string = '24h',
  labelFilters?: Record<string, string>
): Promise<number> {
  const safe = hash.replace(/"/g, '\\"').replace(/\\/g, '\\\\');
  const extraFilter = labelFilters
    ? Object.entries(labelFilters)
        .map(([k, v]) => `,${k}="${v.replace(/"/g, '\\"')}"`)
        .join('')
    : '';
  const exact = `sum(increase(all_events_summaryBytes_total{message_pattern="${safe}"${extraFilter}}[${range}]))`;
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
  const regex = `sum(increase(all_events_summaryBytes_total{message_pattern=~"${skeleton}"${extraFilter}}[${range}]))`;
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

// ── Campaign oracle snapshot ────────────────────────────────────────────

/**
 * Severity-distribution snapshot — bytes per `severity_level` label
 * value over the window. Used by error-levels questions to verify the
 * agent reports the correct distribution.
 */
export async function severitySplit(
  env: EvalEnv,
  range: string = '24h'
): Promise<Array<{ severity: string; bytes: number }>> {
  const promql = `sum by (severity_level) (increase(all_events_summaryBytes_total[${range}]))`;
  const r = await promQuery(env, promql);
  if (r.status !== 'success') return [];
  return r.data.result.map((row) => ({
    severity: row.metric.severity_level || '(untagged)',
    bytes: row.value ? parseFloat(row.value[1]) : 0,
  }));
}

/**
 * Reporter freshness — seconds since the last metric write per tier.
 * Returns Infinity when a tier has never written.
 */
export async function freshness(
  env: EvalEnv
): Promise<{ edge: number; cloud: number }> {
  const out = { edge: Infinity, cloud: Infinity };
  for (const tier of ['edge', 'cloud'] as const) {
    const promql = `time() - max(timestamp(all_events_summaryBytes_total{tenx_env="${tier}"}))`;
    try {
      const r = await promQuery(env, promql);
      if (r.status === 'success' && r.data.result.length > 0) {
        out[tier] = parseFloat(r.data.result[0].value?.[1] ?? 'Infinity');
      }
    } catch {
      // leave as Infinity
    }
  }
  return out;
}

/**
 * Top growth deltas — patterns whose `range`-window volume grew the
 * most vs the prior same-length window. Subtraction is server-side.
 *
 * Agents pick different baseline windows depending on framing
 * (cost_drivers default = 7d, ad-hoc = 30d, sub-day = 1d). The
 * `growthDeltasMultiWindow` helper computes the union across
 * windows so the campaign matcher accepts any legit window choice.
 */
export async function growthDeltas(
  env: EvalEnv,
  range: string = '24h',
  limit: number = 5
): Promise<Array<{ hash: string; delta_bytes: number }>> {
  const promql =
    `topk(${limit}, ` +
    `sum by (message_pattern)(increase(all_events_summaryBytes_total[${range}])) ` +
    `- sum by (message_pattern)(increase(all_events_summaryBytes_total[${range}] offset ${range})))`;
  const r = await promQuery(env, promql);
  if (r.status !== 'success') return [];
  return r.data.result
    .map((row) => ({
      hash: row.metric.message_pattern || '',
      delta_bytes: row.value ? parseFloat(row.value[1]) : 0,
    }))
    .filter((r) => r.hash && r.delta_bytes > 0);
}

/**
 * Multi-window growth — union of growthDeltas across windows. Used
 * by the campaign for "what's growing?" questions where the agent
 * may legitimately pick any window. De-duped by pattern; keep the
 * window/delta with the largest absolute growth.
 */
export async function growthDeltasMultiWindow(
  env: EvalEnv,
  ranges: string[] = ['1d', '7d'],
  limitPerWindow: number = 8
): Promise<Array<{ hash: string; delta_bytes: number; window: string }>> {
  // Per-window catch — Prometheus aggregation queries on long windows
  // (30d-vs-30d subtractions across 400+ patterns) sometimes 5xx. We
  // accept the union of whichever windows succeeded; the campaign
  // scorer reads whatever rows we return. 30d is intentionally
  // off-by-default for the same reason — too expensive on demo.
  const sets = await Promise.all(
    ranges.map(async (r) => {
      try {
        const rows = await growthDeltas(env, r, limitPerWindow);
        return rows.map((row) => ({ ...row, window: r }));
      } catch {
        return [];
      }
    })
  );
  const byHash = new Map<string, { hash: string; delta_bytes: number; window: string }>();
  for (const set of sets) {
    for (const row of set) {
      const cur = byHash.get(row.hash);
      if (!cur || row.delta_bytes > cur.delta_bytes) byHash.set(row.hash, row);
    }
  }
  return [...byHash.values()].sort((a, b) => b.delta_bytes - a.delta_bytes);
}

/**
 * Newly emerged patterns — active in last 5m, silent in the 1h-offset
 * 5m window. Catches "what just started happening?" questions.
 */
export async function newlyEmerged(
  env: EvalEnv,
  limit: number = 5
): Promise<Array<{ hash: string; rate_5m: number }>> {
  const promql =
    `topk(${limit}, sum by (message_pattern)(rate(all_events_summaryVolume_total[5m])) ` +
    `unless on (message_pattern)(rate(all_events_summaryVolume_total[5m] offset 1h) > 0))`;
  const r = await promQuery(env, promql);
  if (r.status !== 'success') return [];
  return r.data.result
    .map((row) => ({
      hash: row.metric.message_pattern || '',
      rate_5m: row.value ? parseFloat(row.value[1]) : 0,
    }))
    .filter((r) => r.hash);
}

/**
 * Comprehensive snapshot of the env — captures everything the campaign
 * oracle needs to compute expected answers for hero questions.
 * Pickled into eval/oracle/expected/<ts>.json by `bin/oracle-probe.mjs`.
 */
export interface OracleSnapshot {
  taken_at: string;
  env_mode: string;
  total_volume_24h_bytes: number;
  pattern_cardinality: number;
  top_patterns_24h: Array<{ hash: string; service: string; severity: string; bytes: number }>;
  severity_split: Array<{ severity: string; bytes: number }>;
  service_split: Array<{ value: string; bytes: number }>;
  namespace_split: Array<{ value: string; bytes: number }>;
  freshness_seconds: { edge: number; cloud: number };
  growth_deltas_24h: Array<{ hash: string; delta_bytes: number }>;
  /**
   * Union of growth across {1d, 7d, 30d} windows. Used by the campaign
   * matcher for "what's growing" questions so the agent's window
   * choice doesn't mark the answer wrong when both are valid.
   */
  growth_deltas_multi_window: Array<{ hash: string; delta_bytes: number; window: string }>;
  newly_emerged_5m_vs_1h: Array<{ hash: string; rate_5m: number }>;
}

export async function fullSnapshot(env: EvalEnv): Promise<OracleSnapshot> {
  const [tot, card, top, sev, svc, ns, fresh, growth, multiGrowth, emerged] = await Promise.all([
    totalVolume(env, '24h'),
    patternCardinality(env, '24h'),
    topPatterns(env, '24h', 10),
    severitySplit(env, '24h'),
    topByLabel(env, 'tenx_user_service', '24h', 10),
    topByLabel(env, 'k8s_namespace', '24h', 10),
    freshness(env),
    growthDeltas(env, '24h', 5),
    growthDeltasMultiWindow(env, ['1d', '7d'], 8),
    newlyEmerged(env, 5),
  ]);
  return {
    taken_at: new Date().toISOString(),
    env_mode: env.mode,
    total_volume_24h_bytes: tot,
    pattern_cardinality: card,
    top_patterns_24h: top,
    severity_split: sev,
    service_split: svc,
    namespace_split: ns,
    freshness_seconds: fresh,
    growth_deltas_24h: growth,
    growth_deltas_multi_window: multiGrowth,
    newly_emerged_5m_vs_1h: emerged,
  };
}
