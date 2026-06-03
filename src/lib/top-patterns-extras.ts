/**
 * Inline computations for the v3 `log10x_top_patterns` layout:
 *
 *   - **Badge classification** — per-row trajectory label (NEW / ACUTE /
 *     GROWING / STABLE / SHRINKING) derived from current-vs-baseline
 *     bytes. Mirrors the semantics in `cost-drivers.ts` (3-window
 *     baseline at offsets 7d/14d/21d) so the badge maps 1:1 to what
 *     log10x_cost_drivers would say for the same hash.
 *   - **Service breadth** — count of distinct services emitting each
 *     hash, used to gate the "show service breakdown" CTA to multi-
 *     service rows only.
 *   - **Datadog analyzer snippet** — lifted from `exclusion-filter.ts`'s
 *     `generateHashFilter('datadog', 'config', ...)`. Folded inline only
 *     when the env's analyzer is Datadog (where ingest-exclusion is
 *     pre-meter, so an exact-tenx_hash query saves the metered moment).
 *     For Splunk we surface a CTA with a post-license caveat instead of
 *     folding inline — Splunk transforms.conf nullQueue drops AFTER
 *     license consumption, so the customer expectation of parity with
 *     the forwarder drop would mislead.
 *   - **Health banner** — lightweight degraded-state detection visible
 *     to top_patterns without invoking log10x_doctor. Surfaces when the
 *     engine metric is empty / events metric is null. Skips a full
 *     doctor pass (too heavy for every top_patterns call).
 */

import { queryInstant } from './api.js';
import * as pql from './promql.js';
import type { EnvConfig } from './environments.js';
import { LABELS } from './promql.js';
import { checkDeps, DEP_CHECK_VENDORS, type DepCheckResult } from './siem/deps/index.js';
import type { SiemId } from './siem/pricing.js';

export type { TrendDelta } from './trend-delta.js';

/** Trajectory state label for a pattern row. Formerly called `Badge`. */
export type Badge = 'NEW' | 'ACUTE' | 'GROWING' | 'STABLE' | 'SHRINKING';

/**
 * Classify a pattern's trajectory based on current-window bytes vs
 * baseline (average of N prior-period bytes). Thresholds match the
 * intuition the Reader uses when scanning:
 *
 *   - NEW       — pattern's first-seen is more recent than the
 *                 baseline window AND no baseline data exists
 *   - ACUTE     — delta/baseline > 0.5 (more than 50% above its own
 *                 baseline rate — a real spike, decision changes)
 *   - GROWING   — 0.05 < delta/baseline ≤ 0.5 (trending up but not a
 *                 spike — same decision as STABLE for most purposes)
 *   - STABLE    — |delta/baseline| ≤ 0.05 (within noise) OR baseline
 *                 query returned empty for a pattern older than the
 *                 baseline window (engine knew about it, baseline data
 *                 just isn't there — likely a labeling difference, not
 *                 a real "new" event)
 *   - SHRINKING — delta/baseline < -0.05
 *
 * The 5% deadband is intentional — Prometheus baselines have natural
 * jitter from edge buffering and Reporter aggregation timing; below 5%
 * the change is more likely noise than signal.
 *
 * The first-seen cross-check matters in envs where pattern names
 * include unstable identifiers (otel-collector adds span IDs, version
 * strings, etc.) — every pattern looks "new" on a 7d baseline because
 * the *name* changed even though the underlying event class didn't.
 * Only mark NEW when first-seen is more recent than the baseline.
 */
export interface BadgeInfo {
  kind: Badge;
  /** Signed ratio vs baseline average. e.g. +0.85 = +85% above baseline.
   * null when no baseline data exists (NEW case). */
  ratio: number | null;
  /** Echoed from input — used to render "new (17h)" with the age. */
  firstSeenAgeSeconds: number | null;
}

