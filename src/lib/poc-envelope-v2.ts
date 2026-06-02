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
import { dollars, ratio, bps, days as roundDays, countRatio } from './poc-round.js';
import { getAllowedActionsForDestination, getDefaultActionForDestination, type Action as CostAction } from './cost.js';

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
  /**
   * Feasibility verdict. Populated when the caller passed a
   * `target_percent_reduction` on the submit. When absent, the POC ran
   * in recommendation-only mode (no commitment artifact, no verdict).
   *
   * `max_achievable_percent` is derived from head_concentration (top-N
   * share of monthly cost) × per-destination action coverage (which
   * patterns the level-1 default action can actually reduce) minus the
   * exception pool (services pinned to action=pass). Feasibility holds
   * when `max_achievable_percent >= target_percent_reduction`.
   */
  feasibility?: FeasibilityVerdict;
  /**
   * Projected commitment artifact. Pre-deploy markdown stub the agent
   * surfaces alongside the verdict so the buyer sees the contractual
   * shape of what they would be signing: target, max achievable,
   * per-action breakdown, exceptions, and the recommended next step
   * (deploy + configure_engine).
   */
  commitment_artifact?: CommitmentArtifact;
  /**
   * Ready-to-commit cap-CSV body in the format `configure_engine`
   * writes. Composed from per-pattern recommendations (see
   * `patterns[].actions`) plus a container-default row for each
   * exception service. `configure_engine(from_poc_id=...)` reads this
   * field verbatim instead of re-deriving the policy from
   * `patterns[].actions`. Emitted only when the POC ran with a
   * `target_percent_reduction` AND the feasibility verdict was reached.
   *
   * Row grammar (matches `cap-csv-parser.ts`):
   *   container,cap                                   ← header
   *   <container>,<bytes>::<reason>:<action>          ← container default
   *   pat:<tenx_hash>,<bytes>::<reason>:<action>      ← per-pattern override
   *
   * Action vocab: pass | sample | compact | tier_down | offload | drop.
   */
  cap_csv?: string;
}

export interface FeasibilityVerdict {
  feasible: boolean;
  target_percent_reduction: number;
  max_achievable_percent: number;
  /** Plain-English explanation of how max_achievable_percent was derived. */
  reason: string;
  /** Per-action breakdown of the achievable pool (in monthly $). */
  achievable_by_action: Array<{
    action: CostAction;
    monthly_cost_usd: number;
    pattern_count: number;
  }>;
  /** Services excluded from the achievable pool (pinned to action=pass). */
  exception_services: string[];
  /** Monthly cost (USD) covered by the exception list. */
  exception_monthly_cost_usd: number;
}

export interface CommitmentArtifact {
  /** Markdown block, pre-deploy framing. */
  markdown: string;
  /** Recommended next-step tool call for the agent to chain into. */
  next_step: {
    tool: 'log10x_advise_install' | 'log10x_configure_engine';
    reason: string;
  };
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

/**
 * Per-pattern action recommendation, expressed in the 6-action vocab the
 * cap-CSV writer / parser share. The renderer picks `recommended_action`
 * by combining `DEFAULT_ACTION_BY_DESTINATION[siem]` with the head-
 * concentration heuristic — high-volume info-class patterns land on
 * the destination's level-1 action (Datadog → tier_down, Splunk →
 * offload, ClickHouse → compact, …); error/audit and exception-pinned
 * patterns land on `pass`; mid-volume info patterns land on `sample`.
 *
 * Replaces the prior bag of sub-action shapes (code_fix /
 * forwarder_exclusion / siem_exclusion / compact / regulate_cap). The
 * new shape is a single recommendation per pattern, ready to compose
 * directly into the cap-CSV `pat:<hash>,<bytes>::<reason>:<action>` row.
 */
export interface PatternActions {
  /** 6-action recommendation for this pattern on this destination. */
  recommended_action: CostAction;
  /**
   * Plain-prose explanation of why this action was selected. Cites the
   * destination level-1 lever, head-concentration band, and any
   * exception-service / floor pin in effect.
   */
  reason: string;
  /**
   * Projected monthly dollar savings if the recommendation is committed,
   * computed using the same reduction coefficients the feasibility
   * verdict uses (drop=1.0, offload=1.0, compact=0.7, tier_down=0.6,
   * sample=0.9, pass=0). Real dollars, rounded to cents.
   */
  expected_savings_usd_per_month: number;
  /**
   * Sample-keep denominator. Populated only when
   * `recommended_action === 'sample'`; null otherwise. Matches the
   * sampleN argument the cost lib uses (`bytes_out = bytes_in / N`).
   */
  sample_n: number | null;
  /**
   * Cap, expressed in bytes per 4-minute reset window, that
   * configure_engine would write for this pattern. Used to construct
   * the `pat:<hash>,<bytes>::<reason>:<action>` cap-CSV row. The
   * configure_engine consumer reads `cap_csv` directly; this field is
   * the per-pattern view for agents inspecting individual rows.
   */
  cap_bytes_per_window: number;
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
  opts?: {
    /**
     * Customer-specified reduction target (0-100). When present, the
     * envelope emits a feasibility verdict + commitment artifact stub.
     * When absent, the POC stays in recommendation-only mode.
     */
    targetPercentReduction?: number;
    /**
     * Services flagged to stay in the SIEM with full retention. Patterns
     * whose service is in this list are pinned to action=pass and their
     * bytes are subtracted from the achievable pool.
     */
    exceptionServices?: string[];
  },
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
    combined_monthly_cost_usd: dollars(c.combinedMonthlyUsd),
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

