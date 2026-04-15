/**
 * Cross-pillar correlation engine for the v1.4 bridge.
 *
 * This module owns the Phase 3-5 logic from the v1.1 spec:
 *
 *   Phase 3 — candidate generation (enumerate candidates from the
 *             opposite pillar scoped by the join key)
 *   Phase 4 — temporal correlation (Pearson on rate curves with lag
 *             offsets)
 *   Phase 5 — structural validation (check metadata overlap between
 *             candidate and anchor; tier output into joined /
 *             structurally_validated / temporal_coincidence /
 *             validation_unavailable)
 *
 * The tiered output is the differentiating property vs every other
 * agent observability tool: a candidate returned in the
 * `temporal_coincidence` tier is explicitly labeled as coincidence, not
 * quietly ranked alongside structurally-grounded candidates. This is
 * what prevents the hallucination failure mode the spec identifies.
 *
 * Node-level correlation is out of scope for v1.4 — the k8s enrichment
 * module doesn't populate k8s_node, so the structural-label alias map
 * below deliberately omits `node ↔ k8s_node`. v1.4.1 will add it once
 * the Reporter-side extraction ships.
 */

import type { EnvConfig } from './environments.js';
import type { CustomerMetricsBackend } from './customer-metrics.js';
import type { PrometheusResponse, PrometheusResult } from './api.js';
import { queryRange, queryInstant } from './api.js';
import type { JoinPair } from './join-discovery.js';

export type AnchorPillar = 'log10x_pattern' | 'customer_metric';

export interface AnchorSpec {
  type: AnchorPillar;
  /** Pattern identity for log10x_pattern; PromQL expression for customer_metric. */
  value: string;
}

/**
 * Confidence tiers for cross-pillar candidates. Ordered by decreasing
 * trustworthiness. A caller that wants to auto-drill should only drill
 * into `joined` or `structurally_validated` tiers; `validation_unavailable`
 * and `temporal_coincidence` should be surfaced to the user without
 * autonomous action.
 */
export type ConfidenceTier =
  | 'joined'
  | 'structurally_validated'
  | 'validation_unavailable'
  | 'temporal_coincidence';

export interface CandidateSubScores {
  /** Pearson r on the rate curves. */
  temporal: number;
  /** Lag tightness 0-1 (how concentrated the peak is around one offset). */
  lag: number;
  /** Structural overlap: 1.0 full, 0.5 partial, 0.0 none, null unknown. */
  structural: number | null;
  /** Volume significance 0-1 (placeholder for now, always 1 unless the caller sets it). */
  volume: number;
}

export interface CrossPillarCandidate {
  /** Opposite-pillar identifier. For log10x candidates: pattern name. For customer candidates: metric expression. */
  name: string;
  /** Labels on the candidate side. */
  labels: Record<string, string>;
  subScores: CandidateSubScores;
  /** Combined confidence. `null` when structural = null (validation_unavailable tier). */
  combinedConfidence: number | null;
  tier: ConfidenceTier;
  /** Lag offset in seconds: negative = candidate leads anchor. */
  lagSeconds: number;
}

export interface CrossPillarResult {
  anchor: AnchorSpec;
  window: { from: number; to: number; step: number };
  joinKey: JoinPair;
  candidates: CrossPillarCandidate[];
  /** Buckets by tier for rendering. Candidates appear in both `candidates` and the corresponding tier array. */
  byTier: Record<ConfidenceTier, CrossPillarCandidate[]>;
  metadata: {
    patternsAnalyzed: number;
    log10xQueries: number;
    customerQueries: number;
    wallTimeMs: number;
  };
}

/**
 * Structural-label alias map for v1.4. Each entry is a pair
 * `[customerSideLabel, log10xSideLabel]` that represents the same
 * physical/logical dimension across the two backends.
 *
 * Node-level aliases (`node ↔ k8s_node`, `instance ↔ k8s_node`) are
 * deliberately absent — k8s_node is not populated by the current k8s
 * enrichment module. See the v1.1 spec's "Enrichment labels" section.
 */
