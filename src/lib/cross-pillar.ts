/**
 * Cross-pillar phase for log10x_investigate.
 *
 * The thesis: correlating a 10x log pattern with the customer's APM /
 * infra metrics is differentiated ONLY where it joins on the stamped
 * pattern identity, not as standalone PromQL arithmetic an agent does
 * natively. So the phase-gap filter + Pearson/lag ranking + overlay that
 * used to be marketed as three standalone "cross-pillar primitives"
 * (metrics_that_moved / rank_by_shape_similarity / metric_overlay) are
 * folded here, behind investigate's orchestration, instead of steering
 * the agent to compose three replicable tools.
 *
 * This phase makes the cross-pillar DECISION internally:
 *   - No customer metrics backend configured (the common case, and the
 *     entire logs-only deployment) → say so honestly: the investigation
 *     covers the stamped-pattern universe only. Don't hand the agent a
 *     primitive it can't usefully run without a backend + candidate set.
 *   - Backend configured → confirm a structural join exists (discover_join,
 *     which keys on the shared resource dimension) and report that the
 *     co-mover bridge is live and anchored on the stamped identity.
 *
 * Best-effort and total: never throws, never blocks the main report.
 * Returns a markdown section, or '' to omit.
 */

import type { EnvConfig } from './environments.js';
import { agentOnly } from './agent-only.js';

interface JoinKeyShape {
  log10x_side?: string;
  customer_side?: string;
  jaccard?: number;
}

/**
 * Build the cross-pillar section for one resolved anchor. `anchor` is the
 * stamped pattern identity the investigation locked onto; `window` is the
 * analysis window (passed to the join discovery for freshness).
 */
export async function runCrossPillarPhase(
  env: EnvConfig,
  anchor: string | undefined,
  window: string,
): Promise<string> {
  if (!anchor) return '';
  try {
    const { resolveBackend } = await import('./customer-metrics.js');
    const resolution = await resolveBackend().catch(() => null);
    const backend = resolution?.backend;

    if (!backend) {
      // Honest not-configured path, the demo / logs-only reality. This
      // REPLACES the old "go call metrics_that_moved + rank + overlay"
      // hand-off: without a customer metrics backend those primitives
      // have nothing to correlate against.
      return [
        '### Cross-pillar correlation',
        '',
        'Not run, no customer metrics backend is configured in this env, so this ' +
          'investigation covers the **stamped log-pattern universe only** (the causal ' +
          'chain / cohort above). Cross-pillar correlation joins a 10x pattern to the ' +
          "customer's APM / infra metrics on the shared resource dimension; it needs a " +
          'metrics backend to read those series.',
        '',
        agentOnly(
          'No customer metrics backend resolved (resolveBackend returned none). Do NOT ' +
          'fall back to log10x_metrics_that_moved / rank_by_shape_similarity / ' +
          'metric_overlay, they read the same backend and will also report ' +
          'not-configured. To enable cross-pillar correlation, configure a metrics ' +
          'backend, then re-run investigate. The log-pattern findings above stand on ' +
          'their own.',
        ),
      ].join('\n');
    }

    // Backend present, confirm a structural join on the stamped identity.
    // Bounded by a short timeout so a slow/hanging customer backend
    // degrades to omitting the section rather than blocking the whole
    // investigation.
    const { executeDiscoverJoin } = await import('../tools/discover-join.js');
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000));
    const joinResult = await Promise.race([
      executeDiscoverJoin({ window, view: 'summary' }, env).catch(() => null),
      timeout,
    ]);
    const joinKey =
      joinResult && typeof joinResult === 'object' && 'data' in joinResult
        ? ((joinResult as { data?: { join_key?: JoinKeyShape } }).data?.join_key)
        : undefined;

    if (joinKey?.log10x_side && joinKey?.customer_side) {
      // Honest framing: we CONFIRM the bridge (backend + structural join on
      // the stamped identity); we do not enumerate candidates and emit the
      // co-mover ranking inline here. The ranking math is commodity; the
      // differentiation is the stamped-identity anchor it correlates against.
      return [
        '### Cross-pillar correlation',
        '',
        `Customer metrics backend: **${backend.backendType}**. Structural join confirmed on ` +
          `\`${joinKey.log10x_side}\` ↔ \`${joinKey.customer_side}\`` +
          (typeof joinKey.jaccard === 'number' ? ` (Jaccard ${joinKey.jaccard.toFixed(2)})` : '') +
          `, so cross-pillar co-mover correlation is AVAILABLE for this incident, anchored on ` +
          `the stamped pattern \`${anchor}\` (the identity a generic agent can't reconstruct). ` +
          `The co-mover ranking itself (phase-gap + Pearson/lag over candidate customer metrics ` +
          `on that join dimension) is not run inline here.`,
        '',
        agentOnly(
          `Cross-pillar bridge is live (backend=${backend.backendType}, join ` +
          `${joinKey.log10x_side}↔${joinKey.customer_side}). To get the co-movers: enumerate ` +
          `candidate customer metrics on the join dimension (label-scoped ` +
          `log10x_customer_metrics_query), then rank by phase-gap + Pearson/lag keyed to anchor ` +
          `"${anchor}". That ranking is commodity arithmetic; the differentiation is the ` +
          `stamped-identity anchor it correlates against.`,
        ),
      ].join('\n');
    }

    return [
      '### Cross-pillar correlation',
      '',
      `Customer metrics backend: **${backend.backendType}** is configured, but no structural ` +
        `join dimension was found between the 10x pattern metrics and the customer metrics ` +
        `(no shared resource label above the Jaccard threshold). Cross-pillar co-mover ` +
        `ranking can't be anchored reliably; the stamped log-pattern findings above stand ` +
        `on their own.`,
    ].join('\n');
  } catch {
    // Total: a cross-pillar hiccup must never break the investigation.
    return '';
  }
}
