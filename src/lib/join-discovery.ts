/**
 * Join-discovery for the cross-pillar bridge.
 *
 * Finds the best structural join label between the Log10x metric universe
 * (fetched via the existing prometheus gateway `fetchLabelValues`) and
 * the customer metric backend (fetched via `CustomerMetricsBackend.listLabelValues`)
 * using Jaccard similarity on label value sets.
 *
 * The join key is a pair `(log10x_side_label, customer_side_label)` whose
 * values overlap highly enough to be considered the same physical or
 * logical dimension across both backends. The default minimum_jaccard
 * floor is 0.7; pairs below the floor are not returned as the primary
 * join, though runner-ups above 0.5 are surfaced for agent awareness.
 *
 * The join discovery result is cached per-session keyed by
 * `(environment, customer_backend_endpoint)` so `correlate_cross_pillar`
 * can auto-run it once and never re-probe during the same MCP process
 * lifetime.
 */

import type { EnvConfig } from './environments.js';
import { fetchLabelValues, fetchActiveLabelValues } from './api.js';
import type { CustomerMetricsBackend } from './customer-metrics.js';

/**
 * Log10x-side labels that are candidates for a structural join as of v1.4.
 * Deliberately excludes k8s_node (not populated by the current k8s
 * enrichment module) and high-cardinality identity labels like
 * `message_pattern`, `tenx_parent_uuid`, `tenx_pipeline_uuid`, etc.
 */
export const LOG10X_JOIN_CANDIDATES = [
  'tenx_user_service',
  'k8s_pod',
  'k8s_namespace',
  'k8s_container',
  'http_code',
  'severity_level',
] as const;

export type Log10xJoinCandidate = (typeof LOG10X_JOIN_CANDIDATES)[number];

/**
 * Common customer-side label names worth probing first. The discovery
 * pass probes ALL labels from the backend, but preferring these up front
 * keeps the common case fast.
 */
export const PREFERRED_CUSTOMER_LABELS = [
  'service',
  'service_name',
  'service.name',
  'dd.service',
  'kube_service',
  'app',
  'pod',
  'kube_pod',
  'kubernetes_pod_name',
  'namespace',
  'kube_namespace',
  'container',
  'kube_container',
] as const;

export interface JoinPair {
  log10xSide: string;
  customerSide: string;
  jaccard: number;
  sharedValues: number;
  log10xOnlyValues: number;
  customerOnlyValues: number;
}

export interface JoinDiscoveryResult {
  status: 'joined' | 'no_join_available';
  /** Best pair above the minimum_jaccard floor. Undefined when status = no_join_available. */
  joinKey?: JoinPair;
  /** Other pairs above 0.5 but below the primary pair. */
  runnerUps: JoinPair[];
  /** Every pair probed, including sub-floor ones. Used for refusal diagnostics. */
  probed: JoinPair[];
  /** Labels we considered on each side. */
  probedLabelsLog10x: string[];
  probedLabelsCustomer: string[];
  /** Whether this result came from the session cache. */
  cachedForSession: boolean;
}

export interface DiscoverJoinOptions {
  minimumJaccard?: number;
  /** Maximum label values to fetch per side per label. High-cardinality labels skipped. */
  maxValuesPerLabel?: number;
  /** Restrict to a specific subset of customer-side labels. */
  candidateLabels?: string[];
  /**
   * Window (seconds) for label value enumeration. When set, both the Log10x
   * and customer backends are queried with `start = now - windowSeconds` and
   * `end = now`, filtering out stale label values from series that stopped
   * emitting samples. Critical for environments where historical replay data
   * or decommissioned services leave orphan label values in the metric store
   * — those drag Jaccard down and cause false `no_join_available` refusals.
   *
   * Recommended default: 600 seconds (10 minutes). Longer windows pick up
   * bursty services; shorter windows tighten the current state.
   */
  windowSeconds?: number;
}

/**
 * Run join discovery against the customer backend.
 *
 * Does NOT consult the session cache — callers who want cached behavior
 * should use `getOrDiscoverJoin()` below.
 */