export const STRUCTURAL_ALIASES: Array<[string[], string[]]> = [
  [['service', 'service_name', 'service.name', 'dd.service', 'app', 'kube_service'], ['tenx_user_service']],
  [['namespace', 'kube_namespace', 'k8s_namespace'], ['k8s_namespace']],
  [['pod', 'kube_pod', 'kubernetes_pod_name', 'k8s_pod', 'pod_name'], ['k8s_pod']],
  [['container', 'kube_container', 'container_name', 'k8s_container'], ['k8s_container']],
];

export interface CorrelateOptions {
  env: EnvConfig;
  backend: CustomerMetricsBackend;
  anchor: AnchorSpec;
  joinKey: JoinPair;
  window: { from: number; to: number; step: number };
  /** Max candidates to return across all tiers. Default 8. */
  maxCandidates?: number;
  /** Minimum |r| for a candidate to be considered at all. Default 0.3. */
  minimumConfidence?: number;
  /** Log10x-side metric name; defaults to the event count metric. */
  log10xMetric?: string;
}

const DEFAULT_LOG10X_METRIC = 'all_events_summaryVolume_total';
const LAG_OFFSETS_SECONDS = [-300, -120, -60, -30, 0, 30, 60, 120, 300];

/**
 * Run the full correlation pipeline.
 *
 * Flow:
 *   1. Fetch anchor range series (from Log10x or customer backend depending on anchor.type)
 *   2. Generate candidates from the OTHER pillar, scoped by the join key value
 *   3. For each candidate, fetch its range series and compute temporal correlation + lag
 *   4. For each candidate above the temporal floor, run structural validation
 *   5. Tier candidates and compute combined confidence
 */
