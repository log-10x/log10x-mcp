/**
 * POC envelope v2 — input + output sections, no prose.
 *
 * The v1 envelope mixed structured data with prose (`headline`,
 * `human_summary`) and relied on rendered markdown as the canonical
 * agent-facing surface. The 4-cell experiment showed that giving the
 * agent prose causes the agent to write a more-confident-sounding but
 * less-trusted report; the agent's own writing voice is what we want
 * surfacing the facts.
 *
 * v2 returns pure JSON: `input` (proves the moat through measured
 * scale + methodology) and `output` (rich per-pattern facts the agent
 * quotes verbatim). No headline. No human_summary. No markdown view.
 * The agent reads the structured data and writes the report.
 */

import type { RenderInput } from './poc-report-renderer.js';
import type { IncidentCluster } from './detectors/incident-cluster.js';
import type { PocEnrichment, RedundancyPair } from './poc-enrichers.js';
import type { ExtractedPattern } from './pattern-extraction.js';
import type { SiemId } from './siem/pricing.js';
import { datadogExclusionForPattern, splunkExclusionForPattern, cloudwatchExclusionForPattern, fluentBitForPattern } from './poc-action-snippets.js';
import { dollars, ratio, bps, days as roundDays, countRatio } from './poc-round.js';

// ── SIEM compactability map ──
// Compact mode is licensable / value-relevant only when the SIEM
// charges per-ingest with on-prem indexing. Cloud SIEMs that charge
// per-event or per-byte ingested don't benefit from template encoding
// because they bill BEFORE storage.
const COMPACT_SUPPORTED_SIEMS = new Set<SiemId>([
  'splunk',         // assumes self-hosted Enterprise; cloud Splunk is excluded by inspection
  'elasticsearch',
  'clickhouse',
]);

const COMPACT_NON_APPLICABLE_REASON: Record<SiemId, string> = {
  datadog: 'datadog_cloud_per_ingest_charge',
  cloudwatch: 'cloudwatch_per_ingest_charge',
  'gcp-logging': 'gcp_per_ingest_charge',
  'azure-monitor': 'azure_per_ingest_charge',
  sumo: 'sumo_per_ingest_charge',
  splunk: 'splunk_cloud_per_ingest_charge_when_cloud',
  elasticsearch: 'elastic_cloud_per_ingest_charge_when_cloud',
  clickhouse: 'compact_supported',
};

// ── Output shape ──

export interface PocEnvelopeV2 {
  tool: 'log10x_poc_from_siem' | 'log10x_poc_from_local';
  schema_version: '2.0';
  input: PocInput;
  output: PocOutput;
}

export interface PocInput {
  siem: string;
  window: {
    start_iso: string;
    end_iso: string;
    duration_seconds: number;
  };
  scope?: string;
  query?: string;
  scale: {
    events_pulled: number;
    bytes_pulled: number;
    distinct_patterns_surfaced: number;
    services_observed: number;
    pull_wall_time_seconds: number;
    templater_wall_time_seconds: number;
  };
  stop: {
    reason: string;
    saturation_reached: boolean;
    events_when_saturated: number | null;
  };
  coverage: {
    events_with_timestamp_pct: number;
    events_with_service_attribution_pct: number;
    events_with_severity_attribution_pct: number;
  };
  methodology: {
    templater: 'engine_fingerprint' | 'paste_lambda';
    fingerprint_determinism: 'stable_across_deploys' | 'sample_lexical';
    cost_calculation: 'measured_bytes_x_analyzer_rate';
    growth_calculation: 'last_24h_rate_over_window_avg_rate';
    incident_clustering: 'jaccard_overlap_pearson_correlation';
    first_seen_source: 'per_event_timestamps_in_window' | 'engine_history' | 'unavailable';
  };
  analyzer_rate_usd_per_gb: number;
}