export async function discoverJoin(
  env: EnvConfig,
  backend: CustomerMetricsBackend,
  options: DiscoverJoinOptions = {}
): Promise<JoinDiscoveryResult> {
  const minimumJaccard = options.minimumJaccard ?? 0.7;
  const maxValuesPerLabel = options.maxValuesPerLabel ?? 1000;
  const windowSeconds = options.windowSeconds;

  // Enumerate Log10x-side label values.
  // When windowSeconds is set, use the PromQL `group by` over `increase()`
  // approach — that returns ONLY label values with samples in the window,
  // filtering out stale replay data / decommissioned services. The
  // `/label/values?start=&end=` endpoint is NOT sufficient (it filters by
  // block intersection, not active sample presence).
  const log10xValues = new Map<string, Set<string>>();
  for (const label of LOG10X_JOIN_CANDIDATES) {
    try {
      const values = windowSeconds
        ? await fetchActiveLabelValues(env, label, windowSeconds)
        : await fetchLabelValues(env, label);
      if (values.length > 0 && values.length <= maxValuesPerLabel) {
        log10xValues.set(label, new Set(values));
      }
    } catch {
      // Skip labels that fail to enumerate; absent labels are not
      // errors, they're just not join candidates in this environment.
    }
  }

  // Enumerate customer-side candidate labels.
  const customerCandidateLabels = options.candidateLabels
    ? options.candidateLabels
    : await pickCustomerCandidateLabels(backend);

  // Auto-scope: if log10x knows about specific namespaces, constrain the
  // customer-side probe to only those namespaces. Without this, customer
  // metrics include every container/service across the entire cluster —
  // monitoring, kube-system, control plane — which drags Jaccard down
  // with values log10x structurally can't have. This mirrors the real
  // correlation use case: you only cross-pillar compare data the log10x
  // pipeline actually ingests.
  const log10xNamespaces = log10xValues.get('k8s_namespace');
  const namespaceScope = windowSeconds && log10xNamespaces && log10xNamespaces.size > 0
    ? Array.from(log10xNamespaces)
    : undefined;

  const customerValues = new Map<string, Set<string>>();
  for (const label of customerCandidateLabels) {
    try {
      // Same rationale as above: windowed path uses PromQL instead of
      // /label/values so it returns only actively-sampled values.
      const values = windowSeconds
        ? await fetchActiveCustomerLabelValues(backend, label, windowSeconds, namespaceScope)
        : await backend.listLabelValues(label);
      if (values.length > 0 && values.length <= maxValuesPerLabel) {
        customerValues.set(label, new Set(values));
      }
    } catch {
      // Skip; some backends return 404 for unknown labels, that's fine.
    }
  }

  // Compute pairwise Jaccard.
  const probed: JoinPair[] = [];
  for (const [l10xLabel, l10xSet] of log10xValues) {
    for (const [custLabel, custSet] of customerValues) {
      const pair = computeJaccard(l10xLabel, l10xSet, custLabel, custSet);
      probed.push(pair);
    }
  }

  probed.sort((a, b) => b.jaccard - a.jaccard);

  const best = probed[0];
  if (!best || best.jaccard < minimumJaccard) {
    return {
      status: 'no_join_available',
      runnerUps: probed.filter((p) => p.jaccard >= 0.5).slice(0, 5),
      probed,
      probedLabelsLog10x: Array.from(log10xValues.keys()),
      probedLabelsCustomer: Array.from(customerValues.keys()),
      cachedForSession: false,
    };
  }

  const runnerUps = probed
    .slice(1)
    .filter((p) => p.jaccard >= 0.5)
    .slice(0, 5);

  return {
    status: 'joined',
    joinKey: best,
    runnerUps,
    probed,
    probedLabelsLog10x: Array.from(log10xValues.keys()),
    probedLabelsCustomer: Array.from(customerValues.keys()),
    cachedForSession: false,
  };
}

function computeJaccard(
  l10xLabel: string,
  l10xSet: Set<string>,
  custLabel: string,
  custSet: Set<string>
): JoinPair {
  let intersection = 0;
  for (const v of l10xSet) {
    if (custSet.has(v)) intersection += 1;
  }
  const union = l10xSet.size + custSet.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  return {
    log10xSide: l10xLabel,
    customerSide: custLabel,
    jaccard,
    sharedValues: intersection,
    log10xOnlyValues: l10xSet.size - intersection,
    customerOnlyValues: custSet.size - intersection,
  };
}

/**
 * Returns the customer-side label values currently active per Prometheus's
 * built-in staleness handling. Implementation strategy (in order):
 *
 * 1. `group by (<label>) ({<label>!="",__name__=~".+"})` — instant vector
 *    query that returns any series with a non-empty `<label>` label. This
 *    uses Prometheus's default 5-minute staleness marker, so series that
 *    stopped emitting samples naturally disappear from the result without
 *    an explicit window parameter. **Broadest and most accurate** for
 *    "currently alive label values", though some Prometheus deployments
 *    reject over-broad `{...=~".+"}` selectors via cardinality limits.
 *
 * 2. Fallback: `group by (<label>) (up{<label>!=""})` — narrower, uses
 *    only the `up` metric (per-scrape-target). Works when the label is
 *    present on scrape targets (e.g., `job`, `instance`), but returns
 *    empty for container/pod labels which aren't on `up`.
 *
 * 3. Last resort: unwindowed `listLabelValues()`. Better to over-return
 *    than miss the join key entirely.
 *
 * `windowSeconds` is accepted for API consistency but Prometheus's
 * staleness handling already provides a ~5-minute active filter at the
 * instant-vector level. Callers with very bursty metrics (longer than
 * the 5min staleness marker) should pre-materialize a `count_over_time`
 * probe upstream.
 */