export function classifyBadge(
  currentBytes: number,
  baselineSamples: number[],
  firstSeenAgeSeconds: number | null = null,
  baselineWindowSeconds: number = 24 * 3600
): BadgeInfo {
  // Three NEW signals: explicit recent first-seen, OR no baseline
  // data + active in current window, OR first-seen lookup returned
  // unknown despite the pattern being currently active. All three
  // indicate the pattern is new beyond the baseline horizon — being
  // conservative ("STABLE") on unknown-first-seen rows dilutes the
  // signal the Reader needs to notice the row.
  const ageRecent = firstSeenAgeSeconds !== null && firstSeenAgeSeconds < baselineWindowSeconds;
  const ageUnknown = firstSeenAgeSeconds === null;

  if (baselineSamples.length === 0) {
    // No baseline + active = new. Whether first-seen is known-recent
    // or unknown, the conclusion is the same: this pattern wasn't in
    // the baseline windows.
    if (ageRecent || ageUnknown) {
      return { kind: 'NEW', ratio: null, firstSeenAgeSeconds };
    }
    return { kind: 'STABLE', ratio: null, firstSeenAgeSeconds };
  }

  const baseline = baselineSamples.reduce((s, v) => s + v, 0) / baselineSamples.length;
  if (baseline <= 0) {
    if (ageRecent || ageUnknown) {
      return { kind: 'NEW', ratio: null, firstSeenAgeSeconds };
    }
    return { kind: 'STABLE', ratio: null, firstSeenAgeSeconds };
  }

  const ratio = (currentBytes - baseline) / baseline;
  if (ratio > 0.5) return { kind: 'ACUTE', ratio, firstSeenAgeSeconds };
  if (ratio > 0.05) return { kind: 'GROWING', ratio, firstSeenAgeSeconds };
  if (ratio < -0.05) return { kind: 'SHRINKING', ratio, firstSeenAgeSeconds };
  return { kind: 'STABLE', ratio, firstSeenAgeSeconds };
}

/** Seven days in seconds — the NEW threshold for classifyStateFromDelta. */
const SEVEN_DAYS_SECONDS = 7 * 24 * 3600;

/**
 * Derive a Badge state from a trend_delta percent value and the
 * pattern's first-seen age.
 *
 * This makes `state` strictly derived from `trend_delta.value` (the
 * source of truth), replacing the older classifyBadge() derivation
 * that went directly from baseline-bytes comparison.
 *
 * Thresholds (Tal, 2026-06-03):
 *   NEW       — firstSeenAgeSeconds < 7d (regardless of delta)
 *   ACUTE     — TODO: requires 1h delta input; not yet implemented.
 *               Reserve the branch for when a separate 1h-delta field
 *               is available on the row.
 *   GROWING   — deltaPct > 15
 *   SHRINKING — deltaPct < -15
 *   STABLE    — |deltaPct| <= 15 (inclusive at ±15)
 *
 * Note: ACUTE cannot be derived from the WoW delta alone — it signals
 * a short-window spike (last 1h vs prior 1h) that is orthogonal to the
 * week-over-week trend. Until a 1h-delta input is wired, callers should
 * treat ACUTE as a TODO and fall through to GROWING/STABLE/SHRINKING.
 */
export function classifyStateFromDelta(
  deltaPct: number,
  ageSeconds: number | null
): Badge {
  if (ageSeconds !== null && ageSeconds < SEVEN_DAYS_SECONDS) return 'NEW';
  // ACUTE: deferred — requires a separate 1h delta input.
  // TODO: if (h1DeltaPct > 100) return 'ACUTE';
  if (deltaPct > 15) return 'GROWING';
  if (deltaPct < -15) return 'SHRINKING';
  return 'STABLE';
}

/**
 * Render the badge in the meaningful form for the new list shape.
 * Replaces the old `—` / `↑` glyphs that gave the Reader nothing
 * actionable. Now each badge carries either the actual percent change
 * vs baseline, the actual first-seen age, or a plain word — whichever
 * is the most concrete claim we can defensibly make.
 *
 *   ACUTE     → "acute spike (+85% vs baseline)"
 *   GROWING   → "+15% vs baseline"
 *   SHRINKING → "−12% vs baseline"
 *   STABLE    → "stable (within ±5%)"
 *   NEW (known age)   → "new (since 17h ago)"
 *   NEW (unknown age) → "new (not in baseline)"
 */
export function fmtBadge(b: Badge): string {
  // Backward-compat single-arg form (used by callers that don't have
  // the ratio / age handy). Falls back to short names; not ideal.
  switch (b) {
    case 'ACUTE': return 'acute spike';
    case 'NEW': return 'new';
    case 'GROWING': return 'growing';
    case 'SHRINKING': return 'shrinking';
    case 'STABLE': return 'stable';
  }
}

/**
 * Preferred renderer — takes the full BadgeInfo so it can include the
 * actual percent change / first-seen age in the output. Use this
 * everywhere the row has access to the full info.
 */
