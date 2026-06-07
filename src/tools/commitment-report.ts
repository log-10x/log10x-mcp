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
  type StructuredOutput,
} from '../lib/output-types.js';
import { buildChassisEnvelope, buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import {
  resolveBackend,
  formatDetectionTrace,
  CustomerMetricsNotConfiguredError,
  type CustomerMetricsBackend,
} from '../lib/customer-metrics.js';
import {
  annualizeDollars,
  buildDisclosedDollarValue,
  type Action,
  type DisclosedDollarValue,
} from '../lib/cost.js';
import { fmtDisclosedDollar } from '../lib/format.js';
import { DEFAULT_ANALYZER_COST_PER_GB, SIEM_DISPLAY_NAMES, type SiemId } from '../lib/siem/pricing.js';
import { loadEnvironments, resolveEnv } from '../lib/environments.js';
import { buildSourceDisclosureFromEnv } from '../lib/source-disclosure.js';
import { getOffloadStatusBatch } from '../lib/offload-status.js';
import {
  readHistorySince,
  readRecentHistory,
  type RecurRun,
} from '../lib/recur-history-reader.js';
import { parseActionIntent } from '../lib/action-intent-parser.js';
import { DEFAULT_LABELS } from '../lib/promql.js';
import { patternDescriptor } from '../lib/pattern-descriptor.js';

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
    .enum(['cfo_md', 'summary', 'json', 'weekly_digest'])
    .default('cfo_md')
    .describe(
      'cfo_md=executive markdown with weekly chart and forward confidence; summary=typed envelope only; json=full structured data; weekly_digest=7-day operational digest from the recurring tick audit trail.'
    ),
  history_path: z
    .string()
    .optional()
    .describe(
      'Override path to the recurring-tick JSONL audit trail (default: $LOG10X_RECUR_HISTORY_PATH or /tmp/log10x-recur-history.jsonl). Used only when format=weekly_digest.'
    ),
  action_intent_path: z
    .string()
    .optional()
    .describe(
      'Override path to data/action-intent.json (relative to the gitops repo root or absolute). Used only when format=weekly_digest.'
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
  /**
   * Where configure_engine wrote the policy. Lets the verify runner
   * find the cap-CSV + action-intent.json regardless of delivery channel.
   *  - 'gitops'    — fetch via `gh api /repos/<repo>/contents/<path>`
   *  - 'configmap' — fetch via `kubectl get configmap <name> -n <ns>`
   * Absent on records persisted before this field was added; verify
   * falls back to env.gitops?.repo for those.
   */
  delivery_target?:
    | { kind: 'gitops'; repo?: string }
    | { kind: 'configmap'; namespace: string; name: string };
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

/** Test hook — read the current runner (undefined when unwired). */
export function _getVerifyRunner(): VerifyRunner | undefined {
  return runEstimateVerifyImpl;
}

/**
 * Minimal shape consumed from `runEstimateVerify` — typed locally so the
 * adapter doesn't pull in the full `VerifyResult` import (keeps the
 * runtime wire-up in index.ts as the only place that touches both
 * modules together; avoids any future circular-import risk between
 * `tools/commitment-report` and `tools/estimate-savings`).
 *
 * Fields kept narrow on purpose: the renamer (Item 5) will join the
 * cap-CSV `:<action>` suffix to fill `per_pattern_breakdown`. Until
 * then, this adapter leaves the per-pattern field unset and the
 * aggregator's §E.1 fallback bucketizes everything into `drop` (with
 * the caveat already wired at commitment-report.ts:1182).
 */
export interface VerifyResultLike {
  destination: SiemId;
  /** Fraction in [-∞, 1] from estimate-savings: 1 - postPassed/scaledBaseline. */
  delivered_pct: number;
  post_passed_bytes: number;
  post_dropped_bytes: number;
  delivered_dollars_now: number;
  attribution_pct: {
    cap_fired_bytes: number;
    drift_bytes: number;
    new_patterns_bytes: number;
    leakage_bytes: number;
  };
  /** Source of the $/GB rate used inside runEstimateVerify. Item 5 will
   * propagate this from estimate-savings; today the function chooses the
   * list price unless the caller passes effective_ingest_per_gb, so the
   * adapter encodes that choice with the right rate_source label. */
  rate_source?: 'list_price' | 'customer_supplied' | 'unset';
  /**
   * Per-pattern action attribution from runEstimateVerify. When present,
   * the adapter populates WeeklyVerifyResult.per_pattern_breakdown so the
   * commitment-report aggregator buckets bytes by engine action. Actions
   * are sourced from `data/action-intent.json` (canonical) with legacy
   * cap-CSV suffix as fallback. Absent when neither `action_intent_content`
   * nor `cap_csv_content` was supplied to verify.
   */
  per_pattern_breakdown?: Array<{
    pattern_hash: string;
    action: Action;
    delivered_bytes: number;
    expected_bytes: number | null;
    action_source: 'pat_row' | 'container' | 'unattributed';
  }>;
}

/**
 * Adapter: `VerifyResult` (estimate-savings.ts) → `WeeklyVerifyResult`
 * (this file). Item-1 narrow scope:
 *  - delivered_pct: VerifyResult.delivered_pct is a fraction (1 - x);
 *    WeeklyVerifyResult is a percentage in [0, 100], clamped.
 *  - bytes_in / bytes_dropped: from VerifyResult post-window totals.
 *    Treating `post_passed + post_dropped` as the week's bytes_in is
 *    correct when the post window IS the week being reported.
 *  - attribution: VerifyResult.attribution_pct fields are already
 *    fractions in [0,1] (estimate-savings.ts:775 pctOf), matching
 *    WeeklyVerifyResult.attribution's normalized-fraction contract.
 *  - per_pattern_breakdown: populated when runEstimateVerify received
 *    `action_intent_content` (canonical, from data/action-intent.json)
 *    or legacy `cap_csv_content` rows with `:action` suffixes. When
 *    neither is available, the §E.1 fallback in `aggregateWeekly`
 *    attributes all bytes_dropped to the `drop` bucket.
 *
 * `week_start` is propagated through verbatim so the weekly_series
 * row labels match the report's enumerated week-boundary cursor.
 */
export function adaptVerifyResultToWeekly(
  vr: VerifyResultLike,
  week_start: string
): WeeklyVerifyResult {
  const bytesIn = Math.max(0, vr.post_passed_bytes + vr.post_dropped_bytes);
  const bytesDropped = Math.max(0, vr.post_dropped_bytes);
  // VerifyResult.delivered_pct can go negative (drift swamped the cap).
  // WeeklyVerifyResult clamps to [0, 100] per its docstring.
  const deliveredPct = Math.max(0, Math.min(100, vr.delivered_pct * 100));
  const dollars = Number.isFinite(vr.delivered_dollars_now)
    ? vr.delivered_dollars_now
    : 0;
  const rateSource = vr.rate_source ?? 'list_price';
  // Item 5: when runEstimateVerify supplied per_pattern_breakdown
  // (cap-CSV join), translate it into the WeeklyVerifyResult shape so
  // the aggregator can attribute bytes to action buckets WITHOUT
  // double-counting unmarked rows. `delivered_bytes` becomes
  // `bytes_saved`; `expected_bytes` is dropped (the commitment-report
  // aggregator does not need it once rate_source is per-row stable).
  // Per-row dollars_saved is derived from bytes_saved × the same rate
  // verify used, since runEstimateVerify already chose that rate.
  let per_pattern_breakdown: WeeklyVerifyResult['per_pattern_breakdown'];
  if (vr.per_pattern_breakdown && vr.per_pattern_breakdown.length > 0) {
    // Per-row dollars: the verify already computed total
    // `delivered_dollars_now` against `post_passed_bytes` (delivery-side
    // billing). Per-pattern $ saved scales by the row's bytes against
    // the post_dropped_bytes total; when rate_source is 'unset' we
    // surface null. This keeps the commitment-report aggregator's
    // dollars-by-action math reconcilable to the envelope's
    // `delivered_dollars` (already weighted by bytes).
    const totalDroppedFromRows = vr.per_pattern_breakdown.reduce(
      (s, r) => s + (Number.isFinite(r.delivered_bytes) ? r.delivered_bytes : 0),
      0
    );
    per_pattern_breakdown = vr.per_pattern_breakdown.map((r) => {
      const safeBytes = Number.isFinite(r.delivered_bytes)
        ? Math.max(0, r.delivered_bytes)
        : 0;
      const dollarsSaved =
        rateSource === 'unset' ||
        !Number.isFinite(dollars) ||
        totalDroppedFromRows <= 0
          ? null
          : dollars * (safeBytes / totalDroppedFromRows);
      return {
        pattern_hash: r.pattern_hash,
        action_taken: r.action,
        bytes_saved: safeBytes,
        dollars_saved: dollarsSaved,
        rate_source: rateSource,
      };
    });
  }

  return {
    week_start,
    bytes_in: bytesIn,
    bytes_dropped: bytesDropped,
    delivered_pct: deliveredPct,
    delivered_dollars: dollars,
    attribution: {
      cap_fired: Math.max(0, Math.min(1, vr.attribution_pct.cap_fired_bytes)),
      drift: Math.max(0, Math.min(1, vr.attribution_pct.drift_bytes)),
      new_patterns: Math.max(
        0,
        Math.min(1, vr.attribution_pct.new_patterns_bytes)
      ),
      leakage: Math.max(0, Math.min(1, vr.attribution_pct.leakage_bytes)),
    },
    rate_source: rateSource,
    per_pattern_breakdown,
  };
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
   * Invariant: drop + compact + offload + tier_down + sample ≈ delivered_pct
   * within ±1pp rounding. `pass` always contributes 0 (the engine did not
   * touch the bytes) but is surfaced for completeness so a caller can
   * verify the bucket map covers every action label the per_pattern_rows
   * carries — i.e. the bucket map is structurally exhaustive over the
   * action enum, not the narrow "savings actions only" subset.
   *
   * On reconciliation failure (bucket sum diverges from delivered_pct by
   * more than 1pp), a `reconciliation_warning` caveat is pushed; the
   * envelope is rendered without modification so the CFO can see the
   * mismatch instead of getting a silently-corrected number.
   *
   * The `offload` bucket is the metric-side `dropped_bytes_in_window`
   * for patterns where `getOffloadStatusBatch` returned `is_offloaded`;
   * the metric stamp overrides any action-intent entry. On metric backend
   * timeout the bucket is 0 and a soft-warning lands in `caveats`.
   */
  percent_reduction_by_action: {
    drop: number;
    compact: number;
    offload: number;
    tier_down: number;
    sample: number;
    pass: number;
  };
  delivered_bytes: number;
  /**
   * Bytes saved by each engine action — bytes counterpart of
   * `percent_reduction_by_action`. Sum to `delivered_bytes` by
   * construction when the offload helper succeeds. On offload-helper
   * timeout the offload bucket is 0 and a caveat surfaces that the
   * contribution was omitted.
   *
   * Same key set as `percent_reduction_by_action` — sample carries real
   * bytes_saved (sample N=2 ≈ 50% reduction per pattern), pass stays 0.
   */
  bytes_saved_by_action: {
    drop: number;
    compact: number;
    offload: number;
    tier_down: number;
    sample: number;
    pass: number;
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
  /** Disclosed-value mirror of delivered_dollars; null when rate_source==='unset'. */
  delivered_dollars_disclosed: DisclosedDollarValue | null;
  delivered_dollars_kind: 'realized' | 'shadow_committed_year_one';
  promised_dollars: number | null;
  /** Disclosed-value mirror of promised_dollars; null when rate_source==='unset'. */
  promised_dollars_disclosed: DisclosedDollarValue | null;
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
    /**
     * Service that emits the pattern (joined from TSDB after weekly
     * aggregation). Surfaced in the CFO markdown at-risk bullet so the
     * reader sees a service-anchored identity instead of the raw hash.
     * Undefined when the descriptor join failed for this hash.
     */
    service?: string;
    /**
     * Engine `message_pattern` token string for the hash (joined from
     * TSDB). Rendered through `patternDescriptor` into the at-risk
     * bullet prose. Absent when the descriptor join returned no result.
     */
    symbol_message?: string;
  }>;
  /**
   * Per-pattern attribution rows merged across the report period.
   *
   * `action_taken` is sourced from `data/action-intent.json` (canonical)
   * via the `runEstimateVerify` → `computeActionSplit` path, falling back
   * to legacy cap-CSV action suffixes for rows written before the
   * action-intent migration. Patterns flagged by
   * `getOffloadStatusBatch.is_offloaded` override to `'offload'`
   * regardless — the metric stamp is ground truth. `dollars_saved` is
   * null whenever the row's `rate_source === 'unset'`.
   *
   * Empty when the upstream verify runner did not return
   * `per_pattern_breakdown` for any week — see the caveat path in §E.1.
   *
   * `intent_observation_mismatch` flags rows where the configured
   * intent (`action_taken='pass'`) disagrees with the observed
   * dropped-bytes signal (`bytes_saved > 0`). This is the canonical
   * policy-drift indicator: the engine is reducing bytes on a pattern
   * the policy says to pass through, OR the new policy has not yet
   * fully propagated to the cluster. The row is surfaced as-is — we
   * do NOT zero out bytes_saved here because the drift signal is
   * exactly what FinOps wants to see; rendering layers should call
   * out the flag rather than hide it.
   */
  per_pattern_rows: Array<{
    pattern_hash: string;
    action_taken: Action;
    bytes_saved: number;
    dollars_saved: number | null;
    rate_source: 'list_price' | 'customer_supplied' | 'unset';
    intent_observation_mismatch?: boolean;
  }>;
  annualized_dollars: number | null;
  /** Disclosed-value mirror of annualized_dollars; null when rate_source==='unset'. */
  annualized_dollars_disclosed: DisclosedDollarValue | null;
  caveats: string[];
  markdown?: string;
  /**
   * One-paragraph plain-prose distillation. Populated on every success
   * path. Dollar figures gated by rate_source.
   */
  human_summary?: string;
}

// ─── weekly-digest types ─────────────────────────────────────────────

/**
 * Per-action attribution totals across the 7-day digest window.
 * Sourced from `data/action-intent.json` entries active during the period.
 */
export interface DigestActionSplit {
  /** Count of patterns actively assigned to this action. */
  pattern_count: number;
}

/**
 * A single tick run as it appears in the digest tick-history section.
 */
export interface DigestTickEntry {
  /** ISO-8601 timestamp of the tick. */
  ts: string;
  /** Tick outcome status. */
  status: 'no_change' | 'applied' | 'dry_run' | 'error';
  /** Projected savings percentage at tick time. */
  projected_savings_pct: number;
  /** Number of patterns whose action changed vs. prior state. */
  delta_patterns: number;
  /** Change in savings pp. */
  delta_pp: number;
  /** Whether this tick wrote new CSV/intent files. */
  changed: boolean;
}

/**
 * A pattern that was not in the prior week's action-intent but appeared
 * this week (new_this_week) or a pattern whose byte volume grew >5x
 * week-over-week (anomaly).
 */
export interface DigestPatternNote {
  pattern_hash: string;
  kind: 'new_this_week' | 'anomaly_growth';
  /**
   * For anomaly_growth: ratio of current_week_savings_pct / prior_week_savings_pct.
   * Undefined for new_this_week.
   */
  growth_ratio?: number;
  /**
   * Service that emits the pattern (joined from TSDB). Undefined when the
   * descriptor join failed or the action-intent entry had no `service`
   * field. Used as a fallback when `symbol_message` is unavailable.
   */
  service?: string;
  /**
   * Engine `message_pattern` token string for the hash (joined from TSDB).
   * Source for the human-facing descriptor in the rendered prose. Absent
   * when the descriptor join returned no result for this hash.
   */
  symbol_message?: string;
  /** Human-readable note. */
  note: string;
}

/**
 * The envelope produced by `format=weekly_digest`.
 *
 * Reads the recurring-tick audit trail (JSONL) plus the current
 * `data/action-intent.json` and produces an operational summary for the
 * last 7 days.
 */
export interface WeeklyDigestEnvelope {
  /** ISO-8601 start of the 7-day window. */
  window_start: string;
  /** ISO-8601 end of the 7-day window (now). */
  window_end: string;

  /**
   * Total bytes projected saved over the window (sum of
   * `projected_savings_pct * total_bytes_proxy`).  This is a directional
   * number derived from the tick projected_savings_pct values — the
   * ground-truth byte count lives in the verify runner path; for a
   * quick operational digest the projection is sufficient.
   *
   * Null when the history is empty (no ticks ran).
   */
  total_projected_savings_pct: number | null;

  /**
   * Number of ticks that ran during the window.
   */
  tick_count: number;

  /**
   * Number of ticks that applied a change (status==='applied').
   */
  applied_count: number;

  /**
   * Per-action count from the current `data/action-intent.json`.
   * Key is the Action string ('drop' | 'compact' | 'sample' | 'offload' | 'tier_down' | 'pass').
   */
  action_distribution: Record<string, DigestActionSplit>;

  /**
   * Ordered tick history (oldest first) for ticks that ran within the window.
   */
  tick_history: DigestTickEntry[];

  /**
   * Patterns that are new this week (present in current intent but absent
   * from the oldest tick snapshot's implied prior state) or that grew >5x
   * in their savings contribution week-over-week (anomaly).
   */
  pattern_notes: DigestPatternNote[];

  /** Caveats (missing history file, parse errors, empty intent, etc.). */
  caveats: string[];

  /** Rendered markdown digest. Populated when format=weekly_digest. */
  markdown?: string;

  /** One-paragraph plain-prose summary. */
  human_summary: string;
}

// ─── weekly-digest builder ───────────────────────────────────────────

/**
 * Compute the action distribution from a parsed action-intent content
 * string.  Returns an empty map when the content is absent or unparseable.
 */
function buildActionDistribution(
  intentContent: string | null
): Record<string, DigestActionSplit> {
  if (!intentContent) return {};
  const parsed = parseActionIntent(intentContent);
  const dist: Record<string, DigestActionSplit> = {};
  for (const entry of parsed.entries) {
    const a = entry.action;
    if (!dist[a]) dist[a] = { pattern_count: 0 };
    dist[a]!.pattern_count += 1;
  }
  return dist;
}

/**
 * Build pattern notes (new patterns + anomaly detection) from tick history.
 *
 * "New this week": patterns present in the current intent that were not
 * present in the earliest tick in the window.  We use `delta_patterns` as
 * a proxy since the full per-pattern snapshot is not embedded in the JSONL;
 * if the earliest applied tick had delta_patterns > 0 we note the count as
 * new patterns.
 *
 * "Anomaly growth": the projected_savings_pct grew >5x between the first
 * and last tick in the window (whole-window signal, not per-pattern since
 * per-pattern bytes are not in the JSONL).
 */
function buildPatternNotes(
  runs: RecurRun[],
  intentContent: string | null,
  descriptors?: Map<string, PatternHashDescriptor>
): DigestPatternNote[] {
  const notes: DigestPatternNote[] = [];

  if (runs.length === 0) return notes;

  // New-this-week: collect pattern hashes from current intent that are
  // newly assigned (use action-intent entries set_at_iso within the window).
  //
  // Hash-leak fix: the rendered `note` prose is the only field that
  // surfaces in the digest markdown bullet AND in the structured
  // pattern_notes payload. Lead with descriptor + service. The bare
  // pattern_hash stays on the structured field (`note.pattern_hash`)
  // for machine consumers; it never lands in the prose.
  if (intentContent) {
    const parsed = parseActionIntent(intentContent);
    const windowEnd = Date.now();
    const windowStart = windowEnd - 7 * 24 * 60 * 60 * 1000;
    for (const entry of parsed.entries) {
      const setAt = entry.set_at_iso ? Date.parse(entry.set_at_iso) : 0;
      if (setAt >= windowStart && setAt <= windowEnd) {
        const desc = descriptors?.get(entry.pattern_hash);
        // Prefer the entry's own `service` (set by the writer at the
        // moment of intent), fall back to the descriptor join, then to
        // the renderPatternLabel "(unnamed pattern)" fallback.
        const service = entry.service || desc?.service || '';
        const symbol_message = desc?.symbol_message;
        const label = renderPatternLabel(symbol_message, service);
        notes.push({
          pattern_hash: entry.pattern_hash,
          kind: 'new_this_week',
          ...(service ? { service } : {}),
          ...(symbol_message ? { symbol_message } : {}),
          note: `${label} added to ${entry.action} plan this week (set ${entry.set_at_iso}).`,
        });
      }
    }
  }

  // Anomaly growth: compare first vs last applied tick's projected_savings_pct.
  const applied = runs.filter((r) => r.status === 'applied');
  if (applied.length >= 2) {
    const first = applied[0]!;
    const last = applied[applied.length - 1]!;
    if (
      first.projected_savings_pct > 0 &&
      last.projected_savings_pct / first.projected_savings_pct >= 5
    ) {
      const ratio = last.projected_savings_pct / first.projected_savings_pct;
      notes.push({
        pattern_hash: '<aggregate>',
        kind: 'anomaly_growth',
        growth_ratio: parseFloat(ratio.toFixed(2)),
        note: `Projected savings grew ${ratio.toFixed(1)}x over the week (${first.projected_savings_pct.toFixed(1)}% → ${last.projected_savings_pct.toFixed(1)}%) — more patterns came into scope.`,
      });
    }
  }

  return notes;
}

/**
 * Render a markdown weekly-digest from the envelope.
 */
function renderWeeklyDigestMarkdown(env: WeeklyDigestEnvelope): string {
  const lines: string[] = [];
  lines.push('# Weekly Digest — Recurring Cost-Reduction Loop');
  lines.push('');
  lines.push(
    `**Window:** ${env.window_start.slice(0, 10)} to ${env.window_end.slice(0, 10)}`
  );
  lines.push('');

  // Summary beat
  const savingsBeat =
    env.total_projected_savings_pct != null
      ? `**Projected savings:** ${env.total_projected_savings_pct.toFixed(1)}% (latest tick).`
      : '_No tick runs in window — no projection available._';
  lines.push(savingsBeat);
  lines.push('');
  lines.push(
    `**Ticks ran:** ${env.tick_count} total, ${env.applied_count} applied changes.`
  );
  lines.push('');

  // Action distribution
  const actionKeys = Object.keys(env.action_distribution).sort();
  if (actionKeys.length > 0) {
    lines.push('## Current action-intent distribution');
    lines.push('');
    lines.push('| Action | Patterns |');
    lines.push('|--------|----------|');
    for (const k of actionKeys) {
      const d = env.action_distribution[k];
      if (d) {
        lines.push(`| ${k} | ${d.pattern_count} |`);
      }
    }
    lines.push('');
  }

  // Tick history
  if (env.tick_history.length > 0) {
    lines.push('## Tick history');
    lines.push('');
    lines.push('| Timestamp | Status | Savings % | Delta patterns | Delta pp |');
    lines.push('|-----------|--------|-----------|----------------|----------|');
    for (const t of env.tick_history) {
      const ts = t.ts.slice(0, 19).replace('T', ' ');
      lines.push(
        `| ${ts} | ${t.status} | ${t.projected_savings_pct.toFixed(1)}% | ${t.delta_patterns} | ${t.delta_pp >= 0 ? '+' : ''}${t.delta_pp.toFixed(1)}pp |`
      );
    }
    lines.push('');
  } else {
    lines.push('_No ticks ran in this window._');
    lines.push('');
  }

  // New patterns / anomalies
  const newPatterns = env.pattern_notes.filter((n) => n.kind === 'new_this_week');
  const anomalies = env.pattern_notes.filter((n) => n.kind === 'anomaly_growth');

  if (newPatterns.length > 0) {
    lines.push('## New patterns this week');
    lines.push('');
    for (const p of newPatterns.slice(0, 20)) {
      // Hash-leak fix: `p.note` already leads with the descriptor +
      // service label (or "(unnamed pattern)") via buildPatternNotes.
      // Emit the note directly, no leading hash.
      lines.push(`- ${p.note}`);
    }
    if (newPatterns.length > 20) {
      lines.push(`- _...and ${newPatterns.length - 20} more_`);
    }
    lines.push('');
  }

  if (anomalies.length > 0) {
    lines.push('## Anomalies (>5x growth week-over-week)');
    lines.push('');
    for (const a of anomalies) {
      lines.push(`- ${a.note}`);
    }
    lines.push('');
  }

  if (env.caveats.length > 0) {
    lines.push('## Caveats');
    lines.push('');
    for (const c of env.caveats) lines.push(`- ${c}`);
  }

  return lines.join('\n');
}

/**
 * Execute the weekly-digest path.
 *
 * Does NOT require a commitment record or a live metrics backend.
 * Reads only the JSONL audit trail and the current action-intent.json.
 */
async function executeWeeklyDigest(
  args: CommitmentReportArgs
): Promise<StructuredOutput> {
  const caveats: string[] = [];

  // 7-day window
  const now = new Date();
  const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Read tick history
  const runs = readHistorySince(windowStart.getTime(), args.history_path);
  if (runs.length === 0) {
    caveats.push(
      'No tick runs found in the last 7 days. Run tenx-recur at least once to populate the audit trail.'
    );
  }

  // Read action-intent.json — try the supplied override path first, then
  // fall back to LOG10X_GITOPS_REPO_PATH/data/action-intent.json, then
  // the recurring-tick default temp path.
  let intentContent: string | null = null;
  const intentCandidates: string[] = [];

  if (args.action_intent_path) {
    intentCandidates.push(args.action_intent_path);
  }
  const gitopsRepo =
    process.env['LOG10X_GITOPS_REPO_PATH'] ??
    join(tmpdir(), 'log10x-recur-repo');
  intentCandidates.push(join(gitopsRepo, 'data', 'action-intent.json'));

  for (const candidate of intentCandidates) {
    try {
      intentContent = readFileSync(candidate, 'utf8');
      break;
    } catch {
      // try next
    }
  }

  if (!intentContent) {
    caveats.push(
      'data/action-intent.json not found — action distribution unavailable. Set LOG10X_GITOPS_REPO_PATH or pass action_intent_path.'
    );
  }

  // Aggregate
  const actionDistribution = buildActionDistribution(intentContent);

  // Hash-leak fix: collect the candidate hashes (intent entries set
  // within the 7-day window) and best-effort fetch descriptors so the
  // rendered notes lead with `descriptor (service)`, not the raw hash.
  // Backend resolution failure → empty map → renderPatternLabel
  // degrades to "(unnamed pattern)" rather than failing the digest.
  let descriptors: Map<string, PatternHashDescriptor> | undefined;
  if (intentContent) {
    const parsed = parseActionIntent(intentContent);
    const windowEnd = Date.now();
    const windowStartMs = windowEnd - 7 * 24 * 60 * 60 * 1000;
    const candidateHashes: string[] = [];
    for (const entry of parsed.entries) {
      const setAt = entry.set_at_iso ? Date.parse(entry.set_at_iso) : 0;
      if (setAt >= windowStartMs && setAt <= windowEnd) {
        candidateHashes.push(entry.pattern_hash);
      }
    }
    if (candidateHashes.length > 0) {
      try {
        const r = await resolveBackend();
        if (r.backend) {
          // commitment.env not available in the digest path; default to
          // the env nickname or 'prod' is wrong — instead, scope only by
          // hash + isDropped filter (the env label is required by the
          // selector). Read the env from args.environment when set;
          // otherwise omit the env filter by passing a wildcard-ish
          // env="" (callers without an explicit environment get whatever
          // the backend's default scope matches).
          const digestEnv = args.environment ?? '';
          descriptors = await fetchHashDescriptors(
            r.backend,
            digestEnv,
            candidateHashes,
            '7d'
          );
        }
      } catch {
        // best-effort; leave descriptors undefined
      }
    }
  }

  const patternNotes = buildPatternNotes(runs, intentContent, descriptors);

  const appliedRuns = runs.filter((r) => r.status === 'applied');
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : undefined;

  // total_projected_savings_pct: report the latest tick's projected value
  // (most recent applied state is the operational ground truth; averaging
  // projections across ticks double-counts stable savings).
  const totalProjectedSavingsPct =
    latestRun != null ? latestRun.projected_savings_pct : null;

  const tickHistory: DigestTickEntry[] = runs.map((r) => ({
    ts: r.ts,
    status: r.status,
    projected_savings_pct: r.projected_savings_pct,
    delta_patterns: r.delta_patterns,
    delta_pp: r.delta_pp,
    changed: r.status === 'applied',
  }));

  // Human summary
  const savingsLine =
    totalProjectedSavingsPct != null
      ? `Latest projected savings: ${totalProjectedSavingsPct.toFixed(1)}%.`
      : 'No savings projection available.';
  const actionLine =
    Object.keys(actionDistribution).length > 0
      ? ` Active actions: ${Object.entries(actionDistribution)
          .filter(([, v]) => v.pattern_count > 0)
          .map(([k, v]) => `${k}=${v.pattern_count}`)
          .join(', ')}.`
      : '';
  const tickLine = ` ${runs.length} tick(s) ran, ${appliedRuns.length} applied changes.`;
  const noteCount = patternNotes.length;
  const noteLine = noteCount > 0 ? ` ${noteCount} pattern note(s) flagged.` : '';
  const human_summary = `Weekly digest (${windowStart.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}). ${savingsLine}${tickLine}${actionLine}${noteLine}`;

  const envelope: WeeklyDigestEnvelope = {
    window_start: windowStart.toISOString(),
    window_end: now.toISOString(),
    total_projected_savings_pct: totalProjectedSavingsPct,
    tick_count: runs.length,
    applied_count: appliedRuns.length,
    action_distribution: actionDistribution,
    tick_history: tickHistory,
    pattern_notes: patternNotes,
    caveats,
    human_summary,
  };

  envelope.markdown = renderWeeklyDigestMarkdown(envelope);

  return buildChassisEnvelope({
    tool: 'log10x_commitment_report',
    view: 'summary',
    headline: human_summary,
    status: 'success',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {},
    scope: { window: `${args.history_path ? '7d' : '30d'}`, window_basis: 'explicit' },
    payload: envelope,
    human_summary,
  });
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

// ─── descriptor join ────────────────────────────────────────────────

/**
 * Per-hash descriptor row joined from TSDB. The bullet renderers in the
 * weekly digest + CFO markdown use this to swap raw 11-char
 * `pattern_hash` strings for a user-facing `descriptor + service` label
 * (same primitive `top_patterns` and `pattern_diff` already rely on).
 */
export interface PatternHashDescriptor {
  service: string;
  symbol_message: string;
}

/**
 * Resolve `pattern_hash → (service, symbol_message)` for a batch of
 * hashes using the live customer metrics backend.
 *
 * Issues the same `sum by (hash, service, message_pattern)` PromQL that
 * `estimate-savings` runs (estimate-savings.ts:807) and picks the
 * dominant (service, descriptor) per hash by bytes, lexicographic
 * tie-break on service then descriptor. Returns an empty map on any
 * query error so the renderers degrade to "(unnamed pattern)" rather
 * than failing the whole report.
 */
export async function fetchHashDescriptors(
  backend: CustomerMetricsBackend,
  metricsEnv: string,
  hashes: string[],
  range: string
): Promise<Map<string, PatternHashDescriptor>> {
  const out = new Map<string, PatternHashDescriptor>();
  const uniq = Array.from(new Set(hashes.filter((h): h is string => typeof h === 'string' && h.length > 0)));
  if (uniq.length === 0) return out;
  const L = DEFAULT_LABELS;
  const hashList = uniq.map((h) => h.replace(/[\\"]/g, (c) => `\\${c}`)).join('|');
  const selector =
    `${L.hash}=~"${hashList}",${L.env}="${metricsEnv}",isDropped!="true"`;
  const query =
    `sum by (${L.hash},${L.service},${L.pattern}) ` +
    `(increase(all_events_summaryBytes_total{${selector}}[${range}]))`;
  let res: Awaited<ReturnType<CustomerMetricsBackend['queryInstant']>>;
  try {
    res = await backend.queryInstant(query);
  } catch {
    return out;
  }
  const rows = res?.data?.result ?? [];
  const acc = new Map<string, { service: string; symbol_message: string; bytes: number }>();
  for (const row of rows) {
    const hash = row.metric?.[L.hash];
    const svc = row.metric?.[L.service] ?? '';
    const sm = row.metric?.[L.pattern] ?? '';
    if (!hash) continue;
    const v = row.value ? parseFloat(row.value[1]) : NaN;
    const bytes = Number.isFinite(v) ? v : 0;
    const prior = acc.get(hash);
    if (
      !prior ||
      bytes > prior.bytes ||
      (bytes === prior.bytes && svc.localeCompare(prior.service) < 0) ||
      (bytes === prior.bytes && svc === prior.service && sm.localeCompare(prior.symbol_message) < 0)
    ) {
      acc.set(hash, { service: svc, symbol_message: sm, bytes });
    }
  }
  for (const [hash, { service, symbol_message }] of acc.entries()) {
    out.set(hash, { service, symbol_message });
  }
  return out;
}

/**
 * Render a hash-free human label from a joined descriptor row. Falls
 * back to "(unnamed pattern)" when both the descriptor and service
 * strings are empty so the rendered prose never leaks the bare hash.
 *
 * The output is the SAME shape every hash-free renderer in the catalog
 * uses (top_patterns, pattern_diff): tokenized descriptor first, service
 * trailing in parens when present.
 */
function renderPatternLabel(
  symbol_message: string | undefined,
  service: string | undefined
): string {
  const desc = symbol_message ? patternDescriptor(symbol_message, '', 60) : '';
  const svc = service && service.trim() ? service.trim() : '';
  if (desc && svc) return `${desc} (${svc})`;
  if (desc) return desc;
  if (svc) return svc;
  return '(unnamed pattern)';
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
  /** True when action_taken='pass' and bytes_saved > 0 (policy drift). */
  intent_observation_mismatch?: boolean;
}

interface ActionBuckets {
  drop: number;
  compact: number;
  offload: number;
  tier_down: number;
  sample: number;
  pass: number;
}

function emptyActionBuckets(): ActionBuckets {
  return { drop: 0, compact: 0, offload: 0, tier_down: 0, sample: 0, pass: 0 };
}

/** Sum of all action buckets in bytes. */
function sumActionBuckets(b: ActionBuckets): number {
  return b.drop + b.compact + b.offload + b.tier_down + b.sample + b.pass;
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
        // §E.1: missing action_taken defaults to 'pass'. Every action
        // (including pass and sample) accumulates its bytes_saved into
        // the matching bucket so the bucket map is structurally
        // exhaustive over the action enum. pass rows with non-zero
        // bytes_saved indicate engine/intent divergence — they land in
        // the pass bucket here; the divergence flag on the per-pattern
        // row is what surfaces the drift to the operator.
        const action: Action = row.action_taken ?? 'pass';
        const bytesSaved = Number.isFinite(row.bytes_saved) ? Math.max(0, row.bytes_saved) : 0;
        if (action === 'drop') buckets.drop += bytesSaved;
        else if (action === 'compact') buckets.compact += bytesSaved;
        else if (action === 'offload') buckets.offload += bytesSaved;
        else if (action === 'tier_down') buckets.tier_down += bytesSaved;
        else if (action === 'sample') buckets.sample += bytesSaved;
        else if (action === 'pass') buckets.pass += bytesSaved;

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
  // Bug #2: stamp intent_observation_mismatch on rows where intent is
  // 'pass' but bytes_saved is non-zero (engine is reducing bytes on a
  // pattern the policy says to pass through). The row stays in the
  // 'pass' bucket — the flag is what surfaces the drift.
  for (const row of merged.values()) {
    if (row.action_taken === 'pass' && row.bytes_saved > 0) {
      row.intent_observation_mismatch = true;
    }
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
    // Disclosure tail carries rate_source semantics; only the contract-kind
    // qualifier still needs an inline label.
    lines.push(
      `**Dollars** _(kind=${kindLabel})_**:** ${fmtDisclosedDollar(env.delivered_dollars_disclosed)} delivered vs ${fmtDisclosedDollar(env.promised_dollars_disclosed)} promised. Annualized run-rate ${fmtDisclosedDollar(env.annualized_dollars_disclosed)}.`
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
  // when rate_source==='unset' the column is omitted entirely. Wrap each
  // share in a DisclosedDollarValue so the disclosure tail rides every cell
  // (the rate_source / list-price caveat is no longer inlined per row).
  const siemLabel = SIEM_DISPLAY_NAMES[env.commitment.destination] ?? null;
  const listRatePerGb =
    env.rate_source === 'list_price'
      ? (DEFAULT_ANALYZER_COST_PER_GB[env.commitment.destination] ?? null)
      : null;
  const dollarShareDisclosed = (bytes: number): DisclosedDollarValue | null => {
    if (!showDollars || env.delivered_bytes <= 0 || env.delivered_dollars == null) return null;
    const value = env.delivered_dollars * (bytes / env.delivered_bytes);
    return buildDisclosedDollarValue(value, env.rate_source, siemLabel, listRatePerGb);
  };
  if (showDollars) {
    lines.push('| Action    | Share of bytes | Bytes saved | Dollars |');
    lines.push('|-----------|----------------|-------------|---------|');
    lines.push(
      `| Drop      | ${pa.drop.toFixed(1)}%           | ${ba.drop.toLocaleString()} | ${fmtDisclosedDollar(dollarShareDisclosed(ba.drop))} |`
    );
    lines.push(
      `| Compact   | ${pa.compact.toFixed(1)}%           | ${ba.compact.toLocaleString()} | ${fmtDisclosedDollar(dollarShareDisclosed(ba.compact))} |`
    );
    if (!offloadTimedOut) {
      lines.push(
        `| Offload   | ${pa.offload.toFixed(1)}%           | ${ba.offload.toLocaleString()} | ${fmtDisclosedDollar(dollarShareDisclosed(ba.offload))} |`
      );
    }
    lines.push(
      `| Tier-down | ${pa.tier_down.toFixed(1)}%           | ${ba.tier_down.toLocaleString()} | ${fmtDisclosedDollar(dollarShareDisclosed(ba.tier_down))} |`
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
      // Hash-leak fix: lead with descriptor + service, drop the raw
      // hash from the rendered prose. The structured field
      // `data.at_risk_actions[].pattern_hash` still carries the hash
      // for machine consumers / downstream automation.
      const label = renderPatternLabel(r.symbol_message, r.service);
      lines.push(`- ${label} — **${r.issue.replace(/_/g, ' ')}**. ${r.recommended}`);
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

  // Dispatch: weekly_digest is a standalone path — no commitment record or
  // live metrics backend required.
  if (format === 'weekly_digest') {
    return executeWeeklyDigest(args);
  }

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
    return buildChassisErrorEnvelope({
      tool: 'log10x_commitment_report',
      err: {
        error_type: 'missing_identifier',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `${headline} ${remediation.split('\n')[0]}`,
      },
      contextPayload: { ok: false, phase: 'not_ready', reason: 'commitment_not_found', remediation },
      source_disclosure: {},
      actions: [
        {
          tool: 'log10x_configure_engine',
          args: { service: args.service ?? '' },
          reason: 'Create a commitment record first. configure_engine with target_percent persists the record this tool reads.',
          role: 'recommended-next',
        },
      ],
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
    return buildChassisErrorEnvelope({
      tool: 'log10x_commitment_report',
      err: {
        error_type: 'config_missing',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `commitment_report unavailable: ${headline}`,
      },
      contextPayload: { ok: false, phase: 'not_ready', reason: 'metrics_backend_missing', error: msg },
      source_disclosure: {},
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
    return buildChassisErrorEnvelope({
      tool: 'log10x_commitment_report',
      err: {
        error_type: 'config_missing',
        retryable: false,
        suggested_backoff_ms: null,
        hint: `commitment_report unavailable: ${headline} ${remediation}`,
      },
      contextPayload: {
        ok: false,
        phase: 'not_ready',
        reason: 'estimate_savings_dependency_missing',
        remediation,
        human_summary: `commitment_report unavailable: ${headline} ${remediation}`,
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
  const atRiskRaw = aggregateAtRiskActions(weeklyResults);

  // Hash-leak fix: join (service, symbol_message) descriptors for the
  // at-risk hashes via the same `sum by (hash, service, message_pattern)`
  // PromQL primitive top_patterns + pattern_diff use. The bare hash stays
  // on the structured field; only the rendered CFO bullet drops it.
  let atRiskDescriptors: Map<string, PatternHashDescriptor> = new Map();
  if (atRiskRaw.length > 0) {
    const hashes = atRiskRaw.map((r) => r.pattern_hash);
    const rangeHours = Math.max(1, period.days * 24);
    atRiskDescriptors = await fetchHashDescriptors(
      backend,
      commitment.env,
      hashes,
      `${rangeHours}h`
    );
  }
  const atRisk = atRiskRaw.map((r) => {
    const desc = atRiskDescriptors.get(r.pattern_hash);
    return {
      pattern_hash: r.pattern_hash,
      issue: r.issue,
      recommended: r.recommended,
      ...(desc?.service ? { service: desc.service } : {}),
      ...(desc?.symbol_message ? { symbol_message: desc.symbol_message } : {}),
    };
  });

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
        if (agg.bytes_saved_by_action.sample < 0) agg.bytes_saved_by_action.sample = 0;
        if (agg.bytes_saved_by_action.pass < 0) agg.bytes_saved_by_action.pass = 0;
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
    sample: pctOfIn(agg.bytes_saved_by_action.sample),
    pass: pctOfIn(agg.bytes_saved_by_action.pass),
  };

  // 5d. Reconciliation gap (bug #4 from the math-lens workflow). The
  // bucket map and delivered_pct are computed from independent code
  // paths; previously a wide gap between them would render a self-
  // contradicting envelope ("delivered 3.8% / attributed 0%"). The gap
  // is computed here and surfaced as a structured caveat in §8 below
  // when it exceeds 1pp (matches the schema docstring's "±1pp
  // rounding" claim).
  const bucketSumPctForGuard =
    percent_reduction_by_action.drop +
    percent_reduction_by_action.compact +
    percent_reduction_by_action.offload +
    percent_reduction_by_action.tier_down +
    percent_reduction_by_action.sample +
    percent_reduction_by_action.pass;
  const reconciliationGapPp = Math.abs(agg.delivered_pct - bucketSumPctForGuard);

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

  // Disclosed-value mirrors for the renderer / JSON consumers. siemLabel is
  // resolved from the commitment destination; listRatePerGb is only carried
  // when the aggregate rate_source is 'list_price' (customer_supplied
  // disclosures are caveat-less by design; unset → null).
  const siemLabel = SIEM_DISPLAY_NAMES[commitment.destination] ?? null;
  const listRatePerGb =
    agg.rate_source === 'list_price'
      ? (DEFAULT_ANALYZER_COST_PER_GB[commitment.destination] ?? null)
      : null;
  const delivered_dollars_disclosed =
    agg.delivered_dollars == null
      ? null
      : buildDisclosedDollarValue(agg.delivered_dollars, agg.rate_source, siemLabel, listRatePerGb);
  const promised_dollars_disclosed =
    promised_dollars == null
      ? null
      : buildDisclosedDollarValue(promised_dollars, agg.rate_source, siemLabel, listRatePerGb);
  const annualized_dollars_disclosed =
    annualized_dollars == null
      ? null
      : buildDisclosedDollarValue(annualized_dollars, agg.rate_source, siemLabel, listRatePerGb);

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
  // Reconciliation guard (bug #4 from the math-lens workflow): bucket
  // sum vs delivered_pct disagreement. The schema invariant says they
  // should agree within ±1pp; surface any wider gap as a caveat so the
  // CFO/agent sees the disagreement instead of getting a silently-
  // contradicting envelope. Typical root cause: intent/observation
  // drift on per_pattern_rows (action_taken from action-intent.json,
  // bytes_saved from observed-dropped TSDB).
  if (reconciliationGapPp > 1 && agg.per_pattern_breakdown_available) {
    caveats.push(
      `Reconciliation gap: percent_reduction_by_action sums to ${bucketSumPctForGuard.toFixed(2)}% but delivered_pct is ${agg.delivered_pct.toFixed(2)}% (gap ${reconciliationGapPp.toFixed(2)}pp, >1pp tolerance). Likely cause: per-pattern action_taken sourced from configured intent (action-intent.json) while bytes_saved sourced from observed-dropped — engine has not yet propagated the new policy, or the policy diverged from observed behavior.`
    );
  }
  // Bug #2: intent/observation mismatch tally. Counts rows where
  // action_taken='pass' but bytes_saved > 0. The rows themselves
  // carry the `intent_observation_mismatch` flag; this caveat is the
  // human-readable summary so the operator sees the drift count
  // without scanning every row.
  const mismatchCount = agg.per_pattern_rows.filter(
    (r) => r.intent_observation_mismatch
  ).length;
  if (mismatchCount > 0) {
    const mismatchBytes = agg.per_pattern_rows
      .filter((r) => r.intent_observation_mismatch)
      .reduce((a, r) => a + r.bytes_saved, 0);
    const mismatchBytesGb = (mismatchBytes / (1024 * 1024 * 1024)).toFixed(2);
    caveats.push(
      `Intent/observation drift: ${mismatchCount} pattern(s) have action_taken='pass' but the engine reduced ${mismatchBytesGb} GB on them in this window. Likely cause: new policy has not yet fully propagated, OR a sample/drop policy was reverted in action-intent.json while the engine still has the prior cap. Check the configmap generation timestamp vs the engine pod's last config reload.`
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
    delivered_dollars_disclosed,
    delivered_dollars_kind: dollarKind,
    promised_dollars,
    promised_dollars_disclosed,
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
      ...(r.intent_observation_mismatch ? { intent_observation_mismatch: true } : {}),
    })),
    annualized_dollars,
    annualized_dollars_disclosed,
    caveats,
  };

  // 9. Render output. `cfo_md` populates the deliverable markdown field on
  // the envelope (data.markdown) so CFO callers can pluck it; the typed
  // envelope is the same shape across all format values.
  if (format === 'cfo_md') {
    envelope.markdown = renderMarkdown(envelope);
  }
  envelope.human_summary = buildCommitmentReportHumanSummary({
    service: commitment.service,
    deliveredPct: agg.delivered_pct,
    promisedPct: commitment.promised_pct,
    days: period.days,
    rateSource: envelope.rate_source,
    deliveredDollars: envelope.delivered_dollars,
    weekCount: envelope.weekly_series.length,
    caveats: envelope.caveats,
  });

  const reportHeadline = `${commitment.service}: delivered ${agg.delivered_pct.toFixed(1)}% vs promised ${commitment.promised_pct.toFixed(1)}% over ${period.days}d.`;
  const rateSourceMapped = agg.rate_source === 'customer_supplied' ? 'customer_supplied' as const
    : agg.rate_source === 'list_price' ? 'list_price' as const
    : 'none' as const;
  // Build siem_vendor + source_label disambiguating WHICH instance of
  // commitment.destination the report is for. The env-config doc resolved
  // by configure_engine carries cluster.region + destination.ingest_url —
  // surface them via the standard helper so a reader can tell "which
  // Datadog org / which CloudWatch account" the delivered% applies to.
  let envForLabel: import('../lib/environments.js').EnvConfig | undefined;
  try {
    const envs = await loadEnvironments();
    envForLabel = resolveEnv(envs, args.environment);
  } catch {
    envForLabel = undefined;
  }
  const labelDisclosure = await buildSourceDisclosureFromEnv(
    envForLabel,
    commitment.destination,
    { envIdOrNickname: commitment.env },
  );
  return buildChassisEnvelope({
    tool: 'log10x_commitment_report',
    view: 'summary',
    headline: reportHeadline,
    status: agg.delivered_pct >= commitment.promised_pct - 5 ? 'success' : 'partial',
    decisions: {
      threshold_used: commitment.promised_pct,
      threshold_basis: 'snapshot',
    },
    source_disclosure: {
      bytes_source: 'tsdb',
      rate_source: rateSourceMapped,
      siem_vendor: commitment.destination,
      ...(labelDisclosure.source_label ? { source_label: labelDisclosure.source_label } : {}),
    },
    scope: {
      window: `${period.days}d`,
      window_basis: 'explicit',
      candidates_count: weeklyResults.length,
      candidates_usable: weeklyResults.length - verifyErrors.length,
    },
    payload: envelope,
    human_summary: envelope.human_summary ?? reportHeadline,
    warnings: caveats.length > 0 ? caveats : undefined,
  });
}

// ─── human_summary builder ────────────────────────────────────────────
function buildCommitmentReportHumanSummary(args: {
  service: string;
  deliveredPct: number;
  promisedPct: number;
  days: number;
  rateSource: 'list_price' | 'customer_supplied' | 'unset';
  deliveredDollars: number | null;
  weekCount: number;
  caveats: string[];
}): string {
  const verdict = args.deliveredPct >= args.promisedPct ? 'met' : 'short';
  const lead = `Service ${args.service} delivered ${args.deliveredPct.toFixed(1)}% reduction vs ${args.promisedPct.toFixed(1)}% promised over the last ${args.days} days across ${args.weekCount} weekly slice${args.weekCount === 1 ? '' : 's'}, ${verdict} the commitment.`;
  const dollars =
    args.rateSource !== 'unset' && args.deliveredDollars != null
      ? ` Realized savings: ${args.rateSource === 'customer_supplied' ? '$' + args.deliveredDollars.toFixed(0) + ' (customer-supplied rate)' : '$' + args.deliveredDollars.toFixed(0) + ' (list price)'}.`
      : '';
  const caveats = args.caveats.length > 0 ? ` Caveats: ${args.caveats.length}.` : '';
  return `${lead}${dollars}${caveats}`;
}
