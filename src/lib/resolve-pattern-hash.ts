/**
 * Shared helper: resolve a pattern's authoritative tenx_hash from the 10x metrics.
 *
 * The local tenxHash(canonicalPattern) hashes the snake_case pattern NAME —
 * but the engine's emitted tenx_hash (the value present in both Prometheus AND
 * the 10x-forwarded SIEM events) is PatternHashEncoder.encode(<symbol sequence
 * of the actual event>), a different input. They never match, so a hash-probe
 * built from the local hash silently falls back to fuzzy phrase-match.
 *
 * Resolving the hash from the metrics label (same value the forwarder writes to
 * the SIEM) is what makes the exact-hash cross-pillar probe actually hit.
 * Returns undefined when the metrics don't carry the pattern (caller falls back
 * to the local hash, then to phrase tokens).
 */

import type { EnvConfig } from './environments.js';
import { queryInstant } from './api.js';
import { LABELS } from './promql.js';
import { parsePrometheusValue } from './cost.js';
import { resolveMetricsEnv } from './resolve-env.js';

export async function resolvePatternHashFromMetrics(
  env: EnvConfig,
  canonicalPattern: string,
): Promise<string | undefined> {
  try {
    const metricsEnv = await resolveMetricsEnv(env);

    const pickBest = (rows: Array<{ metric?: Record<string, string> }>): string | undefined => {
      let best: { h: string; v: number } | undefined;
      for (const row of rows) {
        const h = row.metric?.[LABELS.hash];
        if (!h) continue;
        const v = parsePrometheusValue(row as { value?: [number, string] });
        if (!best || v > best.v) best = { h, v };
      }
      return best?.h;
    };

    // 1) Exact match. The metric label is the snake_case Symbol-Message
    //    identity — when it's the full string, this hits in one PromQL.
    const p = canonicalPattern.replace(/"/g, '\\"');
    const exactQ =
      `count by (${LABELS.hash}) (increase(all_events_summaryBytes_total{` +
      `${LABELS.pattern}="${p}",${LABELS.env}="${metricsEnv}"}[24h]))`;
    const exact = await queryInstant(env, exactQ).catch(() => null);
    const exactRows = exact?.data?.result ?? [];
    const exactHit = pickBest(exactRows);
    if (exactHit) return exactHit;

    // 2) Prefix-anchor fallback. The Reporter truncates `message_pattern`
    //    label values (~80 chars), so the full canonical pattern never
    //    exact-matches — but the truncated label is a deterministic
    //    PREFIX of the full pattern. Match by `^<first-60-chars>` (a
    //    pure regex anchor, no wildcard softening — no fuzziness): all
    //    truncated labels for this pattern still start with this
    //    prefix, and the prefix is long+distinctive enough that
    //    unrelated patterns won't collide. Most-emitting hash wins.
    // Prometheus `=~` is FULLY anchored (^...$ implicit), so a leading
    // `^` plus a prefix alone matches only the prefix exactly — we need
    // `<prefix>.*` so the truncated label's tail is consumed.
    const regexEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = regexEsc(canonicalPattern.slice(0, 60));
    const prefixQ =
      `count by (${LABELS.hash}) (increase(all_events_summaryBytes_total{` +
      `${LABELS.pattern}=~"${prefix}.*",${LABELS.env}="${metricsEnv}"}[24h]))`;
    const prefixR = await queryInstant(env, prefixQ).catch(() => null);
    return pickBest(prefixR?.data?.result ?? []);
  } catch {
    return undefined;
  }
}
