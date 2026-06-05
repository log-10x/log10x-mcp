/**
 * @catalog_tier      A
 * @guardrail         pattern_id_stability
 * @routes_to         log10x_pattern_examples, log10x_pattern_trend
 * @_audit_rationale  Pairs current-window byte presence with 30d first-seen probe (fetchFirstSeenBatch) keyed on locally-derived tenx_hash so pattern_hash is snapshot-independent, then filters patterns whose first-seen age is inside the recency window. Identity-stable separation of new-vs-changing stories an agent cannot recompose from raw PromQL.
 *
 * log10x_whats_new — patterns whose first-seen timestamp falls inside a
 * recency window.
 *
 * Answers "what showed up recently?" — distinct from `top_volume` (current
 * cost ranking) and `whats_changing` (delta vs baseline). New patterns
 * have no baseline, so any "delta math" would be meaningless; this tool
 * exists so they get a clean home and don't pollute the changing-vs-baseline
 * surface.
 *
 * Implementation: query bytes_per_pattern in the current window to find
 * candidate hashes, then for each hash query the 30-day history to find
 * the earliest non-zero datapoint (`fetchFirstSeenBatch`). A pattern is
 * "new" when its first-seen timestamp is inside `first_seen_within`.
 *
 * Default sort: by `first_seen` recency descending (most recent first).
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import { parseTimeframe } from '../lib/format.js';
import { fetchFirstSeenBatch, fmtAge } from '../lib/first-seen.js';
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

export const whatsNewSchema = {
  timeRange: z
    .string()
    .regex(/^\d+[mhd]$/)
    .default('1h')
    .describe('Time range used to score current cost. Default 1h.'),
  first_seen_within: z
    .enum(['1h', '6h', '12h', '1d', '7d', '14d', '30d'])
    .default('1d')
    .describe(
      'Patterns whose first-seen timestamp is younger than this are "new." Default `1d`. ' +
      'Use `1h` for incident triage, `1d` for daily-deploy review, `7d`+ for weekly observability hygiene.',
    ),
  service: z.string().optional().describe('Service name to scope the result. Omit for all services.'),
  severity: z.string().optional().describe('Severity level to scope (e.g. `ERROR`, `CRITICAL`).'),
  limit: z.number().min(1).max(50).default(10).describe('Max patterns to return. Default 10.'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
  view: z.enum(['summary', 'markdown']).default('summary').describe('Output format.'),
};

interface NewPatternServiceRow extends ServiceIdentity {
  cost_now_usd: number;
  bytes_now: number;
  events_now: number;
}

interface NewPatternRow {
  pattern_hash: string;
  symbol_message: string;
  severities: string[];
  first_seen_unix: number;
  first_seen_age_seconds: number;
  first_seen_age_label: string;
  cost_now_usd: number;
  bytes_now: number;
  events_now: number;
  services: NewPatternServiceRow[];
}

interface WhatsNewData {
  time_range: string;
  first_seen_within: string;
  first_seen_within_seconds: number;
  patterns: NewPatternRow[];
  pattern_count_total: number;
  pattern_count_shown: number;
}

function parseFirstSeenWithin(s: string): number {
  const m = s.match(/^(\d+)([hd])$/);
  if (!m) return 86400;
  const n = parseInt(m[1], 10);
  return m[2] === 'h' ? n * 3600 : n * 86400;
}

export async function executeWhatsNew(
  args: {
    timeRange?: string;
    first_seen_within?: string;
    service?: string;
    severity?: string;
    limit?: number;
    analyzerCost?: number;
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig,
): Promise<string | StructuredOutput> {
  // Strict-args boundary: reject undeclared keys at the executor entry so a
  // typo doesn't ride through into a silently dropped argument.
  const strict = validateStrictArgs<typeof args>('log10x_whats_new', whatsNewSchema, args);
  if (strict.error) return strict.error;

  const telemetry = newChassisTelemetry();
  const timeRange = args.timeRange ?? '1h';
  const firstSeenWithin = args.first_seen_within ?? '1d';
  const limit = args.limit ?? 10;
  const tf = parseTimeframe(timeRange);
  const costPerGb = args.analyzerCost ?? 1.0;
  const view = args.view ?? 'summary';
  const windowSeconds = parseFirstSeenWithin(firstSeenWithin);

  const decisions = {
    threshold_used: windowSeconds,
    threshold_basis: 'customer_supplied' as const,
    threshold_audit: {
      value: windowSeconds,
      basis: `first_seen_within=${firstSeenWithin}`,
    },
  };
  const scope = {
    window: tf.label,
    window_basis: 'explicit' as const,
  };
  const sourceDisclosure = {
    bytes_source: 'tsdb' as const,
  };

  const filters: Record<string, string> = {};
  if (args.service) filters[LABELS.service] = args.service;
  if (args.severity) filters[LABELS.severity] = args.severity;

  const metricsEnv = Object.keys(filters).length > 0
    ? await resolveMetricsEnvFiltered(env, filters)
    : await resolveMetricsEnv(env);

  // Current window: hashes that are actively emitting bytes RIGHT NOW.
  // Patterns that existed historically but aren't emitting in the current
  // window aren't surfaced — "new" here means "new AND still active."
  let currentRes: Awaited<ReturnType<typeof queryInstant>>;
  try {
    currentRes = await queryInstant(env, pql.bytesPerPattern(filters, metricsEnv, tf.range));
    recordQuery(telemetry);
  } catch (e) {
    recordQuery(telemetry);
    const err = wrapBackendError(e);
    return buildChassisErrorEnvelope({
      tool: 'log10x_whats_new',
      err,
      telemetry,
      scope,
      source_disclosure: sourceDisclosure,
      contextPayload: {
        time_range: tf.label,
        first_seen_within: firstSeenWithin,
      },
    });
  }
  if (currentRes.status !== 'success' || currentRes.data.result.length === 0) {
    const headline = `No pattern data over ${tf.label}.`;
    const humanSummary = `No pattern data over ${tf.label}. Patterns surface after ~24h of metric collection.`;
    return buildChassisEnvelope({
      tool: 'log10x_whats_new',
      view: 'summary',
      headline,
      status: 'no_signal',
      decisions,
      source_disclosure: sourceDisclosure,
      scope,
      payload: {
        time_range: tf.label,
        first_seen_within: firstSeenWithin,
        first_seen_within_seconds: windowSeconds,
        patterns: [],
        pattern_count_total: 0,
        pattern_count_shown: 0,
      },
      human_summary: humanSummary,
      telemetry,
    });
  }

  // Raw per-(symbolMessage, service, severity) rows from PromQL. The hash
  // is derived locally via groupRowsByPattern (tenxHash(symbolMessage)),
  // so we don't conflate symbol_message and pattern_hash the way prior
  // versions of this tool did.
  interface BytesEventsRow extends RawPatternServiceRow {
    bytes: number;
    events: number;
  }

  // Event counts in the current window, keyed by (symbolMessage, service, severity)
  // so we can join them onto the bytes rows below. eventsPerPattern groups by
  // pattern alone (no service/severity labels in the response), which would
  // make this join miss every row — use eventsByPatternFull to get the
  // matching label set.
  //
  // Failure here is non-fatal — the bytes-side answer is still useful — but
  // we surface it as a structured partial-failure flag instead of silently
  // dropping the error.
  const backendErrors: Array<{ stage: string; error_type: string; hint: string }> = [];
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
  const eventsKey = (sm: string, svc: string, sev: string) => `${sm}\x00${svc}\x00${sev}`;
  const eventsByKey = new Map<string, number>();
  if (eventsRes && eventsRes.status === 'success') {
    for (const r of eventsRes.data.result) {
      const sm = r.metric[LABELS.pattern];
      if (!sm) continue;
      eventsByKey.set(
        eventsKey(sm, r.metric[LABELS.service] || '', r.metric[LABELS.severity] || ''),
        parsePrometheusValue(r),
      );
    }
  }

  const rawRows: BytesEventsRow[] = [];
  for (const r of currentRes.data.result) {
    const sm = r.metric[LABELS.pattern];
    if (!sm) continue;
    const svc = r.metric[LABELS.service] || '';
    const sev = r.metric[LABELS.severity] || '';
    rawRows.push({
      symbolMessage: sm,
      service: svc,
      severity: sev,
      bytes: parsePrometheusValue(r),
      events: eventsByKey.get(eventsKey(sm, svc, sev)) ?? 0,
    });
  }

  // Group raw rows into per-pattern groups (hash derived locally from
  // symbol_message), then fetch first-seen per hash.
  const groups = groupRowsByPattern(rawRows, new Map());
  const hashes = groups.map((g) => g.pattern_hash);
  const firstSeenByHash = await fetchFirstSeenBatch(env, hashes);

  // Filter to patterns whose first-seen is inside the recency window, then
  // build the per-pattern row with services[] aggregated.
  const rows: NewPatternRow[] = [];
  for (const g of groups) {
    const fs = firstSeenByHash.get(g.pattern_hash);
    if (!fs || fs.ageSeconds === null || fs.firstSeenUnix === null) continue;
    if (fs.ageSeconds > windowSeconds) continue;

    let bytesTotal = 0;
    let eventsTotal = 0;
    const services: NewPatternServiceRow[] = [];
    for (const [svc, raw] of g.rows_by_service) {
      bytesTotal += raw.bytes;
      eventsTotal += raw.events;
      services.push({
        name: svc,
        severity: raw.severity,
        cost_now_usd: bytesToCost(raw.bytes, costPerGb),
        bytes_now: raw.bytes,
        events_now: raw.events,
      });
    }
    services.sort((a, b) => b.cost_now_usd - a.cost_now_usd);

    rows.push({
      pattern_hash: g.pattern_hash,
      symbol_message: g.symbol_message,
      severities: g.severities,
      first_seen_unix: fs.firstSeenUnix,
      first_seen_age_seconds: fs.ageSeconds,
      first_seen_age_label: fmtAge(fs.ageSeconds),
      cost_now_usd: bytesToCost(bytesTotal, costPerGb),
      bytes_now: bytesTotal,
      events_now: eventsTotal,
      services,
    });
  }

  // Sort by recency (smallest age = most recent first).
  rows.sort((a, b) => a.first_seen_age_seconds - b.first_seen_age_seconds);
  const shown = rows.slice(0, limit);

  const headline =
    shown.length === 0
      ? `No patterns first seen within ${firstSeenWithin} over ${tf.label}.`
      : `${shown.length} new pattern${shown.length === 1 ? '' : 's'} first seen within ${firstSeenWithin}. ` +
        `Newest: \`${shown[0].pattern_hash}\` (${shown[0].first_seen_age_label}, $${shown[0].cost_now_usd.toFixed(0)}/${tf.range}).`;

  const status: 'success' | 'no_signal' = shown.length === 0 ? 'no_signal' : 'success';
  const data: WhatsNewData & {
    backend_errors?: Array<{ stage: string; error_type: string; hint: string }>;
    partial?: boolean;
  } = {
    time_range: tf.label,
    first_seen_within: firstSeenWithin,
    first_seen_within_seconds: windowSeconds,
    patterns: shown,
    pattern_count_total: rows.length,
    pattern_count_shown: shown.length,
    ...(backendErrors.length > 0 ? { backend_errors: backendErrors, partial: true } : {}),
  };

  const humanSummaryBase =
    status === 'no_signal'
      ? `No patterns first seen within ${firstSeenWithin} over ${tf.label}.`
      : `${shown.length} pattern${shown.length === 1 ? ' was' : 's were'} first seen within ${firstSeenWithin} over ${tf.label}. ` +
        `Newest: \`${shown[0].pattern_hash}\` (${shown[0].first_seen_age_label}, $${shown[0].cost_now_usd.toFixed(0)}/${tf.range}). ` +
        `Inspect with log10x_pattern_examples or log10x_pattern_trend.`;
  const humanSummary =
    backendErrors.length > 0
      ? `${humanSummaryBase} Partial result: events count enrichment failed (${backendErrors[0].error_type}); pattern bytes/cost are still trustworthy.`
      : humanSummaryBase;

  if (view === 'markdown') {
    const lines = [
      `## What's new — ${tf.label}`,
      ``,
      `Patterns first seen within ${firstSeenWithin}, ranked by recency.`,
      ``,
      `| # | Pattern hash | Services | Sev | First seen | Cost now ($/${tf.range}) | Events |`,
      `|---|--------------|----------|-----|------------|--------------------------|--------|`,
      ...shown.map((r, i) => {
        const svcList = r.services.map((s) => s.name).join(', ');
        const sevList = r.severities.join('/');
        return (
          `| ${i + 1} | \`${r.pattern_hash}\` | ${svcList} | ${sevList} | ${r.first_seen_age_label} | ` +
          `$${r.cost_now_usd.toFixed(0)} | ${r.events_now.toFixed(0)} |`
        );
      }),
    ];
    return buildChassisEnvelope({
      tool: 'log10x_whats_new',
      view: 'markdown',
      headline,
      status,
      decisions,
      source_disclosure: sourceDisclosure,
      scope: {
        ...scope,
        candidates_count: rows.length,
        candidates_usable: shown.length,
      },
      payload: data,
      human_summary: humanSummary,
      must_render_verbatim: lines.join('\n'),
      telemetry,
    });
  }

  return buildChassisEnvelope({
    tool: 'log10x_whats_new',
    view: 'summary',
    headline,
    status,
    decisions,
    source_disclosure: sourceDisclosure,
    scope: {
      ...scope,
      candidates_count: rows.length,
      candidates_usable: shown.length,
    },
    payload: data,
    human_summary: humanSummary,
    telemetry,
    actions: shown[0]
      ? [
          {
            tool: 'log10x_pattern_examples',
            args: { pattern: shown[0].pattern_hash, timeRange: tf.range },
            reason: 'see what the newest pattern actually looks like',
          },
          {
            tool: 'log10x_pattern_trend',
            args: { pattern: shown[0].pattern_hash, timeRange: tf.range },
            reason: 'check the trajectory since first appearance',
          },
        ]
      : [],
  });
}