export function fmtBadgeInfo(info: BadgeInfo): string {
  const { kind, ratio, firstSeenAgeSeconds } = info;
  switch (kind) {
    case 'NEW':
      if (firstSeenAgeSeconds !== null) {
        return `new (since ${fmtRelativeAge(firstSeenAgeSeconds)})`;
      }
      return 'new (not in baseline)';
    case 'ACUTE':
      if (ratio !== null) return `acute spike (+${Math.round(ratio * 100)}% vs baseline)`;
      return 'acute spike';
    case 'GROWING':
      if (ratio !== null) return `+${Math.round(ratio * 100)}% vs baseline`;
      return 'growing';
    case 'SHRINKING':
      if (ratio !== null) return `−${Math.round(Math.abs(ratio) * 100)}% vs baseline`;
      return 'shrinking';
    case 'STABLE':
      return 'stable';
  }
}

/** Short relative-age formatter used inside the badge string. Keeps
 * the badge line short by abbreviating (`17h`, `3d`) rather than
 * spelling out (`17 hours ago`). */
function fmtRelativeAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * Fetch baseline bytes for the same (pattern, service, severity)
 * triples that topPatternsFull surfaced, at offsets 7d / 14d / 21d.
 * Returns a Map<key, number[]> keyed by `${pattern}|${service}|${severity}`
 * so the caller can compute the badge per row by joining on identity.
 *
 * Three parallel queries. Worst-case ~1-3s on a healthy Prometheus.
 * Empty results per offset (returns no baseline samples for a hash) are
 * fine — `classifyBadge` returns NEW when baselineSamples is empty.
 */
export async function fetchBaselineBytes(
  env: EnvConfig,
  filters: Record<string, pql.FilterValue>,
  metricsEnv: string,
  range: string,
  // Default to 1d/2d/3d offsets — short enough to be relevant ("is
  // this above what it was doing yesterday?"), far enough to not
  // overlap with the current window. The previous [7, 14, 21]
  // weekly default works for stable patterns but breaks in envs
  // where pattern *names* are unstable (otel-collector embeds span
  // IDs / versions / etc. into pattern names, so every pattern
  // looks "new" on a 7d horizon).
  offsetDays: number[] = [1, 2, 3]
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const results = await Promise.all(
    offsetDays.map(d =>
      queryInstant(env, pql.bytesPerPattern(filters, metricsEnv, range, d)).catch(() => null)
    )
  );
  for (const res of results) {
    if (!res || res.status !== 'success') continue;
    for (const r of res.data.result) {
      const p = r.metric[LABELS.pattern] || '';
      const s = r.metric[LABELS.service] || '';
      const sv = r.metric[LABELS.severity] || '';
      if (!p) continue;
      const key = `${p}|${s}|${sv}`;
      const v = Number(r.value?.[1] ?? '0');
      if (!Number.isFinite(v)) continue;
      const arr = out.get(key) ?? [];
      arr.push(v);
      out.set(key, arr);
    }
  }
  return out;
}

/**
 * For a list of hashes, count the distinct services emitting each one.
 * Uses a single grouped-by-(hash,service) query and post-processes
 * locally — 1 PromQL call vs N. Returns Map<hash, count>.
 *
 * Drives the "show service breakdown" CTA: skipped when count <= 1,
 * surfaced when count >= 2 (multi-service rows where the dominant
 * service in the row header doesn't tell the whole story).
 */
export async function fetchServiceBreadth(
  env: EnvConfig,
  metricsEnv: string,
  range: string,
  hashes: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (hashes.length === 0) return out;
  // PromQL: count of distinct (hash, service) pairs in the window.
  // Filter to the hashes top_patterns surfaced — keeps the query lean
  // when the env has thousands of patterns.
  const hashRegex = hashes.map(h => h.replace(/[^A-Za-z0-9]/g, '')).join('|');
  if (!hashRegex) return out;
  const query =
    `sum by (${LABELS.hash}, ${LABELS.service}) (` +
    `increase(emitted_events_summaryBytes_total{${LABELS.env}="${metricsEnv}",${LABELS.hash}=~"${hashRegex}"}[${range}])` +
    `)`;
  try {
    const res = await queryInstant(env, query);
    if (res.status !== 'success') return out;
    for (const r of res.data.result) {
      const h = r.metric[LABELS.hash];
      if (!h) continue;
      out.set(h, (out.get(h) ?? 0) + 1);
    }
  } catch {
    /* swallow — best-effort */
  }
  return out;
}

