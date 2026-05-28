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
import { getOrDiscoverJoin, discoverJoin, type JoinDiscoveryResult, type JoinPair } from '../lib/join-discovery.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';
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
  view: z.enum(['summary', 'markdown']).default('summary').describe('summary returns the typed envelope. markdown wraps the rendered discovery report in data.markdown.'),
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
}

export async function executeDiscoverJoin(
  args: {
    force_refresh?: boolean;
    minimum_jaccard?: number;
    candidate_labels?: string[];
    window?: string;
    timeRange?: string;
    environment?: string;
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';
  const telemetry = newTelemetry();
  args.force_refresh = args.force_refresh ?? false;
  args.minimum_jaccard = args.minimum_jaccard ?? 0.7;
  const resolution = await resolveBackend();
  if (!resolution.backend) {
    const md = customerMetricsNotConfiguredMessage(formatDetectionTrace(resolution.trace));
    if (view === 'markdown') {
      return buildMarkdownEnvelope({
        tool: 'log10x_discover_join',
        summary: { headline: 'Customer metrics backend not configured.' },
        markdown: md,
      });
    }
    const unified = buildUnifiedFields({ status: 'error', telemetry, humanSummary: 'Customer metrics backend not configured.' });
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

  const md = renderJoinResult(result, backend.backendType, backend.endpoint, windowSeconds);
  if (view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_discover_join',
      summary: { headline: result.status === 'joined' && result.joinKey ? `Join key: ${result.joinKey.log10xSide} ↔ ${result.joinKey.customerSide} (Jaccard ${result.joinKey.jaccard.toFixed(3)})` : 'No join key found above Jaccard threshold.' },
      markdown: md,
    });
  }
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
  };
  const headline = data.join_key
    ? `Join key: ${data.join_key.log10x_side} ↔ ${data.join_key.customer_side} (Jaccard ${data.join_key.jaccard.toFixed(3)}, ${data.runner_ups.length} runner-up${data.runner_ups.length !== 1 ? 's' : ''}).`
    : `No join pair above Jaccard ${args.minimum_jaccard}. Cross-pillar primitives refuse for anchors that need a structural join.`;
  const unified = buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline });
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
  if (!m) throw new Error(`Invalid window: "${s}". Expected format like "10m", "1h", "30s", "2d".`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return n * unitSeconds[unit];
}

function renderJoinResult(
  result: JoinDiscoveryResult,
  backendType: string,
  endpoint: string,
  windowSeconds?: number
): string {
  const lines: string[] = [];
  lines.push('## Cross-pillar join discovery');
  lines.push('');
  lines.push(`**Customer backend**: ${backendType} (${endpoint})`);
  lines.push(`**Cached**: ${result.cachedForSession ? 'yes (session cache)' : 'no (fresh probe)'}`);
  if (windowSeconds) {
    lines.push(`**Window**: last ${windowSeconds}s (stale label values excluded)`);
  } else {
    lines.push(`**Window**: all-time (stale label values from decommissioned series are included — pass \`window\` to filter)`);
  }
  lines.push(`**Labels probed on Log10x side**: ${result.probedLabelsLog10x.join(', ')}`);
  lines.push(`**Labels probed on customer side**: ${result.probedLabelsCustomer.join(', ') || '(none — backend returned empty label universe)'}`);
  lines.push('');

  if (result.status === 'joined' && result.joinKey) {
    lines.push(`### Primary join key`);
    lines.push('');
    lines.push(formatPair(result.joinKey));
    lines.push('');

    if (result.runnerUps.length > 0) {
      lines.push('### Runner-ups (above 0.5 Jaccard)');
      lines.push('');
      for (const p of result.runnerUps) {
        lines.push(formatPair(p));
      }
      lines.push('');
    }

    lines.push('**Next action**: the cross-pillar primitives will reuse this join key automatically. Compose `log10x_metrics_that_moved` → `log10x_rank_by_shape_similarity` → `log10x_metric_overlay` starting from a Log10x pattern OR a customer metric anchor.');
    // Structured chain hint so autonomous walkers don't need to
    // prose-parse the markdown above.
    const next: NextAction[] = [
      {
        tool: 'log10x_metrics_that_moved',
        args: {},
        reason: 'first composition step: deterministic filter on which candidates moved with the anchor',
      },
      {
        tool: 'log10x_rank_by_shape_similarity',
        args: {},
        reason: 'second step on filtered candidates: Pearson + signed lag without tier framing',
      },
      {
        tool: 'log10x_metric_overlay',
        args: {},
        reason: 'third step: aligned anchor+candidate timeseries for the agent to interpret',
      },
    ];
    const block = renderNextActions(next);
    if (block) lines.push('', block);
    return lines.join('\n');
  }

  // status === 'no_join_available'
  lines.push('### Status: no_join_available');
  lines.push('');
  lines.push('**No label pair reached the Jaccard threshold.** Cross-pillar correlation cannot proceed for anchors that require a structural join. See the refusal response for details.');
  lines.push('');
  lines.push('### Top scoring pairs (below threshold, for reference)');
  lines.push('');
  const topProbed = result.probed.slice(0, 8);
  if (topProbed.length === 0) {
    lines.push('_No label pairs were probed. Either the Log10x side or the customer backend returned an empty label universe._');
  } else {
    for (const p of topProbed) {
      lines.push(formatPair(p));
    }
  }
  lines.push('');
  lines.push('**Recommended actions**:');
  lines.push('1. If your customer backend has service-level metrics (`service`, `service.name`, `app`), correlate against those instead of host/instance-level metrics.');
  lines.push('2. Call `log10x_customer_metrics_query` with a broad PromQL expression to explore the backend\'s label universe and find a natural join dimension.');
  lines.push('3. If you expected a join and none appeared, check `log10x_doctor` for the `cross_pillar_enrichment_floor` check to verify what labels Log10x has on this environment.');
  lines.push('4. Re-run with `minimum_jaccard: 0.5` for exploratory discovery if you suspect the join is weak but still useful.');

  return lines.join('\n');
}

function formatPair(p: JoinPair): string {
  return `- \`${p.log10xSide}\` ↔ \`${p.customerSide}\` — Jaccard ${p.jaccard.toFixed(3)} (${p.sharedValues} shared, ${p.log10xOnlyValues} Log10x-only, ${p.customerOnlyValues} customer-only)`;
}
