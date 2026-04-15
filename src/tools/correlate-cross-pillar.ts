/**
 * log10x_correlate_cross_pillar — bidirectional cross-pillar correlation
 * primitive for the v1.4 bridge.
 *
 * Takes an anchor that's either a Log10x pattern OR a customer metric
 * expression and returns ranked co-movers from the OTHER pillar, tiered
 * by structural validation confidence.
 *
 * Tiers:
 *   joined                 — structural overlap on join key + at least one more label
 *   structurally_validated — join key match, partial overlap
 *   validation_unavailable — required labels missing on Log10x side
 *   temporal_coincidence   — no structural link despite temporal match (should be rare; Phase 2 filter)
 *
 * When the session cache has no join discovery result, this tool
 * auto-runs join discovery internally. When the join is not available at
 * all (no_join_available from discover_join), this tool returns the
 * structured refusal response instead of falling back to temporal-only.
 *
 * Tier prerequisite: LOG10X_CUSTOMER_METRICS_URL configured; Reporter tier
 * with k8s_pod / k8s_container / k8s_namespace / tenx_user_service
 * enrichments (defaults on any k8s install).
 *
 * This tool issues 4-12 PromQL queries (Log10x gateway + customer backend)
 * plus up to 8 candidate range queries for temporal scoring.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import {
  loadBackendFromEnv,
  CustomerMetricsNotConfiguredError,
} from '../lib/customer-metrics.js';
import { getOrDiscoverJoin, type JoinDiscoveryResult } from '../lib/join-discovery.js';
import {
  runCrossPillarCorrelation,
  type AnchorSpec,
  type CrossPillarResult,
  type CrossPillarCandidate,
} from '../lib/cross-pillar-correlate.js';

export const correlateCrossPillarSchema = {
  anchor_type: z
    .enum(['log10x_pattern', 'customer_metric'])
    .describe('Which pillar the anchor comes from. `log10x_pattern` correlates a pattern against customer metrics; `customer_metric` correlates a customer metric against Log10x patterns.'),
  anchor: z
    .string()
    .describe('The anchor identity. For `log10x_pattern`: the pattern name / templateHash. For `customer_metric`: the PromQL expression (e.g., `apm_request_duration_p99{service="payments-svc"}`).'),
  window: z
    .string()
    .default('1h')
    .describe('Time window for correlation. `1h` default. Accepts PromQL-style durations: `15m`, `1h`, `6h`, `24h`.'),
  step: z
    .string()
    .default('60s')
    .describe('Bucket step for range queries. Default 60s. Smaller steps produce more accurate lag analysis but cost more queries.'),
  depth: z
    .enum(['shallow', 'normal', 'deep'])
    .default('normal')
    .describe('`shallow` = anchor\'s exact label scope; `normal` (default) = anchor + immediate neighbors; `deep` = full environment (may scan 1000+ metrics on large backends, opt-in only).'),
  minimum_confidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe('Minimum combined confidence for a candidate to be returned. Default 0.3.'),
  minimum_join_jaccard: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'Override the Jaccard threshold the underlying join-discovery pass uses to accept a primary join key. Default 0.7 (high-confidence structural overlap). Lower to 0.3–0.5 when the join key is legitimate but label value sets include stale data from decommissioned pods or historical replay — the underlying correlation is still structural, just dragged down by orphan values. Pair with `window` to suppress the stale data at probe time and avoid needing this override.'
    ),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

export async function executeCorrelateCrossPillar(
  args: {
    anchor_type: 'log10x_pattern' | 'customer_metric';
    anchor: string;
    window: string;
    step: string;
    depth: 'shallow' | 'normal' | 'deep';
    minimum_confidence: number;
    minimum_join_jaccard?: number;
    environment?: string;
  },
  env: EnvConfig
): Promise<string> {
  const backend = loadBackendFromEnv();
  if (!backend) {
    throw new CustomerMetricsNotConfiguredError();
  }

  // Auto-discover the join key. Use the correlation window as the label-value
  // probe window (matches the data we're about to analyze), and pass through
  // any caller-specified minimum_join_jaccard override. Bypass the session
  // cache when either option is provided — the cache key doesn't include
  // these tunables, so cached results would be wrong.
  const windowSeconds = parseDuration(args.window);
  const useCustomOpts = args.minimum_join_jaccard !== undefined;
  const joinOpts = {
    minimumJaccard: args.minimum_join_jaccard ?? 0.7,
    windowSeconds,
  };
  const joinResult = useCustomOpts
    ? await (await import('../lib/join-discovery.js')).discoverJoin(env, backend, joinOpts)
    : await getOrDiscoverJoin(env, backend, joinOpts);
  if (joinResult.status === 'no_join_available' || !joinResult.joinKey) {
    return renderNoJoinAvailable(joinResult, backend.backendType, backend.endpoint, args.anchor);
  }

  // Parse step. (windowSeconds already computed above for join discovery.)
  const stepSeconds = parseDuration(args.step);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const fromSeconds = nowSeconds - windowSeconds;

  const anchor: AnchorSpec = { type: args.anchor_type, value: args.anchor };

  // Run the correlation pipeline.
  const result = await runCrossPillarCorrelation({
    env,
    backend,
    anchor,
    joinKey: joinResult.joinKey,
    window: { from: fromSeconds, to: nowSeconds, step: stepSeconds },
    maxCandidates: args.depth === 'deep' ? 16 : args.depth === 'shallow' ? 4 : 8,
    minimumConfidence: args.minimum_confidence,
  });

  return renderCorrelationResult(result, backend.backendType, args.window);
}

// ── Rendering ──

function renderNoJoinAvailable(
  joinResult: JoinDiscoveryResult,
  backendType: string,
  endpoint: string,
  anchor: string
): string {
  const lines: string[] = [];
  lines.push(`## Cross-pillar correlation · \`${anchor}\``);
  lines.push('');
  lines.push('**Status**: `no_join_available`');
  lines.push('');
  lines.push('The cross-pillar correlation tool cannot correlate this anchor because no shared label exists between the customer metric backend and Log10x pattern metrics. This is a **structural refusal**, not a bug: the tool is correctly refusing to present a temporally-coincident correlation as causal.');
  lines.push('');
  lines.push(`**Customer backend**: ${backendType} (${endpoint})`);
  lines.push(`**Labels probed on Log10x side**: ${joinResult.probedLabelsLog10x.join(', ')}`);
  lines.push(`**Labels probed on customer side**: ${joinResult.probedLabelsCustomer.join(', ') || '(none — backend returned empty label universe)'}`);
  lines.push('');

  if (joinResult.probed.length > 0) {
    lines.push('### Top scoring pairs (all below the 0.7 threshold)');
    lines.push('');
    lines.push('| Log10x side | Customer side | Jaccard |');
    lines.push('|---|---|---|');
    for (const p of joinResult.probed.slice(0, 6)) {
      lines.push(`| \`${p.log10xSide}\` | \`${p.customerSide}\` | ${p.jaccard.toFixed(3)} |`);
    }
    lines.push('');
  }

  lines.push('### Recommended next actions');
  lines.push('');
  lines.push('1. **Correlate against a service-level customer metric instead.** If the customer backend has `apm_request_duration_p99{service=...}`, `apm_error_rate{service=...}`, or similar service-scoped metrics, the join on `service ↔ tenx_user_service` will work cleanly.');
  lines.push('2. **Narrow the anchor to a specific pod identifier.** If the customer metric supports a per-pod query (`container_memory_rss{pod="..."}`, `kube_pod_status_phase{pod="..."}`), the join on `pod ↔ k8s_pod` will work.');
  lines.push('3. **Node-level metrics are deferred to v1.4.1.** The Log10x Reporter\'s k8s enrichment module doesn\'t currently populate a `k8s_node` label. Node-level CPU / memory / disk correlations will become available once the Reporter-side extraction change ships.');
  lines.push('4. **Explore the customer backend\'s label universe.** Call `log10x_customer_metrics_query` with a broad PromQL expression to see what dimensions the backend exposes beyond what the preferred-label discovery probed.');
  lines.push('5. **Run `log10x_doctor`** to verify which Log10x-side enrichment labels are present on this environment\'s pattern metrics. Missing labels indicate a non-k8s deployment or a non-standard forwarder input format.');

  return lines.join('\n');
}

function renderCorrelationResult(
  result: CrossPillarResult,
  backendType: string,
  windowLabel: string
): string {
  const lines: string[] = [];
  const anchorLabel = result.anchor.type === 'customer_metric' ? 'customer metric' : 'Log10x pattern';
  lines.push(`## Cross-pillar correlation · \`${result.anchor.value}\``);
  lines.push('');
  lines.push(`**Status**: correlation_complete`);
  lines.push(`**Anchor**: ${anchorLabel}`);
  lines.push(`**Window**: last ${windowLabel}`);
  lines.push(`**Join key**: \`${result.joinKey.log10xSide}\` ↔ \`${result.joinKey.customerSide}\` (Jaccard ${result.joinKey.jaccard.toFixed(2)})`);
  lines.push(`**Customer backend**: ${backendType}`);
  lines.push(`**Candidates analyzed**: ${result.metadata.patternsAnalyzed}`);
  lines.push('');

  // Joined tier
  if (result.byTier.joined.length > 0) {
    lines.push('### Tier 1 — joined (full structural overlap confirmed)');
    lines.push('');
    for (let i = 0; i < result.byTier.joined.length; i++) {
      lines.push(formatCandidate(i + 1, result.byTier.joined[i]));
    }
    lines.push('');
  } else {
    lines.push('### Tier 1 — joined');
    lines.push('');
    lines.push('_No candidates with full structural overlap. This is normal when the anchor label set doesn\'t include a second structural dimension beyond the join key._');
    lines.push('');
  }

  // Structurally validated tier
  if (result.byTier.structurally_validated.length > 0) {
    lines.push('### Tier 2 — structurally validated (join key match, partial overlap)');
    lines.push('');
    lines.push('_Candidates matched on the join key but not on a second structural dimension. Plausibly a service-level issue affecting all instances, but the structural link is weaker than Tier 1._');
    lines.push('');
    for (let i = 0; i < result.byTier.structurally_validated.length; i++) {
      lines.push(formatCandidate(i + 1, result.byTier.structurally_validated[i]));
    }
    lines.push('');
  }

  // Validation unavailable tier
  if (result.byTier.validation_unavailable.length > 0) {
    lines.push('### Tier 3 — validation unavailable');
    lines.push('');
    lines.push('_These candidates have temporal correlation with the anchor BUT the tool could not confirm whether they are structurally linked, because required Log10x enrichment labels are absent or the anchor expression doesn\'t expose enough label matchers to validate against. **Do not drill autonomously.**_');
    lines.push('');
    for (let i = 0; i < result.byTier.validation_unavailable.length; i++) {
      lines.push(formatCandidate(i + 1, result.byTier.validation_unavailable[i]));
    }
    lines.push('');
  }

  // Temporal coincidence tier
  if (result.byTier.temporal_coincidence.length > 0) {
    lines.push('### Tier 4 — temporal coincidence (warning)');
    lines.push('');
    lines.push('_These candidates have temporal correlation with the anchor AND structural validation ran, but they have NO structural overlap with the anchor. This is coincidence, not causation. Do not present these as causal candidates without independent evidence._');
    lines.push('');
    for (let i = 0; i < result.byTier.temporal_coincidence.length; i++) {
      lines.push(formatCandidate(i + 1, result.byTier.temporal_coincidence[i]));
    }
    lines.push('');
  }

  // Next actions
  lines.push('### Next actions');
  lines.push('');
  const topJoined = result.byTier.joined[0] || result.byTier.structurally_validated[0];
  if (topJoined && result.anchor.type === 'customer_metric') {
    lines.push(`1. Drill into the top candidate: \`log10x_investigate({ starting_point: '${topJoined.name}' })\` for full causal-chain analysis.`);
    lines.push(`2. Pull the actual events contributing to the correlation: \`log10x_streamer_query({ pattern: '${topJoined.name}', window: 'last ${windowLabel}' })\`.`);
    lines.push(`3. Before muting or dropping the candidate pattern, check blast radius: \`log10x_dependency_check({ pattern: '${topJoined.name}' })\`.`);
  } else if (topJoined) {
    lines.push(`1. The top correlated customer metric is \`${topJoined.name}\`. Inspect it directly in your backend's UI or via \`log10x_customer_metrics_query\`.`);
    lines.push(`2. If this anchor pattern should be muted, verify dependencies first: \`log10x_dependency_check({ pattern: '${result.anchor.value}' })\`.`);
  } else {
    lines.push('_No high-confidence candidates found. Consider widening the window, lowering `minimum_confidence`, or verifying the anchor actually moved in the requested window._');
  }
  lines.push('');

  // Metadata
  lines.push('---');
  lines.push('');
  lines.push(`**Metadata**: ${result.metadata.patternsAnalyzed} candidates analyzed, ${result.metadata.log10xQueries} PromQL queries against Log10x, ${result.metadata.customerQueries} against the customer backend, total wall time ${result.metadata.wallTimeMs}ms.`);

  return lines.join('\n');
}

function formatCandidate(idx: number, c: CrossPillarCandidate): string {
  const name = c.name.length > 100 ? c.name.slice(0, 97) + '...' : c.name;
  const conf = c.combinedConfidence !== null ? `${(c.combinedConfidence * 100).toFixed(0)}%` : 'unknown';
  const structural =
    c.subScores.structural === null ? 'unknown' : c.subScores.structural.toFixed(2);
  const lag = c.lagSeconds === 0 ? 'concurrent' : c.lagSeconds < 0 ? `leads ${Math.abs(c.lagSeconds)}s` : `trails ${c.lagSeconds}s`;
  return `${idx}. \`${name}\` — confidence ${conf} (temporal:${c.subScores.temporal.toFixed(2)} lag:${c.subScores.lag.toFixed(2)} structural:${structural} volume:${c.subScores.volume.toFixed(2)}) — ${lag}`;
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)([smhdw])$/);
  if (!m) return 3600;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 3600;
    case 'd':
      return n * 86400;
    case 'w':
      return n * 604800;
    default:
      return 3600;
  }
}
