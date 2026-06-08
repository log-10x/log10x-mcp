/**
 * Anchor-suggestion helper for cross-pillar primitives that refuse on
 * flat-anchor (`anchor_no_phase_separation`).
 *
 * Per Note 30 in the post-composite arc review: when
 * `metrics_that_moved` or `rank_by_shape_similarity` refuse because the
 * caller's anchor has no busy/quiet split, telling the user "re-anchor"
 * without suggestions is dead-end UX. This helper scans the env's
 * recent top patterns (single PromQL range query against the bytes
 * counter), computes the dispersion (coefficient of variation) of each
 * pattern's volume series, and returns the top 3 patterns whose
 * dispersion clears the floor — i.e. patterns that ARE good anchor
 * candidates.
 *
 * The returned rows surface in the tool's refusal envelope as a
 * plain-English table (rank / pattern / service / variation indicator).
 * No "anchor", no "dispersion", no "phase separation" in user prose —
 * those terms stay in field names for the agent.
 */
import type { EnvConfig } from './environments.js';
import { queryRange } from './api.js';
import { LABELS } from './promql.js';
import { resolveMetricsEnv } from './resolve-env.js';
import { computeAnchorDispersion } from './anchor-dispersion.js';

/** Floor for "this pattern has enough variation to be a good starting point." */
export const SUGGESTION_DISPERSION_FLOOR = 0.5;

/** How many top-by-volume patterns to scan before filtering by dispersion. */
const SCAN_TOP_K = 20;

/** How many high-variation suggestions to return. */
const RETURN_TOP_N = 3;

export interface AnchorSuggestion {
  /** Symbol-message name of the pattern (what the user sees + what they
   * pass back in as the next `anchor` arg). */
  pattern: string;
  /** Service that emits it. Empty string when the metric series has no
   * `tenx_user_service` label set. */
  service: string;
  /** Coefficient of variation of the pattern's volume across the
   * window — the same statistic the refusal guard uses. Surfaced
   * structured so the agent can re-rank if it wants to. */
  variation: number;
  /** Plain-English bucket: "high" | "moderate". Renders in the
   * suggestion table; users don't need to read the raw CV. */
  variation_indicator: 'high' | 'moderate';
}

/**
 * Scan the env's top-by-volume patterns over `window` and return up to
 * 3 with dispersion ≥ {@link SUGGESTION_DISPERSION_FLOOR}, sorted by
 * variation descending. Returns `[]` on any error — callers degrade
 * gracefully (no suggestions block) rather than failing the refusal.
 *
 * Single PromQL range query: `topk(20, sum by (message_pattern,
 * tenx_user_service) (rate(all_events_summaryBytes_total{tenx_env=X}[3m])))`.
 * Each returned series has the bucket values needed to compute CV
 * client-side, so no per-pattern fan-out.
 */
export async function suggestHigherVariationAnchors(
  env: EnvConfig,
  windowSeconds: number,
  stepSeconds: number,
): Promise<AnchorSuggestion[]> {
  try {
    const metricsEnv = await resolveMetricsEnv(env);
    const rateRange = Math.max(stepSeconds * 3, 180);
    const promql =
      `topk(${SCAN_TOP_K}, sum by (${LABELS.pattern}, ${LABELS.service}) ` +
      `(rate(all_events_summaryBytes_total{${LABELS.env}="${metricsEnv}"}[${rateRange}s])))`;
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - windowSeconds;
    const res = await queryRange(env, promql, fromSec, nowSec, stepSeconds);
    if (res.status !== 'success') return [];

    const candidates: AnchorSuggestion[] = [];
    for (const r of res.data.result) {
      const pattern = r.metric[LABELS.pattern] ?? '';
      const service = r.metric[LABELS.service] ?? '';
      if (!pattern) continue;
      const values: number[] = [];
      for (const [, raw] of r.values ?? []) {
        const v = Number(raw);
        if (Number.isFinite(v)) values.push(v);
      }
      if (values.length < 3) continue;
      const variation = computeAnchorDispersion(values);
      if (variation < SUGGESTION_DISPERSION_FLOOR) continue;
      candidates.push({
        pattern,
        service,
        variation,
        variation_indicator: variation >= 1.0 ? 'high' : 'moderate',
      });
    }

    candidates.sort((a, b) => b.variation - a.variation);
    return candidates.slice(0, RETURN_TOP_N);
  } catch {
    return [];
  }
}

/**
 * Render the suggestions as a plain-English markdown block. Returns an
 * empty string when there are no suggestions (so the caller can append
 * unconditionally without a stray header).
 *
 * Deliberately plain: no "anchor", no "phase separation", no PromQL.
 * Just "try one of these patterns instead — they have more variation."
 */
export function renderAnchorSuggestionsBlock(suggestions: AnchorSuggestion[]): string {
  if (suggestions.length === 0) return '';
  const lines: string[] = [];
  lines.push('');
  lines.push('Try one of these patterns instead — they have more variation in the same window:');
  lines.push('');
  lines.push('| Rank | Pattern | Service | Variation |');
  lines.push('| --- | --- | --- | --- |');
  suggestions.forEach((s, i) => {
    const svc = s.service || '(unknown)';
    lines.push(`| ${i + 1} | \`${s.pattern}\` | \`${svc}\` | ${s.variation_indicator} |`);
  });
  return lines.join('\n');
}
