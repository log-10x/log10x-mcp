/**
 * log10x_discover_join — auto-discover the join label between Log10x
 * pattern metrics and the customer metric backend via Jaccard similarity
 * on label value sets.
 *
 * This tool runs the Jaccard pass across every candidate label pair and
 * returns the best match above the 0.7 floor, plus runner-ups above 0.5.
 *
 * Cached per-session per (environment, customer-backend-endpoint) so
 * correlate_cross_pillar and translate_metric_to_patterns can auto-call
 * this once at the start of a session and never re-probe.
 *
 * Agents should normally NOT need to call this tool directly — the
 * higher-level correlation tools run it internally via the session cache.
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
  loadBackendFromEnv,
  CustomerMetricsNotConfiguredError,
} from '../lib/customer-metrics.js';
import { getOrDiscoverJoin, discoverJoin, type JoinDiscoveryResult, type JoinPair } from '../lib/join-discovery.js';

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
    .describe('Minimum Jaccard similarity to accept as a primary join. Default 0.7. Lower to 0.5 for exploratory discovery.'),
  candidate_labels: z
    .array(z.string())
    .optional()
    .describe('Optional subset of customer-side labels to probe. When omitted, all labels from the customer backend are probed in preferred-first order.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

export async function executeDiscoverJoin(
  args: {
    force_refresh: boolean;
    minimum_jaccard: number;
    candidate_labels?: string[];
    environment?: string;
  },
  env: EnvConfig
): Promise<string> {
  const backend = loadBackendFromEnv();
  if (!backend) {
    throw new CustomerMetricsNotConfiguredError();
  }

  const result = args.force_refresh
    ? await discoverJoin(env, backend, {
        minimumJaccard: args.minimum_jaccard,
        candidateLabels: args.candidate_labels,
      })
    : await getOrDiscoverJoin(env, backend, {
        minimumJaccard: args.minimum_jaccard,
        candidateLabels: args.candidate_labels,
      });

  return renderJoinResult(result, backend.backendType, backend.endpoint);
}

function renderJoinResult(
  result: JoinDiscoveryResult,
  backendType: string,
  endpoint: string
): string {
  const lines: string[] = [];
  lines.push('## Cross-pillar join discovery');
  lines.push('');
  lines.push(`**Customer backend**: ${backendType} (${endpoint})`);
  lines.push(`**Cached**: ${result.cachedForSession ? 'yes (session cache)' : 'no (fresh probe)'}`);
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

    lines.push('**Next action**: the cross-pillar correlation tools will use this join key automatically. Call `log10x_correlate_cross_pillar` or `log10x_translate_metric_to_patterns` with an anchor and they will reuse the cached result.');
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