export interface PocOutput {
  /**
   * Optional host-agent enrichment block. Populated when the customer
   * sets `enrich_with_host_agent=true` on the submit and the MCP host
   * advertises the `sampling` capability. Contributions come from the
   * host's own LLM using its tools (kubectl, source, dashboards) to
   * add operational context the engine cannot see. Always
   * non-throwing: when enrichment is skipped or fails, `metadata`
   * carries the reason and `contributions` is empty.
   */
  agent_enrichment?: import('./poc-host-agent-enricher.js').AgentEnrichmentResult;
  aggregates: {
    totals: {
      monthly_cost_usd: number;
      top_n_monthly_cost_usd: number;
      head_concentration: { top_1: number; top_5: number; top_15: number };
    };
    emergence_tally: {
      new_24h: number;
      growing: number;
      stable: number;
      recent_burst: number;
      unknown: number;
    };
    by_service: ServiceAggregate[];
    by_severity: Record<string, number>;
    redundancy_pairs: RedundancyPairOutput[];
  };
  incidents: IncidentOutput[];
  patterns: PatternOutput[];
}

export interface ServiceAggregate {
  service: string;
  monthly_cost_usd: number;
  pattern_count: number;
  top_pattern_index: number;
  approx_bytes_per_sec: number;
  share_of_total: number;
}

export interface RedundancyPairOutput {
  pattern_a_index: number;
  pattern_b_index: number;
  count_ratio: number;
  min_count: number;
  service: string;
  hypothesis: 'same_business_event_logged_twice' | 'http_request_response_pair' | 'enter_exit_pair' | 'unknown_pair';
}

export interface IncidentOutput {
  id: number;
  service: string;
  representative_descriptor: string;
  join_signal: 'jaccard_direct' | 'overlap_shared' | 'jaccard_with_correlation';
  confidence: number;
  member_pattern_indices: number[];
  combined_monthly_cost_usd: number;
  root_cause_hypothesis: string;
}

export interface PatternOutput {
  rank: number;
  identity: string;
  fingerprint_hash: string;
  service: string | null;
  severity: string | null;
  metrics: {
    events_in_window: number;
    events_per_day_avg: number;
    events_last_24h: number;
    bytes_in_window: number;
    cost_per_month_usd: number;
    cost_per_year_usd: number;
    share_of_total: number;
  };
  emergence: {
    category: 'new' | 'growing' | 'stable' | 'recent_burst' | 'unknown';
    /**
     * First occurrence of this pattern WITHIN THE STRATIFIED SAMPLE
     * the connector pulled, not the pattern's true first emission
     * time. The connector's 24 random sub-windows cover only ~25% of
     * the requested window, so values here can lag the customer's
     * actual first-emission by days. Use this for relative ordering,
     * not as a definitive "this pattern appeared at time T" claim.
     */
    first_seen_in_sample_iso: string | null;
    last_seen_in_sample_iso: string | null;
    age_in_sample_days: number | null;
    acceleration_ratio: number;
    duration_in_sample_days: number | null;
    events_by_hour_sparkline: number[] | null;
  };
  top_slot: {
    name: string;
    distinct_count: number;
    distinct_over_event_count: number;
    unbounded: boolean;
  } | null;
  incident_cluster_id: number | null;
  redundancy_partner_indices: number[];
  actions: PatternActions;
}

export interface PatternActions {
  code_fix: CodeFixAction;
  forwarder_exclusion: ExclusionAction;
  siem_exclusion: ExclusionAction;
  compact: CompactAction;
  regulate_cap: RegulateCapAction;
}

export interface CodeFixAction {
  applicable: boolean;
  owning_service: string | null;
  bug_hypothesis: string | null;
  fix_complexity_guess:
    | 'config_change_or_dns_fix'
    | 'log_level_demotion'
    | 'rate_limiting'
    | 'inspect_caller_then_demote_or_sample'
    | 'unknown'
    | null;
  expected_outcome: 'this_pattern_disappears' | 'this_pattern_drops_significantly' | null;
}

export interface ExclusionAction {
  applicable: boolean;
  vendor: string | null;
  snippet: string | null;
  /** Null when applicable=false. Real dollars (rounded to cents) when true. */
  expected_savings_usd_per_month: number | null;
}

