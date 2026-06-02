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
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';

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

interface DiscoverJoinSummary {
  status: 'joined' | 'no_join_available' | 'not_configured';
  backend?: string;
  endpoint?: string;
  cached: boolean;
  window_seconds?: number;
  labels_probed_log10x: string[];
  labels_probed_customer: string[];
  join_key?: { log10x_side: string; customer_side: string; jaccard: number; shared_values: number; log10x_only_values: number; customer_only_values: number };
  runner_ups: Array<{ log10x_side: string; customer_side: string; jaccard: number; shared_values: number; log10x_only_values: number; customer_only_values: number }>;
  top_below_threshold: Array<{ log10x_side: string; customer_side: string; jaccard: number; shared_values: number; log10x_only_values: number; customer_only_values: number }>;
  human_summary: string;
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
  const telemetry = newTelemetry();
  args.force_refresh = args.force_refresh ?? false;
  args.minimum_jaccard = args.minimum_jaccard ?? 0.7;
  const resolution = await resolveBackend();
  if (!resolution.backend) {
    // Detection trace kept available for the not-configured remediation hint
    // surfaced through unified.error; markdown wrapping is no longer offered.
    void customerMetricsNotConfiguredMessage(formatDetectionTrace(resolution.trace));
    const unified = buildUnifiedFields({ status: 'error', telemetry, humanSummary: 'Customer metrics backend not configured — discover_join cannot run.' });
    return buildEnvelope({
      tool: 'log10x_discover_join',
      view: 'summary',
      summary: { headline: 'Customer metrics backend not configured — discover_join cannot run.' },
      data: {
        // Keep tool-specific `status` value ('not_configured'); the unified
        // envelope's status (`error`) goes into a parallel field so the
        // agent can read either. Both fields are honest about the call state.
        status: 'not_configured',
        cached: false,
        labels_probed_log10x: [],
        labels_probed_customer: [],
        runner_ups: [],
        top_below_threshold: [],
        query_count: unified.query_count,
        total_latency_ms: unified.total_latency_ms,
        backend_pressure_hint: unified.backend_pressure_hint,
        human_summary: unified.human_summary,
        error: unified.error,
      } satisfies DiscoverJoinSummary & Record<string, unknown>,
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

  const data: DiscoverJoinSummary = {
    status: result.status === 'joined' ? 'joined' : 'no_join_available',
    backend: backend.backendType,
    endpoint: backend.endpoint,
    cached: result.cachedForSession,
    window_seconds: windowSeconds,
    labels_probed_log10x: result.probedLabelsLog10x,
    labels_probed_customer: result.probedLabelsCustomer,
    join_key: result.joinKey ? joinPairToData(result.joinKey) : undefined,
    runner_ups: result.runnerUps.map(joinPairToData),
    top_below_threshold: result.status === 'no_join_available' ? result.probed.slice(0, 8).map(joinPairToData) : [],
    human_summary: '',
  };
  data.human_summary = buildHumanSummary(data, args.minimum_jaccard);
  const headline = data.join_key
    ? `Join key: ${data.join_key.log10x_side} ↔ ${data.join_key.customer_side} (Jaccard ${data.join_key.jaccard.toFixed(3)}, ${data.runner_ups.length} runner-up${data.runner_ups.length !== 1 ? 's' : ''}).`
    : `No join pair above Jaccard ${args.minimum_jaccard}. Cross-pillar primitives refuse for anchors that need a structural join.`;
  const unified = buildUnifiedFields({ status: 'success', telemetry, humanSummary: data.human_summary });
  // discover-join's `data.status` carries tool-specific values
  // ('joined' / 'no_join_available'), so spread unified WITHOUT its status.
  const { status: _unifiedStatus, ...unifiedRest } = unified;
  return buildEnvelope({
    tool: 'log10x_discover_join',
    view: 'summary',
    summary: { headline },
    data: { ...data, ...unifiedRest },
    actions: data.join_key
      ? [
          { tool: 'log10x_metrics_that_moved', args: {}, reason: 'first composition step: anchor a Log10x pattern, filter candidate customer metrics that actually moved with it' },
          { tool: 'log10x_rank_by_shape_similarity', args: {}, reason: 'second step on the filtered candidates: Pearson + signed lag, no tier framing' },
          { tool: 'log10x_metric_overlay', args: {}, reason: 'third step: aligned anchor+candidate timeseries for the agent to interpret' },
        ]
      : [
          { tool: 'log10x_customer_metrics_query', args: {}, reason: 'explore the customer backend label universe to find a natural join dimension' },
        ],
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

function buildHumanSummary(data: DiscoverJoinSummary, minimumJaccard: number): string {
  if (data.status === 'joined' && data.join_key) {
    const jk = data.join_key;
    const runners = data.runner_ups.length;
    return `Found a join key: log10x label \`${jk.log10x_side}\` matches customer label \`${jk.customer_side}\` at Jaccard ${jk.jaccard.toFixed(3)} (${jk.shared_values} shared values). ${runners} runner-up${runners !== 1 ? 's' : ''} above 0.5. Cross-pillar primitives will reuse this join automatically.`;
  }
  const probed = data.top_below_threshold.length;
  const best = probed > 0 ? data.top_below_threshold[0] : undefined;
  const bestHint = best
    ? ` Best below-threshold pair: \`${best.log10x_side}\` ↔ \`${best.customer_side}\` at Jaccard ${best.jaccard.toFixed(3)}.`
    : ' No label pairs were probed; one side returned an empty label universe.';
  return `No label pair reached the Jaccard ${minimumJaccard} threshold across ${data.labels_probed_log10x.length} log10x-side and ${data.labels_probed_customer.length} customer-side labels.${bestHint} Cross-pillar correlation cannot proceed for anchors that need a structural join.`;
}
