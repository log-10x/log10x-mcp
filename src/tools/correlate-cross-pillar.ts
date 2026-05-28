/**
 * log10x_correlate_cross_pillar — bidirectional cross-pillar correlation
 * primitive for the v1.4 bridge.
 *
 * Takes an anchor that's either a Log10x pattern OR a customer metric
 * expression and returns ranked co-movers from the OTHER pillar, tiered
 * by structural validation confidence.
 *
 * Tiers:
 *   confirmed     — structural overlap on join key + at least one more label
 *   service-match — join key match, partial overlap
 *   unconfirmed   — required labels missing on Log10x side
 *   coincidence   — no structural link despite temporal match (should be rare; Phase 2 filter)
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
  resolveBackend,
  formatDetectionTrace,
  customerMetricsNotConfiguredMessage,
} from '../lib/customer-metrics.js';
import { getOrDiscoverJoin, type JoinDiscoveryResult } from '../lib/join-discovery.js';
import {
  runCrossPillarCorrelation,
  type AnchorSpec,
  type CrossPillarResult,
  type CrossPillarCandidate,
} from '../lib/cross-pillar-correlate.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';

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
    .describe('Time window for correlation. `1h` default. Accepts PromQL-style durations: `15m`, `1h`, `6h`, `24h`. Alias: `timeRange`.'),
  timeRange: z
    .string()
    .optional()
    .describe('Alias for `window` for consistency with other Log10x tools. If both are set, `window` wins.'),
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
  view: z.enum(['summary', 'markdown']).default('summary').describe('Output format.'),
};

interface CorrelateCrossPillarSummary {
  status: 'correlation_complete' | 'no_join_available' | 'no_anchor_movement';
  anchor: { type: string; value: string };
  window: string;
  join_key?: { log10x_side: string; customer_side: string; jaccard: number };
  customer_backend?: string;
  candidates_analyzed: number;
  candidates_excluded: number;
  candidates: Array<{
    name: string;
    tier: 'confirmed' | 'service-match' | 'unconfirmed' | 'coincidence';
    /** Pearson r magnitude at the peak lag. Used in confidence math.
     * For direction (co-move vs anti-correlate) see `pearson_signed`. */
    pearson_at_lag: number;
    /** Signed Pearson r at the peak lag. Positive = co-moves with anchor.
     * Negative = anti-correlated (gauge dropped when anchor rose). */
    pearson_signed: number;
    structural_overlap: number | null;
    /** Conservative reported lag (zeroed when below rate-window resolution). */
    lag_seconds: number;
    /** Raw lag the math actually found, NOT zeroed when below rate-window.
     * Negative = candidate leads anchor (possible cause).
     * Positive = candidate lags anchor (possible effect).
     * Weigh this against `lag_tightness` before acting on direction. */
    lag_seconds_raw: number;
    /** Lag tightness 0..1 — how concentrated the peak is. Low = the Pearson
     * peak is broad across many offsets (direction is ambiguous). */
    lag_tightness: number;
    /** True when the lag peak landed at the bound of the search range
     * (now ±1800s, was ±300s). Signals "the math couldn't localize the peak
     * within the search window" — can mean the real lag is wider than
     * the search range OR there's no real lag relationship. The agent
     * disambiguates with `anchor_phase_aligned`, structural overlap,
     * and Pearson magnitude. (No longer auto-demotes — both LLM judges
     * asked for flag-don't-demote so the rows stay visible.) */
    lag_at_bound: boolean;
    /** True when the candidate's mean during the anchor's high-phase
     * buckets meaningfully differs from its mean during the anchor's
     * low-phase buckets (≥15% relative gap). FALSE = the candidate's
     * value is invariant across the anchor's phases, so its Pearson
     * correlation is a shape-accident rather than anchor-driven
     * movement. Lets the agent dismiss diurnal/seasonal confounders that
     * pass the Pearson threshold but aren't actually moving with the
     * anchor's incident. */
    anchor_phase_aligned: boolean;
    combined_confidence: number | null;
    moved: boolean;
  }>;
  tier_counts: { confirmed: number; 'service-match': number; unconfirmed: number; coincidence: number };
}

