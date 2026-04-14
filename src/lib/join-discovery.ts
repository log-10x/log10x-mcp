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
import { fetchLabelValues } from './api.js';
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

  // Enumerate Log10x-side label values.
  const log10xValues = new Map<string, Set<string>>();
  for (const label of LOG10X_JOIN_CANDIDATES) {
    try {
      const values = await fetchLabelValues(env, label);
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

  const customerValues = new Map<string, Set<string>>();
  for (const label of customerCandidateLabels) {
    try {
      const values = await backend.listLabelValues(label);
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
