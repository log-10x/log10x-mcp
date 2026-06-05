/**
 * @catalog_tier      A
 * @guardrail         pattern_id_stability
 * @routes_to         log10x_pattern_trend, log10x_pattern_examples, log10x_whats_new
 * @_audit_rationale  Restored cost_drivers capability with multi-offset baseline averaging (1x/2x/3x timeRange) joined per (pattern_hash, service, severity) tuple, applies DEFAULT_GATES floors, and EXCLUDES brand-new patterns to log10x_whats_new for clean delta-vs-baseline semantics. Uses local pattern_hash derivation (groupRowsByPattern). Differentiated framing + identity-stability join.
 *
 * log10x_whats_changing — patterns ranked by delta vs a baseline window.
 *
 * Answers the "what grew (or shrank) the most since X" question. Distinct
 * from `log10x_top_volume`, which ranks by current cost — this tool ranks
 * by delta and applies gates that drop noise-level changes.
 *
 * Restores the capability of the deleted `log10x_cost_drivers` tool
 * (commit 27dce7d, chk-15) using the modern StructuredOutput envelope
 * and the shared baseline machinery in `top-volume-extras.ts` / gates
 * in `lib/gates.ts`.
 *
 * Brand-new patterns (no baseline samples) are EXCLUDED from this tool's
 * output — they go to `log10x_whats_new` for clean separation of stories.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { applyCostDriverGates, DEFAULT_GATES } from '../lib/gates.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import { parseTimeframe } from '../lib/format.js';
import { fetchFirstSeenBatch } from '../lib/first-seen.js';
import { type StructuredOutput } from '../lib/output-types.js';
import {
  groupRowsByPattern,
  type ServiceIdentity,
  type RawPatternServiceRow,
} from '../lib/pattern-descriptor.js';
import { validateStrictArgs } from '../lib/strict-args.js';
import { wrapBackendError } from '../lib/primitive-errors.js';
import {
  buildChassisEnvelope,
  buildChassisErrorEnvelope,
  newChassisTelemetry,
  recordQuery,
} from '../lib/chassis-envelope.js';

export const whatsChangingSchema = {
  timeRange: z
    .enum(['1d', '7d', '30d'])
    .default('7d')
    .describe(
      'Current window to evaluate. Day-level only — delta math requires day-aligned baseline offsets. ' +
      'For sub-day spike investigation use `log10x_pattern_trend` or `log10x_investigate`.',
    ),
  comparison_window: z
    .union([z.enum(['1d', '7d', '14d', '30d', 'auto']), z.string()])
    .default('auto')
    .describe(
      'Baseline window to compare against. `"auto"` (default) averages three offsets (1×, 2×, 3× the timeRange) ' +
      'for noise smoothing. A specific offset like `"7d"` compares to that single anchor — e.g. ' +
      '`{timeRange: "1d", comparison_window: "1d"}` = today vs yesterday (deploy-delta); ' +
      '`{timeRange: "7d", comparison_window: "7d"}` = this week vs last week.',
    ),
  service: z.string().optional().describe('Service name to scope the result. Omit for all services.'),
  severity: z.string().optional().describe('Severity level to scope (e.g. `ERROR`, `CRITICAL`).'),
  limit: z.number().min(1).max(20).default(10).describe('Max patterns to return. Default 10.'),
  min_delta_usd: z
    .number()
    .optional()
    .describe(
      `Dollar floor for delta. Rows with delta < min_delta_usd are dropped. ` +
      `Default ${DEFAULT_GATES.minDollarPerWeek} (the cost_drivers gate). Set to 0 to disable.`,
    ),
  min_delta_contribution_pct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      `Contribution gate as a percentage. A row's delta must be at least this fraction of total positive ` +
      `delta to be surfaced. Default ${DEFAULT_GATES.minContributionPct}. Set to 0 to disable.`,
    ),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
  view: z
    .enum(['summary', 'markdown'])
    .default('summary')
    .describe('Output format. `summary` returns the structured envelope; `markdown` returns a rendered table.'),
};

interface ChangingServiceRow extends ServiceIdentity {
  cost_now_usd: number;
  cost_baseline_usd: number;
  delta_usd: number;
  delta_pct: number;
  events_now: number;
}

interface ChangingRow {
  pattern_hash: string;
  symbol_message: string;
  severities: string[];
  first_seen_age_seconds: number | null;
  cost_now_usd: number;
  cost_baseline_usd: number;
  /** `delta_usd` aliased — kept so `applyCostDriverGates` (typed on `delta`) sees the value. */
  delta: number;
  delta_usd: number;
  delta_pct: number;
  events_now: number;
  services: ChangingServiceRow[];
}

