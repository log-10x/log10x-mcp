/**
 * log10x_investigate — single-call root-cause investigation.
 *
 * Orchestration tool. Takes a polymorphic starting point (raw log line,
 * pattern identity, service name, or the literal "environment") and
 * returns a complete markdown report by composing:
 *
 *   0. Environment selection
 *   1. Anchor resolution (pattern / service / env mode)
 *   2. Trajectory shape detection (acute vs drift vs flat)
 *   3. Acute-spike correlation with lag analysis          (Phase 3)
 *      — OR —
 *      Drift slope-similarity cohort analysis             (Phase 3-D)
 *   4. Causal chain construction (acute only)
 *   5. Confidence scoring
 *   6. Two-stage Streamer fallback (graceful degradation)
 *   7. Verification command generation
 *
 * Intelligence lives in the tool, not the model. Any MCP-aware client
 * should be able to call this one tool and get a coherent investigation.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { DEFAULT_THRESHOLDS } from '../lib/thresholds.js';
import { classifyTrajectory, runDriftCorrelation } from '../lib/drift.js';
import { runAcuteSpikeCorrelation } from '../lib/correlate.js';
import { detectInflection } from '../lib/inflection.js';
import {
  renderAcuteSpikeReport,
  renderDriftReport,
  renderEmpty,
  collectPatternsReferenced,
  collectDriftPatternsReferenced,
} from '../lib/investigation-templates.js';
import { recordInvestigation, getInvestigation, listInvestigations } from '../lib/investigation-cache.js';
import { isStreamerConfigured, runStreamerQuery, parseTimeExpression } from '../lib/streamer-api.js';

export const investigateSchema = {
  starting_point: z
    .string()
    .describe('The user\'s target, verbatim. Can be a raw log line, a pattern identity (symbolMessage or templateHash), a service name, or the literal string "environment"/"all"/"audit". The tool detects the mode automatically.'),
  window: z
    .string()
    .default('1h')
    .describe('Analysis window. `1h` default for acute-spike cases; `30d` recommended for drift cases. Accepts any PromQL range string.'),
  baseline_offset: z
    .string()
    .optional()
    .describe('Offset for the baseline comparison. Defaults to `24h` for short windows (acute-spike cases) and to the same value as `window` for long windows (≥7d, drift cases). Override only if you need a non-standard comparison.'),
  depth: z
    .enum(['shallow', 'normal', 'deep'])
    .default('normal')
    .describe('`shallow`: anchor service only. `normal` (default): anchor service + immediate dependencies. `deep`: full environment-wide.'),
  environment: z.string().optional().describe('Environment nickname — required in multi-env setups.'),
  use_bytes: z.boolean().default(false).describe('Use byte-based rate instead of event-count. Event-count is strongly preferred; use only if the Reporter does not emit the count metric.'),
};

type Mode = 'pattern' | 'service' | 'environment' | 'raw_line';

export async function executeInvestigate(
  args: {
    starting_point: string;
    window: string;
    baseline_offset?: string;
    depth: 'shallow' | 'normal' | 'deep';
    environment?: string;
    use_bytes: boolean;
  },
  env: EnvConfig
): Promise<string> {
  const investigationId = randomUUID();
  const thresholds = DEFAULT_THRESHOLDS;

  // Apply Zod-schema defaults defensively so the function works when called
  // directly (e.g. from tests or other tools) without the schema layer.
  // eslint-disable-next-line no-param-reassign
  if (!args.window)           (args as Record<string, unknown>).window = '1h';
  if (!args.depth)            (args as Record<string, unknown>).depth = 'normal';
  if (args.use_bytes == null) (args as Record<string, unknown>).use_bytes = false;
  // baseline_offset default depends on window magnitude. For short windows
  // (<= 1h), 24h-ago is the right incident baseline ("is this hour worse than
  // yesterday this hour"). For long windows (>= 7d), 24h-ago is WORSE than
  // useless — it compares "last 30d" to "30d shifted by 1 day" (29 of 30 days
  // overlap, so any inflection older than the shift is invisible). Caught by
  // sub-agent S6 (drift scenario): a $30K/mo cart regression 6 days ago was
  // completely missed by `investigate window=30d` with default 24h baseline,
  // while `cost_drivers` immediately surfaced it as +28,000%. The investigate
  // drift flow would have told the user "everything is fine, ±4%".
  //
  // Heuristic: default baseline_offset = window for long windows, 24h for
  // short. Matches the "this month vs last month" / "this week vs last week"
  // convention that operators actually want.
  // Heuristic plus backend-limit guard. Prometheus instant queries reject
  // anything with a total time span > 32 days ("queries with long day range
  // (32d to 95d) are currently only supported for range type queries"). That
  // means window + offset must stay under 32d.
  //
  //   window  | max useful offset | chosen default
  //   5m–1h   | 32d               | 24h  (yesterday-same-hour incident compare)
  //   6h      | 32d               | 24h
  //   24h     | 31d               | 24h  (yesterday same day)
  //   7d      | 25d               | 7d   (this week vs last week)
  //   14d     | 18d               | 14d  (this fortnight vs last)
  //   16d     | 16d               | 16d  (exactly at the limit)
  //   >16d    | <16d              | use cost_drivers for drift — guard below
  //
  // If window alone is > 16d the user should be using cost_drivers() which
  // has its own drift-safe query path. Emit a helpful routing message.
  let effectiveBaselineOffset: string;
  const windowSecs = parseDurationToSeconds(args.window) || 3600;
  if (!args.baseline_offset) {
    const day = 86400;
    if (windowSecs >= 7 * day && windowSecs <= 16 * day) {
      effectiveBaselineOffset = args.window;
    } else if (windowSecs > 16 * day) {
      // Can't default to window without blowing the 32d limit — use 1d as
      // best-effort and let the audit-rendering code emit a warning.
      effectiveBaselineOffset = '1d';
    } else {
      effectiveBaselineOffset = '24h';
    }
  } else {
    effectiveBaselineOffset = args.baseline_offset;
  }
  // If the combined span would exceed the 32d limit even with an explicit
  // user offset, clamp and warn via the rendered output (we can't stop the
  // call, but we can render a clear message on the failed path).
  const baselineSecs = parseDurationToSeconds(effectiveBaselineOffset) || 86400;
  const combinedSpanSecs = windowSecs + baselineSecs;
  const exceedsPromRangeLimit = combinedSpanSecs > 32 * 86400;

  // ── Phase 0 — Environment resolution + metric primitive probe ──
  const metricsEnv = await resolveMetricsEnv(env);
  const reporterTier = metricsEnv === 'edge' ? 'edge' : metricsEnv === 'cloud' ? 'cloud' : 'unknown';

  // Probe for the event-count metric. If it's not emitted by this Reporter,
  // auto-fall back to bytes and annotate the output so the reader knows
  // the rate curves may be skewed by single large events.
  let useBytesMetric = args.use_bytes;
  let metricWarning: string | undefined;
  if (!useBytesMetric) {
    try {
      const probe = await queryInstant(
        env,
        `count(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"}) > 0`
      );
      if (probe.status !== 'success' || probe.data.result.length === 0) {
        useBytesMetric = true;
        metricWarning = 'event-count metric unavailable — falling back to bytes. Rate curves may be skewed by single large events (a stack-trace burst looks like a volume spike). Deploy the Reporter counter emission to upgrade.';
      }
    } catch {
      // Non-fatal — default to event count optimistically.
    }
  }
  const metricName = useBytesMetric ? 'all_events_summaryBytes_total' : undefined;

  // ── Phase 1 — Anchor resolution ──
  const resolution = await resolveAnchor(args.starting_point, env, metricsEnv, args.window, effectiveBaselineOffset);

  if (resolution.mode === 'environment') {
    // For windows longer than 16 days, route to cost_drivers. Two reasons:
    //   1. Prometheus instant-query 32-day span limit makes it IMPOSSIBLE to
    //      compare "last 30d" to "30d ago" (60d total span) in one query.
    //   2. Even with a shorter offset like 1d, the ratio is meaningless — 29
    //      of 30 days overlap, so any real inflection returns ≈0% change.
    //      Caught by sub-agent S6: a $30K/mo cart regression 6 days ago was
    //      reported as "-0%" because the comparison was 30d vs 30d-minus-1d.
    // The correct tool for multi-week drift is cost_drivers (chunked range
    // query path). Route explicitly rather than produce a silently-broken
    // audit.
    const windowExceedsAuditCapability = windowSecs > 16 * 86400;
    if (exceedsPromRangeLimit || windowExceedsAuditCapability) {
      const reason = exceedsPromRangeLimit
        ? `the combined window + baseline span (${args.window} + ${effectiveBaselineOffset}) exceeds the Prometheus backend's 32-day instant-query limit`
        : `a ${args.window} window cannot be compared against a prior ${args.window} (60d total span exceeds the backend limit), and a shorter baseline like 24h produces a ≈0% overlap comparison that silently hides multi-week regressions`;
      const routedReport = [
        `## Investigation: ${args.starting_point}, last ${args.window}`,
        '',
        `**Investigation id**: ${investigationId}`,
        `**Result**: Routed to \`log10x_cost_drivers\`.`,
        '',
        `This question routes better through \`log10x_cost_drivers\`: ${reason}. \`cost_drivers\` uses a chunked range-query path that handles long-window drift correctly and produces per-service week-over-week deltas.`,
        '',
        '**Try instead**:',
        `- \`log10x_cost_drivers({ timeRange: '7d' })\` for global drift ranking (week-over-week)`,
        `- \`log10x_cost_drivers({ timeRange: '30d' })\` for monthly drift`,
        `- \`log10x_investigate({ starting_point: 'environment', window: '7d' })\` if you want the audit layout with a backend-safe window`,
        `- \`log10x_pattern_trend({ pattern: '<specific>', timeRange: '30d', step: '1h' })\` for a single-pattern 30-day time series`,
      ].join('\n');
      recordInvestigation({
        investigationId,
        createdAt: Date.now(),
        startingPoint: args.starting_point,
        environment: env.nickname,
        reporterTier,
        shape: 'environment',
        report: routedReport,
        patternsReferenced: [],
      });
      return routedReport;
    }
    const report = await renderEnvironmentAudit(args, env, metricsEnv, investigationId, reporterTier, effectiveBaselineOffset);
    recordInvestigation({
      investigationId,
      createdAt: Date.now(),
      startingPoint: args.starting_point,
      environment: env.nickname,
      reporterTier,
      shape: 'environment',
      report,
      patternsReferenced: [],
    });
    return report;
  }

  if (!resolution.anchor) {
    const report = [
      `## Investigation: ${args.starting_point}, last ${args.window}`,
      '',
      `**Investigation id**: ${investigationId}`,
      `**Result**: Could not resolve "${args.starting_point}" to a known pattern or service.`,
      '',
      '**Supported inputs**:',
      '- A raw log line (will be templatized and matched by structural identity)',
      '- A pattern identity (symbolMessage / templateHash)',
      '- A service name',
      '- The literal string `"environment"`, `"all"`, or `"audit"` for an env-wide sweep',
      '',
      '**Try next**:',
      `- \`log10x_event_lookup({ pattern: '${args.starting_point}' })\` to search by substring`,
      `- \`log10x_services()\` to list known services`,
    ].join('\n');
    recordInvestigation({
      investigationId,
      createdAt: Date.now(),
      startingPoint: args.starting_point,
      environment: env.nickname,
      reporterTier,
      shape: 'unresolved',
      report,
      patternsReferenced: [],
    });
    return report;
  }

  // ── Phase 2a — Recency probe ──
  // Check whether the resolved anchor has been firing RECENTLY, not just
  // aggregating cost over the window. For service-mode and crashloop
  // diagnosis, the top-cost-pattern over 24h may be a historical error that
  // has been suppressed (e.g. the libgssapi crash that was fixed but still
  // dominates yesterday's cost), while the CURRENT failure is a different
  // pattern entirely. Caught by head-to-head test S11/S12: kubectl --previous
  // correctly surfaced a Postgres duplicate-key bug as the CURRENT crashloop
  // cause, while the MCP resolved to the Kerberos pattern (90% false
  // confidence) because it was still the top-cost-pattern for the 24h window.
  //
  // Recency check: query the anchor's rate over the last 5 minutes. If it's
  // near zero while the pattern still accumulates cost in the wider window,
  // emit a banner warning the user that the tool's answer may be historical.
  let recencyWarning: string | undefined;
  if (resolution.mode === 'service' || resolution.mode === 'pattern') {
    try {
      const freshnessMetric = metricName || 'all_events_summaryVolume_total';
      const recencyQ = `sum(rate(${freshnessMetric}{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(resolution.anchor)}"}[5m]))`;
      const res = await queryInstant(env, recencyQ);
      let recentRate = 0;
      if (res.status === 'success' && res.data.result[0]) {
        recentRate = parsePrometheusValue(res.data.result[0]);
      }
      if (recentRate < thresholds.acuteNoiseFloor) {
        // Anchor hasn't fired in the last 5 minutes. If this is a service-mode
        // investigation, also run a most-recent-error probe scoped to the
        // service to see whether a DIFFERENT pattern is currently active.
        if (resolution.mode === 'service' && resolution.service) {
          // Query for ANY pattern currently firing in the service, not just
          // ERROR/CRIT. The severity label is often empty on multi-line stack
          // traces (real accounting crashloop case: 71% of logs have
          // severity="(empty)" because the Npgsql exception trace doesn't
          // parse into CRITICAL). Rank by rate so the loudest current pattern
          // surfaces first — we'll let the operator judge which is the live
          // failure.
          const activeErrorsQ =
            `topk(3, sum by (${LABELS.pattern}, ${LABELS.severity}) (rate(${freshnessMetric}{${LABELS.env}="${metricsEnv}",${LABELS.service}="${escape(resolution.service)}"}[5m])) > ${thresholds.acuteNoiseFloor}) unless on (${LABELS.pattern}) (sum by (${LABELS.pattern}) (rate(${freshnessMetric}{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(resolution.anchor)}"}[5m])))`;
          const activeRes = await queryInstant(env, activeErrorsQ);
          if (activeRes.status === 'success' && activeRes.data.result.length > 0) {
            const activeNames = activeRes.data.result
              .map((r) => {
                const p = r.metric[LABELS.pattern];
                const s = r.metric[LABELS.severity] || 'unknown-severity';
                return `\`${p}\` (${s})`;
              })
              .join(', ');
            recencyWarning =
              `⚠ **Anchor may be historical, not current**: The resolved anchor \`${resolution.anchor}\` has not fired in the last 5 minutes (rate near zero) but is still ranked top by 24h cost. For current-crashloop / active-incident scenarios, the 24h cost ranking can surface a pattern that was loud YESTERDAY but has since been fixed or suppressed, while a DIFFERENT pattern is causing the active failure.\n\n` +
              `**Currently-active patterns in \`${resolution.service}\`** (last 5 min, any severity, excluding the anchor): ${activeNames}. Re-run \`log10x_investigate\` with one of these as \`starting_point\` to diagnose the live issue.`;
          } else {
            recencyWarning =
              `⚠ **Anchor may be historical**: \`${resolution.anchor}\` has not fired in the last 5 minutes. No other patterns currently active in \`${resolution.service}\` either — service may be stable and the anchor is purely historical cost.`;
          }
        } else {
          recencyWarning =
            `⚠ **Anchor may be historical**: \`${resolution.anchor}\` has not fired in the last 5 minutes (rate near zero). The analysis below reflects cumulative behavior across the window, not current activity.`;
        }
      }
    } catch {
      // non-fatal
    }
  }

  // ── Phase 2 — Trajectory shape classification ──
  const shape = await classifyTrajectory(
    env,
    metricsEnv,
    resolution.anchor,
    args.window,
    thresholds,
    resolution.severity,
    metricName,
    effectiveBaselineOffset
  );

  if (shape.shape === 'flat') {
    const emptyReport = renderEmpty(args.starting_point, args.window, investigationId, thresholds.acuteNoiseFloor);
    // If the anchor is historical (fired below noise floor in the last 5m)
    // AND a different pattern is currently active in the service, the flat
    // "no significant movement" result is dangerously misleading — it means
    // "the HISTORICAL TOP-COST pattern is flat" not "nothing is happening".
    // Prepend the recency warning so an operator sees the live pattern
    // pointer before the empty result. Caught by sub-agent S16 on the
    // accounting crashloop rerun: the recency probe correctly found the
    // live bug but the flat-path report dropped the warning.
    const report = recencyWarning ? `${recencyWarning}\n\n---\n\n${emptyReport}` : emptyReport;
    recordInvestigation({
      investigationId,
      createdAt: Date.now(),
      startingPoint: args.starting_point,
      environment: env.nickname,
      reporterTier,
      shape: 'flat',
      report,
      patternsReferenced: [resolution.anchor],
    });
    return report;
  }

  // ── Phase 3-D — Drift flow ──
  if (shape.shape === 'drift') {
    const driftWindow = widestDriftWindow(args.window);
    const drift = await runDriftCorrelation({
      env,
      metricsEnv,
      anchor: resolution.anchor,
      window: driftWindow,
      depth: args.depth,
      thresholds,
      scopeService: resolution.service,
      anchorSeverity: resolution.severity,
      metricName,
    });

    const sevKey = (resolution.severity || 'default').toLowerCase() as keyof typeof thresholds.driftMinSlopePerWeek;
    const driftFloor = thresholds.driftMinSlopePerWeek[sevKey] ?? thresholds.driftMinSlopePerWeek.default;

    const report = renderDriftReport({
      investigationId,
      anchor: resolution.anchor,
      startingPoint: args.starting_point,
      inputType: resolution.inputType,
      service: resolution.service,
      environment: env.nickname,
      windowLabel: driftWindow,
      metricsEnv,
      reporterTier,
      metricPrimitive: useBytesMetric ? 'bytes' : 'event_count',
      driftThresholdApplied: driftFloor,
      drift,
    });
    recordInvestigation({
      investigationId,
      createdAt: Date.now(),
      startingPoint: args.starting_point,
      environment: env.nickname,
      reporterTier,
      shape: 'drift',
      report,
      patternsReferenced: collectDriftPatternsReferenced(resolution.anchor, drift),
    });
    return report;
  }

  // ── Phase 3 — Acute-spike flow ──
  const inflection = await detectInflection(
    env,
    metricsEnv,
    resolution.anchor,
    args.window,
    metricName
  );
  const baselineOffsetSeconds = parseDurationToSeconds(effectiveBaselineOffset);

  const correlation = await runAcuteSpikeCorrelation({
    env,
    metricsEnv,
    anchor: resolution.anchor,
    inflectionTimestamp: inflection.timestamp,
    baselineOffsetSeconds,
    window: args.window,
    depth: args.depth,
    thresholds,
    scopeService: resolution.service,
    metricName,
  });

  // Per spec: if the inflection is inferred (no sharp change-point), cap all
  // chain-link confidences at "low" so the report doesn't overclaim causality.
  if (inflection.confidence === 'inferred') {
    for (const link of correlation.chain) {
      link.chain = Math.min(link.chain, 0.3);
      link.confidence = link.stat * link.lag * link.chain;
    }
  }

  // ── Phase 6 — Streamer fallback (graceful) ──
  let streamerFallback: 'disabled' | 'unavailable' | 'stage_1_only' | 'stage_1_and_2' | 'not_run' = 'not_run';
  const leadConfidence = correlation.chain[0]?.confidence ?? 0;

  if (!isStreamerConfigured()) {
    streamerFallback = 'unavailable';
  } else if (leadConfidence >= thresholds.cleanChainThreshold) {
    streamerFallback = 'disabled'; // clean chain — no need
  } else if (leadConfidence < thresholds.streamerEscalationThreshold) {
    // Stage 1 — targeted anchor history
    try {
      const stage1 = await runStreamerQuery(
        env,
        {
          pattern: resolution.anchor,
          from: 'now-30d',
          to: 'now',
          format: 'aggregated',
          bucketSize: '1d',
          limit: 10_000,
        },
        { timeoutMs: 30_000 }
      );
      streamerFallback = 'stage_1_only';
      // If Stage 1 reveals enough buckets with sustained movement, we'd
      // normally fire Stage 2. The MVP stops at Stage 1 and annotates.
      if ((stage1.buckets || []).length > 7) {
        // TODO: full Stage 2 re-correlation in the historical inflection window.
        streamerFallback = 'stage_1_only';
      }
    } catch {
      streamerFallback = 'unavailable';
    }
  }

  // ── Phase 7 — Render acute-spike report ──
  const modeDetectionParts = [resolution.modeDetection, `inflection=${inflection.confidence === 'inferred' ? 'inferred_midpoint' : inflection.confidence}`];
  if (metricWarning) modeDetectionParts.push('metric=bytes_fallback');
  const modeDetection = modeDetectionParts.join(' · ');

  const baseReport = renderAcuteSpikeReport({
    investigationId,
    anchor: resolution.anchor,
    startingPoint: args.starting_point,
    inputType: resolution.inputType,
    service: resolution.service,
    environment: env.nickname,
    inflectionTimestamp: inflection.timestamp,
    windowLabel: args.window,
    metricsEnv,
    reporterTier,
    metricPrimitive: useBytesMetric ? 'bytes' : 'event_count',
    noiseFloor: thresholds.acuteNoiseFloor,
    modeDetection,
    correlation,
    streamerFallback,
    depth: args.depth,
    metricWarning,
  });
  // Prepend the recency warning (if any) so a reader sees it before the
  // main analysis — historical vs current misattribution is the most
  // dangerous mis-interpretation for crashloop scenarios.
  const report = recencyWarning ? `${recencyWarning}\n\n---\n\n${baseReport}` : baseReport;
  recordInvestigation({
    investigationId,
    createdAt: Date.now(),
    startingPoint: args.starting_point,
    environment: env.nickname,
    reporterTier,
    shape: 'acute',
    report,
    patternsReferenced: collectPatternsReferenced(resolution.anchor, correlation),
  });
  return report;
}

// ── Anchor resolution ──

interface Resolution {
  mode: Mode;
  anchor?: string;
  service?: string;
  severity?: string;
  inputType: string;
  modeDetection: string;
}

async function resolveAnchor(
  startingPoint: string,
  env: EnvConfig,
  metricsEnv: string,
  window: string,
  baselineOffset: string
): Promise<Resolution> {
  const sp = startingPoint.trim();

  // Environment-wide audit literal
  if (/^(environment|all|audit)$/i.test(sp)) {
    return { mode: 'environment', inputType: 'environment_literal', modeDetection: 'environment_audit' };
  }

  // Pattern identity heuristic: templateHash (`~xxx`), underscore_separated
  // token, OR dash-separated service name (e.g., `product-reviews`, `ad-service`).
  // Services in k8s commonly use kebab-case, so the regex must accept dashes
  // or the resolver falls through to the fuzzy raw-log-line matcher and finds
  // unrelated patterns with substring hits. Caught live on otel-demo: the
  // `product-reviews` input was being routed to the `llm` service because the
  // llm patterns contain "product_reviews" in their body text.
  if (/^~?[A-Za-z0-9_-]+$/.test(sp)) {
    // Try as pattern first
    const byPattern = await queryInstant(
      env,
      `sum(rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(sp)}"}[5m])) > 0`
    );
    if (byPattern.status === 'success' && byPattern.data.result.length > 0) {
      // Try to pull the severity + service for the anchor.
      const meta = await lookupPatternMeta(env, metricsEnv, sp);
      return {
        mode: 'pattern',
        anchor: sp,
        service: meta.service,
        severity: meta.severity,
        inputType: 'pattern_identity',
        modeDetection: 'direct',
      };
    }
    // Try as service — anchor becomes the pattern with the largest |rate change|
    // vs the user's baseline_offset, NOT the loudest pattern. Previous behavior
    // (topk by absolute 1h rate) meant a stable high-volume pattern would shadow
    // every actually-moving pattern in the service, producing "no significant
    // movement" reports even when env-mode surfaced clear -73% decliners on the
    // same data. The resolver must match what the user actually asked — "what
    // moved in this service" — not "what's loudest in this service".
    //
    // We bottom-guard the baseline with meaningfulBaselineFloor=0.01 events/s
    // to prevent near-zero baselines from inflating relative change to +9000%
    // on trivial activity (GAPS G6, PR #25 correction).
    const thresholds = (await import('../lib/thresholds.js')).DEFAULT_THRESHOLDS;
    const meaningfulBaselineFloor = thresholds.acuteNoiseFloor * 10;
    const signedChange =
      `(sum by (${LABELS.pattern}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.service}="${escape(sp)}"}[${window}])) ` +
      `/ ` +
      `sum by (${LABELS.pattern}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.service}="${escape(sp)}"}[${window}] offset ${baselineOffset}) > ${meaningfulBaselineFloor})` +
      `) - 1`;
    const [growRes, declineRes] = await Promise.all([
      queryInstant(env, `topk(1, ${signedChange})`),
      queryInstant(env, `bottomk(1, ${signedChange})`),
    ]);
    // Merge, pick the row with the largest |rate change|
    type Row = { pattern: string; severity: string; rc: number };
    const rows: Row[] = [];
    for (const res of [growRes, declineRes]) {
      if (res.status === 'success') {
        for (const r of res.data.result) {
          const rc = parsePrometheusValue(r);
          if (Number.isFinite(rc)) {
            rows.push({
              pattern: r.metric[LABELS.pattern],
              severity: r.metric[LABELS.severity],
              rc,
            });
          }
        }
      }
    }
    if (rows.length > 0) {
      rows.sort((a, b) => Math.abs(b.rc) - Math.abs(a.rc));
      const top = rows[0];
      return {
        mode: 'service',
        anchor: top.pattern,
        service: sp,
        severity: top.severity,
        inputType: 'service_name',
        modeDetection: 'direct',
      };
    }
    // Fallback: if no patterns crossed the meaningful baseline floor, fall
    // back to the loudest pattern so the investigate flow still has something
    // to classify (will likely hit "flat", which is the honest result).
    const svcPat = await queryInstant(
      env,
      `topk(1, sum by (${LABELS.pattern}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.service}="${escape(sp)}"}[${window}])))`
    );
    if (svcPat.status === 'success' && svcPat.data.result.length > 0) {
      const row = svcPat.data.result[0];
      return {
        mode: 'service',
        anchor: row.metric[LABELS.pattern],
        service: sp,
        severity: row.metric[LABELS.severity],
        inputType: 'service_name',
        modeDetection: 'direct',
      };
    }
    return { mode: 'pattern', inputType: 'pattern_identity', modeDetection: 'unresolved' };
  }

  // Raw log line → fuzzy substring match on the pattern label
  const fuzzy = sp
    .replace(/[0-9]+/g, '.*')
    .replace(/[_\s]+/g, '.*')
    .replace(/[^\w.*]/g, '.*')
    .slice(0, 60);
  const fuzzyQ = `topk(1, sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.pattern}=~".*${fuzzy}.*"}[5m])))`;
  try {
    const res = await queryInstant(env, fuzzyQ);
    if (res.status === 'success' && res.data.result.length > 0) {
      const row = res.data.result[0];
      return {
        mode: 'raw_line',
        anchor: row.metric[LABELS.pattern],
        service: row.metric[LABELS.service],
        severity: row.metric[LABELS.severity],
        inputType: 'raw_log_line',
        modeDetection: 'fuzzy_match',
      };
    }
  } catch {
    // non-fatal
  }
  return { mode: 'raw_line', inputType: 'raw_log_line', modeDetection: 'unresolved' };
}

async function lookupPatternMeta(
  env: EnvConfig,
  metricsEnv: string,
  pattern: string
): Promise<{ service?: string; severity?: string }> {
  try {
    const q = `sum by (${LABELS.service}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.pattern}="${escape(pattern)}"}[1h]))`;
    const res = await queryInstant(env, q);
    if (res.status === 'success' && res.data.result[0]) {
      return {
        service: res.data.result[0].metric[LABELS.service],
        severity: res.data.result[0].metric[LABELS.severity],
      };
    }
  } catch {
    // non-fatal
  }
  return {};
}

// ── Environment-wide audit ──

async function renderEnvironmentAudit(
  args: { window: string; starting_point: string; baseline_offset?: string; depth: 'shallow' | 'normal' | 'deep'; environment?: string; use_bytes: boolean },
  env: EnvConfig,
  metricsEnv: string,
  investigationId: string,
  reporterTier: 'edge' | 'cloud' | 'unknown',
  effectiveBaselineOffset: string
): Promise<string> {
  const lines: string[] = [];
  lines.push(`## Environment audit, last ${args.window}`);
  lines.push('');
  lines.push(`**Investigation id**: ${investigationId}`);
  lines.push(`**Environment**: ${env.nickname}`);
  lines.push(`**Reporter tier**: ${reporterTier}`);
  lines.push('');

  // Top 5 movers by rate change, preserving direction.
  //
  // Previous implementation used topk(5, abs((current/baseline) - 1)) which
  // correctly ranked by magnitude but LOST THE SIGN. A pattern going from
  // 87 events/s (baseline) to 0 events/s (current) has rc = -1, abs(rc)=1,
  // and renders as "+100% vs 24h ago" even though it's a -100% decline.
  // Caught by production investigation of cart_cartstore_ValkeyCartStore
  // during the otel-demo swap session — the pattern went to zero because
  // of an unrelated engine bug (see GAPS G8), and the "+100%" label was
  // the opposite of what happened. Sign loss makes the output structurally
  // dishonest.
  //
  // Fix: run two separate queries — topk(5, signed_change) for biggest
  // growths, bottomk(5, signed_change) for biggest declines — then merge
  // and label each with its actual sign. Baseline guard retained so
  // near-zero baselines don't amplify spurious +N% flags (GAPS G6).
  const thresholds = (await import('../lib/thresholds.js')).DEFAULT_THRESHOLDS;
  const meaningfulBaselineFloor = thresholds.acuteNoiseFloor * 10;
  const signedChangeExpr =
    `(sum by (${LABELS.pattern}, ${LABELS.service}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"}[${args.window}])) ` +
    `/ ` +
    `sum by (${LABELS.pattern}, ${LABELS.service}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"}[${args.window}] offset ${effectiveBaselineOffset}) > ${meaningfulBaselineFloor})` +
    `) - 1`;
  try {
    const [growRes, declineRes] = await Promise.all([
      queryInstant(env, `topk(5, ${signedChangeExpr})`),
      queryInstant(env, `bottomk(5, ${signedChangeExpr})`),
    ]);

    type Row = { pattern: string; service: string; rc: number };
    const rows: Row[] = [];
    for (const r of [growRes, declineRes]) {
      if (r.status !== 'success') continue;
      for (const row of r.data.result) {
        const rc = parsePrometheusValue(row);
        if (!Number.isFinite(rc)) continue;
        const pattern = row.metric[LABELS.pattern];
        const service = row.metric[LABELS.service] || 'unknown';
        rows.push({ pattern, service, rc });
      }
    }
    // Dedupe by pattern — a row can be in both topk/bottomk if only a handful exist.
    const seen = new Set<string>();
    const deduped = rows.filter((r) => {
      if (seen.has(r.pattern)) return false;
      seen.add(r.pattern);
      return true;
    });
    // Sort by absolute magnitude so the biggest movers come first.
    deduped.sort((a, b) => Math.abs(b.rc) - Math.abs(a.rc));
    const topMovers = deduped.slice(0, 8);

    if (topMovers.length > 0) {
      lines.push('### Top movers');
      lines.push('');
      for (const r of topMovers) {
        const pct = (r.rc * 100).toFixed(0);
        const direction = r.rc >= 0 ? `+${pct}%` : `${pct}%`;
        const label = r.rc >= 0 ? 'grew' : 'declined';
        lines.push(`- \`${r.pattern}\` (\`${r.service}\`) — ${label} ${direction} vs ${effectiveBaselineOffset} ago`);
      }
      lines.push('');
      lines.push('**Next action**: investigate the top mover individually:');
      lines.push(`\`log10x_investigate({ starting_point: '<top_pattern_name>', window: '${args.window}' })\``);
      lines.push('');
      lines.push('_Note: declines (negative %) are real signals — a pattern that stopped firing may indicate a service crashed, a monitor was muted, or a real upstream change. Treat them the same way you treat spikes._');
    } else {
      lines.push('_No significant movement detected across the environment in this window._');
      lines.push('');
      lines.push(`_Top-movers pass requires the baseline-window rate to exceed ${meaningfulBaselineFloor} events/s on at least one pattern. If no pattern meets that floor, the environment is either steady-state or too sparse for meaningful delta detection. Try a longer window or investigate individual services directly._`);
    }
  } catch (e) {
    lines.push(`_Environment audit query failed: ${(e as Error).message}_`);
  }

  return lines.join('\n');
}

// ── Helpers ──

function widestDriftWindow(current: string): string {
  // Widen a short window for drift analysis. Drift needs at least 7 days of history.
  const sec = parseDurationToSeconds(current);
  if (sec >= 7 * 86400) return current;
  return '30d';
}

function parseDurationToSeconds(s: string): number {
  const m = s.match(/^(\d+)([smhdw])$/);
  if (!m) return 86400;
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
      return 86400;
  }
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ── log10x_investigation_get ──

export const investigationGetSchema = {
  investigation_id: z
    .string()
    .optional()
    .describe('The investigation_id of a prior investigation. If omitted, returns the most recent N investigations as an index.'),
  limit: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe('When investigation_id is omitted: how many recent investigations to list.'),
};

export function executeInvestigationGet(args: { investigation_id?: string; limit: number }): string {
  if (args.investigation_id) {
    const rec = getInvestigation(args.investigation_id);
    if (!rec) {
      return `No investigation with id "${args.investigation_id}" in this session\'s cache. Cache holds the 50 most recent investigations; earlier records have been evicted. Run log10x_investigate again with the same starting_point to regenerate.`;
    }
    const age = Math.round((Date.now() - rec.createdAt) / 1000);
    const header = `## Investigation replay · ${rec.investigationId}\n\n**Age**: ${age}s ago\n**Starting point**: ${rec.startingPoint}\n**Shape**: ${rec.shape}\n**Environment**: ${rec.environment} (${rec.reporterTier})\n**Patterns touched**: ${rec.patternsReferenced.length}\n\n---\n\n`;
    return header + rec.report;
  }

  const recent = listInvestigations(args.limit);
  if (recent.length === 0) {
    return 'No investigations in this session\'s cache yet. Run log10x_investigate first.';
  }
  const lines: string[] = ['## Recent investigations', ''];
  for (const rec of recent) {
    const age = Math.round((Date.now() - rec.createdAt) / 1000);
    lines.push(
      `- \`${rec.investigationId}\` · ${age}s ago · ${rec.shape} · \`${rec.startingPoint}\` · ${rec.patternsReferenced.length} patterns`
    );
  }
  lines.push('');
  lines.push('Call `log10x_investigation_get({ investigation_id: \'<id>\' })` to replay a specific one.');
  return lines.join('\n');
}
