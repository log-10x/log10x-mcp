/**
 * log10x_commitment_report — promised-vs-delivered tracking for x%-by-Y
 * commitments.
 *
 * Customer signs a commitment ("we will deliver X% spend reduction on
 * service S against destination D by date Y") via `log10x_configure_engine`.
 * That tool persists a commitment record to the snapshot-store namespace
 * `commitments/`. This tool, called periodically (weekly is the design
 * cadence), reports promised vs delivered, attributes variance, and
 * projects forward Bayesian confidence.
 *
 * Contract-awareness — IMPORTANT for Datadog & similar committed-volume
 * deals where the contract ratchets up but not down:
 *
 *   YEAR-ONE (`contract_type='committed'`):
 *     - We CAN'T reduce dollar spend (volume is already paid for the
 *       remainder of the term), but we CAN bank bytes-saved as headroom
 *       against future overages and as evidence at the next renewal.
 *     - delivered_dollars is reported as a SHADOW number with caveat.
 *     - delivered_bytes is the primary KPI.
 *
 *   YEAR-TWO ONWARD (`contract_type='on_demand'`, or `contract_type='committed'`
 *     past `term_end`):
 *     - Bytes-saved translates to dollar-saved at the contract unit rate.
 *     - delivered_dollars becomes the primary KPI.
 *
 * Bayesian forward confidence: Beta(α,β) prior, weak by default (2,2),
 * updated with weekly fractional evidence. Posterior CDF gives p10 / p90
 * for next-90d. See spec §5 default-chosen Q4.
 *
 * Dependencies (some not yet shipped in this branch; references stubbed
 * with explicit `not_ready` envelopes when missing):
 *   - estimate-savings.ts → `runEstimateVerify` (one weekly window)
 *   - configure-engine.ts → writes commitment records to snapshot-store
 *
 * Spec: /tmp/poc-comparison/14d-24-implementation-spec.md §5.
 */

import { z } from 'zod';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEnvelope,
  buildMarkdownEnvelope,
  type StructuredOutput,
} from '../lib/output-types.js';
import {
  resolveBackend,
  formatDetectionTrace,
  CustomerMetricsNotConfiguredError,
  type CustomerMetricsBackend,
} from '../lib/customer-metrics.js';
import { annualizeDollars, type Action } from '../lib/cost.js';
import type { SiemId } from '../lib/siem/pricing.js';
import { loadEnvironments, resolveEnv } from '../lib/environments.js';
import { getOffloadStatusBatch } from '../lib/offload-status.js';

// ─── input schema ────────────────────────────────────────────────────

export const commitmentReportSchema = {
  commitment_id: z
    .string()
    .optional()
    .describe(
      'Commitment record id (created by log10x_configure_engine on PR-merge). If omitted, resolves the most recent commitment for the active service.'
    ),
  service: z
    .string()
    .optional()
    .describe(
      'Service name to resolve a commitment by — used when commitment_id is omitted. When both are present, commitment_id wins.'
    ),
  period: z
    .enum(['30d', '90d', 'ytd'])
    .default('90d')
    .describe('Reporting window. 30d=last 30 days, 90d=last 90 days, ytd=since Jan 1 of current year.'),
  format: z
    .enum(['cfo_md', 'summary', 'json'])
    .default('cfo_md')
    .describe(
      'cfo_md=executive markdown with weekly chart and forward confidence; summary=typed envelope only; json=full structured data.'
    ),
  environment: z
    .string()
    .optional()
    .describe('Environment nickname; defaults to the active env.'),
};

const schemaObj = z.object(commitmentReportSchema);
export type CommitmentReportArgs = z.infer<typeof schemaObj>;

// ─── persistence (commitments namespace, parallel to snapshot-store) ─

/**
 * Commitment record persisted by `log10x_configure_engine` on PR merge.
 *
 * `contract_type='committed'` means a committed-volume contract (Datadog
 * Enterprise, Splunk Enterprise commit) — year-one dollar savings are
 * theoretical, year-two onward they're realized. `contract_type='on_demand'`
 * means usage-billed (CloudWatch, ES Service, etc.) — dollar savings
 * realize immediately.
 */
export interface CommitmentRecord {
  id: string;
  env: string;
  service: string;
  destination: SiemId;
  promised_pct: number;
  contract_type: 'committed' | 'on_demand';
  /** ISO-8601 start of the commitment window (when the engine config went live). */
  started_at: string;
  /** Baseline window the promised_pct was measured against (e.g. '30d'). */
  baseline_window: string;
  baseline_bytes_30d: number;
  baseline_usd_monthly: number;
  /**
   * For contract_type='committed', the contract term-end date.
   * After this date, dollar savings switch from shadow to realized.
   */
  term_end?: string;
}

function commitmentsDir(): string {
  const dir = process.env.LOG10X_ADVISOR_STATE_DIR
    ? join(process.env.LOG10X_ADVISOR_STATE_DIR, 'commitments')
    : join(tmpdir(), 'log10x-advisor-snapshots', 'commitments');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore; commitments dir creation failure → load returns undefined
  }
  return dir;
}

/** Persist a commitment record. Called by configure-engine.ts on PR-merge. */
export function putCommitment(rec: CommitmentRecord): void {
  try {
    const dir = commitmentsDir();
    writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec));
  } catch {
    // disk write failure is non-fatal in dev; callers may re-create on next merge
  }
}

/** Load a commitment by id. Returns undefined when missing. */
export function getCommitment(id: string): CommitmentRecord | undefined {
  try {
    const p = join(commitmentsDir(), `${id}.json`);
    const raw = readFileSync(p, 'utf8');
    return JSON.parse(raw) as CommitmentRecord;
  } catch {
    return undefined;
  }
}

/** Most-recent commitment for a service (used when commitment_id omitted). */
export function findCommitmentByService(
  service: string,
  env?: string
): CommitmentRecord | undefined {
  try {
    const dir = commitmentsDir();
    const files = readdirSync(dir).filter((n) => n.endsWith('.json'));
    let best: { rec: CommitmentRecord; mtime: number } | undefined;
    for (const f of files) {
      try {
        const raw = readFileSync(join(dir, f), 'utf8');
        const rec = JSON.parse(raw) as CommitmentRecord;
        if (rec.service !== service) continue;
        if (env && rec.env !== env) continue;
        const mtime = statSync(join(dir, f)).mtimeMs;
        if (!best || mtime > best.mtime) best = { rec, mtime };
      } catch {
        // skip malformed
      }
    }
    return best?.rec;
  } catch {
    return undefined;
  }
}