async function fetchActiveCustomerLabelValues(
  backend: CustomerMetricsBackend,
  label: string,
  windowSeconds: number,
  namespaceScope?: string[]
): Promise<string[]> {
  void windowSeconds; // reserved for future use; see docstring
  // Build a namespace selector clause when provided. This scopes the
  // customer-side probe to the same namespaces the log10x pipeline is
  // ingesting from, which is the only apples-to-apples comparison for
  // Jaccard computation. Without this, customer-side returns every
  // container/service in the cluster (monitoring, kube-system, control
  // plane), dragging Jaccard down with values log10x structurally can't
  // observe.
  const nsClause = namespaceScope && namespaceScope.length > 0
    ? `,namespace=~"${namespaceScope.map(s => s.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&')).join('|')}"`
    : '';
  const collect = (res: {
    data?: { result?: Array<{ metric: Record<string, string> }> };
  }): string[] => {
    const vals = new Set<string>();
    for (const r of res?.data?.result || []) {
      const v = r.metric?.[label];
      if (v) vals.add(v);
    }
    return Array.from(vals);
  };

  // Attempt 1: broad instant selector, optionally namespace-scoped.
  try {
    const promql = `group by (${label}) ({${label}!=""${nsClause},__name__=~".+"})`;
    const res = await backend.queryInstant(promql);
    const vals = collect(res);
    if (vals.length > 0) return vals;
  } catch {
    // Some Prom deployments refuse this pattern; fall through.
  }
  // Attempt 2: `up`-based (works only for target-level labels).
  try {
    const promql = `group by (${label}) (up{${label}!=""${nsClause}})`;
    const res = await backend.queryInstant(promql);
    const vals = collect(res);
    if (vals.length > 0) return vals;
  } catch {
    // Fall through.
  }
  // Attempt 3: unwindowed list endpoint — no namespace filter available here,
  // since the /label/values endpoint doesn't support label selectors.
  return backend.listLabelValues(label);
}

/**
 * Pick the customer-side labels to probe. Starts with the preferred list,
 * then adds everything else from `listLabels()` that isn't in the preferred
 * list. The preferred list is just an ordering optimization — the full
 * label universe is probed regardless.
 */
async function pickCustomerCandidateLabels(backend: CustomerMetricsBackend): Promise<string[]> {
  let allLabels: string[] = [];
  try {
    allLabels = await backend.listLabels();
  } catch {
    allLabels = [];
  }
  // Filter out internal Prometheus labels that are never useful for joining.
  const INTERNAL = new Set(['__name__', '__address__', '__scheme__', '__metrics_path__']);
  const filtered = allLabels.filter((l) => !INTERNAL.has(l));

  // Move preferred labels to the front for ordering.
  const preferred = PREFERRED_CUSTOMER_LABELS.filter((l) => filtered.includes(l));
  const rest = filtered.filter((l) => !(PREFERRED_CUSTOMER_LABELS as readonly string[]).includes(l));
  return [...preferred, ...rest];
}

// ── Session cache ──

interface CacheEntry {
  key: string;
  result: JoinDiscoveryResult;
  storedAt: number;
}

const MAX_CACHE_ENTRIES = 16;
const sessionCache = new Map<string, CacheEntry>();

function cacheKey(env: EnvConfig, backend: CustomerMetricsBackend): string {
  return `${env.nickname}::${backend.backendType}::${backend.endpoint}`;
}

/**
 * Get a cached join discovery result, or run discoverJoin and cache it.
 * This is the function the higher-level tools should call by default.
 */
export async function getOrDiscoverJoin(
  env: EnvConfig,
  backend: CustomerMetricsBackend,
  options: DiscoverJoinOptions = {}
): Promise<JoinDiscoveryResult> {
  const key = cacheKey(env, backend);
  const cached = sessionCache.get(key);
  if (cached) {
    // Move to end so the LRU eviction front stays at the least-recently-used entry.
    sessionCache.delete(key);
    sessionCache.set(key, cached);
    return { ...cached.result, cachedForSession: true };
  }

  const result = await discoverJoin(env, backend, options);
  sessionCache.set(key, { key, result, storedAt: Date.now() });

  // Bound the cache (LRU: delete+re-insert to move to end, evict front
  // when size exceeds).
  while (sessionCache.size > MAX_CACHE_ENTRIES) {
    const firstKey = sessionCache.keys().next().value;
    if (firstKey) sessionCache.delete(firstKey);
  }

  return result;
}

/** Clear the session cache. Exposed for tests. */
export function clearJoinCacheForTest(): void {
  sessionCache.clear();
}
