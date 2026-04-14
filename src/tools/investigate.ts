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
    .default('24h')
    .describe('Offset for the baseline comparison. `24h` default (compare current window to same window 24h ago).'),
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
    baseline_offset: string;
    depth: 'shallow' | 'normal' | 'deep';
    environment?: string;
    use_bytes: boolean;
  },
  env: EnvConfig
): Promise<string> {
  const investigationId = randomUUID();
  const thresholds = DEFAULT_THRESHOLDS;

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
  const resolution = await resolveAnchor(args.starting_point, env, metricsEnv);

  if (resolution.mode === 'environment') {
    const report = await renderEnvironmentAudit(args, env, metricsEnv, investigationId, reporterTier);
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

  // ── Phase 2 — Trajectory shape classification ──
  const shape = await classifyTrajectory(
    env,
    metricsEnv,
    resolution.anchor,
    args.window,
    thresholds,
    resolution.severity,
    metricName
  );

  if (shape.shape === 'flat') {
    const report = renderEmpty(args.starting_point, args.window, investigationId, thresholds.acuteNoiseFloor);
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
  const baselineOffsetSeconds = parseDurationToSeconds(args.baseline_offset);

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

  const report = renderAcuteSpikeReport({
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

async function resolveAnchor(startingPoint: string, env: EnvConfig, metricsEnv: string): Promise<Resolution> {
  const sp = startingPoint.trim();

  // Environment-wide audit literal
  if (/^(environment|all|audit)$/i.test(sp)) {
    return { mode: 'environment', inputType: 'environment_literal', modeDetection: 'environment_audit' };
  }

  // Pattern identity heuristic: templateHash (`~xxx`) or underscore_separated token
  if (/^~?[A-Za-z0-9_]+$/.test(sp)) {
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
    // Try as service — anchor becomes the loudest pattern in the service
    const svcPat = await queryInstant(
      env,
      `topk(1, sum by (${LABELS.pattern}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}",${LABELS.service}="${escape(sp)}"}[1h])))`
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
  args: { window: string; starting_point: string; baseline_offset: string; depth: 'shallow' | 'normal' | 'deep'; environment?: string; use_bytes: boolean },
  env: EnvConfig,
  metricsEnv: string,
  investigationId: string,
  reporterTier: 'edge' | 'cloud' | 'unknown'
): Promise<string> {
  const lines: string[] = [];
  lines.push(`## Environment audit, last ${args.window}`);
  lines.push('');
  lines.push(`**Investigation id**: ${investigationId}`);
  lines.push(`**Environment**: ${env.nickname}`);
  lines.push(`**Reporter tier**: ${reporterTier}`);
  lines.push('');

  // Top 5 hottest patterns by rate change
  try {
    const q =
      `topk(5, abs(` +
      `(sum by (${LABELS.pattern}, ${LABELS.service}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"}[${args.window}])) ` +
      `/ ` +
      `sum by (${LABELS.pattern}, ${LABELS.service}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"}[${args.window}] offset ${args.baseline_offset}))` +
      `) - 1))`;
    const res = await queryInstant(env, q);
    if (res.status === 'success' && res.data.result.length > 0) {
      lines.push('### Top movers');
      lines.push('');
      for (const row of res.data.result) {
        const rc = parsePrometheusValue(row);
        if (!Number.isFinite(rc)) continue;
        const pattern = row.metric[LABELS.pattern];
        const service = row.metric[LABELS.service];
        const pct = (rc * 100).toFixed(0);
        lines.push(`- \`${pattern}\` (\`${service || 'unknown'}\`) — ${rc >= 0 ? '+' : ''}${pct}% vs ${args.baseline_offset} ago`);
      }
      lines.push('');
      lines.push('**Next action**: investigate the top mover individually:');
      lines.push(`\`log10x_investigate({ starting_point: '<top_pattern_name>', window: '${args.window}' })\``);
    } else {
      lines.push('_No significant movement detected across the environment in this window._');
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