  // ── Exception-services pinning ──
  // Any pattern whose service is in the exception list is pinned to
  // recommended_action='pass': the buyer flagged these services as
  // audit / compliance / executive-dashboard critical and wants the raw
  // stream to keep flowing into the SIEM. Pinning here overrides the
  // destination-default-action selection that buildActions just ran.
  const exceptionSet = new Set<string>(
    (opts?.exceptionServices ?? []).map((s) => s.toLowerCase()),
  );
  if (exceptionSet.size > 0) {
    for (const p of patternOutputs) {
      const svc = (p.service ?? '').toLowerCase();
      if (!svc || !exceptionSet.has(svc)) continue;
      p.actions = {
        recommended_action: 'pass',
        reason: 'service_pinned_by_exception_list',
        expected_savings_usd_per_month: 0,
        sample_n: null,
        // pass keeps the full per-window throughput unchanged — the cap
        // is set to the pattern's own monthly-projected throughput
        // divided across 4-minute windows so the rate receiver never
        // throttles it.
        cap_bytes_per_window: p.actions.cap_bytes_per_window,
      };
    }
  }

  // ── Feasibility verdict + commitment artifact stub ──
  // Both are emitted only when the caller passed target_percent_reduction.
  // The math: max_achievable = sum(monthly cost of patterns the
  // destination's level-1/2 actions can act on, minus exception bytes).
  // Exception-service patterns are pinned to action=pass and subtract
  // from the achievable pool.
  let feasibility: FeasibilityVerdict | undefined;
  let commitmentArtifact: CommitmentArtifact | undefined;
  let capCsv: string | undefined;
  if (opts?.targetPercentReduction !== undefined) {
    feasibility = computeFeasibility(
      opts.targetPercentReduction,
      enrichedPatterns,
      siem,
      monthlyCostUsd,
      windowDurationSeconds,
      exceptionSet,
      opts.exceptionServices ?? [],
    );
    commitmentArtifact = buildCommitmentArtifact(
      feasibility,
      input,
      monthlyCostUsd,
    );
    // cap_csv is composed from the per-pattern actions the renderer
    // emitted above. configure_engine(from_poc_id=…) reads this field
    // verbatim instead of re-deriving the policy.
    capCsv = buildCapCsv(patternOutputs, siem, exceptionSet, windowDurationSeconds);
  }

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
        events_with_timestamp_pct: ratio(withTimestamp / totalPatterns),
        events_with_service_attribution_pct: ratio(withService / totalPatterns),
        events_with_severity_attribution_pct: ratio(withSeverity / totalPatterns),
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
      ...(feasibility ? { feasibility } : {}),
      ...(commitmentArtifact ? { commitment_artifact: commitmentArtifact } : {}),
      ...(capCsv ? { cap_csv: capCsv } : {}),
    },
  };
}

/**
 * Derive max_achievable_percent from the FULL enriched-pattern list (not
 * just top-N): for each pattern, look up the destination's level-1
 * default action and treat its monthly cost as either fully reducible
 * (drop / offload), partially reducible (sample, compact, tier_down),
 * or non-reducible (pass — which is what exception_services force).
 *
 * Reducibility coefficients (multiply pattern monthly cost):
 *   drop      → 1.00 (full removal)
 *   offload   → 1.00 (destination sees nothing; S3 cost out of scope)
 *   compact   → 0.70 (ClickHouse / Splunk envelope; matches cost.ts mid-band)
 *   tier_down → 0.60 (Datadog Flex / CW IA; conservative cost-tier delta)
 *   sample    → 0.90 (1-in-10 default keep rate is the common config)
 *   pass      → 0.00 (no reduction)
 */