// ─── verify-result interface (consumed from estimate-savings.ts) ────

/**
 * Shape of one weekly verify-mode output from estimate-savings.ts.
 * Defined here so commitment-report can compile and run before
 * estimate-savings ships. When the real `runEstimateVerify` lands,
 * it must produce this shape (or be adapted via `_setVerifyRunner`).
 *
 * Attribution fields are NORMALIZED FRACTIONS in [0,1].
 */
export interface WeeklyVerifyResult {
  week_start: string; // ISO-8601 (YYYY-MM-DD)
  bytes_in: number;
  bytes_dropped: number;
  delivered_pct: number; // (bytes_dropped / bytes_in) * 100, clamped to [0,100]
  delivered_dollars: number; // estimate-savings verify-mode $ for the week
  attribution: {
    cap_fired: number; // share of delivered savings from configured caps firing as planned
    drift: number; // share lost to pattern drift (pattern_hash changed, cap missed)
    new_patterns: number; // share lost to brand-new uncapped patterns
    leakage: number; // share lost to caps under-firing (lower than promised)
  };
  at_risk_patterns?: Array<{
    pattern_hash: string;
    issue: 'leakage' | 'new_pattern_uncapped' | 'drift';
    suggested: string;
  }>;
  /**
   * Source of the $/GB rate used to compute `delivered_dollars` for the
   * week. Propagated from estimate-savings.ts verify-mode output.
   *  - 'customer_supplied' — caller passed effective_ingest_per_gb
   *  - 'list_price'        — from vendors.json defaults
   *  - 'unset'             — no rate; `delivered_dollars` is null
   */
  rate_source?: 'list_price' | 'customer_supplied' | 'unset';
  /**
   * Per-pattern breakdown sourced from the cap CSV `<bytes>::<reason>:<action>`
   * row format (see project_unified_savings_tool.md). When the engine
   * regulator JS does not parse the `:<action>` suffix yet, this field
   * is absent — the commitment report falls back to attributing all
   * `bytes_dropped` to the `drop` bucket (legacy behaviour) and pushes a
   * caveat noting the breakdown is unavailable.
   *
   * When `action_taken` is omitted on a row, the report defaults it to
   * `'pass'` and contributes 0 bytes to every bucket — preserves the
   * §A.1 invariant (drop+compact+offload+tier_down ≈ delivered_pct)
   * without double-counting unmarked patterns.
   */
  per_pattern_breakdown?: Array<{
    pattern_hash: string;
    action_taken?: Action;
    bytes_saved: number;
    dollars_saved?: number | null;
    rate_source?: 'list_price' | 'customer_supplied' | 'unset';
  }>;
}

/**
 * Hook called once per ISO week in the report period. The real
 * `runEstimateVerify` lives in estimate-savings.ts (separate chat).
 * This indirection lets the report run with a stub in tests AND lets
 * the integrating chat point at the live implementation by calling
 * `_setVerifyRunner` at module load.
 */
export type VerifyRunner = (args: {
  backend: CustomerMetricsBackend;
  commitment: CommitmentRecord;
  week_start: string;
  week_end: string;
}) => Promise<WeeklyVerifyResult>;

let runEstimateVerifyImpl: VerifyRunner | undefined;

/**
 * Wire the live runEstimateVerify (estimate-savings.ts calls this at
 * module-load when it ships). Until then, the commitment report
 * surfaces a clear `not_ready` envelope explaining the missing dep.
 */
export function _setVerifyRunner(impl: VerifyRunner): void {
  runEstimateVerifyImpl = impl;
}

/** Test hook — clear the wired runner. */
export function _clearVerifyRunner(): void {
  runEstimateVerifyImpl = undefined;
}

// ─── envelope types ──────────────────────────────────────────────────

export interface CommitmentReportEnvelope {
  commitment: {
    id: string;
    service: string;
    destination: SiemId;
    promised_pct: number;
    contract_type: 'committed' | 'on_demand';
    started_at: string;
  };
  period: { start: string; end: string; days: number };
  delivered_pct: number;
  /**
   * Share of `bytes_in` saved by each engine action, 0..100 percent.
   *
   * Each share is a percent of bytes_in (NOT a share of delivered_pct).
   * Invariant: drop + compact + offload + tier_down ≈ delivered_pct
   * within ±0.5pp rounding. Patterns whose cap CSV row omits the
   * `:<action>` suffix default to `'pass'` and contribute 0 to every
   * bucket — see §E.1 in the patch spec.
   *
   * The `offload` bucket is the metric-side `dropped_bytes_in_window`
   * for patterns where `getOffloadStatusBatch` returned `is_offloaded`;
   * the metric stamp overrides any cap-CSV action. On metric backend
   * timeout the bucket is 0 and a soft-warning lands in `caveats`.
   */
  percent_reduction_by_action: {
    drop: number;
    compact: number;
    offload: number;
    tier_down: number;
  };
  delivered_bytes: number;
  /**
   * Bytes saved by each engine action — bytes counterpart of
   * `percent_reduction_by_action`. Sum to `delivered_bytes` by
   * construction when the offload helper succeeds. On offload-helper
   * timeout the offload bucket is 0 and a caveat surfaces that the
   * contribution was omitted.
   */
  bytes_saved_by_action: {
    drop: number;
    compact: number;
    offload: number;
    tier_down: number;
  };
  /**
   * For year-one committed contracts: the THEORETICAL dollar value of
   * the bytes saved (banked, not realized). For on-demand contracts and
   * post-term-end committed contracts: realized dollar savings.
   *
   * Null when `rate_source === 'unset'` — no $/GB rate available, the
   * report leads with the byte/percent KPI and gates every dollar phrase.
   */
  delivered_dollars: number | null;
  delivered_dollars_kind: 'realized' | 'shadow_committed_year_one';
  promised_dollars: number | null;
  /**
   * Aggregate rate source across the weekly slices. Reduced from each
   * week's `rate_source`:
   *  - all 'customer_supplied'   → 'customer_supplied'
   *  - any 'unset' or mixed/none → 'unset'
   *  - otherwise                  → 'list_price'
   * Surfaced inline in the dollar paragraph and gates the list-price
   * disclaimer.
   */
  rate_source: 'list_price' | 'customer_supplied' | 'unset';
  variance_attribution: {
    cap_fired_pct: number;
    drift_pct: number;
    new_patterns_pct: number;
    leakage_pct: number;
  };
  weekly_series: Array<{
    week_start: string;
    delivered_pct: number;
    delivered_bytes: number;
    delivered_dollars: number | null;
    rate_source: 'list_price' | 'customer_supplied' | 'unset';
  }>;
  forward_confidence: {
    p10_next_90d_pct: number;
    expected_next_90d_pct: number;
    p90_next_90d_pct: number;
    low_data_warning: boolean;
  };
  at_risk_actions: Array<{
    pattern_hash: string;
    issue: 'leakage' | 'new_pattern_uncapped' | 'drift';
    recommended: string;
  }>;
  /**
   * Per-pattern attribution rows merged across the report period.
   *
   * `action_taken` is sourced from the cap CSV `:<action>` suffix
   * (project_unified_savings_tool.md), falling back to `'pass'` when
   * absent. Patterns flagged by `getOffloadStatusBatch.is_offloaded`
   * override to `'offload'` regardless of the cap CSV — the metric
   * stamp is ground truth. `dollars_saved` is null whenever the row's
   * `rate_source === 'unset'`.
   *
   * Empty when the upstream verify runner did not return
   * `per_pattern_breakdown` for any week — see the caveat path in §E.1.
   */
  per_pattern_rows: Array<{
    pattern_hash: string;
    action_taken: Action;
    bytes_saved: number;
    dollars_saved: number | null;
    rate_source: 'list_price' | 'customer_supplied' | 'unset';
  }>;
  annualized_dollars: number | null;
  caveats: string[];
  markdown?: string;
}