export async function runCrossPillarCorrelation(
  opts: CorrelateOptions
): Promise<CrossPillarResult> {
  const started = Date.now();
  const metric = opts.log10xMetric || DEFAULT_LOG10X_METRIC;
  const maxCandidates = opts.maxCandidates ?? 8;
  const minimumConfidence = opts.minimumConfidence ?? 0.3;

  let log10xQueries = 0;
  let customerQueries = 0;

  // ── Phase 1 — Anchor fetch ──
  const anchorSeries = await fetchAnchorSeries(opts, metric);
  if (opts.anchor.type === 'log10x_pattern') log10xQueries += 1;
  else customerQueries += 1;

  // For log10x_pattern anchors, probe the pattern's metadata labels once
  // so candidate generation can extract the join key value and structural
  // validation can score against real anchor label values.
  let resolvedLog10xAnchorLabels: Record<string, string> | undefined;
  if (opts.anchor.type === 'log10x_pattern') {
    resolvedLog10xAnchorLabels = await probeLog10xPatternLabels(opts, metric);
    log10xQueries += 1;
  }

  // For customer_metric anchors, parse the label matchers directly from
  // the anchor's PromQL expression so the candidate generator can apply
  // pod/service/container filters in addition to the join key.
  const parsedCustomerAnchorLabels =
    opts.anchor.type === 'customer_metric' ? parseAnchorLabels(opts.anchor) : undefined;

  // ── Phase 3 — Candidate generation ──
  const anchorLabelsForCandidateGen =
    opts.anchor.type === 'log10x_pattern' ? resolvedLog10xAnchorLabels : parsedCustomerAnchorLabels;
  const candidateNames = await generateCandidateNames(opts, metric, anchorLabelsForCandidateGen);

  // ── Phase 4 — Temporal correlation per candidate ──
  const candidates: CrossPillarCandidate[] = [];
  for (const candidate of candidateNames.slice(0, maxCandidates * 3)) {
    let candidateSeries: number[];
    try {
      candidateSeries = await fetchCandidateSeries(opts, candidate.name, metric);
      if (opts.anchor.type === 'log10x_pattern') customerQueries += 1;
      else log10xQueries += 1;
    } catch {
      continue;
    }

    const { r, lagSeconds, lagTightness } = computeTemporalCorrelation(
      anchorSeries,
      candidateSeries,
      opts.window.step
    );

    // ── Phase 5 — Structural validation ──
    const structural = computeStructuralScore(opts.anchor, candidate.labels, resolvedLog10xAnchorLabels);

    // Gate: a candidate is kept if EITHER (a) temporal correlation crosses
    // the minimum_confidence floor OR (b) structural validation confirms a
    // strong label overlap (join-key-only >= 0.5). Previous behavior was a
    // HARD temporal gate that dropped the candidate before structural ran —
    // which meant any anchor backed by a cumulative counter (e.g.
    // `kube_pod_container_status_restarts_total`) over a short window would
    // have near-zero variance, near-zero Pearson r, and everything would be
    // dropped. Caught by sub-agent S8 (cross-pillar wedge test): accounting
    // pod restart counter vs Kerberos log pattern returned 0 candidates in
    // EVERY tier because the temporal gate killed them before structural
    // could fire. The wedge claim ("structural validation rescues the
    // correlation when temporal is noisy") has to actually rescue.
    //
    // The temporal score still flows into `combinedConfidence`, so a
    // structurally-strong but temporally-flat pair surfaces with a small
    // headline confidence and the decomposition (temporal:0.00 structural:1.00)
    // tells the reader honestly that this is structure-only.
    const structuralAllowsPassthrough = structural.score !== null && structural.score >= 0.5;
    if (Math.abs(r) < minimumConfidence && !structuralAllowsPassthrough) continue;

    const subScores: CandidateSubScores = {
      temporal: Math.abs(r),
      lag: lagTightness,
      structural: structural.score,
      volume: 1.0,
    };

    // If temporal correlation is below the minimum but structural passes,
    // use a structural-only combinedConfidence (temporal = 0 zeroes everything
    // else, which hides the real signal).
    const combinedConfidence =
      structural.score === null
        ? null
        : subScores.temporal >= minimumConfidence
          ? subScores.temporal * Math.max(0.2, subScores.lag) * structural.score * subScores.volume
          : structural.score * 0.5; // structure-only: halve to indicate weaker than full overlap

    const tier = pickTier(structural.score, structural.reason);

    candidates.push({
      name: candidate.name,
      labels: candidate.labels,
      subScores,
      combinedConfidence,
      tier,
      lagSeconds,
    });
  }

  // Sort: joined first, then structurally_validated, then validation_unavailable, then temporal_coincidence.
  // Within each tier, sort by combinedConfidence descending (null treated as 0).
  const tierOrder: Record<ConfidenceTier, number> = {
    joined: 0,
    structurally_validated: 1,
    validation_unavailable: 2,
    temporal_coincidence: 3,
  };
  candidates.sort((a, b) => {
    const tierDelta = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDelta !== 0) return tierDelta;
    const ac = a.combinedConfidence ?? 0;
    const bc = b.combinedConfidence ?? 0;
    return bc - ac;
  });

  const trimmed = candidates.slice(0, maxCandidates);

  const byTier: Record<ConfidenceTier, CrossPillarCandidate[]> = {
    joined: [],
    structurally_validated: [],
    validation_unavailable: [],
    temporal_coincidence: [],
  };
  for (const c of trimmed) byTier[c.tier].push(c);

  return {
    anchor: opts.anchor,
    window: opts.window,
    joinKey: opts.joinKey,
    candidates: trimmed,
    byTier,
    metadata: {
      patternsAnalyzed: candidateNames.length,
      log10xQueries,
      customerQueries,
      wallTimeMs: Date.now() - started,
    },
  };
}

// ── Fetch helpers ──