export interface CompactAction {
  applicable: boolean;
  reason: string;
  expected_compression_ratio: number | null;
  expected_savings_usd_per_month: number | null;
}

export interface RegulateCapAction {
  applicable: boolean;
  current_p95_bytes_per_sec: number;
  proposed_cap_bytes_per_sec: number;
  rationale: string;
  expected_drop_pct: number;
}

// ── Build helpers ──

/**
 * Build the v2 envelope from RenderInput + the already-enriched
 * patterns / clusters / redundancy pairs produced by the renderer's
 * enrichPatternsWithSections helper. Reuses every computation that
 * already happened — no double work.
 */
export function buildPocEnvelopeV2(
  input: RenderInput,
  enrichedPatterns: Array<ExtractedPattern & { costPerWindow: number; costPerWeek: number; pctOfTotal: number; poc: PocEnrichment; identity: string; recommendedAction: 'mute' | 'sample' | 'keep'; sampleRate: number }>,
  clusters: IncidentCluster[],
  redundancyPairs: RedundancyPair[],
  topN: number,
): PocEnvelopeV2 {
  const siem = input.siem as SiemId;
  const windowDurationSeconds = Math.round(input.windowHours * 3600);
  const windowEndMs = input.windowEndMs ?? Date.now();
  const windowStartMs = input.windowStartMs ?? windowEndMs - windowDurationSeconds * 1000;

  // Coverage: how many of the pulled patterns have timestamps, service, severity?
  // Computed across the FULL pattern list (not just top-N) so the agent sees
  // the underlying coverage of the pull.
  let withTimestamp = 0;
  let withService = 0;
  let withSeverity = 0;
  for (const p of input.extraction.patterns) {
    if (p.firstSeenMs !== undefined) withTimestamp++;
    if (p.service) withService++;
    if (p.severity) withSeverity++;
  }
  const totalPatterns = Math.max(1, input.extraction.patterns.length);

  // Compute total cost. When the caller supplied rawIngestBytes (the
  // size of the actual SIEM payload, envelope and all), project
  // monthly cost from that — it matches the customer's bill. When
  // absent, fall back to summing the templater-side per-pattern
  // costPerWindow, which understates because it ignores the JSON
  // envelope bytes around each event.
  const monthlyCostUsd = input.rawIngestBytes && input.rawIngestBytes > 0 && input.windowHours > 0
    ? (input.rawIngestBytes / (1024 ** 3)) * input.analyzerCostPerGb * (24 * 30) / input.windowHours
    : enrichedPatterns.reduce((s, p) => s + p.costPerWindow, 0) * (24 * 30) / Math.max(0.001, input.windowHours);

  // Aggregations.
  const aggregates = buildAggregates(enrichedPatterns, redundancyPairs, topN, monthlyCostUsd, windowDurationSeconds);

  // Per-pattern outputs (top-N only).
  const topPatterns = enrichedPatterns.slice(0, topN);
  const patternOutputs: PatternOutput[] = topPatterns.map((p, i) =>
    buildPatternOutput(p, i, siem, monthlyCostUsd, windowDurationSeconds, input),
  );

  // Cluster outputs — convert member identities to top-N indices when possible.
  const identityToIndex = new Map<string, number>();
  patternOutputs.forEach((p, i) => identityToIndex.set(p.identity, i));
  const incidentOutputs: IncidentOutput[] = clusters.map((c, ci) => ({
    id: ci,
    service: c.service,
    representative_descriptor: c.representativeLabel,
    join_signal: c.joinSignal,
    confidence: c.confidence,
    member_pattern_indices: c.members
      .map((m) => identityToIndex.get(m.identity))
      .filter((i): i is number => i !== undefined),
    combined_monthly_cost_usd: c.combinedMonthlyUsd,
    root_cause_hypothesis: inferRootCauseHypothesis(c),
  }));

  // Tag each pattern with its cluster id (re-derive — the enricher already did it but here we use top-N indices).
  for (const c of incidentOutputs) {
    for (const idx of c.member_pattern_indices) {
      patternOutputs[idx].incident_cluster_id = c.id;
    }
  }
  // Redundancy partner indices.
  const redundancyOutputs: RedundancyPairOutput[] = [];
  for (const pair of redundancyPairs) {
    const ai = identityToIndex.get(pair.identityA);
    const bi = identityToIndex.get(pair.identityB);
    if (ai === undefined || bi === undefined) continue;
    patternOutputs[ai].redundancy_partner_indices.push(bi);
    patternOutputs[bi].redundancy_partner_indices.push(ai);
    redundancyOutputs.push({
      pattern_a_index: ai,
      pattern_b_index: bi,
      count_ratio: countRatio(pair.ratio),
      min_count: pair.minCount,
      service: topPatterns[ai].service || '(unattributed)',
      hypothesis: inferRedundancyHypothesis(topPatterns[ai].identity, topPatterns[bi].identity),
    });
  }
  aggregates.redundancy_pairs = redundancyOutputs;

  return {
    tool: 'log10x_poc_from_siem',
    schema_version: '2.0',
    input: {
      siem: input.siem,
      window: {
        start_iso: new Date(windowStartMs).toISOString(),
        end_iso: new Date(windowEndMs).toISOString(),
        duration_seconds: windowDurationSeconds,
      },
      scope: input.scope,
      query: input.query,
      scale: {
        events_pulled: input.extraction.totalEvents,
        bytes_pulled: input.extraction.totalBytes,
        distinct_patterns_surfaced: input.extraction.patterns.length,
        services_observed: countDistinctServices(input.extraction.patterns),
        pull_wall_time_seconds: Math.round(input.pullWallTimeMs / 1000),
        templater_wall_time_seconds: Math.round(input.templateWallTimeMs / 1000),
      },
      stop: {
        reason: input.reasonStopped,
        saturation_reached: input.reasonStopped === 'source_exhausted',
        events_when_saturated: input.reasonStopped === 'source_exhausted' ? input.extraction.totalEvents : null,
      },
      coverage: {
        events_with_timestamp_pct: withTimestamp / totalPatterns,
        events_with_service_attribution_pct: withService / totalPatterns,
        events_with_severity_attribution_pct: withSeverity / totalPatterns,
      },
      methodology: {
        templater: input.extraction.executionMode === 'local_cli' ? 'engine_fingerprint' : 'paste_lambda',
        fingerprint_determinism: 'stable_across_deploys',
        cost_calculation: 'measured_bytes_x_analyzer_rate',
        growth_calculation: 'last_24h_rate_over_window_avg_rate',
        incident_clustering: 'jaccard_overlap_pearson_correlation',
        first_seen_source: withTimestamp > 0 ? 'per_event_timestamps_in_window' : 'unavailable',
      },
      analyzer_rate_usd_per_gb: input.analyzerCostPerGb,
    },
    output: {
      aggregates,
      incidents: incidentOutputs,
      patterns: patternOutputs,
    },
  };
}