function computeFeasibility(
  targetPercent: number,
  patterns: Array<ExtractedPattern & { costPerWindow: number; pctOfTotal: number; poc: PocEnrichment; recommendedAction: 'mute' | 'sample' | 'keep' }>,
  siem: SiemId,
  totalMonthlyCostUsd: number,
  windowDurationSeconds: number,
  exceptionSet: Set<string>,
  exceptionServices: string[],
): FeasibilityVerdict {
  // Convert per-pattern window cost → monthly cost using the same
  // factor the rest of the envelope uses.
  const monthlyFactor = (24 * 30) / Math.max(0.001, windowDurationSeconds / 3600);

  const allowed = getAllowedActionsForDestination(siem);
  const level1 = allowed[0] ?? 'offload';
  const level2 = allowed[1] ?? level1;

  const byAction = new Map<CostAction, { monthly: number; count: number }>();
  let exceptionMonthly = 0;
  let achievableMonthly = 0;

  for (const p of patterns) {
    const monthly = p.costPerWindow * monthlyFactor;
    const svc = (p.service ?? '').toLowerCase();

    if (svc && exceptionSet.has(svc)) {
      exceptionMonthly += monthly;
      const slot = byAction.get('pass') ?? { monthly: 0, count: 0 };
      slot.monthly += monthly;
      slot.count += 1;
      byAction.set('pass', slot);
      continue;
    }

    // Map the enricher's recommendation onto the destination's
    // hierarchy. ERROR-class rows stay pass (keep). High-volume
    // info-class rows use level-1; medium-volume sample rows degrade
    // to level-2 when level-2 exists (e.g. Splunk: sample becomes
    // compact rather than offload, since envelope-compact preserves
    // the sample's signal at lower cost). Without level-2 the
    // enricher's verdict (mute/sample) drives the coefficient.
    const refined = p.poc.refinedAction ?? p.recommendedAction;
    let action: CostAction;
    if (refined === 'fix' || refined === 'blocked' || refined === 'keep') {
      action = 'pass';
    } else if (refined === 'mute') {
      // Mute maps onto the destination's preferred lever — drop the
      // bytes via tier_down (Datadog Flex), offload (Splunk S3),
      // compact (ClickHouse), or drop (no destination-side option).
      action = level1;
    } else if (refined === 'sample') {
      // Sample keeps a slice. When the destination has a cheaper-tier
      // option (compact / tier_down), prefer that over a flat sample.
      action = level2 !== 'offload' && level2 !== 'drop' ? level2 : 'sample';
    } else {
      action = level1;
    }

    const coefficient = reductionCoefficient(action);
    achievableMonthly += monthly * coefficient;

    const slot = byAction.get(action) ?? { monthly: 0, count: 0 };
    slot.monthly += monthly;
    slot.count += 1;
    byAction.set(action, slot);
  }

  const maxAchievablePercent = totalMonthlyCostUsd > 0
    ? Math.min(100, Math.max(0, (achievableMonthly / totalMonthlyCostUsd) * 100))
    : 0;
  const feasible = maxAchievablePercent >= targetPercent;

  const achievableByAction = Array.from(byAction.entries())
    .map(([action, agg]) => ({
      action,
      monthly_cost_usd: dollars(agg.monthly),
      pattern_count: agg.count,
    }))
    .sort((a, b) => b.monthly_cost_usd - a.monthly_cost_usd);

  const reasonParts: string[] = [];
  reasonParts.push(
    `Total monthly cost $${dollars(totalMonthlyCostUsd).toFixed(2)} across ${patterns.length} patterns.`,
  );
  reasonParts.push(
    `Level-1 action on ${siem} is \`${level1}\`${level2 !== level1 ? ` (level-2: \`${level2}\`)` : ''}.`,
  );
  if (exceptionServices.length > 0) {
    reasonParts.push(
      `${exceptionServices.length} exception service(s) pinned to pass, removing $${dollars(exceptionMonthly).toFixed(2)}/mo from the achievable pool.`,
    );
  }
  reasonParts.push(
    feasible
      ? `Achievable ${maxAchievablePercent.toFixed(1)}% meets target ${targetPercent}%.`
      : `Achievable ${maxAchievablePercent.toFixed(1)}% short of target ${targetPercent}%; widen exceptions or raise destination tier coverage.`,
  );

  return {
    feasible,
    target_percent_reduction: targetPercent,
    max_achievable_percent: ratio(maxAchievablePercent),
    reason: reasonParts.join(' '),
    achievable_by_action: achievableByAction,
    exception_services: exceptionServices,
    exception_monthly_cost_usd: dollars(exceptionMonthly),
  };
}

function reductionCoefficient(action: CostAction): number {
  switch (action) {
    case 'drop': return 1.0;
    case 'offload': return 1.0;
    case 'compact': return 0.7;
    case 'tier_down': return 0.6;
    case 'sample': return 0.9;
    case 'pass': return 0.0;
  }
}

/**
 * Pre-deploy commitment artifact. Renders the verdict + per-action
 * breakdown + exceptions + next-step recommendation as one paste-ready
 * markdown block the agent can show the buyer alongside the verdict.
 * Item 4 will attach the cap CSV; this stub commits to the shape so
 * the artifact is already a stable contract surface.
 */
function buildCommitmentArtifact(
  f: FeasibilityVerdict,
  input: RenderInput,
  monthlyCostUsd: number,
): CommitmentArtifact {
  const lines: string[] = [];
  lines.push(`## Projected commitment — ${input.siem} (${input.window} sample)`);
  lines.push('');
  lines.push(`- **Target reduction**: ${f.target_percent_reduction}%`);
  lines.push(
    `- **Projected max achievable**: ${f.max_achievable_percent.toFixed(1)}% (${f.feasible ? 'feasible' : 'short of target'})`,
  );
  lines.push(
    `- **Sample monthly cost analyzed**: $${dollars(monthlyCostUsd).toFixed(2)}`,
  );
  lines.push('');
  lines.push('### Per-action breakdown');
  lines.push('');
  lines.push('| Action | Patterns | Monthly cost in pool ($) |');
  lines.push('|---|---|---|');
  for (const row of f.achievable_by_action) {
    lines.push(
      `| \`${row.action}\` | ${row.pattern_count} | $${row.monthly_cost_usd.toFixed(2)} |`,
    );
  }
  lines.push('');
  if (f.exception_services.length > 0) {
    lines.push('### Exception services (stay in SIEM, full retention)');
    lines.push('');
    for (const svc of f.exception_services) lines.push(`- \`${svc}\``);
    lines.push('');
    lines.push(
      `_Removed $${f.exception_monthly_cost_usd.toFixed(2)}/mo from the achievable pool._`,
    );
    lines.push('');
  }
  lines.push('### Next step');
  lines.push('');
  if (f.feasible) {
    lines.push(
      '1. Run `log10x_advise_install` to provision the Receiver in your forwarder pipeline.',
    );
    lines.push(
      '2. Run `log10x_configure_engine` to author the per-pattern action plan (cap CSV) that delivers the commitment.',
    );
    lines.push('');
    lines.push(
      '_This is a PRE-DEPLOY projection from a SIEM sample. Actual commitment requires Receiver deployment and per-pattern verification metrics over a 7-14 day baseline window._',
    );
  } else {
    lines.push(
      '1. Either lower `target_percent_reduction` to within the achievable band, or',
    );
    lines.push(
      '2. Trim `exception_services` (each exception subtracts from the achievable pool), or',
    );
    lines.push(
      '3. Pair the deployment with a destination-tier upgrade (e.g. ClickHouse compact, Splunk S3 offload) that unlocks a higher-coverage action than the current level-1.',
    );
  }
  return {
    markdown: lines.join('\n'),
    next_step: f.feasible
      ? {
          tool: 'log10x_advise_install',
          reason: 'feasibility passes; provision Receiver then author the per-pattern action plan',
        }
      : {
          tool: 'log10x_configure_engine',
          reason: 'target exceeds achievable; preview the action plan to negotiate target or exceptions',
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
  // Total templater bytes — used to apportion the total monthly cost
  // (which is scaled from rawIngestBytes when available) by each
  // service's share of templater bytes. Without this apportionment,
  // each service's cost is computed only from its templater bytes,
  // which sums to ~$0.65/mo while the envelope's top-level total
  // shows $3.13/mo (rawIngestBytes-based). The mismatch caused every
  // service except the dominant one to round below $0.005 -> $0.
  const totalServiceBytes = Array.from(serviceMap.values()).reduce((s, a) => s + a.bytes, 0);
  const byService: ServiceAggregate[] = [];
  for (const [service, agg] of serviceMap) {
    // Each service's share of total templater bytes, applied to the
    // calibrated total monthly cost. Sums to totalMonthlyCostUsd.
    const shareOfBytes = totalServiceBytes > 0 ? agg.bytes / totalServiceBytes : 0;
    const monthlyCost = totalMonthlyCostUsd * shareOfBytes;
    byService.push({
      service,
      monthly_cost_usd: dollars(monthlyCost),
      pattern_count: agg.count,
      top_pattern_index: agg.topPatternIndex,
      approx_bytes_per_sec: bps(agg.bytes / Math.max(1, windowDurationSeconds)),
      share_of_total: ratio(shareOfBytes),
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

// Cap is denominated in bytes per 4-minute reset window — the same
// units configure_engine writes into the cap-CSV row. Eight windows per
// hour × 24 × 30 = 5760 windows per month.
const WINDOWS_PER_MONTH = 5760;

/**
 * Map per-pattern recommendation to one of the 6 actions using the
 * destination's level-1/2 default action and the head-concentration
 * heuristic (item-2's DEFAULT_ACTION_BY_DESTINATION + this function).
 *
 * The mapping rules:
 *   - error / audit / floor-pinned    → pass
 *   - high-volume info ("hot loop")   → destination level-1 action
 *   - moderate-volume info            → sample (level-2 if cheaper)
 *   - low-volume / WARN               → pass
 *
 * Sample defaults to N=10 (matches the cost-lib default and the value
 * configure_engine uses).
 */
function buildActions(
  p: { service?: string; severity?: string; template: string; symbolMessage?: string; identity: string; recommendedAction: string; sampleRate: number; poc: PocEnrichment; pctOfTotal: number; bytes: number },
  siem: SiemId,
  monthlyCost: number,
  _windowDurationSeconds: number,
): PatternActions {
  const allowed = getAllowedActionsForDestination(siem);
  const level1: CostAction = allowed[0] ?? getDefaultActionForDestination(siem, 1);
  const level2: CostAction = allowed[1] ?? level1;

  const sev = (p.severity || '').toUpperCase();
  const isError = /ERROR|CRIT|FATAL/.test(sev);
  const isHotLoop = p.pctOfTotal >= 0.02;
  const isFrequent = p.pctOfTotal >= 0.01;
  const refined = p.poc.refinedAction ?? p.recommendedAction;

  // 1) Map refined verdict + head-concentration into the 6-action vocab.
  let action: CostAction;
  let reason: string;
  let sampleN: number | null = null;

  if (refined === 'fix' || refined === 'blocked' || refined === 'keep' || isError) {
    action = 'pass';
    reason = isError
      ? `severity=${sev || 'error-class'} kept for incident diagnosis.`
      : refined === 'blocked'
        ? 'dependency_check found references; cannot reduce safely.'
        : refined === 'fix'
          ? 'recommended fix at source; engine pass until commit lands.'
          : 'low volume or non-actionable signal — pass.';
  } else if (refined === 'mute') {
    // Mute = lean on the destination's preferred lever.
    action = level1;
    reason = isHotLoop
      ? `high-volume ${sev || 'info-class'} pattern (${(p.pctOfTotal * 100).toFixed(1)}% of analyzed volume) — level-1 action \`${level1}\` on ${siem}.`
      : `${sev || 'info-class'} pattern routed to destination level-1 action \`${level1}\`.`;
  } else if (refined === 'sample') {
    // Sample = use cheap level-2 tier when it's better than a flat
    // sample-keep on this destination; otherwise stay on sample.
    if (isFrequent && (level2 === 'compact' || level2 === 'tier_down')) {
      action = level2;
      reason = `moderate-volume ${sev || 'info-class'} pattern — destination level-2 \`${level2}\` is cheaper than a flat sample on ${siem}.`;
    } else {
      action = 'sample';
      sampleN = Math.max(2, Math.round(p.sampleRate ?? 10));
      reason = `moderate-volume ${sev || 'info-class'} pattern — keep 1/${sampleN} to retain signal at lower cost.`;
    }
  } else {
    action = 'pass';
    reason = 'no qualifying reduction signal — pass.';
  }

  // 2) Project savings from the action coefficient (matches feasibility).
  const expectedSavings = monthlyCost * reductionCoefficient(action) * (action === 'sample' && sampleN ? (1 - 1 / sampleN) / 0.9 : 1);

  // 3) Cap bytes per 4-minute reset window. Matches the math in
  // configure-engine.ts:computeCapBytesPerWindow so configure_engine
  // can read this directly from the snapshot's cap_csv without
  // re-deriving the cap.
  const monthlyBytes = (p as unknown as { bytes: number }).bytes * (24 * 30) / Math.max(0.001, _windowDurationSeconds / 3600);
  const cap = capBytesPerWindow(action, monthlyBytes, sampleN ?? 10);

  return {
    recommended_action: action,
    reason,
    expected_savings_usd_per_month: dollars(expectedSavings),
    sample_n: sampleN,
    cap_bytes_per_window: Math.round(cap),
  };
}

/**
 * Mirror of configure-engine.ts:computeCapBytesPerWindow. Same
 * coefficients per action so a POC-emitted cap_csv lands at identical
 * bytes when configure_engine writes one for the same pattern.
 */
function capBytesPerWindow(action: CostAction, monthlyBytes: number, sampleN: number): number {
  const perWindow = monthlyBytes / WINDOWS_PER_MONTH;
  switch (action) {
    case 'pass':
      return Math.max(1, perWindow);
    case 'sample':
      return Math.max(1, perWindow / Math.max(1, sampleN));
    case 'compact':
      return Math.max(1, perWindow * 0.15);
    case 'tier_down':
      return Math.max(1, perWindow);
    case 'offload':
    case 'drop':
    default:
      return 0;
  }
}

/**
 * Compose the cap-CSV body that `configure_engine(from_poc_id=...)`
 * reads verbatim. Same row format as `renderCsvDiff` in
 * configure-engine.ts:
 *
 *   container,cap                                       ← header
 *   <container>,<bytes>::<reason>:<action>              ← container default
 *   pat:<tenx_hash>,<bytes>::<reason>:<action>          ← per-pattern row
 *
 * Container-level rows are emitted one per distinct service observed
 * across the top-N patterns. The default action is the destination's
 * level-1 action (per DEFAULT_ACTION_BY_DESTINATION); exception
 * services get `pass`. Per-pattern rows are emitted for every top-N
 * pattern whose recommendation differs from the container default OR
 * whose service is in the exception list — pinning rows so the engine
 * keeps them flowing untouched.
 */
function buildCapCsv(
  patterns: PatternOutput[],
  siem: SiemId,
  exceptionSet: Set<string>,
  windowDurationSeconds: number,
): string {
  const level1: CostAction = getDefaultActionForDestination(siem, 1);
  const services = new Map<string, { bytes: number; isException: boolean }>();
  for (const p of patterns) {
    const svc = (p.service ?? '').toLowerCase();
    if (!svc) continue;
    const existing = services.get(svc);
    if (existing) {
      existing.bytes += p.metrics.bytes_in_window;
    } else {
      services.set(svc, { bytes: p.metrics.bytes_in_window, isException: exceptionSet.has(svc) });
    }
  }

  const lines: string[] = ['container,cap'];
  // Container-default rows — one per service, sorted for stable diffs.
  for (const [svc, agg] of [...services.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const action: CostAction = agg.isException ? 'pass' : level1;
    const reason = agg.isException
      ? 'service_pinned_by_exception_list'
      : `MCP poc_envelope (destination_level_1=${level1})`;
    const monthlyBytes = agg.bytes * (24 * 30) / Math.max(0.001, windowDurationSeconds / 3600);
    const cap = Math.round(capBytesPerWindow(action, monthlyBytes, 10));
    lines.push(`${svc},${cap}::${reason.replace(/,/g, ';')}:${action}`);
  }
  // Per-pattern overrides — emitted when the action differs from the
  // container default OR when the row is exception-pinned. Sorted by
  // pattern_hash so the CSV is reproducible across builds.
  const overrides: Array<{ hash: string; line: string }> = [];
  for (const p of patterns) {
    if (!p.fingerprint_hash) continue;
    const svc = (p.service ?? '').toLowerCase();
    const isException = svc && exceptionSet.has(svc);
    const containerAction: CostAction = isException ? 'pass' : level1;
    if (p.actions.recommended_action === containerAction && !isException) continue;
    overrides.push({
      hash: p.fingerprint_hash,
      line: `pat:${p.fingerprint_hash},${p.actions.cap_bytes_per_window}::${p.actions.reason.replace(/,/g, ';')}:${p.actions.recommended_action}`,
    });
  }
  overrides.sort((a, b) => a.hash.localeCompare(b.hash));
  for (const o of overrides) lines.push(o.line);
  return lines.join('\n') + '\n';
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