/**
 * Per-hash dependency-check pass for the env's analyzer.
 *
 * Runs `checkDeps` in parallel for each hash. Each call hits the
 * analyzer's read-only APIs (DescribeAlarms / DescribeMetricFilters /
 * ListDashboards on CloudWatch; equivalents for Splunk / Datadog /
 * Elasticsearch). Per-vendor pagination is bounded inside the module.
 *
 * Returns null when no analyzer is detected or the analyzer isn't in
 * the supported subset — the caller renders no dep badge in that case.
 * Returns Map<hash, DepCheckResult> on success (some entries may have
 * `error` set if the per-hash scan failed; the renderer handles that
 * shape).
 *
 * Honest note on precision (per the 2026-05-20 audit): the matcher is
 * `allTokensMatchExact` — token-AND on discrete tokens, mirroring the
 * templater's tokenization. Catches saved searches / alerts whose body
 * contains every pattern token as a discrete token. Misses references
 * by `tenx_hash` value (hash-only refs). False-positives possible on
 * common-word patterns. The renderer surfaces this caveat inline.
 */
export async function fetchDepsPerHash(
  analyzer: string | null,
  hashes: Array<{ hash: string; service: string; severity: string }>
): Promise<Map<string, DepCheckResult> | null> {
  if (!analyzer) return null;
  if (!(DEP_CHECK_VENDORS as readonly string[]).includes(analyzer)) return null;
  const vendor = analyzer as SiemId;
  const out = new Map<string, DepCheckResult>();
  // The `pattern` argument the dep_check expects is the pattern name
  // (snake_case identity) but we don't have that here — top_patterns
  // operates on `tenx_hash` keys, which are short opaque strings.
  // Pass the hash as the "pattern" so the deps modules use it as the
  // token-AND input. The hash is base62; tokenization on
  // non-alphanumeric runs returns the hash itself as a single token —
  // which means `allTokensMatchExact` only matches haystacks that
  // contain the exact hash string. That's actually MORE precise than
  // name-token matching (no false positives from common-word overlap),
  // at the cost of missing references that use the pattern name. The
  // renderer's caveat covers this.
  const results = await Promise.all(
    hashes.map(async h => {
      try {
        const res = await checkDeps(vendor, {
          pattern: h.hash,
          tokens: [h.hash],
          service: h.service,
          severity: h.severity,
        });
        return { hash: h.hash, res };
      } catch (e) {
        return { hash: h.hash, res: null as DepCheckResult | null };
      }
    })
  );
  for (const r of results) {
    if (r.res) out.set(r.hash, r.res);
  }
  return out;
}

/**
 * Datadog ingest-exclusion query for an exact tenx_hash match. The
 * query goes into Logs > Configuration > Indexes > Exclusion Filters;
 * the drop happens pre-meter, so the customer's metered ingest cost is
 * actually reduced (unlike Splunk transforms.conf nullQueue, which
 * drops post-license and only saves indexer storage).
 *
 * Lifted from `exclusion-filter.ts`'s `generateHashFilter('datadog',
 * 'config', ...)` — kept here as a small standalone helper so
 * top_patterns can fold it inline without importing the full
 * exclusion_filter tool's surface.
 */
export function datadogAnalyzerQuery(hash: string, service: string, severity: string): string {
  const parts = [`@tenx_hash:"${hash}"`];
  if (service) parts.push(`service:${service}`);
  if (severity && severity !== 'uncl') parts.push(`status:${severity.toLowerCase()}`);
  return parts.join(' ');
}

/**
 * Lightweight degraded-state detection. Surfaces when the engine
 * metric tier appears unhealthy *from what top_patterns can already
 * see* — empty total-bytes-in-scope, missing events metric, etc.
 *
 * Does NOT run log10x_doctor (which is a multi-second multi-API probe
 * unsuitable for the hero tool's hot path). Returns null when no
 * banner is warranted; otherwise returns a short markdown string the
 * renderer pins to the top of the output.
 */
export interface HealthSignals {
  totalBytes: number;
  patternCountTotal?: number;
  eventsAvailable: boolean;
}

export function healthBanner(s: HealthSignals): string | null {
  if (s.totalBytes <= 0) {
    return (
      '> ⚠ engine metric reports zero bytes in scope — events may not be reaching the engine, ' +
      'or the window is too narrow. Run `log10x_doctor` for the full health verdict.'
    );
  }
  if (!s.eventsAvailable) {
    return (
      '> ⚠ event-count metric unavailable — bytes are flowing but per-pattern event totals could not be ' +
      'retrieved. The cards below show byte totals only. Run `log10x_doctor` for diagnostics.'
    );
  }
  return null;
}