export async function executeCorrelateCrossPillar(
  args: {
    anchor_type: 'log10x_pattern' | 'customer_metric';
    anchor: string;
    window?: string;
    timeRange?: string;
    step?: string;
    depth?: 'shallow' | 'normal' | 'deep';
    minimum_confidence?: number;
    minimum_join_jaccard?: number;
    environment?: string;
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig
): Promise<string | import('../lib/output-types.js').StructuredOutput> {
  const view = args.view ?? 'summary';
  const sumOut: { data?: CorrelateCrossPillarSummary } = {};
  const md = await executeCorrelateCrossPillarInner(args, env, sumOut);
  const { buildMarkdownEnvelope, buildEnvelope } = await import('../lib/output-types.js');
  if (view === 'markdown' || !sumOut.data) {
    return buildMarkdownEnvelope({
      tool: 'log10x_correlate_cross_pillar',
      summary: { headline: md.split('\n')[0]?.slice(0, 200) || 'correlate_cross_pillar result' },
      markdown: md,
    });
  }
  const d = sumOut.data;
  const excludedSuffix = d.candidates_excluded > 0 ? ` (${d.candidates_excluded} excluded below confidence floor)` : '';
  const headline = `\`${d.anchor.value}\` over ${d.window}: ${d.candidates_analyzed} candidates analyzed via ${d.customer_backend ?? 'customer backend'}, ${d.tier_counts.confirmed} confirmed + ${d.tier_counts['service-match']} service-match + ${d.tier_counts.unconfirmed} unconfirmed${excludedSuffix}`;
  return buildEnvelope({
    tool: 'log10x_correlate_cross_pillar',
    view: 'summary',
    summary: { headline },
    data: d,
    truncated: d.candidates_excluded > 0,
  });
}

async function executeCorrelateCrossPillarInner(
  args: {
    anchor_type: 'log10x_pattern' | 'customer_metric';
    anchor: string;
    window?: string;
    timeRange?: string;
    step?: string;
    depth?: 'shallow' | 'normal' | 'deep';
    minimum_confidence?: number;
    minimum_join_jaccard?: number;
    environment?: string;
  },
  env: EnvConfig,
  sumOut?: { data?: CorrelateCrossPillarSummary }
): Promise<string> {
  // Accept `timeRange` as alias for `window`, then apply schema-default
  // fallbacks for chain/script callers that bypass the MCP-SDK Zod
  // boundary. Without these `parseDuration(undefined)` and the depth /
  // minimum_confidence comparisons crash.
  if (!args.window && args.timeRange) {
    args.window = args.timeRange;
  }
  args.window = args.window ?? '1h';
  args.step = args.step ?? '60s';
  args.depth = args.depth ?? 'normal';
  args.minimum_confidence = args.minimum_confidence ?? 0.3;
  const resolution = await resolveBackend();
  if (!resolution.backend) {
    // Graceful degrade for autonomous chains. Throwing aborts a parent
    // chain (e.g., investigate -> correlate_cross_pillar -> ...); a
    // structured markdown return lets the parent log the missing-backend
    // state and continue with log-tier-only synthesis.
    return customerMetricsNotConfiguredMessage(formatDetectionTrace(resolution.trace));
  }
  const backend = resolution.backend;

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

  // Populate typed summary for view='summary' callers.
  if (sumOut) {
    const flatCandidates = [...result.byTier['confirmed'], ...result.byTier['service-match'], ...result.byTier['unconfirmed'], ...result.byTier['coincidence']];
    sumOut.data = {
      status: 'correlation_complete',
      anchor: { type: result.anchor.type, value: result.anchor.value },
      window: args.window,
      join_key: result.joinKey ? {
        log10x_side: result.joinKey.log10xSide,
        customer_side: result.joinKey.customerSide,
        jaccard: result.joinKey.jaccard,
      } : undefined,
      customer_backend: backend.backendType,
      candidates_analyzed: result.metadata.patternsAnalyzed,
      candidates_excluded: Math.max(0, result.metadata.patternsAnalyzed - flatCandidates.length),
      candidates: flatCandidates.map((c) => ({
        name: c.name,
        tier: c.tier,
        pearson_at_lag: c.subScores.temporal,
        pearson_signed: c.subScores.temporalSigned,
        structural_overlap: c.subScores.structural,
        lag_seconds: c.lagSeconds,
        lag_seconds_raw: c.lagSecondsRaw,
        lag_tightness: c.subScores.lag,
        lag_at_bound: c.lagAtBound,
        anchor_phase_aligned: c.anchorPhaseAligned,
        combined_confidence: c.combinedConfidence,
        moved: c.evidence.moved,
      })),
      tier_counts: {
        confirmed: result.byTier['confirmed'].length,
        'service-match': result.byTier['service-match'].length,
        unconfirmed: result.byTier['unconfirmed'].length,
        coincidence: result.byTier['coincidence'].length,
      },
    };
  }

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

  // Confirmed tier
  if (result.byTier['confirmed'].length > 0) {
    lines.push('### Tier 1 — confirmed (full structural overlap)');
    lines.push('');
    for (let i = 0; i < result.byTier['confirmed'].length; i++) {
      lines.push(formatCandidate(i + 1, result.byTier['confirmed'][i]));
    }
    lines.push('');
  } else {
    lines.push('### Tier 1 — confirmed');
    lines.push('');
    lines.push('_No candidates with full structural overlap. This is normal when the anchor label set doesn\'t include a second structural dimension beyond the join key._');
    lines.push('');
  }

  // Service-match tier
  if (result.byTier['service-match'].length > 0) {
    lines.push('### Tier 2 — service-match (join key match, partial overlap)');
    lines.push('');
    lines.push('_Candidates matched on the join key but not on a second structural dimension. Plausibly a service-level issue affecting all instances, but the structural link is weaker than Tier 1._');
    lines.push('');
    for (let i = 0; i < result.byTier['service-match'].length; i++) {
      lines.push(formatCandidate(i + 1, result.byTier['service-match'][i]));
    }
    lines.push('');
  }

  // Unconfirmed tier
  if (result.byTier['unconfirmed'].length > 0) {
    lines.push('### Tier 3 — unconfirmed');
    lines.push('');
    lines.push('_These candidates have temporal correlation with the anchor BUT the tool could not confirm whether they are structurally linked, because required Log10x enrichment labels are absent or the anchor expression doesn\'t expose enough label matchers to validate against. **Do not drill autonomously.**_');
    lines.push('');
    for (let i = 0; i < result.byTier['unconfirmed'].length; i++) {
      lines.push(formatCandidate(i + 1, result.byTier['unconfirmed'][i]));
    }
    lines.push('');
  }

  // Coincidence tier
  if (result.byTier['coincidence'].length > 0) {
    lines.push('### Tier 4 — coincidence (warning)');
    lines.push('');
    lines.push('_Probably unrelated. Either they are not on the same service/pod as your anchor, or they barely moved during the window (so any apparent correlation is just noise). Do not treat these as related._');
    lines.push('');
    for (let i = 0; i < result.byTier['coincidence'].length; i++) {
      lines.push(formatCandidate(i + 1, result.byTier['coincidence'][i]));
    }
    lines.push('');
  }

  // Agent-only machine detail (sub-scores + re-runnable PromQL) for every
  // candidate — kept OUT of the human view (it reads as data-science noise),
  // handed to the agent for verification / chaining. Humans get the plain
  // lines above; the agent gets the precision + the exact query here.
  if (result.candidates.length > 0) {
    lines.push(candidateAgentDetail(result.candidates));
    lines.push('');
  }

  // Topology-boundary hand-off (anti-hallucination), in plain English. The
  // dangerous path is the confirmed/service-match tier: an agent can read the
  // timing as a proven cause and fabricate a dependency story. State the
  // correlation→causation line plainly so the agent reasons from co-movement
  // and defers causal direction to traces/APM (the APM boundary we do NOT
  // cross by building a call graph ourselves).
  if (result.byTier['confirmed'].length > 0 || result.byTier['service-match'].length > 0) {
    lines.push(
      '> **These moved at the same time as your anchor. That is not proof one caused the other.** To find the actual cause, look at the request traces in your APM, or at what changed or deployed around the time this started.'
    );
    lines.push('');
    lines.push(
      agentOnly(
        'Do NOT relay these as causation. Present them as things that moved together; if the user needs the causal direction, tell them to confirm in their traces/APM or the deploy timeline. This tool shows correlation + shared labels, not a proven dependency.'
      )
    );
    lines.push('');
  }

  // Next actions
  lines.push('### Next actions');
  lines.push('');
  const topJoined = result.byTier['confirmed'][0] || result.byTier['service-match'][0];
  const nextActions: NextAction[] = [];
  if (topJoined && result.anchor.type === 'customer_metric') {
    lines.push(`1. Drill into the top candidate: \`log10x_investigate({ starting_point: '${topJoined.name}' })\` for temporal-correlation + lag analysis.`);
    nextActions.push({
      tool: 'log10x_investigate',
      args: { starting_point: topJoined.name },
      reason: 'temporal-correlation + lag analysis on the top correlated pattern',
    });
    lines.push(`2. Pull the actual events contributing to the correlation: \`log10x_retriever_query({ pattern: '${topJoined.name}' })\`.`);
    nextActions.push({
      tool: 'log10x_retriever_query',
      args: { pattern: topJoined.name, from: `now-${windowLabel}` },
      reason: 'pull historical events contributing to the correlation',
    });
    lines.push(`3. Before muting or dropping the candidate pattern, check blast radius: \`log10x_dependency_check({ pattern: '${topJoined.name}' })\`.`);
    nextActions.push({
      tool: 'log10x_dependency_check',
      args: { pattern: topJoined.name },
      reason: 'blast-radius check before muting the candidate',
    });
  } else if (topJoined) {
    lines.push(`1. The top correlated customer metric is \`${topJoined.name}\`. Inspect it directly in your backend's UI or via \`log10x_customer_metrics_query\`.`);
    lines.push(`2. If this anchor pattern should be muted, verify dependencies first: \`log10x_dependency_check({ pattern: '${result.anchor.value}' })\`.`);
    nextActions.push({
      tool: 'log10x_dependency_check',
      args: { pattern: result.anchor.value },
      reason: 'blast-radius check before muting the anchor',
    });
  } else {
    lines.push('_No high-confidence candidates found. Consider widening the window, lowering `minimum_confidence`, or verifying the anchor actually moved in the requested window._');
  }
  lines.push('');

  // Metadata
  lines.push('---');
  lines.push('');
  lines.push(`**Metadata**: ${result.metadata.patternsAnalyzed} candidates analyzed, ${result.metadata.log10xQueries} PromQL queries against Log10x, ${result.metadata.customerQueries} against the customer backend, total wall time ${result.metadata.wallTimeMs}ms.`);

  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);
  return lines.join('\n');
}