async function fetchAnchorSeries(opts: CorrelateOptions, metric: string): Promise<number[]> {
  if (opts.anchor.type === 'customer_metric') {
    const res = await opts.backend.queryRange(
      opts.anchor.value,
      opts.window.from,
      opts.window.to,
      opts.window.step
    );
    return extractValuesFromRange(res);
  }

  // Log10x pattern anchor.
  const promql = `sum(rate(${metric}{message_pattern="${escape(opts.anchor.value)}"}[${durationLabel(opts.window.step)}]))`;
  const res = await queryRange(opts.env, promql, opts.window.from, opts.window.to, opts.window.step);
  return extractValuesFromRange(res);
}

async function fetchCandidateSeries(
  opts: CorrelateOptions,
  name: string,
  metric: string
): Promise<number[]> {
  if (opts.anchor.type === 'customer_metric') {
    // Candidate is a log10x pattern.
    const promql = `sum(rate(${metric}{message_pattern="${escape(name)}"}[${durationLabel(opts.window.step)}]))`;
    const res = await queryRange(opts.env, promql, opts.window.from, opts.window.to, opts.window.step);
    return extractValuesFromRange(res);
  }

  // Candidate is a customer metric expression.
  const res = await opts.backend.queryRange(
    name,
    opts.window.from,
    opts.window.to,
    opts.window.step
  );
  return extractValuesFromRange(res);
}

function extractValuesFromRange(res: PrometheusResponse): number[] {
  if (res.status !== 'success' || !res.data.result[0]?.values) return [];
  return res.data.result[0].values.map(([, v]) => parseFloat(v) || 0);
}

// ── Candidate generation ──

interface CandidateNameAndLabels {
  name: string;
  labels: Record<string, string>;
}

