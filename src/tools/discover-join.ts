/**
 * log10x_discover_join — auto-discover the join label between Log10x
 * pattern metrics and the customer metric backend via Jaccard similarity
 * on label value sets.
 *
 * This tool runs the Jaccard pass across every candidate label pair and
 * returns the best match above the 0.7 floor, plus runner-ups above 0.5.
 *
 * Cached per-session per (environment, customer-backend-endpoint) so
 * the cross-pillar primitives (metrics_that_moved, rank_by_shape_similarity,
 * metric_overlay) can auto-call this once at the start of a session and
 * never re-probe.
 *
 * Agents should normally NOT need to call this tool directly — the
 * cross-pillar primitives run it internally via the session cache.
 * The explicit tool exists for power users who want to inspect the join
 * universe before correlating, or to force a re-discovery.
 *
 * Tier prerequisites: LOG10X_CUSTOMER_METRICS_URL configured.
 * This tool issues up to ~12 PromQL queries (6 Log10x-side label value
 * fetches + 6 customer-side). Results are cached per session.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import {
  resolveBackend,
  formatDetectionTrace,
  customerMetricsNotConfiguredMessage,
} from '../lib/customer-metrics.js';
import { getOrDiscoverJoin, discoverJoin, type JoinPair } from '../lib/join-discovery.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { newChassisTelemetry, buildChassisEnvelope } from '../lib/chassis-envelope.js';

export const discoverJoinSchema = {
  force_refresh: z
    .boolean()
    .default(false)
    .describe('When true, bypass the session cache and re-run the Jaccard pass against the live backends.'),
  minimum_jaccard: z
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe('Minimum Jaccard similarity to accept as a primary join. Default 0.7. Lower to 0.5 for exploratory discovery, 0.3 for noisy environments with historical stale values.'),
  candidate_labels: z
    .array(z.string())
    .optional()
    .describe('Optional subset of customer-side labels to probe. When omitted, all labels from the customer backend are probed in preferred-first order.'),
  window: z
    .string()
    .optional()
    .describe(
      'Time window for label value enumeration (e.g., "10m", "1h", "30m"). When set, both the Log10x and customer backends are queried with [now - window, now] filtering, excluding stale label values from series that stopped emitting samples. CRITICAL for environments with historical replay data, decommissioned pods, or otherwise orphan label values — stale values drag Jaccard down and cause false `no_join_available` refusals. Recommended: "10m" for steady-state clusters, "1h" for bursty traffic. Omit to include all-time values (default Prometheus behavior). Alias: `timeRange`.'
    ),
  timeRange: z
    .string()
    .optional()
    .describe('Alias for `window` for consistency with other Log10x tools.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

interface DiscoverJoinPayload {
  /** Tool-specific join status — distinct from chassis status. */
  join_status: 'joined' | 'no_join_available' | 'not_configured' | 'no_label_universe';
  /**
   * Machine-readable reason for join failures.
   * Populated when join_status is 'no_label_universe' or 'no_join_available'.
   */
  failure_reason?: 'customer_side_empty' | 'log10x_side_empty' | 'below_threshold';
  backend?: string;
  endpoint?: string;
  cached: boolean;
  window_seconds?: number;
  labels_probed_log10x: string[];
  labels_probed_customer: string[];
  join_key?: { log10x_side: string; customer_side: string; jaccard: number; shared_values: number; log10x_only_values: number; customer_only_values: number };
  runner_ups: Array<{ log10x_side: string; customer_side: string; jaccard: number; shared_values: number; log10x_only_values: number; customer_only_values: number }>;
  top_below_threshold: Array<{ log10x_side: string; customer_side: string; jaccard: number; shared_values: number; log10x_only_values: number; customer_only_values: number }>;
}