// Human-facing line: plain English, no data-science sub-scores. The
// machine detail (temporal/structural/spread + the re-runnable PromQL) goes
// in an agent-only block via `candidateAgentDetail` so a person reads a
// sentence and the agent still gets the precision + query to verify/chain.
function formatCandidate(idx: number, c: CrossPillarCandidate): string {
  const metricName = c.labels['__name__'] || c.name;
  const t = c.subScores.temporal;
  const strength = t >= 0.7 ? 'tracks the anchor closely' : t >= 0.4 ? 'moves with the anchor' : 'moves loosely with the anchor';
  const timing =
    c.lagSeconds === 0 ? 'at the same time'
      : c.lagSeconds < 0 ? `about ${Math.abs(c.lagSeconds)}s before it`
        : `about ${c.lagSeconds}s after it`;
  return `${idx}. \`${metricName}\` — ${strength}, ${timing}`;
}

/** Agent-only machine detail for the candidates: the sub-scores Pearson/
 * structural/movement and the exact re-runnable PromQL. Kept out of the
 * human view (it reads as data-science noise) but handed to the agent so it
 * can verify independently and chain. */
function candidateAgentDetail(candidates: CrossPillarCandidate[]): string {
  const rows = candidates.map((c) => {
    const name = c.labels['__name__'] || c.name;
    const s = c.subScores;
    const structural = s.structural === null ? 'n/a' : s.structural.toFixed(2);
    const spread = c.evidence ? c.evidence.movedSpread.toFixed(2) : 'n/a';
    const rate = c.evidence ? `${Math.round(c.evidence.rateWindowSeconds / 60)}m` : 'n/a';
    const conf = c.combinedConfidence !== null ? `${(c.combinedConfidence * 100).toFixed(0)}%` : 'n/a';
    return `- ${name} [${c.tier}] temporal=${s.temporal.toFixed(2)} structural=${structural} spread=${spread} rate=${rate} lag=${c.lagSeconds}s conf=${conf}\n  query: ${c.name}`;
  });
  return agentOnly(
    'Per-candidate evidence + re-runnable PromQL (for verification / chaining; not for the human reply):\n' +
      rows.join('\n')
  );
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