interface WhatsChangingData {
  time_range: string;
  comparison_window: string;
  baseline_offset_days: number[];
  gates_applied: { min_delta_usd: number; min_delta_contribution_pct: number };
  total_positive_delta_usd: number;
  patterns: ChangingRow[];
  pattern_count_total: number;
  pattern_count_shown: number;
  excluded_new_count: number;
}

export async function executeWhatsChanging(
  args: {
    timeRange?: string;
    comparison_window?: string;
    service?: string;
    severity?: string;
    limit?: number;
    min_delta_usd?: number;
    min_delta_contribution_pct?: number;
    analyzerCost?: number;
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig,
): Promise<string | StructuredOutput> {
  // Strict-args boundary: reject undeclared keys at the executor entry so a
  // typo doesn't ride through into a silently dropped argument.
  const strict = validateStrictArgs<typeof args>('log10x_whats_changing', whatsChangingSchema, args);
  if (strict.error) return strict.error;

  const telemetry = newChassisTelemetry();
  const timeRange = args.timeRange ?? '7d';
  const limit = args.limit ?? 10;
  const tf = parseTimeframe(timeRange);
  const costPerGb = args.analyzerCost ?? 1.0;
  const view = args.view ?? 'summary';

  // Resolve baseline offsets from comparison_window arg.
  const cw = args.comparison_window ?? 'auto';
  let baselineOffsets: number[];
  let cwLabel: string;
  if (cw === 'auto') {
    baselineOffsets = tf.baselineOffsets;
    cwLabel = `auto (3-window avg, offsets ${baselineOffsets.join('d/')}d)`;
  } else {
    const m = cw.match(/^(\d+)d$/);
    if (!m) {
      return buildChassisErrorEnvelope({
        tool: 'log10x_whats_changing',
        err: {
          error_type: 'schema_invalid',
          retryable: false,
          suggested_backoff_ms: null,
          hint: `Invalid comparison_window: ${cw}. Use 'auto' or a day-offset like '7d', '14d', '30d'.`,
        },
        telemetry,
        scope: { window: tf.label, window_basis: 'explicit' },
        source_disclosure: { bytes_source: 'tsdb' },
        contextPayload: {
          time_range: tf.label,
          comparison_window: cw,
        },
      });
    }
    baselineOffsets = [parseInt(m[1], 10)];
    cwLabel = `${m[1]}d offset`;
  }

  const minDeltaUsd = args.min_delta_usd ?? DEFAULT_GATES.minDollarPerWeek;
  const minDeltaContribPct = args.min_delta_contribution_pct ?? DEFAULT_GATES.minContributionPct;
  const minDeltaUsdIsDefault = args.min_delta_usd === undefined;
  const minContribIsDefault = args.min_delta_contribution_pct === undefined;
  const gatesAtDefault = minDeltaUsdIsDefault && minContribIsDefault;

  const filters: Record<string, string> = {};
  if (args.service) filters[LABELS.service] = args.service;
  if (args.severity) filters[LABELS.severity] = args.severity;

  const metricsEnv = Object.keys(filters).length > 0
    ? await resolveMetricsEnvFiltered(env, filters)
    : await resolveMetricsEnv(env);

  const decisions = {
    threshold_used: minDeltaUsd,
    threshold_basis: gatesAtDefault ? ('default' as const) : ('customer_supplied' as const),
    threshold_audit: {
      value: minDeltaUsd,
      basis: `min_delta_usd=${minDeltaUsd} (default=${DEFAULT_GATES.minDollarPerWeek}), min_delta_contribution_pct=${minDeltaContribPct} (default=${DEFAULT_GATES.minContributionPct})`,
    },
  };
  const sourceDisclosure = {
    bytes_source: 'tsdb' as const,
  };
  const scopeBase = {
    window: tf.label,
    window_basis: 'explicit' as const,
  };

  // Query 1: current window. Treat backend errors as a hard failure (we
  // can't compute deltas without the after-side); empty result as no_signal.
  let currentRes: Awaited<ReturnType<typeof queryInstant>>;
  try {
    currentRes = await queryInstant(env, pql.bytesPerPattern(filters, metricsEnv, tf.range));
    recordQuery(telemetry);
  } catch (e) {
    recordQuery(telemetry);
    const err = wrapBackendError(e);
    return buildChassisErrorEnvelope({
      tool: 'log10x_whats_changing',
      err,
      telemetry,
      scope: scopeBase,
      source_disclosure: sourceDisclosure,
      contextPayload: {
        time_range: tf.label,
        comparison_window: cwLabel,
        stage: 'current_window',
      },
    });
  }
  if (currentRes.status !== 'success' || currentRes.data.result.length === 0) {
    return buildChassisEnvelope({
      tool: 'log10x_whats_changing',
      view: 'summary',
      headline: `No pattern data available over ${tf.label}.`,
      status: 'no_signal',
      decisions,
      source_disclosure: sourceDisclosure,
      scope: scopeBase,
      payload: {
        time_range: tf.label,
        comparison_window: cwLabel,
        baseline_offset_days: baselineOffsets,
        gates_applied: { min_delta_usd: minDeltaUsd, min_delta_contribution_pct: minDeltaContribPct },
        total_positive_delta_usd: 0,
        patterns: [],
        pattern_count_total: 0,
        pattern_count_shown: 0,
        excluded_new_count: 0,
      },
      human_summary: `No pattern data over ${tf.label}. Patterns surface after ~24h of metric collection — widen the window or wait for ingestion to catch up.`,
      telemetry,
    });
  }

  // Raw rows are keyed by (symbolMessage, service, severity). Both the
  // current and baseline joins happen on that tuple — earlier versions
  // of this tool keyed solely by symbol_message, which collapsed
  // per-service rows into one and dropped data for multi-service patterns.
  interface ChangingRawRow extends RawPatternServiceRow {
    bytes_now: number;
    baseline_samples: number[];
    events_now: number;
  }
  const rawKey = (sm: string, svc: string, sev: string) => `${sm}\x00${svc}\x00${sev}`;
  const rawByKey = new Map<string, ChangingRawRow>();
  for (const r of currentRes.data.result) {
    const sm = r.metric[LABELS.pattern];
    if (!sm) continue;
    const svc = r.metric[LABELS.service] || '';
    const sev = r.metric[LABELS.severity] || '';
    rawByKey.set(rawKey(sm, svc, sev), {
      symbolMessage: sm,
      service: svc,
      severity: sev,
      bytes_now: parsePrometheusValue(r),
      baseline_samples: [],
      events_now: 0,
    });
  }

  // Queries 2..N: baseline windows (one per offset). Join by the full
  // (symbol_message, service, severity) tuple. A per-offset failure isn't
  // fatal — the remaining offsets still produce a usable baseline — but we
  // surface it as a structured backend_errors[] entry instead of a silent
  // .catch(() => null).
  const backendErrors: Array<{ stage: string; offset_days?: number; error_type: string; hint: string }> = [];
  const baselineResults = await Promise.all(
    baselineOffsets.map(async (offsetDays) => {
      try {
        const res = await queryInstant(env, pql.bytesPerPattern(filters, metricsEnv, tf.range, offsetDays));
        recordQuery(telemetry);
        return res;
      } catch (e) {
        recordQuery(telemetry);
        const err = wrapBackendError(e);
        backendErrors.push({
          stage: 'baseline_window',
          offset_days: offsetDays,
          error_type: err.error_type,
          hint: err.hint,
        });
        return null;
      }
    }),
  );
  for (const baseRes of baselineResults) {
    if (!baseRes || baseRes.status !== 'success') continue;
    for (const r of baseRes.data.result) {
      const sm = r.metric[LABELS.pattern];
      if (!sm) continue;
      const k = rawKey(sm, r.metric[LABELS.service] || '', r.metric[LABELS.severity] || '');
      const row = rawByKey.get(k);
      if (row) row.baseline_samples.push(parsePrometheusValue(r));
    }
  }

  // Per-(pattern, service, severity) event counts in the current window.
  // Must use eventsByPatternFull (not eventsPerPattern) so the response
  // carries service + severity labels — needed to join 1:1 with the bytes
  // rows. eventsPerPattern aggregates across service/severity, so a join
  // on the full triple would miss every row. Like the baseline call, a
  // failure here is non-fatal; the bytes-side answer is still useful.
  let eventsRes: Awaited<ReturnType<typeof queryInstant>> | null = null;
  try {
    eventsRes = await queryInstant(env, pql.eventsByPatternFull(filters, metricsEnv, tf.range));
    recordQuery(telemetry);
  } catch (e) {
    recordQuery(telemetry);
    const err = wrapBackendError(e);
    backendErrors.push({ stage: 'events_by_pattern_full', error_type: err.error_type, hint: err.hint });
    eventsRes = null;
  }
  if (eventsRes && eventsRes.status === 'success') {
    for (const r of eventsRes.data.result) {
      const sm = r.metric[LABELS.pattern];
      if (!sm) continue;
      const k = rawKey(sm, r.metric[LABELS.service] || '', r.metric[LABELS.severity] || '');
      const row = rawByKey.get(k);
      if (row) row.events_now = parsePrometheusValue(r);
    }
  }

  // Group raw rows by pattern (hash derived locally from symbol_message),
  // fetch first_seen, then aggregate per-pattern deltas + per-service
  // breakdowns.
  const rawRows = Array.from(rawByKey.values());
  const groups = groupRowsByPattern(rawRows, new Map());
  const hashes = groups.map((g) => g.pattern_hash);
  const firstSeenByHash = await fetchFirstSeenBatch(env, hashes);

  // Build deltas. Patterns with NO baseline samples across ANY service are
  // EXCLUDED — they belong in whats_new. A pattern with baseline in service
  // A but not service B is still "persistent at pattern level"; its
  // services[] will reflect the per-service presence.
  const rows: ChangingRow[] = [];
  let totalPositiveDelta = 0;
  let excludedNewCount = 0;

  for (const g of groups) {
    let bytesNowTotal = 0;
    let bytesBaselineTotal = 0;
    let eventsNowTotal = 0;
    let hasAnyBaseline = false;
    const services: ChangingServiceRow[] = [];
    for (const [svc, raw] of g.rows_by_service) {
      const baselineAvg =
        raw.baseline_samples.length > 0
          ? raw.baseline_samples.reduce((a, b) => a + b, 0) / raw.baseline_samples.length
          : 0;
      if (raw.baseline_samples.length > 0) hasAnyBaseline = true;
      bytesNowTotal += raw.bytes_now;
      bytesBaselineTotal += baselineAvg;
      eventsNowTotal += raw.events_now;
      const svcCostNow = bytesToCost(raw.bytes_now, costPerGb);
      const svcCostBaseline = bytesToCost(baselineAvg, costPerGb);
      const svcDelta = svcCostNow - svcCostBaseline;
      const svcDeltaPct = svcCostBaseline > 0 ? (svcDelta / svcCostBaseline) * 100 : 0;
      services.push({
        name: svc,
        severity: raw.severity,
        cost_now_usd: svcCostNow,
        cost_baseline_usd: svcCostBaseline,
        delta_usd: svcDelta,
        delta_pct: svcDeltaPct,
        events_now: raw.events_now,
      });
    }
    if (!hasAnyBaseline) {
      excludedNewCount += 1;
      continue;
    }
    services.sort((a, b) => Math.abs(b.delta_usd) - Math.abs(a.delta_usd));
    const costNow = bytesToCost(bytesNowTotal, costPerGb);
    const costBaseline = bytesToCost(bytesBaselineTotal, costPerGb);
    const delta = costNow - costBaseline;
    const deltaPct = costBaseline > 0 ? (delta / costBaseline) * 100 : 0;
    rows.push({
      pattern_hash: g.pattern_hash,
      symbol_message: g.symbol_message,
      severities: g.severities,
      first_seen_age_seconds: firstSeenByHash.get(g.pattern_hash)?.ageSeconds ?? null,
      cost_now_usd: costNow,
      cost_baseline_usd: costBaseline,
      delta,
      delta_usd: delta,
      delta_pct: deltaPct,
      events_now: eventsNowTotal,
      services,
    });
    if (delta > 0) totalPositiveDelta += delta;
  }

  // Apply gates and sort by absolute delta magnitude descending.
  // applyCostDriverGates keeps positive-delta rows that pass both floors.
  // We extend it to ALSO surface large negative deltas (shrinkers) — they
  // can be a deploy artifact worth flagging — by including them when their
  // magnitude crosses the floor.
  const gated = applyCostDriverGates(rows, totalPositiveDelta, {
    minDollarPerWeek: minDeltaUsd,
    minContributionPct: minDeltaContribPct,
  });
  const shrinkers = rows.filter((r) => {
    if (r.delta_usd >= 0) return false;
    return Math.abs(r.delta_usd) >= minDeltaUsd;
  });
  const combined = [...gated, ...shrinkers].sort((a, b) => Math.abs(b.delta_usd) - Math.abs(a.delta_usd));
  const shown = combined.slice(0, limit);

  const headline =
    shown.length === 0
      ? `No patterns changed by >$${minDeltaUsd} over ${tf.label} vs ${cwLabel}.`
      : `${shown.length} pattern${shown.length === 1 ? '' : 's'} changed by >$${minDeltaUsd} over ${tf.label} vs ${cwLabel}. ` +
        `Top: \`${shown[0].pattern_hash}\` ${shown[0].delta_usd >= 0 ? '+' : '-'}$${Math.abs(shown[0].delta_usd).toFixed(0)} ` +
        `(${shown[0].delta_pct >= 0 ? '+' : ''}${shown[0].delta_pct.toFixed(0)}%).`;

  const status: 'success' | 'no_signal' = shown.length === 0 ? 'no_signal' : 'success';

  // Build the observed delta distribution from the gated/combined pool so
  // an agent can judge whether min_delta_usd was at the noise floor or
  // well above it on this backend. Mirrors metrics-that-moved's pattern.
  const observedDeltaUsdDist = computeObservedDistribution(
    rows.map((r) => Math.abs(r.delta_usd)),
  );
  const observedDeltaPctDist = computeObservedDistribution(
    rows.map((r) => Math.abs(r.delta_pct)),
  );
  const decisionsWithAudit = {
    ...decisions,
    threshold_audit: {
      ...decisions.threshold_audit,
      observed_distribution: observedDeltaUsdDist,
    },
  };

  const data: WhatsChangingData & {
    backend_errors?: typeof backendErrors;
    partial?: boolean;
    observed_distribution?: {
      delta_usd: ReturnType<typeof computeObservedDistribution>;
      delta_pct: ReturnType<typeof computeObservedDistribution>;
    };
  } = {
    time_range: tf.label,
    comparison_window: cwLabel,
    baseline_offset_days: baselineOffsets,
    gates_applied: { min_delta_usd: minDeltaUsd, min_delta_contribution_pct: minDeltaContribPct },
    total_positive_delta_usd: totalPositiveDelta,
    patterns: shown,
    pattern_count_total: rows.length,
    pattern_count_shown: shown.length,
    excluded_new_count: excludedNewCount,
    observed_distribution: { delta_usd: observedDeltaUsdDist, delta_pct: observedDeltaPctDist },
    ...(backendErrors.length > 0 ? { backend_errors: backendErrors, partial: true } : {}),
  };

  const callout =
    excludedNewCount > 0
      ? `${excludedNewCount} brand-new pattern${excludedNewCount === 1 ? '' : 's'} excluded — see \`log10x_whats_new\`.`
      : undefined;

  // Honest summary: lead with the result, add the calibration caveat when
  // the gates are still at their hand-picked defaults, surface partial
  // failure when any baseline offset or the events join failed.
  const calibTag = gatesAtDefault
    ? ` Gates are at their hand-picked defaults; compare against the observed delta distribution before acting.`
    : '';
  const partialTag =
    backendErrors.length > 0
      ? ` Partial result: ${backendErrors.length} backend call${backendErrors.length === 1 ? '' : 's'} failed (${backendErrors[0].error_type}); the remaining offsets still produced a usable baseline.`
      : '';
  const newExclusionTag =
    excludedNewCount > 0
      ? ` ${excludedNewCount} brand-new pattern${excludedNewCount === 1 ? '' : 's'} excluded (no baseline) — route to log10x_whats_new for those.`
      : '';
  const humanSummary =
    status === 'no_signal'
      ? `No patterns crossed the $${minDeltaUsd} delta floor over ${tf.label} vs ${cwLabel}. ${rows.length} patterns were evaluated.${newExclusionTag}${calibTag}${partialTag}`
      : `${shown.length} pattern${shown.length === 1 ? '' : 's'} changed by more than $${minDeltaUsd} over ${tf.label} vs ${cwLabel}. ` +
        `Top: \`${shown[0].pattern_hash}\` ${shown[0].delta_usd >= 0 ? '+' : '-'}$${Math.abs(shown[0].delta_usd).toFixed(0)} (${shown[0].delta_pct >= 0 ? '+' : ''}${shown[0].delta_pct.toFixed(0)}%). ` +
        `Inspect with log10x_pattern_trend.${newExclusionTag}${calibTag}${partialTag}`;

  const scope = {
    ...scopeBase,
    candidates_count: rows.length + excludedNewCount,
    candidates_usable: rows.length,
    candidates_evaluated: shown.length,
    candidates_failed: backendErrors.map((e) => `${e.stage}${e.offset_days != null ? `@${e.offset_days}d` : ''}`),
  };

  const builtActions = shown[0]
    ? [
        {
          tool: 'log10x_pattern_trend',
          args: { pattern: shown[0].pattern_hash, timeRange: tf.range },
          reason: 'inspect the trajectory of the top changer',
        },
        {
          tool: 'log10x_pattern_examples',
          args: { pattern: shown[0].pattern_hash, timeRange: tf.range },
          reason: 'see real events for the top changer',
        },
        ...(excludedNewCount > 0
          ? [
              {
                tool: 'log10x_whats_new',
                args: { timeRange: tf.range },
                reason: `${excludedNewCount} brand-new patterns excluded from this list — see whats_new`,
              },
            ]
          : []),
      ]
    : [];

  if (view === 'markdown') {
    const lines = [
      `## What's changing — ${tf.label}`,
      ``,
      `Comparison: current ${tf.range} vs ${cwLabel}`,
      `Gates: min_delta=$${minDeltaUsd}, min_contribution=${minDeltaContribPct}%`,
      `Excluded NEW patterns (no baseline): ${excludedNewCount}`,
      ``,
      `| # | Pattern hash | Services | Sev | Now ($) | Baseline ($) | Δ ($) | Δ (%) | Events |`,
      `|---|--------------|----------|-----|---------|--------------|-------|-------|--------|`,
      ...shown.map((r, i) => {
        const svcList = r.services.map((s) => s.name).join(', ');
        const sevList = r.severities.join('/');
        return (
          `| ${i + 1} | \`${r.pattern_hash}\` | ${svcList} | ${sevList} | $${r.cost_now_usd.toFixed(0)} | ` +
          `$${r.cost_baseline_usd.toFixed(0)} | ${r.delta_usd >= 0 ? '+' : '-'}$${Math.abs(r.delta_usd).toFixed(0)} | ` +
          `${r.delta_pct >= 0 ? '+' : ''}${r.delta_pct.toFixed(0)}% | ${r.events_now.toFixed(0)} |`
        );
      }),
    ];
    return buildChassisEnvelope({
      tool: 'log10x_whats_changing',
      view: 'markdown',
      headline,
      headline_callout: callout,
      status,
      decisions: decisionsWithAudit,
      source_disclosure: sourceDisclosure,
      scope,
      payload: data,
      human_summary: humanSummary,
      must_render_verbatim: lines.join('\n'),
      telemetry,
      actions: builtActions,
    });
  }

  return buildChassisEnvelope({
    tool: 'log10x_whats_changing',
    view: 'summary',
    headline,
    headline_callout: callout,
    status,
    decisions: decisionsWithAudit,
    source_disclosure: sourceDisclosure,
    scope,
    payload: data,
    human_summary: humanSummary,
    telemetry,
    actions: builtActions,
  });
}

/**
 * Empirical distribution helper. Mirrors metrics-that-moved's
 * computeObservedPhaseGapDistribution so threshold_audit can surface
 * "the floor I compared against vs the actual observed values" for the
 * agent to calibrate against without round-tripping to a separate tool.
 */
function computeObservedDistribution(values: number[]): {
  n: number;
  min: number;
  p25: number;
  p50: number;
  p75: number;
  max: number;
} | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const at = (q: number) => sorted[Math.min(n - 1, Math.floor(q * n))];
  return {
    n,
    min: sorted[0],
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    max: sorted[n - 1],
  };
}
