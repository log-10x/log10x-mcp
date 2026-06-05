/**
 * log10x_find_skew — surfaces patterns where one slot value dominates
 * (sampling opportunity).
 *
 * Stage 1 implementation: accepts an `events` paste (the same shape as
 * `log10x_resolve_batch`) and runs the local templater + skew detector.
 * Env-mode auto-pull (query customer TSDB for top patterns, fetch sample
 * events, run detector) is a follow-up feature in Stage 2.
 *
 * Pre-launch GA-track audit (2026-05-28): unified envelope with status,
 * threshold_basis, threshold_audit, structured errors, observation-vs-
 * floor disclosure. The math (concentration percentage) is deterministic.
 * The agent is honest about the floor being unvalidated.
 */

import { z } from 'zod';
import { extractPatterns } from '../lib/pattern-extraction.js';
import { findSkew, type SkewFinding } from '../lib/detectors/skew.js';
import { aggregateSlotsBySymbolMessage } from '../lib/detectors/slot-aggregation.js';
import { type StructuredOutput } from '../lib/output-types.js';
import type { PrimitiveError } from '../lib/primitive-errors.js';
import { buildChassisEnvelope } from '../lib/chassis-envelope.js';
import { sanitizeUserProse } from '../lib/anti-jargon-prose.js';

/** Default minimum dominant-value fraction. Hand-picked, unvalidated. */
export const DEFAULT_MIN_CONCENTRATION = 0.6;
/** Default sampling rate for the savings projection. Hand-picked, unvalidated. */
export const DEFAULT_SAMPLE_N = 10;
/** Default minimum events per pattern to bother checking. */
export const DEFAULT_MIN_EVENTS = 10;

export const findSkewSchema = {
  events: z
    .array(z.unknown())
    .describe(
      'Events to analyze for slot skew. Same shape as log10x_resolve_batch — raw strings or JSON objects. Each event is templated locally; skew is computed across the resulting patterns.'
    ),
  min_concentration: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_MIN_CONCENTRATION)
    .describe(
      'Minimum dominant-value fraction for a slot to be flagged as skewed. Default 0.6 (a slot is "skewed" when one value is 60%+ of events). Hand-picked default tagged as `unvalidated_default` in the output. Compare against the `observed_dominant_pct_distribution` in `threshold_audit` to judge whether 0.6 is well above or below this dataset\'s noise.'
    ),
  top_n: z.number().min(1).max(50).default(20).describe('Number of findings to return. Default 20.'),
  min_events: z
    .number()
    .min(1)
    .default(DEFAULT_MIN_EVENTS)
    .describe('Minimum events per pattern to bother checking. Default 10 (filters low-sample noise).'),
  sample_n: z
    .number()
    .min(2)
    .default(DEFAULT_SAMPLE_N)
    .describe(
      'Sampling rate N for the savings projection (1/N of the dominant case kept). Default 10. Same calibration caveat — sample_n=10 is a defensible starting point but not validated for any specific cost target.'
    ),
  privacy_mode: z.boolean().default(false).describe('Route events through a locally-installed tenx CLI instead of the paste Lambda.'),
};

export type FindSkewArgs = {
  events: unknown[];
  min_concentration?: number;
  top_n?: number;
  min_events?: number;
  sample_n?: number;
  /** Ignored. Retained in the signature for backward-compat with
   * in-process callers; the markdown view was removed from the public
   * schema in favor of the structured `human_summary` field. */
  view?: 'summary' | 'markdown';
  privacy_mode?: boolean;
};

/**
 * Top-level call status. Agent branches on this before reading anything else.
 *   - `success`: candidates evaluated, ≥1 found above the concentration floor.
 *   - `no_signal`: candidates evaluated, NONE crossed the floor. Stop searching.
 *   - `insufficient_data`: not enough events to bother analyzing OR no
 *     pattern had ≥ min_events after templating.
 *   - `error`: structural failure (templater crash, input validation failed).
 */
export type FindSkewStatus = 'success' | 'no_signal' | 'insufficient_data' | 'error';

interface Distribution {
  n: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  max: number;
}

interface ThresholdAudit {
  min_concentration: {
    value: number;
    basis: 'unvalidated_default' | 'caller_override';
  };
  sample_n: {
    value: number;
    basis: 'unvalidated_default' | 'caller_override';
  };
  /**
   * Machine-side: empirical distribution of the dominant-value percentage
   * across ALL fields checked (before filtering by min_concentration).
   * The agent can branch on this to judge whether the configured minimum
   * dominance is well above or below the data's natural variation. Not
   * surfaced in user prose — statistics belong here, not in the headline
   * or human_summary.
   */
  observed_dominant_pct_distribution: Distribution | null;
  /** Number of fields checked (denominator for the distribution). */
  n_candidate_slots: number;
}