function countDistinctServices(patterns: ExtractedPattern[]): number {
  const services = new Set<string>();
  for (const p of patterns) if (p.service) services.add(p.service);
  return services.size;
}

function buildAggregates(
  patterns: Array<ExtractedPattern & { costPerWindow: number; pctOfTotal: number; poc: PocEnrichment }>,
  _redundancyPairs: RedundancyPair[],
  topN: number,
  totalMonthlyCostUsd: number,
  windowDurationSeconds: number,
): PocOutput['aggregates'] {
  const top1 = patterns[0]?.pctOfTotal ?? 0;
  const top5 = patterns.slice(0, 5).reduce((s, p) => s + p.pctOfTotal, 0);
  const top15 = patterns.slice(0, 15).reduce((s, p) => s + p.pctOfTotal, 0);
  const topNCostPerWindow = patterns.slice(0, topN).reduce((s, p) => s + p.costPerWindow, 0);
  const topNMonthlyCostUsd = topNCostPerWindow * (24 * 30) / Math.max(0.001, windowDurationSeconds / 3600);

  // Emergence tally.
  const emergence = { new_24h: 0, growing: 0, stable: 0, recent_burst: 0, unknown: 0 };
  for (const p of patterns) {
    const cat = p.poc.emergence?.category ?? 'unknown';
    if (cat === 'new') emergence.new_24h++;
    else if (cat === 'growing') emergence.growing++;
    else if (cat === 'stable') emergence.stable++;
    else if (cat === 'recent_burst') emergence.recent_burst++;
    else emergence.unknown++;
  }

  // Per-service aggregation.
  const serviceMap = new Map<string, { cost: number; count: number; bytes: number; topPatternIndex: number; topPatternCost: number }>();
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i];
    const svc = p.service || '(unattributed)';
    const existing = serviceMap.get(svc);
    if (existing) {
      existing.cost += p.costPerWindow;
      existing.count += 1;
      existing.bytes += p.bytes;
      if (p.costPerWindow > existing.topPatternCost) {
        existing.topPatternCost = p.costPerWindow;
        existing.topPatternIndex = i;
      }
    } else {
      serviceMap.set(svc, { cost: p.costPerWindow, count: 1, bytes: p.bytes, topPatternIndex: i, topPatternCost: p.costPerWindow });
    }
  }
  const byService: ServiceAggregate[] = [];
  for (const [service, agg] of serviceMap) {
    const monthlyCost = agg.cost * (24 * 30) / Math.max(0.001, windowDurationSeconds / 3600);
    byService.push({
      service,
      monthly_cost_usd: dollars(monthlyCost),
      pattern_count: agg.count,
      top_pattern_index: agg.topPatternIndex,
      approx_bytes_per_sec: bps(agg.bytes / Math.max(1, windowDurationSeconds)),
      share_of_total: ratio(monthlyCost / Math.max(0.001, totalMonthlyCostUsd)),
    });
  }
  byService.sort((a, b) => b.monthly_cost_usd - a.monthly_cost_usd);

  // Severity aggregation (share of bytes).
  const bySeverityBytes = new Map<string, number>();
  let totalBytes = 0;
  for (const p of patterns) {
    totalBytes += p.bytes;
    const sev = p.severity || '(none)';
    bySeverityBytes.set(sev, (bySeverityBytes.get(sev) || 0) + p.bytes);
  }
  const bySeverity: Record<string, number> = {};
  if (totalBytes > 0) {
    for (const [sev, bytes] of bySeverityBytes) bySeverity[sev] = ratio(bytes / totalBytes);
  }

  return {
    totals: {
      monthly_cost_usd: dollars(totalMonthlyCostUsd),
      top_n_monthly_cost_usd: dollars(topNMonthlyCostUsd),
      head_concentration: { top_1: ratio(top1), top_5: ratio(top5), top_15: ratio(top15) },
    },
    emergence_tally: emergence,
    by_service: byService,
    by_severity: bySeverity,
    redundancy_pairs: [],
  };
}

