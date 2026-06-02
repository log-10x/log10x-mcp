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
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import type { PrimitiveError } from '../lib/primitive-errors.js';

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
   * Empirical distribution of the dominant-value percentage across ALL
   * candidate slots evaluated (before filtering by min_concentration).
   * Lets the agent see "floor 0.60 vs observed p50 0.30 — floor is well
   * above typical noise" vs "floor 0.60 vs observed p50 0.85 — almost
   * every slot is dominated by one value; floor is too low for this
   * dataset."
   */
  observed_dominant_pct_distribution: Distribution | null;
  /** Number of candidate slots evaluated (i.e. denominator for the distribution). */
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

  // ── Empirical observed-distribution: scan every pattern's slots ────
  // BEFORE the threshold filter, so the agent can see the noise floor.
  const observed: number[] = [];
  let nCandidateSlots = 0;
  let nPatternsAboveMinEvents = 0;
  for (const p of extraction.patterns) {
    const count = (p as { count?: number }).count ?? 0;
    if (count < minEvents) continue;
    nPatternsAboveMinEvents += 1;
    const slots = (p as { slotDistribution?: Array<{ dominantPct?: number }> }).slotDistribution ?? [];
    for (const s of slots) {
      if (typeof s.dominantPct === 'number' && Number.isFinite(s.dominantPct)) {
        observed.push(s.dominantPct);
        nCandidateSlots += 1;
      }
    }
  }
  const observedDistribution = distribute(observed);

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
  };

  const headline =
    status === 'success'
      ? `${findings.length} skew finding${findings.length === 1 ? '' : 's'} (floor ${(minConcentration * 100).toFixed(0)}%${thresholdBasis === 'unvalidated_default' ? ', unvalidated' : ''}). Top: \`${findings[0]!.patternIdentity}\` slot \`${findings[0]!.skewedSlots[0]!.slotName}\` is \`${findings[0]!.skewedSlots[0]!.dominantValue}\` ${Math.round(findings[0]!.skewedSlots[0]!.dominantPct * 100)}% of events.`
      : status === 'no_signal'
        ? `No slot crossed the ${(minConcentration * 100).toFixed(0)}% concentration floor. ${nPatternsAboveMinEvents} pattern(s) evaluated.`
        : status === 'insufficient_data'
          ? `Insufficient data — no pattern had ≥${minEvents} events after templating.`
          : `Error: ${data.error?.error_type ?? 'unknown'}.`;

  return buildEnvelope({
    tool: 'log10x_find_skew',
    view: 'summary',
    summary: {
      headline,
      bullets: findings.slice(0, 3).map((f) => {
        const top = f.skewedSlots[0]!;
        return `\`${f.patternIdentity}\`: slot \`${top.slotName}\` is \`${top.dominantValue}\` ${Math.round(top.dominantPct * 100)}% of events — sample at 1/${sampleN} saves ~${Math.round(f.samplingOpportunityPct * 100)}% of bytes.`;
      }),
    },
    data,
    truncated: findings.length >= topN,
    actions: findings.slice(0, 3).map((f) => ({
      tool: 'log10x_pattern_mitigate',
      args: { pattern: f.patternIdentity },
      reason: `Apply sample 1/${sampleN} on the dominant value for this pattern.`,
    })),
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
  return buildEnvelope({
    tool: 'log10x_find_skew',
    view: 'summary',
    summary: { headline: `Error (${args.err.error_type}): ${args.err.hint.slice(0, 120)}` },
    data,
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
}): string {
  const floorPct = (args.minConcentration * 100).toFixed(0);
  const observedFragment =
    args.observedDistribution !== null
      ? ` Observed median dominant-value share across candidate slots: ${(args.observedDistribution.p50 * 100).toFixed(0)}% (p75 ${(args.observedDistribution.p75 * 100).toFixed(0)}%).`
      : '';
  const calibTag =
    args.thresholdBasis === 'unvalidated_default'
      ? ' Floor is an unvalidated default — compare against the observed distribution before treating the count as authoritative.'
      : '';
  if (args.status === 'insufficient_data') {
    return `find_skew analyzed ${args.nEvents} event(s) but no pattern had ≥${args.findings.length > 0 ? args.findings[0]!.totalEvents : 'min_events'} events after templating. Paste more events for the same patterns OR widen the source.${calibTag}`;
  }
  if (args.status === 'no_signal') {
    return `No slot crossed the ${floorPct}% concentration floor across ${args.nPatternsAboveMinEvents} pattern(s) evaluated.${observedFragment} ${args.thresholdBasis === 'unvalidated_default' ? 'The floor may be too strict for this dataset (compare with the observed distribution), or there is genuinely no skew to exploit here.' : 'No skew exists at this calibrated floor.'}`;
  }
  const top = args.findings[0];
  const topNote = top
    ? ` Top finding: \`${top.patternIdentity}\` slot \`${top.skewedSlots[0]!.slotName}\` is \`${top.skewedSlots[0]!.dominantValue}\` ${Math.round(top.skewedSlots[0]!.dominantPct * 100)}% of events; sampling that case at 1/${args.sampleN} would save ~${Math.round(top.samplingOpportunityPct * 100)}% of this pattern's bytes.`
    : '';
  return `${args.findings.length} pattern(s) showed slot skew above the ${floorPct}% concentration floor across ${args.nPatternsAboveMinEvents} evaluated.${topNote}${observedFragment}${calibTag}`;
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