// ─── period resolution ──────────────────────────────────────────────

function resolvePeriod(period: '30d' | '90d' | 'ytd'): {
  start: Date;
  end: Date;
  days: number;
} {
  const end = new Date();
  let start: Date;
  if (period === 'ytd') {
    start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
  } else {
    const days = period === '30d' ? 30 : 90;
    start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  }
  const days = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
  );
  return { start, end, days };
}

/**
 * Enumerate weekly windows in [start, end]. Each window is 7 days; the
 * last may be partial, clamped to `end`.
 */
function enumerateWeeks(
  start: Date,
  end: Date
): Array<{ week_start: string; week_end: string }> {
  const weeks: Array<{ week_start: string; week_end: string }> = [];
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  let cursor = new Date(start.getTime());
  while (cursor.getTime() < end.getTime()) {
    const weekEnd = new Date(
      Math.min(cursor.getTime() + 7 * MS_PER_DAY, end.getTime())
    );
    weeks.push({
      week_start: cursor.toISOString().slice(0, 10),
      week_end: weekEnd.toISOString().slice(0, 10),
    });
    cursor = weekEnd;
  }
  return weeks;
}

// ─── Bayesian Beta(α,β) — weekly evidence update ────────────────────

/**
 * Update a Beta(α,β) prior with weekly fractional evidence and return
 * p10 / expected / p90 of the posterior as percentages.
 *
 * Each weekly delivered_pct/100 is treated as a fractional Bernoulli
 * outcome: it adds `pct_frac` to α and `(1 - pct_frac)` to β. This is
 * the conjugate-update form when treating "pct of bytes saved per week"
 * as a continuous Beta-distributed signal.
 *
 * Weak default prior α0=β0=2 (spec §5 Q4 default-chosen). Beta quantile
 * via Wilson-Hilferty Gamma approximation — accurate to ~1pp absolute
 * error for the percentile reporting we do here.
 */
export function bayesianForwardConfidence(
  weekly: Array<{ delivered_pct: number }>,
  priorAlpha = 2,
  priorBeta = 2
): { p10: number; expected: number; p90: number; low_data_warning: boolean } {
  let alpha = priorAlpha;
  let beta = priorBeta;
  for (const w of weekly) {
    const f = Math.max(0, Math.min(1, w.delivered_pct / 100));
    alpha += f;
    beta += 1 - f;
  }
  const expected = (alpha / (alpha + beta)) * 100;
  const p10 = betaQuantile(0.10, alpha, beta) * 100;
  const p90 = betaQuantile(0.90, alpha, beta) * 100;
  return {
    p10,
    expected,
    p90,
    low_data_warning: weekly.length < 2,
  };
}

/**
 * Beta(α,β) quantile via Wilson-Hilferty Gamma approximation. Beta(α,β)
 * has same distribution as G1/(G1+G2) where Gi ~ Gamma(αi, 1). For each
 * Gamma we approximate via the Wilson-Hilferty cube-root transform.
 */
function betaQuantile(p: number, alpha: number, beta: number): number {
  const z = inverseNormalCdf(p);
  const g1 = gammaQuantileWH(alpha, z);
  const g2 = gammaQuantileWH(beta, -z);
  if (g1 + g2 <= 0) return alpha / (alpha + beta);
  return Math.max(0, Math.min(1, g1 / (g1 + g2)));
}

function gammaQuantileWH(k: number, z: number): number {
  // Wilson-Hilferty: Gamma(k,1) ≈ k * (1 - 1/(9k) + z*sqrt(1/(9k)))^3
  const oneOver9k = 1 / (9 * k);
  const root = 1 - oneOver9k + z * Math.sqrt(oneOver9k);
  return Math.max(0, k * root * root * root);
}