export async function executeDiscoverJoin(
  args: {
    force_refresh?: boolean;
    minimum_jaccard?: number;
    candidate_labels?: string[];
    window?: string;
    timeRange?: string;
    environment?: string;
  },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const telemetry = newChassisTelemetry();
  args.force_refresh = args.force_refresh ?? false;
  args.minimum_jaccard = args.minimum_jaccard ?? 0.7;
  const resolution = await resolveBackend();
  if (!resolution.backend) {
    void customerMetricsNotConfiguredMessage(formatDetectionTrace(resolution.trace));
    return buildChassisEnvelope({
      tool: 'log10x_discover_join',
      view: 'summary',
      headline: 'Customer metrics backend not configured — discover_join cannot run.',
      status: 'error',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: { label_source: 'customer_prom' },
      scope: {
        window: 'all',
        window_basis: 'auto_default',
        candidates_count: 0,
        candidates_usable: 0,
      },
      payload: {
        join_status: 'not_configured',
        cached: false,
        labels_probed_log10x: [],
        labels_probed_customer: [],
        runner_ups: [],
        top_below_threshold: [],
      } satisfies DiscoverJoinPayload,
      human_summary: 'Customer metrics backend not configured — discover_join cannot run.',
      error: {
        error_type: 'config_missing',
        retryable: false,
        suggested_backoff_ms: null,
        hint: 'LOG10X_CUSTOMER_METRICS_URL is not set. Configure the customer metrics backend first.',
      },
      telemetry,
    });
  }
  const backend = resolution.backend;

  const effectiveWindow = args.window ?? args.timeRange;
  const windowSeconds = effectiveWindow ? parseWindowToSeconds(effectiveWindow) : undefined;
  const bypass = args.force_refresh || windowSeconds != null;
  const opts = {
    minimumJaccard: args.minimum_jaccard,
    candidateLabels: args.candidate_labels,
    windowSeconds,
  };
  const result = bypass
    ? await discoverJoin(env, backend, opts)
    : await getOrDiscoverJoin(env, backend, opts);

  // Empty-universe check: if either side returned zero labels, there is nothing
  // to probe and the threshold-miss message would be misleading. Return a
  // dedicated status so callers can distinguish "backend returned no labels"
  // from "labels existed but no pair crossed Jaccard".
  const log10xEmpty   = result.probedLabelsLog10x.length   === 0;
  const customerEmpty = result.probedLabelsCustomer.length === 0;
  if ((log10xEmpty || customerEmpty) && result.status !== 'joined') {
    const failureReason: 'customer_side_empty' | 'log10x_side_empty' =
      customerEmpty ? 'customer_side_empty' : 'log10x_side_empty';
    const emptyPayload: DiscoverJoinPayload = {
      join_status: 'no_label_universe',
      failure_reason: failureReason,
      backend: backend.backendType,
      endpoint: backend.endpoint,
      cached: result.cachedForSession,
      window_seconds: windowSeconds,
      labels_probed_log10x: result.probedLabelsLog10x,
      labels_probed_customer: result.probedLabelsCustomer,
      runner_ups: [],
      top_below_threshold: [],
    };
    const side = customerEmpty ? 'Customer-side' : 'Log10x-side';
    const emptyHeadline =
      `${side} metrics backend returned 0 labels — cross-pillar join cannot be computed. ` +
      `Verify ${customerEmpty ? 'customer_metrics_backend is configured and reaching a Prometheus with data' : 'the Log10x reporter is emitting metrics'}.`;
    const emptyHumanSummary =
      `${side} label universe is empty (0 labels returned). ` +
      `Cross-pillar join requires at least one label on each side. ` +
      `${customerEmpty ? 'Check that LOG10X_CUSTOMER_METRICS_URL points to a Prometheus instance with active series.' : 'Check that the Log10x reporter is running and emitting all_events_* metrics.'}`;
    return buildChassisEnvelope({
      tool: 'log10x_discover_join',
      view: 'summary',
      headline: emptyHeadline,
      status: 'no_signal',
      decisions: { threshold_used: args.minimum_jaccard, threshold_basis: 'customer_supplied' },
      source_disclosure: { label_source: 'log10x_prom', siem_vendor: backend.backendType },
      scope: {
        window: effectiveWindow ?? 'all',
        window_basis: effectiveWindow ? 'explicit' : 'auto_default',
        candidates_count: 0,
        candidates_usable: 0,
      },
      payload: emptyPayload,
      human_summary: emptyHumanSummary,
      actions: [
        { tool: 'log10x_customer_metrics_query', args: {}, reason: 'inspect the customer metrics backend label universe directly to diagnose the empty-label condition' },
      ],
      telemetry,
    });
  }

  const payload: DiscoverJoinPayload = {
    join_status: result.status === 'joined' ? 'joined' : 'no_join_available',
    failure_reason: result.status === 'no_join_available' ? 'below_threshold' : undefined,
    backend: backend.backendType,
    endpoint: backend.endpoint,
    cached: result.cachedForSession,
    window_seconds: windowSeconds,
    labels_probed_log10x: result.probedLabelsLog10x,
    labels_probed_customer: result.probedLabelsCustomer,
    join_key: result.joinKey ? joinPairToData(result.joinKey) : undefined,
    runner_ups: result.runnerUps.map(joinPairToData),
    top_below_threshold: result.status === 'no_join_available' ? result.probed.slice(0, 8).map(joinPairToData) : [],
  };

  const humanSummary = buildHumanSummary(payload, args.minimum_jaccard);
  const headline = payload.join_key
    ? `Join key: ${payload.join_key.log10x_side} ↔ ${payload.join_key.customer_side} (Jaccard ${payload.join_key.jaccard.toFixed(3)}, ${payload.runner_ups.length} runner-up${payload.runner_ups.length !== 1 ? 's' : ''}).`
    : `No join pair above Jaccard ${args.minimum_jaccard}. Cross-pillar primitives refuse for anchors that need a structural join.`;

  const totalProbed = result.probedLabelsLog10x.length + result.probedLabelsCustomer.length;

  return buildChassisEnvelope({
    tool: 'log10x_discover_join',
    view: 'summary',
    headline,
    status: payload.join_status === 'joined' ? 'success' : 'no_signal',
    decisions: {
      threshold_used: args.minimum_jaccard,
      threshold_basis: 'customer_supplied',
    },
    source_disclosure: {
      label_source: 'log10x_prom',
      siem_vendor: backend.backendType,
    },
    scope: {
      window: effectiveWindow ?? 'all',
      window_basis: effectiveWindow ? 'explicit' : 'auto_default',
      candidates_count: totalProbed,
      candidates_usable: totalProbed,
    },
    payload,
    human_summary: humanSummary,
    actions: payload.join_key
      ? [
          { tool: 'log10x_metrics_that_moved', args: {}, reason: 'first composition step: anchor a Log10x pattern, filter candidate customer metrics that actually moved with it' },
          { tool: 'log10x_rank_by_shape_similarity', args: {}, reason: 'second step on the filtered candidates: Pearson + signed lag, no tier framing' },
          { tool: 'log10x_metric_overlay', args: {}, reason: 'third step: aligned anchor+candidate timeseries for the agent to interpret' },
        ]
      : [
          { tool: 'log10x_customer_metrics_query', args: {}, reason: 'explore the customer backend label universe to find a natural join dimension' },
        ],
    telemetry,
  });
}