interface FindSkewSummary {
  status: FindSkewStatus;
  threshold_basis: 'unvalidated_default' | 'caller_override';
  threshold_audit: ThresholdAudit;
  input_ref: {
    n_events: number;
    n_patterns_after_templating: number;
    n_patterns_above_min_events: number;
  };
  query_count: 0;
  total_latency_ms: number;
  backend_pressure_hint: null;
  human_summary: string;
  findings: SkewFinding[];
  /**
   * Number of candidate slots that were filtered because distinctCount=1
   * (tautological dominance — the slot had only one value so 100% "dominance"
   * is meaningless). Exposed in the payload so callers can audit the filter.
   * Present only when > 0.
   */
  filtered_singleton_slots?: number;
  /** Populated only when `status === 'error'`. */
  error?: PrimitiveError;
}

export async function executeFindSkew(args: FindSkewArgs): Promise<StructuredOutput> {
  const startedAt = Date.now();
  const minConcentration = args.min_concentration ?? DEFAULT_MIN_CONCENTRATION;
  const sampleN = args.sample_n ?? DEFAULT_SAMPLE_N;
  const minEvents = args.min_events ?? DEFAULT_MIN_EVENTS;
  const topN = args.top_n ?? 20;
  const thresholdBasis: 'unvalidated_default' | 'caller_override' =
    minConcentration === DEFAULT_MIN_CONCENTRATION && sampleN === DEFAULT_SAMPLE_N
      ? 'unvalidated_default'
      : 'caller_override';

  // ── Input validation ───────────────────────────────────────────────
  if (!Array.isArray(args.events) || args.events.length === 0) {
    return errorEnvelope({
      thresholdBasis,
      minConcentration,
      sampleN,
      nEvents: 0,
      startedAt,
      err: {
        error_type: 'input_invalid',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'No events supplied. find_skew requires an array of events (raw strings or JSON objects).',
      },
    });
  }

  // ── Local templater pass ───────────────────────────────────────────
  let extraction: Awaited<ReturnType<typeof extractPatterns>>;
  try {
    extraction = await extractPatterns(args.events, { privacyMode: args.privacy_mode });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorEnvelope({
      thresholdBasis,
      minConcentration,
      sampleN,
      nEvents: args.events.length,
      startedAt,
      err: {
        error_type: /tenx|cli/i.test(msg) ? 'input_invalid' : 'local_processing_failed',
        retryable: false,
        suggested_backoff_ms: null,
        hint: msg.slice(0, 300),
      },
    });
  }

  const findings = findSkew(extraction.patterns, {
    minConcentration,
    topN,
    minEvents,
    sampleN,
  });

  // ── Empirical observed-distribution: scan every aggregated pattern's slots ────
  // BEFORE the threshold filter, so the agent can see the noise floor.
  // We call aggregateSlotsBySymbolMessage directly (same path findSkew uses
  // internally) so we read from AggregatedSlot.dominantPct — a field that
  // actually exists — instead of the non-existent ExtractedPattern.slotDistribution.
  const aggregated = aggregateSlotsBySymbolMessage(extraction.patterns, { minEvents });
  const observed: number[] = [];
  let nCandidateSlots = 0;
  let nPatternsAboveMinEvents = 0;
  for (const agg of aggregated) {
    nPatternsAboveMinEvents += 1;
    for (const s of agg.slots) {
      if (typeof s.dominantPct === 'number' && Number.isFinite(s.dominantPct)) {
        observed.push(s.dominantPct);
        nCandidateSlots += 1;
      }
    }
  }
  const observedDistribution = distribute(observed);

  // ── Count singleton slots filtered by DEFECT-100 guard ────────────
  // A slot with distinctCount=1 always reads as 100% dominant —
  // tautological, not exploitable skew. Count them here so callers
  // can audit how many were removed.
  let filteredSingletonSlots = 0;
  for (const agg of aggregated) {
    for (const s of agg.slots) {
      if (s.dominantPct >= minConcentration && s.distinctCount === 1) {
        filteredSingletonSlots += 1;
      }
    }
  }

  // ── Status determination ───────────────────────────────────────────
  let status: FindSkewStatus;
  if (nPatternsAboveMinEvents === 0) {
    status = 'insufficient_data';
  } else if (findings.length === 0) {
    status = 'no_signal';
  } else {
    status = 'success';
  }

  const human_summary = buildHumanSummary({
    status,
    findings,
    minConcentration,
    sampleN,
    thresholdBasis,
    observedDistribution,
    nEvents: args.events.length,
    nPatterns: extraction.patterns.length,
    nPatternsAboveMinEvents,
    filteredSingletonSlots,
  });

  const data: FindSkewSummary = {
    status,
    threshold_basis: thresholdBasis,
    threshold_audit: {
      min_concentration: { value: minConcentration, basis: thresholdBasis },
      sample_n: { value: sampleN, basis: thresholdBasis },
      observed_dominant_pct_distribution: observedDistribution,
      n_candidate_slots: nCandidateSlots,
    },
    input_ref: {
      n_events: args.events.length,
      n_patterns_after_templating: extraction.patterns.length,
      n_patterns_above_min_events: nPatternsAboveMinEvents,
    },
    query_count: 0,
    total_latency_ms: Date.now() - startedAt,
    backend_pressure_hint: null,
    human_summary,
    findings,
    ...(filteredSingletonSlots > 0 ? { filtered_singleton_slots: filteredSingletonSlots } : {}),
  };

  // ── Headline ───────────────────────────────────────────────────────
  // Lead with the finding. No raw statistics, no internal vocabulary.
  let headline: string;
  if (status === 'success') {
    const top = findings[0]!;
    const topSlot = top.skewedSlots[0]!;
    headline = sanitizeUserProse(
      `Found skew on field \`${topSlot.slotName}\` — value \`${topSlot.dominantValue}\` covers ${Math.round(topSlot.dominantPct * 100)}% of events in pattern \`${top.patternIdentity}\`.`,
    );
  } else if (status === 'no_signal') {
    headline = sanitizeUserProse(
      `No skew found across ${nPatternsAboveMinEvents} pattern(s) — try \`log10x_pattern_mitigate\` to compact or sample uniformly.`,
    );
  } else if (status === 'insufficient_data') {
    headline = sanitizeUserProse(
      `Not enough events to check for skew — no pattern had ≥${minEvents} events after extraction.`,
    );
  } else {
    headline = `Error: ${data.error?.error_type ?? 'unknown'}.`;
  }

  return buildChassisEnvelope({
    tool: 'log10x_find_skew',
    view: 'summary',
    headline,
    headline_bullets: findings.slice(0, 3).map((f) => {
      const top = f.skewedSlots[0]!;
      return sanitizeUserProse(
        `\`${f.patternIdentity}\`: field \`${top.slotName}\` is \`${top.dominantValue}\` ${Math.round(top.dominantPct * 100)}% of events — smart sampling at 1/${sampleN} saves ~${Math.round(f.samplingOpportunityPct * 100)}% of bytes.`,
      );
    }),
    status: status === 'success' ? 'success' : status === 'no_signal' ? 'no_signal' : status === 'insufficient_data' ? 'insufficient_data' : 'error',
    decisions: {
      threshold_used: minConcentration,
      threshold_basis: thresholdBasis === 'caller_override' ? 'customer_supplied' : thresholdBasis,
      threshold_audit: {
        value: minConcentration,
        basis: thresholdBasis,
        n_candidate_slots: nCandidateSlots,
        observed_distribution: observedDistribution ? {
          n: observedDistribution.n,
          min: observedDistribution.min,
          p25: observedDistribution.p25,
          p50: observedDistribution.p50,
          p75: observedDistribution.p75,
          max: observedDistribution.max,
        } : null,
      },
      ...(filteredSingletonSlots > 0 ? { filtered_singleton_slots: filteredSingletonSlots } : {}),
    },
    source_disclosure: {},
    scope: {
      window: 'paste_batch',
      window_basis: 'auto_default',
      candidates_count: nPatternsAboveMinEvents,
      candidates_usable: nPatternsAboveMinEvents,
    },
    payload: { ...data },
    human_summary: human_summary,
    truncated: findings.length >= topN,
    actions: findings.slice(0, 3).map((f) => ({
      tool: 'log10x_pattern_mitigate',
      args: { pattern: f.patternIdentity },
      reason: `Apply sample 1/${sampleN} on the dominant value for this pattern.`,
    })),
    ...(data.error ? { error: data.error } : {}),
  });
}