async function generateCandidateNames(
  opts: CorrelateOptions,
  metric: string,
  resolvedAnchorLabels?: Record<string, string>
): Promise<CandidateNameAndLabels[]> {
  let joinValue: string | undefined;
  if (opts.anchor.type === 'log10x_pattern') {
    // Join value comes from the probed metadata labels.
    joinValue = resolvedAnchorLabels?.[opts.joinKey.log10xSide];
  } else {
    joinValue = extractCustomerMetricLabelValue(opts.anchor, opts.joinKey);
  }
  if (!joinValue) return [];

  if (opts.anchor.type === 'customer_metric') {
    // Candidates are Log10x patterns scoped by the join key AND by any
    // additional structural label the anchor provides. Previously this
    // scoped ONLY by the join key (typically namespace), then used
    // `topk(20, rate)` to narrow — which meant crashlooping services with
    // backoff-limited rate (like `accounting` at $0.01/day because the pod
    // spends most of its time in CrashLoopBackOff) got excluded entirely
    // from the candidate universe. The Kerberos log pattern would never
    // surface no matter the structural score.
    //
    // Fix: extract pod/service/container filters from the anchor's parsed
    // labels and add them as extra PromQL selectors. That way
    // `kube_pod_container_status_restarts_total{pod=~"accounting.*"}` hunts
    // only among log10x patterns with `k8s_pod=~"accounting.*"`, regardless
    // of rate.
    const scopeLabel = opts.joinKey.log10xSide;
    const extraSelectors: string[] = [];
    if (resolvedAnchorLabels) {
      // Map customer-side label names to log10x-side names via the alias
      // table used for structural validation.
      const aliasMap: Array<[string[], string[]]> = STRUCTURAL_ALIASES;
      for (const [custAliases, l10xAliases] of aliasMap) {
        const anchorValue =
          pickFirst(resolvedAnchorLabels, custAliases) ||
          pickFirst(resolvedAnchorLabels, l10xAliases);
        if (!anchorValue) continue;
        if (anchorValue.length < 3) continue;
        // Pick the preferred log10x-side label name.
        const l10xLabel = l10xAliases[0];
        if (!l10xLabel) continue;
        // Skip if this is the join key itself (already in the base selector).
        if (l10xLabel === scopeLabel) continue;
        extraSelectors.push(`${l10xLabel}=~"${escape(anchorValue)}.*"`);
      }
    }
    const allSelectors = [`${scopeLabel}="${escape(joinValue)}"`, ...extraSelectors];
    const promql = `topk(20, sum by (message_pattern, k8s_pod, k8s_namespace, k8s_container, tenx_user_service) (rate(${metric}{${allSelectors.join(',')}}[5m])))`;
    try {
      let res = await queryInstant(opts.env, promql);
      // If the scoped query returns nothing (e.g., the pod filter was too
      // strict or the service has zero rate in the last 5m), retry without
      // the extra selectors so we at least return the namespace-scoped
      // candidates. The structural scorer will still prefer label matches.
      if (res.status !== 'success' || res.data.result.length === 0) {
        const fallbackPromql = `topk(20, sum by (message_pattern, k8s_pod, k8s_namespace, k8s_container, tenx_user_service) (rate(${metric}{${scopeLabel}="${escape(joinValue)}"}[5m])))`;
        res = await queryInstant(opts.env, fallbackPromql);
        if (res.status !== 'success') return [];
      }
      return res.data.result.map((r: PrometheusResult) => ({
        name: r.metric['message_pattern'] || '(unknown)',
        labels: r.metric,
      }));
    } catch {
      return [];
    }
  }

  // Candidates are customer metrics with the join label value matching the anchor's metadata.
  // We enumerate candidate metric names via the backend's label values for __name__,
  // then filter to metrics that carry the join key label. This is potentially expensive
  // on large backends; the topk narrowing happens via the temporal ranker downstream.
  const candidateSet = new Set<string>();
  try {
    const names = await opts.backend.listLabelValues('__name__');
    for (const n of names) {
      if (n.startsWith('log10x_')) continue;
      candidateSet.add(n);
    }
  } catch {
    return [];
  }
  // For each candidate metric name, build a PromQL expression scoped to the join label value.
  const scopeLabel = opts.joinKey.customerSide;
  const results: CandidateNameAndLabels[] = [];
  for (const metricName of Array.from(candidateSet).slice(0, 100)) {
    const expr = `${metricName}{${scopeLabel}="${escape(joinValue)}"}`;
    results.push({ name: expr, labels: { [scopeLabel]: joinValue, __name__: metricName } });
  }
  return results;
}

/**
 * Probe a log10x pattern's metadata labels by running an instant query and
 * reading the first series' label set. Returns the label map, or undefined
 * if the pattern has no active series.
 */
async function probeLog10xPatternLabels(
  opts: CorrelateOptions,
  metric: string
): Promise<Record<string, string> | undefined> {
  const promql = `sum by (tenx_user_service, k8s_namespace, k8s_pod, k8s_container) (rate(${metric}{message_pattern="${escape(opts.anchor.value)}"}[5m]))`;
  try {
    const res = await queryInstant(opts.env, promql);
    if (res.status !== 'success' || !res.data.result[0]) return undefined;
    return res.data.result[0].metric;
  } catch {
    return undefined;
  }
}

/**
 * Extract the join key value from a customer_metric anchor's PromQL expression.
 *
 * Escapes regex metacharacters in the label name and anchors on a label
 * separator character ([{,\s]) to avoid matching a suffix like `user_service`
 * when the join key is `service`.
 */
function extractCustomerMetricLabelValue(anchor: AnchorSpec, joinKey: JoinPair): string | undefined {
  const escapedLabel = joinKey.customerSide.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = anchor.value.match(new RegExp(`(?:[{,\\s]|^)${escapedLabel}="([^"]+)"`));
  return match?.[1];
}

// ── Structural validation ──

interface StructuralScore {
  score: number | null;
  reason: string;
}

