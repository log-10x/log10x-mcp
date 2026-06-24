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
import { iQueryInstant, QUERY_BUDGET } from './interactive-query.js';
import { LABELS } from './promql.js';
import { parsePrometheusValue } from './cost.js';
import { resolveMetricsEnv } from './resolve-env.js';
import { looksLikePatternHash } from './anchor-promql.js';

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
    const exact = await iQueryInstant(env, exactQ, QUERY_BUDGET.cheap);
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
    const prefixR = await iQueryInstant(env, prefixQ, QUERY_BUDGET.cheap);
    return pickBest(prefixR?.data?.result ?? []);
  } catch {
    return undefined;
  }
}

/**
 * Result of {@link resolvePatternRefInMetrics}.
 *   - `exists`: true when the metrics backend carries this pattern over the
 *     probed window. `null` when the probe could not be issued (no env, RPC
 *     failure, etc.) — caller distinguishes "not checked" from "checked,
 *     absent".
 *   - `hash`: the canonical tenx_hash when known. Echoed back when the
 *     caller passed a hash; resolved from `LABELS.pattern` when caller
 *     passed a name.
 *   - `name`: the canonical Symbol Message name when known. Resolved from
 *     `LABELS.hash` when caller passed a hash; echoed back when caller
 *     passed a name. May be `null` even when `exists=true` if the metrics
 *     row carries the opposite-side label only (rare).
 *   - `ref_kind`: which side the input shape matched. `hash` when input
 *     matched `PATTERN_HASH_REGEX`, else `name`.
 */
export interface PatternRefResolution {
  exists: boolean | null;
  hash?: string;
  name?: string;
  ref_kind: 'hash' | 'name';
}

/**
 * Canonical "does this pattern exist in the metrics backend" probe.
 *
 * Mirrors the per-tool resolution paths used by `pattern_examples`,
 * `pattern_detail`, and `event_lookup` — same metric (`all_events_summaryBytes_total`),
 * same labels (`LABELS.hash` when input is hash-shaped, `LABELS.pattern`
 * otherwise), same env scoping (`resolveMetricsEnv`). Use this instead of
 * a bespoke probe whenever a tool only needs to confirm pattern existence
 * by either form (hash OR name) the user pasted in.
 *
 * Window is fixed at 24h to match the resolution path the other tools use.
 * Callers needing a wider window should call the lower-level helpers
 * directly.
 *
 * Behavior:
 *   - Hash-shaped input (`PATTERN_HASH_REGEX`): queries by `LABELS.hash`,
 *     returns the dominant `LABELS.pattern` value as `name` if any row hits.
 *   - Name-shaped input: queries via `resolvePatternHashFromMetrics`
 *     (exact-match then prefix fallback), returns the dominant
 *     `LABELS.hash` value as `hash` if any row hits.
 *   - Network / parse failures collapse to `exists: null` (not checked),
 *     so callers can disclose "could not verify" rather than "absent".
 */
export async function resolvePatternRefInMetrics(
  env: EnvConfig,
  ref: string,
): Promise<PatternRefResolution> {
  const trimmed = ref.trim();
  if (looksLikePatternHash(trimmed)) {
    try {
      const metricsEnv = await resolveMetricsEnv(env);
      const escaped = trimmed.replace(/"/g, '\\"');
      const q =
        `count by (${LABELS.pattern}) (increase(all_events_summaryBytes_total{` +
        `${LABELS.hash}="${escaped}",${LABELS.env}="${metricsEnv}"}[24h]))`;
      const res = await iQueryInstant(env, q, QUERY_BUDGET.cheap);
      const rows = res?.data?.result ?? [];
      if (rows.length === 0) {
        // Probe ran cleanly, no rows → confirmed absent in this window.
        return { exists: res ? false : null, hash: trimmed, ref_kind: 'hash' };
      }
      let best: { p: string; v: number } | undefined;
      for (const row of rows) {
        const p = row.metric?.[LABELS.pattern];
        if (!p) continue;
        const v = parsePrometheusValue(row as { value?: [number, string] });
        if (!best || v > best.v) best = { p, v };
      }
      return {
        exists: true,
        hash: trimmed,
        name: best?.p,
        ref_kind: 'hash',
      };
    } catch {
      return { exists: null, hash: trimmed, ref_kind: 'hash' };
    }
  }
  // Name-shaped input. resolvePatternHashFromMetrics already implements
  // the exact-match + prefix fallback the catalog uses; reuse it so
  // truncated-label patterns still resolve.
  try {
    const hash = await resolvePatternHashFromMetrics(env, trimmed);
    if (hash) {
      return { exists: true, hash, name: trimmed, ref_kind: 'name' };
    }
    return { exists: false, name: trimmed, ref_kind: 'name' };
  } catch {
    return { exists: null, name: trimmed, ref_kind: 'name' };
  }
}