function errorEnvelope(args: {
  thresholdBasis: 'unvalidated_default' | 'caller_override';
  minConcentration: number;
  sampleN: number;
  nEvents: number;
  startedAt: number;
  err: PrimitiveError;
}): StructuredOutput {
  const data: FindSkewSummary = {
    status: 'error',
    threshold_basis: args.thresholdBasis,
    threshold_audit: {
      min_concentration: { value: args.minConcentration, basis: args.thresholdBasis },
      sample_n: { value: args.sampleN, basis: args.thresholdBasis },
      observed_dominant_pct_distribution: null,
      n_candidate_slots: 0,
    },
    input_ref: {
      n_events: args.nEvents,
      n_patterns_after_templating: 0,
      n_patterns_above_min_events: 0,
    },
    query_count: 0,
    total_latency_ms: Date.now() - args.startedAt,
    backend_pressure_hint: null,
    human_summary: `find_skew failed: ${args.err.hint}`,
    findings: [],
    error: args.err,
  };
  return buildChassisEnvelope({
    tool: 'log10x_find_skew',
    view: 'summary',
    headline: `Error (${args.err.error_type}): ${args.err.hint.slice(0, 120)}`,
    status: 'error',
    decisions: { threshold_used: args.minConcentration, threshold_basis: args.thresholdBasis === 'caller_override' ? 'customer_supplied' as const : args.thresholdBasis },
    source_disclosure: {},
    scope: { window: 'paste_batch', window_basis: 'auto_default' },
    payload: { ...data },
    human_summary: `find_skew failed: ${args.err.hint}`,
    error: args.err,
  });
}