/**
 * Compute the structural sub-score for a candidate given the anchor's labels.
 *
 * Returns:
 *   score = 1.0  → full structural overlap (join key + at least one more structural label)
 *   score = 0.5  → join key match only (partial overlap)
 *   score = 0.0  → no structural overlap despite temporal match
 *   score = null → validation couldn't run because required labels missing
 *
 * For `log10x_pattern` anchors, `resolvedAnchorLabels` must be supplied from the
 * metadata probe — parsing labels from a pattern name alone is not possible.
 */
function computeStructuralScore(
  anchor: AnchorSpec,
  candidateLabels: Record<string, string>,
  resolvedAnchorLabels?: Record<string, string>
): StructuralScore {
  const anchorLabels =
    anchor.type === 'log10x_pattern' ? resolvedAnchorLabels : parseAnchorLabels(anchor);
  if (!anchorLabels) {
    return {
      score: null,
      reason:
        'anchor_labels_unresolved — customer-metric anchors with no parseable label matchers cannot be structurally validated',
    };
  }

  // Count structural overlaps across the alias map.
  let joinKeyMatch = false;
  let extraStructuralMatches = 0;
  let aliasesChecked = 0;

  for (const [custAliases, l10xAliases] of STRUCTURAL_ALIASES) {
    const anchorValue = pickFirst(anchorLabels, custAliases) || pickFirst(anchorLabels, l10xAliases);
    const candidateValue =
      pickFirst(candidateLabels, l10xAliases) || pickFirst(candidateLabels, custAliases);

    if (anchorValue && candidateValue) {
      aliasesChecked += 1;
      // Exact match OR prefix match (handles anchors derived from regex
      // matchers like `pod=~"accounting.*"` that got their metachars stripped
      // to `accounting`, which should match a concrete pod name like
      // `accounting-76dc9dc54-jfqxm`). Prefix is only applied when the
      // anchor value is at least 3 chars to avoid noise matches.
      const exactMatch = anchorValue === candidateValue;
      const prefixMatch =
        anchorValue.length >= 3 && candidateValue.startsWith(anchorValue);
      if (exactMatch || prefixMatch) {
        if (!joinKeyMatch) joinKeyMatch = true;
        else extraStructuralMatches += 1;
      }
    }
  }

  if (aliasesChecked === 0) {
    return {
      score: null,
      reason:
        'no_structural_labels_available — neither anchor nor candidate exposes any labels in the v1.4 alias map',
    };
  }

  if (!joinKeyMatch) {
    return { score: 0.0, reason: 'no_join_key_match — temporal coincidence only' };
  }

  if (extraStructuralMatches > 0) {
    return {
      score: 1.0,
      reason: `full_overlap — join key plus ${extraStructuralMatches} additional structural label match(es)`,
    };
  }

  return {
    score: 0.5,
    reason: 'join_key_only — matched on service or primary dimension but not on host/pod level',
  };
}

function parseAnchorLabels(anchor: AnchorSpec): Record<string, string> | undefined {
  if (anchor.type !== 'customer_metric') return undefined;
  const labels: Record<string, string> = {};
  // PromQL label matcher parser. Handles four matcher forms:
  //   key="value"    exact match
  //   key=~"regex"   regex match   — stored with regex metachars stripped
  //   key!="value"   exact non-match — stored (caller decides how to use)
  //   key!~"regex"   regex non-match — stored with metachars stripped
  // Previously only `=` was parsed, so anchors like `pod=~"accounting.*"`
  // silently dropped the pod label and the cross-pillar correlation
  // couldn't filter candidates to the intended scope. Caught by sub-agent
  // S8: accounting restart counter couldn't surface the Kerberos pattern
  // because the pod label wasn't parsed out of the anchor PromQL.
  const braceMatch = anchor.value.match(/\{([^}]*)\}/);
  if (!braceMatch) return labels;
  const body = braceMatch[1];
  const re = /(\w+)\s*(=~|!~|!=|=)\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const key = m[1];
    const op = m[2];
    const raw = m[3];
    if (op === '=' || op === '=~') {
      // Strip regex metacharacters so a downstream exact-value compare can
      // still land. For `accounting.*` this gives `accounting` which matches
      // the `accounting-76dc9dc54-jfqxm` prefix via startsWith below.
      const stripped = raw.replace(/[.^$*+?()[\]{}|\\]/g, '');
      labels[key] = stripped;
    }
    // `!=` / `!~` negative matchers are intentionally NOT stored — they'd
    // need a different comparison semantics. Positive matchers are the
    // overwhelming majority of cross-pillar anchors.
  }
  return labels;
}