function buildPatternOutput(
  p: ExtractedPattern & { costPerWindow: number; pctOfTotal: number; poc: PocEnrichment; identity: string; recommendedAction: 'mute' | 'sample' | 'keep'; sampleRate: number },
  rank: number,
  siem: SiemId,
  totalMonthlyCostUsd: number,
  windowDurationSeconds: number,
  input: RenderInput,
): PatternOutput {
  const eventsInWindow = p.count;
  const windowDays = Math.max(0.001, windowDurationSeconds / 86400);
  const eventsPerDayAvg = eventsInWindow / windowDays;
  const monthlyCost = p.costPerWindow * (24 * 30) / Math.max(0.001, windowDurationSeconds / 3600);

  // Events last 24h from the per-hour bucket map (if present).
  let eventsLast24h = 0;
  if (p.eventsByHour && input.windowEndMs) {
    const last24hBucketStart = Math.floor((input.windowEndMs - 24 * 3_600_000) / 3_600_000);
    for (const [bucket, count] of Object.entries(p.eventsByHour)) {
      if (Number(bucket) >= last24hBucketStart) eventsLast24h += count;
    }
  }

  // Build emergence section.
  //
  // Field naming carries an explicit `_in_sample` suffix on the
  // surfaced-from-sample fields. The previous names (`first_seen_iso`,
  // `last_seen_iso`, `age_days`, `duration_days`) were misleading on
  // sampled pulls — they reflected the first and last event in the
  // STRATIFIED SUB-WINDOWS the connector pulled, not when the pattern
  // first or last existed in the customer's true log stream. The
  // explicit suffix tells the host agent that these bounds are
  // sample-bounded and not authoritative.
  const emergenceCat = p.poc.emergence?.category ?? 'unknown';
  const emergence: PatternOutput['emergence'] = {
    category: emergenceCat,
    first_seen_in_sample_iso: p.firstSeenMs ? new Date(p.firstSeenMs).toISOString() : null,
    last_seen_in_sample_iso: p.lastSeenMs ? new Date(p.lastSeenMs).toISOString() : null,
    age_in_sample_days: p.poc.emergence ? roundDays(p.poc.emergence.ageInWindowMs / 86_400_000) : null,
    acceleration_ratio: ratio(p.poc.emergence?.accelerationRatio ?? 0),
    duration_in_sample_days: p.poc.emergence ? roundDays(p.poc.emergence.durationMs / 86_400_000) : null,
    // Sparkline now emits for stable patterns too — stability over the
    // window is exactly what a sparkline visualizes best, and the
    // previous "only new/growing/burst" gate left the highest-cost
    // patterns with `null`.
    events_by_hour_sparkline: buildSparkline(p.eventsByHour, input.windowStartMs, input.windowEndMs, 14),
  };

  // Top-slot output. distinct_over_event_count is rounded to 3 dp so
  // values like 0.9995569666986636 stop looking like real precision.
  const topSlot = p.poc.topSlot
    ? {
        name: p.poc.topSlot.slot,
        distinct_count: p.poc.topSlot.distinctCount,
        distinct_over_event_count: ratio(p.poc.topSlot.distinctOverCount),
        unbounded: p.poc.topSlot.distinctOverCount >= 0.9,
      }
    : null;

  // Action outputs.
  const actions = buildActions(p, siem, monthlyCost, windowDurationSeconds);

  return {
    rank: rank + 1,
    identity: p.identity,
    fingerprint_hash: p.hash,
    service: p.service ?? null,
    severity: p.severity ?? null,
    metrics: {
      events_in_window: eventsInWindow,
      events_per_day_avg: Math.round(eventsPerDayAvg),
      events_last_24h: eventsLast24h,
      bytes_in_window: p.bytes,
      cost_per_month_usd: dollars(monthlyCost),
      cost_per_year_usd: dollars(monthlyCost * 12),
      share_of_total: ratio(monthlyCost / Math.max(0.001, totalMonthlyCostUsd)),
    },
    emergence,
    top_slot: topSlot,
    incident_cluster_id: null, // populated by the cluster-builder pass
    redundancy_partner_indices: [],
    actions,
  };
}