function inverseNormalCdf(p: number): number {
  // Beasley-Springer-Moro approximation; accurate to ~4 decimals on (0,1).
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

// ─── aggregation ────────────────────────────────────────────────────

/**
 * Merged per-pattern row used in the envelope's `per_pattern_rows`.
 * Built up by `aggregateWeekly` and (optionally) overridden by the
 * offload-status batch later in `executeCommitmentReport`.
 */
interface MergedPatternRow {
  pattern_hash: string;
  action_taken: Action;
  bytes_saved: number;
  dollars_saved: number | null;
  rate_source: 'list_price' | 'customer_supplied' | 'unset';
}

interface ActionBuckets {
  drop: number;
  compact: number;
  offload: number;
  tier_down: number;
}

function emptyActionBuckets(): ActionBuckets {
  return { drop: 0, compact: 0, offload: 0, tier_down: 0 };
}

function aggregateWeekly(weekly: WeeklyVerifyResult[]): {
  delivered_pct: number;
  delivered_bytes: number;
  delivered_dollars: number | null;
  rate_source: 'list_price' | 'customer_supplied' | 'unset';
  attribution: {
    cap_fired_pct: number;
    drift_pct: number;
    new_patterns_pct: number;
    leakage_pct: number;
  };
  bytes_saved_by_action: ActionBuckets;
  per_pattern_rows: MergedPatternRow[];
  /**
   * True when at least one week supplied `per_pattern_breakdown`. When
   * false, the four-way split degraded to legacy behaviour (all of
   * `delivered_bytes` lands in the `drop` bucket) and the caller must
   * push a caveat.
   */
  per_pattern_breakdown_available: boolean;
} {
  let totalIn = 0;
  let totalDropped = 0;
  let totalDollars = 0;
  let anyDollar = false;
  let capWeighted = 0;
  let driftWeighted = 0;
  let newPatWeighted = 0;
  let leakWeighted = 0;
  // Reduce per-week rate_source: customer_supplied dominates iff ALL
  // contributing weeks (with non-null dollars) are customer_supplied;
  // any 'unset' or absent rate_source on a week with non-null dollars
  // downgrades the aggregate to 'unset'.
  let sawCustomer = false;
  let sawList = false;
  let sawUnsetOrMissing = false;
  const buckets = emptyActionBuckets();
  // Merge per-pattern rows across weeks: same pattern_hash gets its
  // bytes_saved + dollars_saved summed, action_taken latched to the
  // most recent week (last write wins — the action a pattern carries
  // at the end of the period is what FinOps wants to see).
  const merged = new Map<string, MergedPatternRow>();
  let perPatternAvailable = false;
  for (const w of weekly) {
    totalIn += w.bytes_in;
    totalDropped += w.bytes_dropped;
    if (w.delivered_dollars != null && Number.isFinite(w.delivered_dollars)) {
      totalDollars += w.delivered_dollars;
      anyDollar = true;
    }
    const rs = w.rate_source;
    if (rs === 'customer_supplied') sawCustomer = true;
    else if (rs === 'list_price') sawList = true;
    else sawUnsetOrMissing = true;
    const weight = w.bytes_in;
    capWeighted += w.attribution.cap_fired * weight;
    driftWeighted += w.attribution.drift * weight;
    newPatWeighted += w.attribution.new_patterns * weight;
    leakWeighted += w.attribution.leakage * weight;

    if (w.per_pattern_breakdown && w.per_pattern_breakdown.length > 0) {
      perPatternAvailable = true;
      for (const row of w.per_pattern_breakdown) {
        // §E.1: missing action_taken defaults to 'pass'; pass rows
        // contribute 0 to every bucket and 0 bytes_saved.
        const action: Action = row.action_taken ?? 'pass';
        const bytesSaved = Number.isFinite(row.bytes_saved) ? Math.max(0, row.bytes_saved) : 0;
        if (action === 'drop') buckets.drop += bytesSaved;
        else if (action === 'compact') buckets.compact += bytesSaved;
        else if (action === 'offload') buckets.offload += bytesSaved;
        else if (action === 'tier_down') buckets.tier_down += bytesSaved;
        // 'pass' / 'sample' → 0 contribution (sample is a partial cut
        // not represented in the four-way bucket break-out here).

        const rowRate = row.rate_source ?? 'unset';
        const rowDollars =
          rowRate === 'unset' || row.dollars_saved == null || !Number.isFinite(row.dollars_saved)
            ? null
            : row.dollars_saved;
        const prior = merged.get(row.pattern_hash);
        if (!prior) {
          merged.set(row.pattern_hash, {
            pattern_hash: row.pattern_hash,
            action_taken: action,
            bytes_saved: bytesSaved,
            dollars_saved: rowDollars,
            rate_source: rowRate,
          });
        } else {
          prior.bytes_saved += bytesSaved;
          // Sum dollars when both sides have a rate; null sticks if
          // either side was unset so the renderer keeps gating $.
          if (prior.dollars_saved != null && rowDollars != null) {
            prior.dollars_saved += rowDollars;
          } else if (rowDollars != null && prior.dollars_saved == null) {
            prior.dollars_saved = rowDollars;
          }
          // Latch the latest action_taken (last week wins).
          prior.action_taken = action;
          // Rate source: keep prior unless prior was unset.
          if (prior.rate_source === 'unset' && rowRate !== 'unset') {
            prior.rate_source = rowRate;
          }
        }
      }
    }
  }
  // §E.1 fallback: when no week supplied per_pattern_breakdown, the
  // four-way split degrades to legacy behaviour — all delivered_bytes
  // attributed to the `drop` bucket. per_pattern_rows is empty.
  if (!perPatternAvailable) {
    buckets.drop = totalDropped;
  }
  const denom = totalIn > 0 ? totalIn : 1;
  let rate_source: 'list_price' | 'customer_supplied' | 'unset';
  if (sawUnsetOrMissing || (!sawCustomer && !sawList)) rate_source = 'unset';
  else if (sawCustomer && !sawList) rate_source = 'customer_supplied';
  else if (sawList && !sawCustomer) rate_source = 'list_price';
  else rate_source = 'unset'; // mixed list+customer → conservative
  return {
    delivered_pct: totalIn > 0 ? (totalDropped / totalIn) * 100 : 0,
    delivered_bytes: totalDropped,
    delivered_dollars: rate_source === 'unset' || !anyDollar ? null : totalDollars,
    rate_source,
    attribution: {
      cap_fired_pct: (capWeighted / denom) * 100,
      drift_pct: (driftWeighted / denom) * 100,
      new_patterns_pct: (newPatWeighted / denom) * 100,
      leakage_pct: (leakWeighted / denom) * 100,
    },
    bytes_saved_by_action: buckets,
    per_pattern_rows: Array.from(merged.values()),
    per_pattern_breakdown_available: perPatternAvailable,
  };
}

function aggregateAtRiskActions(
  weekly: WeeklyVerifyResult[]
): Array<{
  pattern_hash: string;
  issue: 'leakage' | 'new_pattern_uncapped' | 'drift';
  recommended: string;
}> {
  // Dedup by (pattern_hash, issue), keep last suggested string.
  const seen = new Map<
    string,
    {
      pattern_hash: string;
      issue: 'leakage' | 'new_pattern_uncapped' | 'drift';
      recommended: string;
    }
  >();
  for (const w of weekly) {
    for (const r of w.at_risk_patterns ?? []) {
      const key = `${r.pattern_hash}:${r.issue}`;
      seen.set(key, {
        pattern_hash: r.pattern_hash,
        issue: r.issue,
        recommended: r.suggested,
      });
    }
  }
  // Sort by issue severity: leakage > new_pattern_uncapped > drift, then hash.
  const severity: Record<string, number> = {
    leakage: 0,
    new_pattern_uncapped: 1,
    drift: 2,
  };
  return Array.from(seen.values()).sort((a, b) => {
    const s = severity[a.issue] - severity[b.issue];
    return s !== 0 ? s : a.pattern_hash.localeCompare(b.pattern_hash);
  });
}

// ─── contract-aware dollar accounting ───────────────────────────────

function classifyDollarKind(
  commitment: CommitmentRecord,
  periodEnd: Date
): 'realized' | 'shadow_committed_year_one' {
  if (commitment.contract_type === 'on_demand') return 'realized';
  if (!commitment.term_end) return 'shadow_committed_year_one';
  const termEndMs = Date.parse(commitment.term_end);
  if (isNaN(termEndMs)) return 'shadow_committed_year_one';
  return periodEnd.getTime() >= termEndMs
    ? 'realized'
    : 'shadow_committed_year_one';
}

// ─── markdown rendering ─────────────────────────────────────────────

function renderAsciiChart(
  weekly: Array<{ week_start: string; delivered_pct: number }>,
  promised: number
): string {
  if (weekly.length === 0) return '_(no weekly data)_';
  const maxPct = Math.max(promised, ...weekly.map((w) => w.delivered_pct), 1);
  const width = 32;
  const lines: string[] = [];
  for (const w of weekly) {
    const bars = Math.round((w.delivered_pct / maxPct) * width);
    const bar = '█'.repeat(bars) + '░'.repeat(Math.max(0, width - bars));
    lines.push(`  ${w.week_start}  ${bar} ${w.delivered_pct.toFixed(1)}%`);
  }
  const promisedBars = Math.max(0, Math.min(width, Math.round((promised / maxPct) * width)));
  const promisedMarker = '─'.repeat(promisedBars) + '┤' + ' '.repeat(Math.max(0, width - promisedBars - 1));
  lines.push(`  promised    ${promisedMarker} ${promised.toFixed(1)}%`);
  return lines.join('\n');
}

function renderMarkdown(env: CommitmentReportEnvelope): string {
  const status =
    env.delivered_pct >= env.commitment.promised_pct
      ? 'ON TRACK'
      : env.delivered_pct >= env.commitment.promised_pct * 0.9
        ? 'NEAR TARGET'
        : 'BEHIND';
  const kindLabel =
    env.delivered_dollars_kind === 'shadow_committed_year_one'
      ? 'shadow, committed-volume contract year-one'
      : 'realized';

  const lines: string[] = [];
  lines.push(`# Commitment Report — ${env.commitment.service}`);
  lines.push('');
  lines.push(
    `**Status:** ${status} — delivered **${env.delivered_pct.toFixed(1)}%** vs promised **${env.commitment.promised_pct.toFixed(1)}%** over ${env.period.days} days (${env.period.start.slice(0, 10)} to ${env.period.end.slice(0, 10)}).`
  );
  // §C.1: per-action breakdown beat. Print only non-zero buckets and
  // suppress entirely when delivered_pct is 0 (BEHIND status carries
  // that already). All four percents are share-of-bytes_in, pre-computed
  // in the envelope by the aggregator.
  if (env.delivered_pct > 0) {
    const segs: string[] = [];
    const pa = env.percent_reduction_by_action;
    if (pa.drop > 0) segs.push(`drop ${pa.drop.toFixed(1)}%`);
    if (pa.compact > 0) segs.push(`compact ${pa.compact.toFixed(1)}%`);
    if (pa.offload > 0) segs.push(`offload ${pa.offload.toFixed(1)}%`);
    if (pa.tier_down > 0) segs.push(`tier-down ${pa.tier_down.toFixed(1)}%`);
    if (segs.length > 0) {
      lines.push(`breakdown: ${segs.join(' · ')}`);
    }
  }
  lines.push('');
  // Dollar paragraph: inline `(rate_source=X, kind=Y)`. When rate_source
  // is unset, suppress the dollar figures and report bytes-banked only.
  if (env.rate_source === 'unset' || env.delivered_dollars == null) {
    lines.push(
      `**Bytes delivered:** ${env.delivered_bytes.toLocaleString()} bytes saved. _(rate_source=unset, kind=${kindLabel} — pass effective_ingest_per_gb on log10x_estimate_savings to overlay dollar values.)_`
    );
  } else {
    const promised = env.promised_dollars ?? 0;
    const annualized = env.annualized_dollars ?? 0;
    lines.push(
      `**Dollars** _(rate_source=${env.rate_source}, kind=${kindLabel})_**:** $${env.delivered_dollars.toFixed(0)} delivered vs $${promised.toFixed(0)} promised. Annualized run-rate $${annualized.toFixed(0)}.`
    );
  }
  if (env.delivered_dollars_kind === 'shadow_committed_year_one') {
    lines.push('');
    lines.push(
      `> _Committed-volume contract, year-one. Dollar savings are tracked as bytes-banked headroom; realized dollars start at term-end._`
    );
  }
  // List-price disclaimer (only when rate came from vendors.json).
  if (env.rate_source === 'list_price') {
    lines.push('');
    lines.push(
      `> _Dollar figures use list_price from vendors.json. Pass effective_ingest_per_gb on log10x_estimate_savings (verify) to use your contract rate._`
    );
  }
  lines.push('');
  lines.push('## Weekly delivery');
  lines.push('');
  lines.push('```');
  lines.push(renderAsciiChart(env.weekly_series, env.commitment.promised_pct));
  lines.push('```');
  lines.push('');
  lines.push('## Variance attribution');
  lines.push('');
  lines.push('| Source                 | Share of bytes |');
  lines.push('|------------------------|----------------|');
  lines.push(`| Caps firing as planned | ${env.variance_attribution.cap_fired_pct.toFixed(1)}% |`);
  lines.push(`| Pattern drift          | ${env.variance_attribution.drift_pct.toFixed(1)}% |`);
  lines.push(`| New uncapped patterns  | ${env.variance_attribution.new_patterns_pct.toFixed(1)}% |`);
  lines.push(`| Leakage (under-firing) | ${env.variance_attribution.leakage_pct.toFixed(1)}% |`);

  // §C.2: Savings-by-action table. Dollars column is gated on
  // rate_source !== 'unset' (matches the existing dollar-paragraph
  // rule on line 624-627). Zero-share rows stay in for completeness —
  // FinOps wants to see the zeros to confirm nothing was missed.
  // EXCEPT when the offload bucket is "unknown" (helper timed out),
  // in which case we omit the offload row entirely — see §E.2. That
  // condition is signalled by a specific caveat string, checked here.
  const offloadTimedOut = env.caveats.some((c) =>
    c.startsWith('Offload status lookup timed out')
  );
  const showDollars = env.rate_source !== 'unset' && env.delivered_dollars != null;
  lines.push('');
  lines.push('## Savings by action');
  lines.push('');
  const pa = env.percent_reduction_by_action;
  const ba = env.bytes_saved_by_action;
  // Per-action dollar fractions track byte fractions when delivered_bytes>0;
  // when rate_source==='unset' the column is omitted entirely.
  const dollarShare = (bytes: number): number => {
    if (!showDollars || env.delivered_bytes <= 0 || env.delivered_dollars == null) return 0;
    return env.delivered_dollars * (bytes / env.delivered_bytes);
  };
  if (showDollars) {
    lines.push('| Action    | Share of bytes | Bytes saved | Dollars (rate_source) |');
    lines.push('|-----------|----------------|-------------|-----------------------|');
    lines.push(
      `| Drop      | ${pa.drop.toFixed(1)}%           | ${ba.drop.toLocaleString()} | $${dollarShare(ba.drop).toFixed(0)} (${env.rate_source}) |`
    );
    lines.push(
      `| Compact   | ${pa.compact.toFixed(1)}%           | ${ba.compact.toLocaleString()} | $${dollarShare(ba.compact).toFixed(0)} (${env.rate_source}) |`
    );
    if (!offloadTimedOut) {
      lines.push(
        `| Offload   | ${pa.offload.toFixed(1)}%           | ${ba.offload.toLocaleString()} | $${dollarShare(ba.offload).toFixed(0)} (${env.rate_source}) |`
      );
    }
    lines.push(
      `| Tier-down | ${pa.tier_down.toFixed(1)}%           | ${ba.tier_down.toLocaleString()} | $${dollarShare(ba.tier_down).toFixed(0)} (${env.rate_source}) |`
    );
  } else {
    lines.push('| Action    | Share of bytes | Bytes saved |');
    lines.push('|-----------|----------------|-------------|');
    lines.push(`| Drop      | ${pa.drop.toFixed(1)}%           | ${ba.drop.toLocaleString()} |`);
    lines.push(`| Compact   | ${pa.compact.toFixed(1)}%           | ${ba.compact.toLocaleString()} |`);
    if (!offloadTimedOut) {
      lines.push(`| Offload   | ${pa.offload.toFixed(1)}%           | ${ba.offload.toLocaleString()} |`);
    }
    lines.push(`| Tier-down | ${pa.tier_down.toFixed(1)}%           | ${ba.tier_down.toLocaleString()} |`);
  }
  // §C.3: Offload nudge — declarative wording, no "you / your".
  if (ba.offload > 0) {
    lines.push('');
    lines.push(
      '> _Offloaded volume is queryable via `log10x_retriever_query` for forensic access — pass the period start/end to scan the customer-owned archive._'
    );
  }
  lines.push('');
  lines.push('## Forward confidence (next 90 days)');
  lines.push('');
  lines.push(`- **Expected:** ${env.forward_confidence.expected_next_90d_pct.toFixed(1)}%`);
  lines.push(
    `- **p10 to p90 band:** ${env.forward_confidence.p10_next_90d_pct.toFixed(1)}% to ${env.forward_confidence.p90_next_90d_pct.toFixed(1)}%`
  );
  if (env.forward_confidence.low_data_warning) {
    lines.push('');
    lines.push(
      '> _Fewer than 2 weekly windows of data so far. The forecast band is wide; tighten it by waiting another week or two before re-running._'
    );
  }
  if (env.at_risk_actions.length > 0) {
    lines.push('');
    lines.push('## At-risk patterns');
    lines.push('');
    for (const r of env.at_risk_actions.slice(0, 10)) {
      lines.push(`- \`${r.pattern_hash}\` — **${r.issue.replace(/_/g, ' ')}**. ${r.recommended}`);
    }
  }
  if (env.caveats.length > 0) {
    lines.push('');
    lines.push('## Caveats');
    lines.push('');
    for (const c of env.caveats) lines.push(`- ${c}`);
  }
  return lines.join('\n');
}

// ─── executor ────────────────────────────────────────────────────────

export async function executeCommitmentReport(
  args: CommitmentReportArgs
): Promise<StructuredOutput> {
  const format = args.format ?? 'cfo_md';

  // 1. Resolve commitment record.
  let commitment: CommitmentRecord | undefined;
  if (args.commitment_id) {
    commitment = getCommitment(args.commitment_id);
  } else if (args.service) {
    commitment = findCommitmentByService(args.service, args.environment);
  }

  if (!commitment) {
    const headline = args.commitment_id
      ? `No commitment record found for id "${args.commitment_id}".`
      : args.service
        ? `No commitment record found for service "${args.service}".`
        : 'No commitment record found. Provide commitment_id or service.';
    const remediation = [
      'Create a commitment first by running log10x_configure_engine with target_percent. After the generated PR merges, configure_engine persists a commitment record this tool can read.',
      '',
      'If a commitment already exists, the id is printed in the configure_engine output and lives at $LOG10X_ADVISOR_STATE_DIR/commitments/<id>.json (or $TMPDIR/log10x-advisor-snapshots/commitments/<id>.json).',
    ].join('\n');
    if (format === 'cfo_md') {
      return buildMarkdownEnvelope({
        tool: 'log10x_commitment_report',
        summary: { headline },
        markdown: `# Commitment report unavailable\n\n${headline}\n\n${remediation}`,
      });
    }
    return buildEnvelope({
      tool: 'log10x_commitment_report',
      view: 'summary',
      summary: { headline },
      data: {
        ok: false,
        phase: 'not_ready',
        reason: 'commitment_not_found',
        remediation,
      },
    });
  }

  // 2. Resolve customer metrics backend.
  let backend: CustomerMetricsBackend;
  try {
    const r = await resolveBackend();
    if (!r.backend) {
      throw new CustomerMetricsNotConfiguredError(formatDetectionTrace(r.trace));
    }
    backend = r.backend;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const headline =
      'Customer metrics backend not configured — commitment_report cannot compute weekly verify.';
    if (format === 'cfo_md') {
      return buildMarkdownEnvelope({
        tool: 'log10x_commitment_report',
        summary: { headline },
        markdown: `# Commitment report unavailable\n\n${headline}\n\n${msg}`,
      });
    }
    return buildEnvelope({
      tool: 'log10x_commitment_report',
      view: 'summary',
      summary: { headline },
      data: {
        ok: false,
        phase: 'not_ready',
        reason: 'metrics_backend_missing',
        error: msg,
      },
    });
  }

  // 3. Period + weekly windows.
  const period = resolvePeriod(args.period ?? '90d');
  const commitmentStart = Date.parse(commitment.started_at);
  const effectiveStart =
    !isNaN(commitmentStart) && commitmentStart > period.start.getTime()
      ? new Date(commitmentStart)
      : period.start;
  const weeks = enumerateWeeks(effectiveStart, period.end);

  // 4. Run estimate-savings verify per week, IF the runner is wired.
  if (!runEstimateVerifyImpl) {
    const headline =
      'log10x_estimate_savings dependency not yet available — commitment_report cannot produce weekly verify.';
    const remediation =
      'commitment_report depends on log10x_estimate_savings (verify mode), shipped in the same x%-MCP-cost-tooling branch. Re-run npm run build after merging estimate-savings.';
    if (format === 'cfo_md') {
      return buildMarkdownEnvelope({
        tool: 'log10x_commitment_report',
        summary: { headline },
        markdown: `# Commitment report unavailable\n\n${headline}\n\n${remediation}`,
      });
    }
    return buildEnvelope({
      tool: 'log10x_commitment_report',
      view: 'summary',
      summary: { headline },
      data: {
        ok: false,
        phase: 'not_ready',
        reason: 'estimate_savings_dependency_missing',
        remediation,
      },
    });
  }

  const weeklyResults: WeeklyVerifyResult[] = [];
  const verifyErrors: string[] = [];
  for (const w of weeks) {
    try {
      const r = await runEstimateVerifyImpl({
        backend,
        commitment,
        week_start: w.week_start,
        week_end: w.week_end,
      });
      weeklyResults.push(r);
    } catch (e: unknown) {
      verifyErrors.push(
        `${w.week_start}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // 5. Aggregate + attribution.
  const agg = aggregateWeekly(weeklyResults);
  const atRisk = aggregateAtRiskActions(weeklyResults);

  // 5b. Offload-bucket override via metric-surface stamp (§B.3).
  // The receiver stamps `isDropped="true"` on every offloaded event;
  // getOffloadStatusBatch reads that signal. Any pattern flagged as
  // offloaded has its row's action_taken overridden to 'offload'
  // REGARDLESS of what the cap CSV said — the metric stamp is ground
  // truth. On metric backend timeout / env-load failure the bucket
  // stays 0 and a caveat surfaces (§E.2).
  let offloadHelperTimedOut = false;
  if (agg.per_pattern_breakdown_available && agg.per_pattern_rows.length > 0) {
    try {
      const envs = await loadEnvironments();
      const envCfg = resolveEnv(envs, args.environment);
      const hashes = agg.per_pattern_rows.map((r) => r.pattern_hash);
      const rangeHours = Math.max(1, period.days * 24);
      const batch = await getOffloadStatusBatch(envCfg, {
        patternHashes: hashes,
        metricsEnv: commitment.env,
        range: `${rangeHours}h`,
        timeoutMs: 2000,
      });
      // Empty record == helper failed (per offload-status.ts:228). When
      // every entry is ok:false the same caveat applies (§E.2).
      const haveData = Object.values(batch).some((s) => s && s.ok);
      if (!haveData) {
        offloadHelperTimedOut = true;
      } else {
        for (const row of agg.per_pattern_rows) {
          const status = batch[row.pattern_hash];
          if (!status || !status.ok || !status.is_offloaded) continue;
          // `is_offloaded=true` is only ever set when dropped_bytes is
          // populated (both happy-path and kept-cohort-timeout partial
          // path). The dropped-cohort-timeout partial path forces
          // is_offloaded=false, so this `continue` covers it. The null
          // guard below is belt-and-braces for TS narrowing.
          if (status.dropped_bytes_in_window === null) continue;
          // Move the row's bytes_saved out of its prior bucket; the
          // canonical magnitude for the offload bucket is the metric
          // `dropped_bytes_in_window` (per §B.3 step 3).
          const priorAction = row.action_taken;
          const priorBytes = row.bytes_saved;
          if (priorAction === 'drop') agg.bytes_saved_by_action.drop -= priorBytes;
          else if (priorAction === 'compact') agg.bytes_saved_by_action.compact -= priorBytes;
          else if (priorAction === 'tier_down') agg.bytes_saved_by_action.tier_down -= priorBytes;
          else if (priorAction === 'offload') agg.bytes_saved_by_action.offload -= priorBytes;
          const metricBytes = Math.max(0, status.dropped_bytes_in_window);
          agg.bytes_saved_by_action.offload += metricBytes;
          row.action_taken = 'offload';
          row.bytes_saved = metricBytes;
        }
        // Clamp negative bucket residuals to 0 — pathological if
        // bytes_saved drifted below an offloaded row's prior contribution.
        if (agg.bytes_saved_by_action.drop < 0) agg.bytes_saved_by_action.drop = 0;
        if (agg.bytes_saved_by_action.compact < 0) agg.bytes_saved_by_action.compact = 0;
        if (agg.bytes_saved_by_action.tier_down < 0) agg.bytes_saved_by_action.tier_down = 0;
      }
    } catch {
      offloadHelperTimedOut = true;
    }
  }

  // 5c. Compute percent_reduction_by_action — each bucket as a share of
  // bytes_in (NOT a share of delivered_pct), per §A.1.
  const bytesInTotal = weeklyResults.reduce((a, w) => a + w.bytes_in, 0);
  const pctOfIn = (bytes: number): number =>
    bytesInTotal > 0 ? Math.max(0, Math.min(100, (bytes / bytesInTotal) * 100)) : 0;
  const percent_reduction_by_action = {
    drop: pctOfIn(agg.bytes_saved_by_action.drop),
    compact: pctOfIn(agg.bytes_saved_by_action.compact),
    offload: pctOfIn(agg.bytes_saved_by_action.offload),
    tier_down: pctOfIn(agg.bytes_saved_by_action.tier_down),
  };

  // 6. Bayesian forward confidence (spec §5 Q4 default: weak Beta(2,2)).
  const forecast = bayesianForwardConfidence(
    weeklyResults.map((w) => ({ delivered_pct: w.delivered_pct }))
  );

  // 7. Contract-aware dollar classification.
  const dollarKind = classifyDollarKind(commitment, period.end);
  // promised_dollars and annualized_dollars only make sense when we have
  // a rate. When rate_source==='unset', everything dollar-side is null.
  const promised_dollars =
    agg.rate_source === 'unset'
      ? null
      : commitment.baseline_usd_monthly *
        (period.days / 30) *
        (commitment.promised_pct / 100);
  const annualized_dollars =
    agg.delivered_dollars == null
      ? null
      : annualizeDollars(agg.delivered_dollars, period.days);

  // 8. Caveats.
  const caveats: string[] = [];
  if (dollarKind === 'shadow_committed_year_one') {
    caveats.push(
      'Committed-volume contract, year-one: dollar savings are theoretical (bytes-banked headroom). Realized dollars kick in at contract term-end.'
    );
  }
  if (agg.rate_source === 'list_price') {
    caveats.push(
      'Dollar figures use list_price from vendors.json. Pass effective_ingest_per_gb on log10x_estimate_savings (verify) to use your contract rate.'
    );
  } else if (agg.rate_source === 'unset') {
    caveats.push(
      'No $/GB rate available from upstream verify — dollar figures omitted. Pass effective_ingest_per_gb on log10x_estimate_savings to overlay them.'
    );
  }
  if (verifyErrors.length > 0) {
    caveats.push(
      `${verifyErrors.length} weekly window(s) failed verify: ${verifyErrors.slice(0, 3).join('; ')}`
    );
  }
  if (weeklyResults.length < 2) {
    caveats.push(
      'Fewer than 2 weeks of verify data — forward confidence band is wide.'
    );
  }
  const promisedFloor = commitment.promised_pct - 5;
  if (agg.delivered_pct < promisedFloor) {
    caveats.push(
      `Delivered ${agg.delivered_pct.toFixed(1)}% trails promised ${commitment.promised_pct.toFixed(1)}% by more than 5pp — investigate at-risk patterns.`
    );
  }
  // §E.1: per-pattern breakdown unavailable from upstream verify.
  if (!agg.per_pattern_breakdown_available) {
    caveats.push(
      'Per-pattern action breakdown unavailable — log10x_estimate_savings verify mode did not return per_pattern_breakdown for this period.'
    );
  }
  // §E.2: offload-status helper timed out.
  if (offloadHelperTimedOut) {
    caveats.push(
      'Offload status lookup timed out — offload contribution omitted. Re-run after metrics backend stabilizes.'
    );
  }
  // §B.2: compact rows against a no-op destination signal config drift
  // between the cap CSV and the destination cost model.
  const compactNoOp = (() => {
    const noOpDests: SiemId[] = ['datadog', 'cloudwatch', 'azure-monitor', 'gcp-logging', 'sumo'];
    if (!noOpDests.includes(commitment.destination)) return false;
    return agg.per_pattern_rows.some((r) => r.action_taken === 'compact');
  })();
  if (compactNoOp) {
    caveats.push(
      `Compact action found on ${commitment.destination} but the destination cost model is no-op for compact — likely cap CSV / destination config drift.`
    );
  }
  // §B.4: tier_down bytes are tagged for downstream tier swap, not
  // removed from ingest. Wording mirrors cost.ts:394.
  if (agg.bytes_saved_by_action.tier_down > 0) {
    caveats.push(
      'tier_down bytes are tagged for downstream tier swap, not removed from ingest — savings realize on the destination-side storage tier.'
    );
  }

  // Hold a backend handle reference so unused-import linters stay quiet
  // when the runner stub isn't wired; otherwise `backend` is consumed by
  // the verify loop above.
  void backend;

  const envelope: CommitmentReportEnvelope = {
    commitment: {
      id: commitment.id,
      service: commitment.service,
      destination: commitment.destination,
      promised_pct: commitment.promised_pct,
      contract_type: commitment.contract_type,
      started_at: commitment.started_at,
    },
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      days: period.days,
    },
    delivered_pct: agg.delivered_pct,
    percent_reduction_by_action,
    delivered_bytes: agg.delivered_bytes,
    bytes_saved_by_action: agg.bytes_saved_by_action,
    delivered_dollars: agg.delivered_dollars,
    delivered_dollars_kind: dollarKind,
    promised_dollars,
    rate_source: agg.rate_source,
    variance_attribution: agg.attribution,
    weekly_series: weeklyResults.map((w) => {
      const wRate = w.rate_source ?? 'unset';
      return {
        week_start: w.week_start,
        delivered_pct: w.delivered_pct,
        delivered_bytes: w.bytes_dropped,
        delivered_dollars:
          wRate === 'unset' ||
          w.delivered_dollars == null ||
          !Number.isFinite(w.delivered_dollars)
            ? null
            : w.delivered_dollars,
        rate_source: wRate,
      };
    }),
    forward_confidence: {
      p10_next_90d_pct: forecast.p10,
      expected_next_90d_pct: forecast.expected,
      p90_next_90d_pct: forecast.p90,
      low_data_warning: forecast.low_data_warning,
    },
    at_risk_actions: atRisk,
    per_pattern_rows: agg.per_pattern_rows.map((r) => ({
      pattern_hash: r.pattern_hash,
      action_taken: r.action_taken,
      bytes_saved: r.bytes_saved,
      dollars_saved: r.dollars_saved,
      rate_source: r.rate_source,
    })),
    annualized_dollars,
    caveats,
  };

  // 9. Render output by format.
  if (format === 'cfo_md') {
    envelope.markdown = renderMarkdown(envelope);
    return buildMarkdownEnvelope({
      tool: 'log10x_commitment_report',
      summary: {
        headline: `${commitment.service}: delivered ${agg.delivered_pct.toFixed(1)}% vs promised ${commitment.promised_pct.toFixed(1)}% over ${period.days}d.`,
      },
      markdown: envelope.markdown,
    });
  }

  return buildEnvelope({
    tool: 'log10x_commitment_report',
    view: 'summary',
    summary: {
      headline: `${commitment.service}: delivered ${agg.delivered_pct.toFixed(1)}% vs promised ${commitment.promised_pct.toFixed(1)}% over ${period.days}d.`,
    },
    data: envelope,
  });
}