function pickFirst(obj: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function pickTier(score: number | null, reason: string): ConfidenceTier {
  void reason; // reserved for future per-reason tiering
  if (score === null) return 'validation_unavailable';
  if (score >= 1.0) return 'joined';
  if (score >= 0.5) return 'structurally_validated';
  return 'temporal_coincidence';
}

// ── Temporal correlation (Pearson + lag) ──

interface TemporalResult {
  r: number;
  lagSeconds: number;
  lagTightness: number;
}

function computeTemporalCorrelation(
  anchor: number[],
  candidate: number[],
  step: number
): TemporalResult {
  if (anchor.length === 0 || candidate.length === 0) {
    return { r: 0, lagSeconds: 0, lagTightness: 0 };
  }
  // Align series to the shorter length.
  const n = Math.min(anchor.length, candidate.length);
  const a = anchor.slice(0, n);
  const c = candidate.slice(0, n);

  // Compute Pearson r at each supported lag offset (expressed in bucket counts).
  const offsets = LAG_OFFSETS_SECONDS.map((s) => Math.round(s / step));
  const rValues: Array<{ offset: number; r: number }> = [];
  for (const offset of offsets) {
    const r = pearsonWithOffset(a, c, offset);
    if (Number.isFinite(r)) rValues.push({ offset, r });
  }
  if (rValues.length === 0) return { r: 0, lagSeconds: 0, lagTightness: 0 };

  // Pick the offset with the highest |r|.
  rValues.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  const peak = rValues[0];
  // Lag tightness: how much larger the peak is than the mean of the other offsets.
  const mean = rValues.slice(1).reduce((sum, x) => sum + Math.abs(x.r), 0) / Math.max(1, rValues.length - 1);
  const peakMag = Math.abs(peak.r);
  const tightness = peakMag > 0 ? Math.max(0, Math.min(1, (peakMag - mean) / peakMag)) : 0;

  return {
    r: peak.r,
    lagSeconds: peak.offset * step,
    lagTightness: tightness,
  };
}

function pearsonWithOffset(a: number[], b: number[], offset: number): number {
  // Slice to overlapping window given the offset.
  // Positive offset: a leads b, so compare a[0..n-offset] with b[offset..n]
  // Negative offset: b leads a, so compare a[-offset..n] with b[0..n+offset]
  let ax: number[], bx: number[];
  if (offset >= 0) {
    ax = a.slice(0, a.length - offset);
    bx = b.slice(offset);
  } else {
    ax = a.slice(-offset);
    bx = b.slice(0, b.length + offset);
  }
  const n = Math.min(ax.length, bx.length);
  if (n < 3) return 0;
  ax = ax.slice(0, n);
  bx = bx.slice(0, n);

  const meanA = ax.reduce((s, x) => s + x, 0) / n;
  const meanB = bx.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = ax[i] - meanA;
    const db = bx[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

// ── Helpers ──

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function durationLabel(stepSeconds: number): string {
  if (stepSeconds % 86400 === 0) return `${stepSeconds / 86400}d`;
  if (stepSeconds % 3600 === 0) return `${stepSeconds / 3600}h`;
  if (stepSeconds % 60 === 0) return `${stepSeconds / 60}m`;
  return `${stepSeconds}s`;
}