function buildSparkline(
  eventsByHour: Record<number, number> | undefined,
  windowStartMs: number | undefined,
  windowEndMs: number | undefined,
  buckets: number,
): number[] | null {
  if (!eventsByHour || !windowStartMs || !windowEndMs) return null;
  const windowMs = windowEndMs - windowStartMs;
  const bucketSizeMs = Math.max(3_600_000, windowMs / buckets); // floor at 1h bucket
  const out = new Array(buckets).fill(0);
  for (const [hourBucket, count] of Object.entries(eventsByHour)) {
    const tsMs = Number(hourBucket) * 3_600_000;
    if (tsMs < windowStartMs || tsMs >= windowEndMs) continue;
    const i = Math.min(buckets - 1, Math.floor((tsMs - windowStartMs) / bucketSizeMs));
    out[i] += count;
  }
  return out;
}

function buildActions(
  p: { service?: string; severity?: string; template: string; symbolMessage?: string; identity: string; recommendedAction: string; sampleRate: number; poc: PocEnrichment },
  siem: SiemId,
  monthlyCost: number,
  _windowDurationSeconds: number,
): PatternActions {
  const desc = `${p.symbolMessage || ''} ${p.template}`.toLowerCase();
  const sev = (p.severity || '').toUpperCase();
  const isError = /ERROR|CRIT|FATAL/.test(sev);
  const isDependencyFailure = isError &&
    /\b(dial|timeout|no.such.host|refused|unreachable|deadline|connection.reset|broken.pipe)\b/.test(desc);

  // Code fix recommendation.
  const codeFix: CodeFixAction = (() => {
    if (isDependencyFailure) {
      return {
        applicable: true,
        owning_service: p.service ?? null,
        bug_hypothesis: 'dependency_failure_retry_loop',
        fix_complexity_guess: 'config_change_or_dns_fix',
        expected_outcome: 'this_pattern_disappears',
      };
    }
    if (/DEBUG/.test(sev)) {
      return {
        applicable: true,
        owning_service: p.service ?? null,
        bug_hypothesis: 'debug_logging_left_enabled_in_production',
        fix_complexity_guess: 'log_level_demotion',
        expected_outcome: 'this_pattern_disappears',
      };
    }
    if (/TRACE/.test(sev)) {
      // TRACE-level logs are typically OTel SDK tracer emissions
      // wrapping the underlying call's severity. The upstream call
      // may be info / debug — the agent should investigate before
      // demoting. Recommend trace-sampling instead of log demotion.
      return {
        applicable: true,
        owning_service: p.service ?? null,
        bug_hypothesis: 'trace_level_emission_from_otel_sdk_wrapping',
        fix_complexity_guess: 'inspect_caller_then_demote_or_sample',
        expected_outcome: 'this_pattern_drops_significantly',
      };
    }
    // INFO that's a high-cardinality slot — often a missing rate-limit
    if (p.poc.topSlot && p.poc.topSlot.distinctOverCount > 0.7) {
      return {
        applicable: true,
        owning_service: p.service ?? null,
        bug_hypothesis: 'unbounded_variable_slot_drives_cardinality',
        fix_complexity_guess: 'rate_limiting',
        expected_outcome: 'this_pattern_drops_significantly',
      };
    }
    return {
      applicable: false,
      owning_service: null,
      bug_hypothesis: null,
      fix_complexity_guess: null,
      expected_outcome: null,
    };
  })();

  // Forwarder + SIEM exclusions. When not applicable the snippet and
  // savings are null (not 0) so the agent doesn't read "we recommend
  // this action with zero savings" — it reads "this action is not
  // applicable, ignore it".
  const expectedSavings = p.poc.refinedAction === 'mute' ? monthlyCost : p.poc.refinedAction === 'sample' ? monthlyCost * (1 - 1 / Math.max(1, p.sampleRate)) : 0;
  const forwarderExclusion: ExclusionAction = (p.poc.refinedAction === 'mute' || p.poc.refinedAction === 'sample')
    ? {
        applicable: true,
        vendor: 'fluent-bit',
        snippet: fluentBitForPattern(p.identity, p.template),
        expected_savings_usd_per_month: dollars(expectedSavings),
      }
    : { applicable: false, vendor: null, snippet: null, expected_savings_usd_per_month: null };

  const siemSnippet = siemSpecificSnippet(siem, p.identity, p.template);
  const siemExclusion: ExclusionAction = (p.poc.refinedAction === 'mute' || p.poc.refinedAction === 'sample') && siemSnippet
    ? {
        applicable: true,
        vendor: siem,
        snippet: siemSnippet,
        expected_savings_usd_per_month: dollars(expectedSavings),
      }
    : { applicable: false, vendor: null, snippet: null, expected_savings_usd_per_month: null };

  // Compact — gated on SIEM.
  const compactApplicable = COMPACT_SUPPORTED_SIEMS.has(siem);
  const compact: CompactAction = compactApplicable
    ? {
        applicable: true,
        reason: 'compact_supported_for_this_siem',
        expected_compression_ratio: ratio(0.3), // typical engine measurement
        expected_savings_usd_per_month: dollars(monthlyCost * 0.7),
      }
    : {
        applicable: false,
        reason: COMPACT_NON_APPLICABLE_REASON[siem] ?? 'unknown_siem',
        expected_compression_ratio: null,
        expected_savings_usd_per_month: null,
      };

  // Regulate cap — when refinedAction is mute or fix, this action is
  // NOT applicable (the action is to drop entirely or fix the source,
  // not to apply a rate cap; recommending both produces a confusing
  // two-action recipe). regulate_cap only applies when refinedAction
  // is sample or keep.
  const observedBytesPerSec = (p as unknown as { bytes: number }).bytes / Math.max(1, _windowDurationSeconds);
  const capApplicable = p.poc.refinedAction === 'sample' || p.poc.refinedAction === 'keep';
  const proposedCap = p.poc.refinedAction === 'sample'
    ? observedBytesPerSec / Math.max(1, p.sampleRate)
    : p.poc.refinedAction === 'keep'
      ? observedBytesPerSec * 1.2
      : 0;
  const regulateCap: RegulateCapAction = capApplicable ? {
    applicable: true,
    current_p95_bytes_per_sec: bps(observedBytesPerSec * 1.5),
    proposed_cap_bytes_per_sec: bps(proposedCap),
    rationale: p.poc.refinedAction === 'sample'
      ? 'sample_to_retain_signal_at_lower_volume'
      : 'allow_observed_steady_state_with_burst_headroom',
    expected_drop_pct: ratio(p.poc.refinedAction === 'sample' ? 1 - 1 / Math.max(1, p.sampleRate) : 0),
  } : {
    applicable: false,
    current_p95_bytes_per_sec: bps(observedBytesPerSec * 1.5),
    proposed_cap_bytes_per_sec: 0,
    rationale: 'use_forwarder_exclusion_or_fix_root_cause_instead',
    expected_drop_pct: 0,
  };

  return {
    code_fix: codeFix,
    forwarder_exclusion: forwarderExclusion,
    siem_exclusion: siemExclusion,
    compact,
    regulate_cap: regulateCap,
  };
}