function distribute(values: number[]): Distribution | null {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const at = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))];
  return {
    n,
    min: sorted[0],
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    max: sorted[n - 1],
  };
}

function buildHumanSummary(args: {
  status: FindSkewStatus;
  findings: SkewFinding[];
  minConcentration: number;
  sampleN: number;
  thresholdBasis: 'unvalidated_default' | 'caller_override';
  observedDistribution: Distribution | null;
  nEvents: number;
  nPatterns: number;
  nPatternsAboveMinEvents: number;
  filteredSingletonSlots?: number;
}): string {
  // Lead with the concept, then the finding, then the next action.
  // Statistics belong in machine fields (threshold_audit), not user prose.
  const concept = 'Skew = when one specific value dominates a field (e.g., 95% of events come from one user).';

  if (args.status === 'insufficient_data') {
    return sanitizeUserProse(
      `${concept} Not enough events to check — analyzed ${args.nEvents} event(s) and no pattern had ≥${args.findings.length > 0 ? args.findings[0]!.totalEvents : 'min_events'} events after extraction. Paste more events for the same patterns, or widen the source.`,
    );
  }

  if (args.status === 'no_signal') {
    return sanitizeUserProse(
      `${concept} No skew found: every field in this pattern has a single value, or no value dominates clearly enough to target. Smart-targeted sampling doesn't apply here. Better fit: compact the pattern or drop a percentage — run \`log10x_pattern_mitigate\` to see the options with cost impact.`,
    );
  }

  const top = args.findings[0];
  if (!top) {
    return sanitizeUserProse(`${concept} ${args.findings.length} pattern(s) showed skew. Run \`log10x_pattern_mitigate\` to apply smart sampling.`);
  }
  const slot = top.skewedSlots[0]!;
  const dominantPct = Math.round(slot.dominantPct * 100);
  return sanitizeUserProse(
    `${concept} Found skew on field \`${slot.slotName}\` in pattern \`${top.patternIdentity}\`: \`${slot.dominantValue}\` covers ${dominantPct}% of events. Worth investigating — could be a bot, a specific client, or a real issue concentrated on one entity. Smart sampling that keeps the unusual events is a good fit here — run \`log10x_pattern_mitigate\` for the configured action.`,
  );
}

function renderMarkdown(
  findings: SkewFinding[],
  args: FindSkewArgs,
  minConcentration: number,
): string {
  const lines: string[] = [];
  lines.push(`## Skew findings (min concentration ${minConcentration})`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('_No skewed slots found above the threshold._');
    return lines.join('\n');
  }
  lines.push('| pattern | top skewed slot | dominant value | dominant % | sampling opportunity (1/N) |');
  lines.push('|---|---|---|---|---|');
  for (const f of findings) {
    const slot = f.skewedSlots[0]!;
    lines.push(
      `| \`${f.patternIdentity}\` | \`${slot.slotName}\` | \`${slot.dominantValue}\` | ${Math.round(slot.dominantPct * 100)}% | ${Math.round(f.samplingOpportunityPct * 100)}% |`
    );
  }
  return lines.join('\n');
}