function joinPairToData(p: JoinPair) {
  return {
    log10x_side: p.log10xSide,
    customer_side: p.customerSide,
    jaccard: p.jaccard,
    shared_values: p.sharedValues,
    log10x_only_values: p.log10xOnlyValues,
    customer_only_values: p.customerOnlyValues,
  };
}

/** Parse a Prometheus-style window string ("10m", "1h", "30s") to seconds. */
function parseWindowToSeconds(s: string): number {
  const m = s.trim().match(/^(\d+)([smhdw])$/);
  // KEEP (schema-violation): freeform string the Zod layer cannot pre-validate.
  if (!m) throw new Error(`Invalid window: "${s}". Expected format like "10m", "1h", "30s", "2d".`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return n * unitSeconds[unit];
}

function buildHumanSummary(payload: DiscoverJoinPayload, minimumJaccard: number): string {
  if (payload.join_status === 'joined' && payload.join_key) {
    const jk = payload.join_key;
    const runners = payload.runner_ups.length;
    return `Found a join key: log10x label \`${jk.log10x_side}\` matches customer label \`${jk.customer_side}\` at Jaccard ${jk.jaccard.toFixed(3)} (${jk.shared_values} shared values). ${runners} runner-up${runners !== 1 ? 's' : ''} above 0.5. Cross-pillar primitives will reuse this join automatically.`;
  }
  const probed = payload.top_below_threshold.length;
  const best = probed > 0 ? payload.top_below_threshold[0] : undefined;
  const bestHint = best
    ? ` Best below-threshold pair: \`${best.log10x_side}\` ↔ \`${best.customer_side}\` at Jaccard ${best.jaccard.toFixed(3)}.`
    : ' No label pairs were probed; one side returned an empty label universe.';
  return `No label pair reached the Jaccard ${minimumJaccard} threshold across ${payload.labels_probed_log10x.length} log10x-side and ${payload.labels_probed_customer.length} customer-side labels.${bestHint} Cross-pillar correlation cannot proceed for anchors that need a structural join.`;
}