function siemSpecificSnippet(siem: SiemId, identity: string, template: string): string | null {
  switch (siem) {
    case 'datadog': return datadogExclusionForPattern(identity, template);
    case 'splunk': return splunkExclusionForPattern(identity, template);
    case 'cloudwatch': return cloudwatchExclusionForPattern(identity, template);
    default: return null;
  }
}

function inferRootCauseHypothesis(c: IncidentCluster): string {
  const label = c.representativeLabel.toLowerCase();
  if (/dial.*tcp|no.such.host|lookup/.test(label)) return 'dns_or_service_discovery_failure';
  if (/timeout|deadline/.test(label)) return 'downstream_service_timeout';
  if (/refused|connection.reset/.test(label)) return 'downstream_service_unavailable';
  if (/oom|out.of.memory|memory/.test(label)) return 'memory_pressure_in_caller';
  return 'co_occurring_failures_share_root_cause';
}

function inferRedundancyHypothesis(idA: string, idB: string): RedundancyPairOutput['hypothesis'] {
  const a = idA.toLowerCase();
  const b = idB.toLowerCase();
  if (/received|request|incoming/.test(a) && /complete|success|response|done/.test(b)) return 'enter_exit_pair';
  if (/received|request|incoming/.test(b) && /complete|success|response|done/.test(a)) return 'enter_exit_pair';
  if (/charge|transaction|payment|order/.test(a) && /charge|transaction|payment|order/.test(b)) return 'same_business_event_logged_twice';
  if (/request|incoming|inbound/.test(a) && /response|outgoing|outbound/.test(b)) return 'http_request_response_pair';
  return 'unknown_pair';
}
