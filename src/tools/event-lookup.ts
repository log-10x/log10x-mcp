/**
 * log10x_event_lookup — analyze a specific log pattern.
 *
 * Finds the pattern across all services, shows cost breakdown,
 * and requests AI analysis.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant, queryAi } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue, buildDisclosedDollarValue, type DisclosedDollarValue } from '../lib/cost.js';
import { resolveRate, destinationFromEnvAnalyzer } from '../lib/rate-resolution.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import {
  fmtDollar, fmtPattern, fmtSeverity, fmtCount, fmtBytes, fmtPct,
  fmtDisclosedDollar,
  parseTimeframe, costPeriodLabel, normalizePattern
} from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import { fetchOneSampleByHash } from '../lib/siem/sample.js';
import { patternDisplay } from '../lib/pattern-descriptor.js';
import { type StructuredOutput, type Action } from '../lib/output-types.js';
import { newChassisTelemetry, buildChassisEnvelope, buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import { wrapBackendError } from '../lib/primitive-errors.js';
import { getOffloadStatus } from '../lib/offload-status.js';
import { isRetrieverConfigured } from '../lib/retriever-api.js';
import { normalizeTimeRange } from '../lib/time-range.js';

export const eventLookupSchema = {
  pattern: z.string().optional().describe('Pattern name or search term to look up (e.g., "Payment_Gateway_Timeout"). Omit when passing `pattern_hash` / `tenxHash` instead.'),
  pattern_hash: z.string().optional().describe('Canonical 11-char hash seen on a SIEM / CloudWatch Logs event (e.g. "03ndjreM-sU"). Alias of `tenxHash`; both are accepted. Resolved against the 10x metrics to recover the pattern, then the normal cost/services breakdown is shown.'),
  tenxHash: z.string().optional().describe('Legacy alias of `pattern_hash`. Both are accepted. Pass either the canonical `pattern_hash` form or this legacy form — they are treated identically.'),
  service: z.string().optional().describe('Service to scope the lookup'),
  timeRange: z.enum(['15m', '1h', '6h', '24h', '1d', '7d', '30d']).default('7d').describe("Time range. Sub-day values for incident-window lookups. '24h' and '1d' are equivalent."),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB (deprecated alias of `effective_ingest_per_gb`)'),
  effective_ingest_per_gb: z.number().optional().describe('Customer-supplied SIEM ingest cost in $/GB. When set, dollar fields populate with rate_source=customer_supplied; when absent and no list rate is detected, dollar fields collapse to null and rate_source=unset.'),
  siemScope: z.string().optional().describe('SIEM scope for the live sample line on a tenxHash reverse lookup: a CloudWatch log group (`/aws/ecs/my-svc`), ES index, or Splunk index. When omitted, the detected SIEM connector uses its own default scope. Only consulted when `tenxHash` was passed (the cross-pillar correlation case).'),
  environment: z.string().optional().describe('Environment nickname'),
};

interface EventLookupSummary {
  pattern: string;
  // Stable tenx_hash identity — promoted from `resolved_from_hash` so
  // catalog-identity-handoff lands at the same top-level key on both the
  // hash-input path (caller passed pattern_hash/tenxHash) AND the
  // name-input/raw-line path (resolved internally from the pattern label).
  // Empty string when the pattern is not present in TSDB.
  pattern_hash: string;
  window: string;
  services: Array<{
    service: string;
    severity: string;
    bytes: number;
    share_pct: number;
    cost_per_window_usd: number | null;
    cost_baseline_usd: number | null;
    cost_per_window_usd_disclosed: DisclosedDollarValue | null;
    cost_baseline_usd_disclosed: DisclosedDollarValue | null;
    events: number;
    is_new: boolean;
    // Stable pattern_hash echoed on every per-service row so cross-pillar
    // chain steps (event_lookup → pattern_examples / retriever_query /
    // customer_metrics_query) can join on hash without re-fetching the
    // summary-level resolved_from_hash. Empty string when the pattern is
    // not present in TSDB (same as the top-level pattern_hash sentinel).
    pattern_hash: string;
  }>;
  totals: {
    bytes: number;
    cost_per_window_usd: number | null;
    cost_baseline_usd: number | null;
    cost_per_window_usd_disclosed: DisclosedDollarValue | null;
    cost_baseline_usd_disclosed: DisclosedDollarValue | null;
    events: number;
    service_count: number;
  };
  rate_source: 'list_price' | 'customer_supplied' | 'unset';
  resolved_from_hash?: string;
  offload_status?: {
    is_offloaded: boolean;
    /** Null when the kept-cohort PromQL scan timed out — share math suppressed. */
    dropped_share_pct_24h: number | null;
    /** Null when the kept-cohort PromQL scan timed out — share math suppressed. */
    kept_share_pct_24h: number | null;
    recommend_action: 'none' | 'use_retriever_query' | 'check_advise_retriever';
    /** True when the kept-cohort PromQL scan timed out on a heavy pattern. */
    kept_timed_out?: boolean;
  };
}

export async function executeEventLookup(
  args: { pattern?: string; pattern_hash?: string; tenxHash?: string; service?: string; timeRange?: string; analyzerCost?: number; effective_ingest_per_gb?: number; siemScope?: string },
  env: EnvConfig
): Promise<StructuredOutput> {
  // Normalize: pattern_hash is the canonical field; tenxHash is the legacy alias.
  // Merge so downstream code only reads args.tenxHash.
  const argsNormalized = { ...args, tenxHash: args.pattern_hash ?? args.tenxHash };
  const telemetry = newChassisTelemetry();
  const sumOut: { data?: EventLookupSummary; nextActions?: NextAction[] } = {};
  let md: string;
  try {
    md = await executeEventLookupInner(argsNormalized, env, sumOut);
  } catch (err: unknown) {
    // Wave 2.D: route through wrapBackendError so HTTP-status-coded
    // throws from queryInstant / queryAi (e.g. "HTTP 503: ...") classify
    // as backend_unavailable/backend_timeout/schema_invalid/anchor_not_found
    // with proper retryable + suggested_backoff_ms instead of always
    // collapsing to a non-retryable 'backend_error'.
    const wrapped = wrapBackendError(err);
    return buildChassisErrorEnvelope({
      tool: 'log10x_event_lookup',
      err: wrapped,
      telemetry,
      contextPayload: {
        pattern: argsNormalized.pattern,
        pattern_hash: argsNormalized.tenxHash,
        timeRange: argsNormalized.timeRange ?? '7d',
      },
      source_disclosure: { bytes_source: 'tsdb' },
    });
  }
  // Early-return cases (no data, raw line, pattern not found): the inner
  // produced a markdown narrative. Strip headings and collapse to a
  // single-paragraph human_summary so the envelope stays typed.
  if (!sumOut.data) {
    const stripped = md
      .replace(/^##\s*/m, '')
      .split('\n')
      .filter((l) => l.trim().length > 0 && !l.trim().startsWith('-') && !l.trim().startsWith('|'))
      .join(' ')
      .slice(0, 600);
    const headline = md.split('\n')[0]?.replace(/^##\s*/, '').slice(0, 200) || 'event_lookup — no result';
    return buildChassisEnvelope({
      tool: 'log10x_event_lookup',
      view: 'summary',
      headline,
      status: 'no_signal',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: { bytes_source: 'tsdb' },
      scope: { window: argsNormalized.timeRange ?? '7d', window_basis: 'auto_default' },
      payload: { pattern: argsNormalized.pattern, tenx_hash: argsNormalized.tenxHash },
      human_summary: stripped || headline,
      telemetry,
    });
  }
  const d = sumOut.data;
  // Headline leads with events / services / bytes (universal axes) and
  // gates the dollar clause on rate_source so an unset rate yields a
  // truthful percent-first headline instead of a fabricated "$0.00".
  const svcWord = d.totals.service_count === 1 ? 'service' : 'services';
  const headline = d.rate_source === 'unset' || d.totals.cost_per_window_usd_disclosed == null
    ? `\`${d.pattern}\` over ${d.window}: ${fmtCount(d.totals.events)} events across ${d.totals.service_count} ${svcWord} (${(d.totals.bytes / 1_000_000).toFixed(1)} MB)`
    : `\`${d.pattern}\` over ${d.window}: ${fmtCount(d.totals.events)} events across ${d.totals.service_count} ${svcWord} (${(d.totals.bytes / 1_000_000).toFixed(1)} MB) · ${fmtDisclosedDollar(d.totals.cost_per_window_usd_disclosed)}`;
  const rateSourceMapped = d.rate_source === 'customer_supplied' ? 'customer_supplied' as const
    : d.rate_source === 'list_price' ? 'list_price' as const
    : 'none' as const;
  // event_lookup is a hub: agents reading the result must be told where to
  // go next. Convert the NextAction prose-hints into the structured
  // actions[] block on the chassis envelope so a chain walker can branch
  // without parsing markdown. Mapping is direct: NextAction
  // { tool, args, reason } → Action { tool, args, reason, role }.
  const chassisActions: Action[] = (sumOut.nextActions ?? []).map((a) => ({
    tool: a.tool,
    args: a.args as Record<string, unknown>,
    reason: a.reason,
    role: 'recommended-next' as const,
  }));
  return buildChassisEnvelope({
    tool: 'log10x_event_lookup',
    view: 'summary',
    headline,
    status: 'success',
    decisions: { threshold_used: null, threshold_basis: 'default' },
    source_disclosure: {
      bytes_source: 'tsdb',
      rate_source: rateSourceMapped,
      pattern_count_source: {
        kind: 'scoped_total',
        count: d.totals.service_count,
        denominator_meaning: `Services emitting ${d.pattern} over ${d.window}`,
      },
    },
    scope: {
      window: d.window,
      window_basis: 'explicit',
      candidates_count: d.totals.service_count,
      candidates_usable: d.totals.service_count,
    },
    payload: d,
    human_summary: headline,
    actions: chassisActions,
    telemetry,
  });
}

async function executeEventLookupInner(
  args: { pattern?: string; pattern_hash?: string; tenxHash?: string; service?: string; timeRange?: string; analyzerCost?: number; effective_ingest_per_gb?: number; siemScope?: string },
  env: EnvConfig,
  sumOut?: { data?: EventLookupSummary; nextActions?: NextAction[] }
): Promise<string> {
  // Defensive defaults — schema defaults only apply at the MCP-SDK
  // boundary; chain-walkers, internal callers, and the eval harness
  // can land here with raw args. Match eventLookupSchema defaults.
  // Normalise '1d' legacy alias → '24h'.
  const timeRange = normalizeTimeRange(args.timeRange ?? '7d');
  const tf = parseTimeframe(timeRange);
  // SHARED rate resolver (lib/rate-resolution.ts). Same priority chain as
  // services/top_patterns/explain_mode/estimate_savings: caller arg →
  // envs.json analyzerCost → LOG10X_ANALYZER_COST → destination list price
  // → unset. Prior to this, event_lookup and top_patterns landed on
  // different rate_source tags for the SAME env+hash+window: math agreed,
  // attribution didn't. The shared resolver collapses that divergence.
  const rateResolved = resolveRate(
    { effective_ingest_per_gb: args.effective_ingest_per_gb, analyzerCost: args.analyzerCost },
    env,
    destinationFromEnvAnalyzer(env),
  );
  const rateSource: 'list_price' | 'customer_supplied' | 'unset' = rateResolved.source;
  const costPerGb: number | null = rateResolved.rate_per_gb;
  const period = costPeriodLabel(tf.days);
  const metricsEnv = await resolveMetricsEnv(env);

  // Reverse cross-pillar lookup: a tenx_hash (e.g. seen on an event in
  // the customer's SIEM / CloudWatch Logs) → the named pattern, then the
  // normal breakdown. tenx_hash is the engine's portable pattern identity;
  // this resolves the opaque hash back to a name + cost via the 10x metrics.
  let resolvedFromHash: string | undefined;
  let inputPattern = args.pattern;
  if (args.tenxHash) {
    const h = args.tenxHash.trim();
    const q = `count by (${LABELS.pattern}) (increase(all_events_summaryBytes_total{${LABELS.hash}="${h.replace(/"/g, '\\"')}",${LABELS.env}="${metricsEnv}"}[${tf.range}]))`;
    const r = await queryInstant(env, q).catch(() => null);
    const top = r && r.status === 'success'
      ? r.data.result
          .map((x) => ({ p: x.metric[LABELS.pattern] || '', v: parsePrometheusValue(x) }))
          .filter((x) => x.p)
          .sort((a, b) => b.v - a.v)[0]?.p
      : undefined;
    if (!top) {
      return `No pattern carries tenx_hash \`${h}\` in this env over the ${tf.label} window. The hash may be from a different env or outside the time range.`;
    }
    resolvedFromHash = h;
    inputPattern = top;
  }
  if (!inputPattern) {
    return 'Pass either `pattern` (a pattern name) or `pattern_hash` / `tenxHash` (an 11-char hash seen on a SIEM / CloudWatch Logs event).';
  }

  // Reporter pattern labels are always snake_case. The agent may have picked
  // up a display form (space-separated) from top_patterns / whats_changing and
  // passed it back in; normalize to the canonical form so the exact-match
  // selector lands.
  const rawInput = inputPattern;
  const pattern = normalizePattern(inputPattern);
  // Detect raw-log-line inputs BEFORE normalization (normalize strips the
  // punctuation that identifies them). A raw line typically has spaces AND
  // shell/URL punctuation; a canonical pattern identity has neither.
  const looksLikeRawLogLine = /\s/.test(rawInput) && /["'{}:/]/.test(rawInput);
  // One clean provenance line when the lookup started from an opaque hash
  // — tells the human what their SIEM hash maps to. Not agent chatter.
  // Provenance + (reverse case only) one labeled live SIEM sample.
  // The SIEM round-trip is gated on resolvedFromHash so a plain
  // pattern lookup stays a fast metrics-only path; the sample is
  // best-effort and silent when no SIEM is unambiguously available.
  const finalize = async (s: string): Promise<string> => {
    if (!resolvedFromHash) return s;
    const head = `Resolved tenx_hash \`${resolvedFromHash}\` → \`${pattern}\`\n\n${s}`;
    const sample = await fetchOneSampleByHash({
      hash: resolvedFromHash,
      service: args.service,
      scope: args.siemScope,
    });
    if (!sample) return head;
    return `${head}\n\nLive sample from ${sample.displayName} (tenx_hash ${resolvedFromHash}):\n  ${sample.line}`;
  };

  // Current window: bytes per service for this pattern
  const currentRes = await queryInstant(env, pql.patternAcrossServices(pattern, metricsEnv, tf.range));

  if (currentRes.status !== 'success' || currentRes.data.result.length === 0) {
    // Try fuzzy match with regex. Escape regex special characters AND PromQL
    // string delimiters before building the query — raw log lines commonly
    // contain quotes, colons, braces, and URL schemes that blow up the
    // Prometheus query parser with HTTP 400 if passed through verbatim.
    // Caught by sub-agent S4 (paste-triage scenario): lines with `"..."` or
    // `{...}` 400-ed silently, leaving the agent thinking the patterns didn't
    // exist when they just couldn't be queried.
    const regexSafe = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // escape regex metacharacters
      .replace(/[_ :\-]+/g, '.*')              // re-soften separators to wildcards
      .replace(/"/g, '.')                       // drop literal quotes (can't embed in PromQL string)
      .slice(0, 200);                           // cap length to keep query size sane
    const fuzzyQuery = `sum by (${LABELS.service}, ${LABELS.severity}) (increase(all_events_summaryBytes_total{${LABELS.pattern}=~".*${regexSafe}.*",${LABELS.env}="${metricsEnv}"}[${tf.range}]))`;
    const fuzzyRes = await queryInstant(env, fuzzyQuery).catch(() => null);

    if (!fuzzyRes || fuzzyRes.status !== 'success' || fuzzyRes.data.result.length === 0) {
      if (looksLikeRawLogLine) {
        // Emit a NEXT_ACTIONS hint to resolve_batch so autonomous-chain
        // walkers can pivot without rereading the prose. The structured
        // hint is what the deterministic harness and chain-walker
        // sub-models read; the prose above is for human-facing render.
        const rawHint: NextAction[] = [
          {
            tool: 'log10x_resolve_batch',
            args: { source: 'events', events: [rawInput] },
            reason: 'raw log line, resolve the raw line into a stable pattern identity via resolve_batch',
          },
        ];
        return [
          'No match found for raw log line via pattern matcher.',
          '',
          'This input looks like a raw log line (contains spaces + punctuation). `log10x_event_lookup` is for canonical pattern identities (snake_case, no punctuation). For raw-line triage, use `log10x_resolve_batch({ events: ["<line>"] })` which resolves raw lines into pattern identities first.',
          '',
          renderNextActions(rawHint),
        ]
          .filter(Boolean)
          .join('\n');
      }
      return `No data found for pattern "${pattern}". Check the pattern name (use underscores, e.g., Payment_Gateway_Timeout).`;
    }
    // Use fuzzy results
    return finalize(await formatResults(fuzzyRes.data.result, pattern, metricsEnv, tf, costPerGb, rateSource, period, env, sumOut, resolvedFromHash));
  }

  return finalize(await formatResults(currentRes.data.result, pattern, metricsEnv, tf, costPerGb, rateSource, period, env, sumOut, resolvedFromHash));
}

async function formatResults(
  results: Array<{ metric: Record<string, string>; value?: [number, string] }>,
  pattern: string,
  metricsEnv: string,
  tf: ReturnType<typeof parseTimeframe>,
  costPerGb: number | null,
  rateSource: 'list_price' | 'customer_supplied' | 'unset',
  period: string,
  env: EnvConfig,
  sumOut?: { data?: EventLookupSummary; nextActions?: NextAction[] },
  resolvedFromHash?: string
): Promise<string> {
  // Aggregate bytes per service (multiple severity levels possible).
  // Also keep the per-severity split per service: a pattern's text
  // spans severities, and a per-(pattern,service,severity) ranking
  // (top_patterns) shows ONE severity slice. Surfacing the split here
  // makes the two reconcile exactly (e.g. all-sev 603 MB = ERROR 374
  // + DEBUG 218 + (none) 11, and 374 is the slice top_patterns ranks)
  // instead of looking like a 1.6x discrepancy.
  const serviceBytes = new Map<string, number>();
  const serviceSev = new Map<string, { sev: string; bytes: number }>();
  const serviceSevSplit = new Map<string, Map<string, number>>();

  for (const r of results) {
    const svc = r.metric[LABELS.service] || '';
    const sev = r.metric[LABELS.severity] || '';
    const bytes = parsePrometheusValue(r);
    serviceBytes.set(svc, (serviceBytes.get(svc) || 0) + bytes);
    const split = serviceSevSplit.get(svc) ?? new Map<string, number>();
    split.set(sev || '(none)', (split.get(sev || '(none)') || 0) + bytes);
    serviceSevSplit.set(svc, split);
    // Keep dominant severity
    const current = serviceSev.get(svc);
    if (!current || bytes > current.bytes) {
      serviceSev.set(svc, { sev, bytes });
    }
  }

  // Baseline per service
  const baselineByService = new Map<string, number[]>();
  for (const offsetDays of tf.baselineOffsets) {
    const baseRes = await queryInstant(env, pql.patternAcrossServices(pattern, metricsEnv, tf.range, offsetDays));
    if (baseRes.status === 'success') {
      for (const r of baseRes.data.result) {
        const svc = r.metric[LABELS.service] || '';
        const arr = baselineByService.get(svc) || [];
        arr.push(parsePrometheusValue(r));
        baselineByService.set(svc, arr);
      }
    }
  }

  // Event counts per service
  const eventsRes = await queryInstant(env, pql.eventsPerServiceForPattern(pattern, metricsEnv, tf.range));
  const eventsBySvc = new Map<string, number>();
  if (eventsRes.status === 'success') {
    for (const r of eventsRes.data.result) {
      const svc = r.metric[LABELS.service] || '';
      eventsBySvc.set(svc, parsePrometheusValue(r));
    }
  }

  // Build service rows. Cost fields collapse to null when rate_source='unset'
  // so downstream renderers can gate the $-clause via fmtDisclosedDollar
  // instead of silently quoting bytes×0 or bytes×$1/GB. The disclosed mirror
  // rides alongside each numeric so the formatter cannot drop the disclosure tail.
  interface SvcRow {
    service: string; severity: string; bytes: number;
    costNow: number | null; costBaseline: number | null;
    costNowDisclosed: DisclosedDollarValue | null;
    costBaselineDisclosed: DisclosedDollarValue | null;
    events: number; isNew: boolean;
  }
  // Event-lookup does not detect the SIEM today (the rate side has the
  // override / list price split, but no destination label). Pass null so
  // the disclosure tail falls back to the generic "at SIEM list price …"
  // form per buildDisclosedDollarValue.
  const siemLabel: string | null = null;
  const rows: SvcRow[] = [];
  let totalCostNow: number | null = rateSource === 'unset' ? null : 0;
  let totalCostBase: number | null = rateSource === 'unset' ? null : 0;
  let totalEvents = 0;
  let totalBytes = 0;

  for (const [svc, bytes] of serviceBytes) {
    const costNow = costPerGb != null ? bytesToCost(bytes, costPerGb) : null;
    const baseWeeks = baselineByService.get(svc) || [];
    const isNew = baseWeeks.length === 0;
    const costBase: number | null = costPerGb == null
      ? null
      : isNew
        ? 0
        : bytesToCost(
            baseWeeks.reduce((a, b) => a + b, 0) / baseWeeks.length,
            costPerGb
          );
    const events = eventsBySvc.get(svc) || 0;
    const costNowDisclosed: DisclosedDollarValue | null = costNow == null
      ? null
      : buildDisclosedDollarValue(costNow, rateSource, siemLabel, costPerGb);
    const costBaselineDisclosed: DisclosedDollarValue | null = costBase == null
      ? null
      : buildDisclosedDollarValue(costBase, rateSource, siemLabel, costPerGb);

    rows.push({
      service: svc,
      severity: serviceSev.get(svc)?.sev || '',
      bytes,
      costNow,
      costBaseline: costBase,
      costNowDisclosed,
      costBaselineDisclosed,
      events,
      isNew,
    });
    if (totalCostNow != null && costNow != null) totalCostNow += costNow;
    if (totalCostBase != null && costBase != null) totalCostBase += costBase;
    totalEvents += events;
    totalBytes += bytes;
  }
  // Totals disclosed mirrors — built once after the per-row pass so the
  // envelope carries both raw numbers (legacy field) and the disclosed form.
  const totalCostNowDisclosed: DisclosedDollarValue | null = totalCostNow == null
    ? null
    : buildDisclosedDollarValue(totalCostNow, rateSource, siemLabel, costPerGb);
  const totalCostBaseDisclosed: DisclosedDollarValue | null = totalCostBase == null
    ? null
    : buildDisclosedDollarValue(totalCostBase, rateSource, siemLabel, costPerGb);

  // Sort by bytes (volume is the universal axis); cost-sort would silently
  // randomize ordering when rate_source='unset' and every row's cost is null.
  rows.sort((a, b) => b.bytes - a.bytes);
  const maxBytes = rows.length ? Math.max(...rows.map(r => r.bytes)) : 0;

  // Offload status (best-effort, 2s timeout). Resolve hash once: prefer
  // the hash the caller arrived with (resolvedFromHash), otherwise one
  // cheap topk(1) round-trip to recover it from the pattern name. On any
  // failure / timeout the field stays absent — gates downstream render.
  // The resolved hash is also promoted to the summary's top-level
  // `pattern_hash` so the catalog-identity-handoff carries through on
  // the raw-line / name-input path (which previously dropped the hash).
  let offloadStatus: EventLookupSummary['offload_status'];
  let summaryPatternHash: string = resolvedFromHash ?? '';
  try {
    let hashToQuery: string | undefined = resolvedFromHash;
    if (!hashToQuery) {
      const hq = `topk(1, sum by (${LABELS.hash}) (increase(all_events_summaryBytes_total{${LABELS.pattern}="${pattern.replace(/"/g, '\\"')}",${LABELS.env}="${metricsEnv}"}[24h])))`;
      const hr = await queryInstant(env, hq).catch(() => null);
      if (hr && hr.status === 'success' && hr.data.result.length > 0) {
        const h = hr.data.result[0].metric[LABELS.hash];
        if (typeof h === 'string' && h.length > 0) hashToQuery = h;
      }
    }
    if (hashToQuery && !summaryPatternHash) summaryPatternHash = hashToQuery;
    if (hashToQuery) {
      const s = await getOffloadStatus(env, {
        patternHash: hashToQuery,
        metricsEnv,
        range: '24h',
        timeoutMs: 2000,
      });
      if (s.ok && s.is_offloaded) {
        const action: 'none' | 'use_retriever_query' | 'check_advise_retriever' =
          (await isRetrieverConfigured()) ? 'use_retriever_query' : 'check_advise_retriever';
        // Partial-result path: kept-cohort scan timed out on a heavy
        // pattern (the smoke surfaced this on demo AQwRuueOWbQ at
        // 21.55 GB dropped). dropped_bytes is populated; share is null;
        // surface the actionable signal anyway.
        if (s.kept_timed_out || s.kept_bytes_in_window === null || s.dropped_bytes_in_window === null) {
          offloadStatus = {
            is_offloaded: true,
            dropped_share_pct_24h: null,
            kept_share_pct_24h: null,
            recommend_action: action,
            kept_timed_out: true,
          };
        } else {
          const total = s.kept_bytes_in_window + s.dropped_bytes_in_window;
          const droppedShare = total > 0 ? (s.dropped_bytes_in_window / total) * 100 : 0;
          offloadStatus = {
            is_offloaded: true,
            dropped_share_pct_24h: droppedShare,
            kept_share_pct_24h: 100 - droppedShare,
            recommend_action: action,
          };
        }
      } else if (s.ok) {
        offloadStatus = {
          is_offloaded: false,
          dropped_share_pct_24h: 0,
          kept_share_pct_24h: 100,
          recommend_action: 'none',
        };
      }
    }
  } catch { /* best-effort */ }

  // Populate the typed summary output for view='summary' callers.
  if (sumOut) {
    sumOut.data = {
      pattern,
      pattern_hash: summaryPatternHash,
      window: tf.label,
      services: rows.map(r => ({
        service: r.service,
        severity: r.severity,
        bytes: r.bytes,
        // share_pct = service bytes / pattern total bytes — surfaces the
        // per-service contribution as a percent so the renderer can lead
        // with byte-share before any dollar clause.
        share_pct: totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0,
        cost_per_window_usd: r.costNow,
        cost_baseline_usd: r.costBaseline,
        cost_per_window_usd_disclosed: r.costNowDisclosed,
        cost_baseline_usd_disclosed: r.costBaselineDisclosed,
        events: r.events,
        is_new: r.isNew,
        // Echo the resolved pattern_hash on every per-service row so
        // chain steps that consume this payload (investigate's offload
        // pivot, cross-pillar pattern_examples / retriever_query joins)
        // can carry the stable identity without re-fetching the
        // summary-level resolved_from_hash. Same string on all rows for
        // a given call — that is by design: rows are slices of one
        // pattern, not different patterns.
        pattern_hash: summaryPatternHash,
      })),
      totals: {
        bytes: totalBytes,
        cost_per_window_usd: totalCostNow,
        cost_baseline_usd: totalCostBase,
        cost_per_window_usd_disclosed: totalCostNowDisclosed,
        cost_baseline_usd_disclosed: totalCostBaseDisclosed,
        events: totalEvents,
        service_count: rows.length,
      },
      rate_source: rateSource,
      resolved_from_hash: resolvedFromHash,
      offload_status: offloadStatus,
    };
  }

  // Format output. One stanza per service for this single pattern:
  // header (service · severity · NEW), share-bar scaled to the busiest
  // service, then volume · baseline -> now · events.
  const lines: string[] = [];
  lines.push(`${patternDisplay(pattern).title}  ·  ${tf.label}`);
  // Bytes first; share is implicit in the totals row (this IS the total).
  // The cost clause appears only when a rate is resolved; otherwise we
  // would be quoting bytes × $1/GB and calling it a baseline.
  const totalCostBaseStr = fmtDisclosedDollar(totalCostBaseDisclosed);
  const totalCostNowStr = fmtDisclosedDollar(totalCostNowDisclosed);
  const costClause = rateSource === 'unset'
    ? ''
    : ` · cost was ${totalCostBaseStr} -> now ${totalCostNowStr}${period}`;
  lines.push(`Total: ${fmtBytes(totalBytes)} over ${tf.label}${costClause} · ${rows.length} service${rows.length !== 1 ? 's' : ''}`);
  if (rateSource !== 'unset') lines.push(`(cost: prior comparable ${tf.label} baseline -> current)`);
  lines.push(`_Total across every service and severity over ${tf.label}; the "by severity" line below shows the split. A per-(pattern,service,severity) ranking (e.g. the top-patterns list) shows ONE severity row, so its number for this pattern equals one line of that split, not this total. That is expected, not a discrepancy._`);
  lines.push('');

  for (const r of rows) {
    // No severity token here: this row is the service's ALL-severity
    // total for the pattern, so tagging it with one severity (the
    // dominant series') misread as "this is the ERROR volume" and
    // would not reconcile with a per-severity ranking. Severity split
    // is the per-pattern ranking's job, not this total view.
    const head = [r.service || '(no service)'];
    if (r.isNew) head.push('NEW');
    lines.push(`${head.join(' · ')}`);
    // Bytes + share of pattern total first; cost delta only when a rate
    // is resolved, so unset-rate readers see the volume story instead
    // of "was — -> now —" filler.
    const sharePct = totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0;
    const m = [
      `${fmtBytes(r.bytes)} (${fmtPct(sharePct)} of pattern)`,
    ];
    if (rateSource !== 'unset') {
      m.push(`was ${fmtDisclosedDollar(r.costBaselineDisclosed)} -> now ${fmtDisclosedDollar(r.costNowDisclosed)}${period}`);
    }
    if (r.events > 0) m.push(`${fmtCount(r.events)} events`);
    lines.push(`  ${m.join(' · ')}`);
    // Per-severity split so the all-severity total visibly decomposes,
    // and the SRE can see which slice a per-(pattern,service,severity)
    // ranking (top_patterns) is showing. Sorted desc, capped to 4.
    const split = serviceSevSplit.get(r.service);
    if (split && split.size > 1) {
      const parts = [...split.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([sev, b]) => `${fmtSeverity(sev) || sev} ${fmtBytes(b)}`);
      lines.push(`  by severity: ${parts.join(' · ')}`);
    }
    lines.push('');
  }
  if (lines[lines.length - 1] === '') lines.pop();

  // Offload nudge — single line, declarative, only when the receiver is
  // actively routing this pattern to forwarder offload. The recommended
  // next call is retriever_query when the retriever is wired, otherwise
  // advise_retriever for the bucket recipe.
  if (offloadStatus && offloadStatus.is_offloaded) {
    // HONESTY: the routeState="drop" marker is the engine's drop/offload cohort — it
    // does NOT distinguish offload-to-S3 (recoverable) from hard-drop (gone).
    // So we do not assert the bytes are archived/fetchable; we offer the fetch
    // conditionally and flag that a zero result means it was hard-dropped.
    const tail = offloadStatus.recommend_action === 'use_retriever_query'
      ? `If your receiver offloads this pattern to S3 (not hard-drop), fetch it via \`log10x_retriever_query({ pattern: '${pattern}', from: 'now-24h' })\`. A zero result means it was hard-dropped, not offloaded.`
      : `Check \`log10x_advise_retriever\` for the bucket recipe — the receiver is reducing this pattern but no retriever surface is configured.`;
    lines.push('');
    if (offloadStatus.kept_timed_out || offloadStatus.dropped_share_pct_24h === null || offloadStatus.kept_share_pct_24h === null) {
      lines.push(`_Reduction status (24h): this pattern is in the receiver's drop/offload cohort (routeState="drop" marker; kept-side share query slow on a heavy cohort, share not computed). ${tail}_`);
    } else {
      const dropped = fmtPct(offloadStatus.dropped_share_pct_24h);
      const kept = fmtPct(offloadStatus.kept_share_pct_24h);
      lines.push(`_Reduction status (24h): ${dropped} of this pattern's volume is in the receiver's drop/offload cohort (routeState="drop" marker; ${kept} still flowing to the SIEM). ${tail}_`);
    }
  }

  // AI analysis — OPT-IN only. queryAi posts the sampled query results + a
  // prompt to the log10x API (always log10x, never the customer's own backend),
  // so it stays OFF by default to keep the cost path from phoning home. Enable
  // with LOG10X_AI_SUMMARY=true (or wire a customer-owned AI provider later).
  if (process.env.LOG10X_AI_SUMMARY === 'true') {
  try {
    const queryResultJson = JSON.stringify(results.slice(0, 5));
    // De-verdict (TOOL-AUDIT Phase 2): ask the classifier for the FACTUAL
    // category only, not a routing verdict. The old prompt asked for
    // ACTION (filter/keep/reduce) + FILTER_PCT (% safe to filter) — an
    // asserted drop-recommendation the agent/user is better placed to judge
    // from the cost / severity / sample context this tool already returns.
    const aiPrompt = `Classify this log pattern. Pattern: ${pattern}. Provide: CATEGORY (error/debug/info/metric/health), CONFIDENCE (high/medium/low), EXPLANATION (one factual line on what the pattern represents, no recommendation).`;
    // queryAi expects a number; pass 0 when rate is unset (the AI prompt
    // only uses cost for table rendering, which we disable with
    // output_table=false, so the value is a no-op classifier-side).
    const aiResult = await queryAi(env, queryResultJson, aiPrompt, costPerGb ?? 0);

    if (aiResult) {
      lines.push('');
      lines.push('AI Analysis:');
      for (const line of aiResult.split('\n')) {
        if (line.trim()) lines.push(`  ${line.trim()}`);
      }
    }
  } catch {
    // AI analysis is optional — skip silently
  }
  }

  lines.push('');
  lines.push(`${rows.length} service${rows.length !== 1 ? 's' : ''} · ${fmtCount(totalEvents)} events`);

  // next_action hints — provide both prose (for human readers) and a
  // structured NEXT_ACTIONS block (for autonomous-chain agents). When the
  // pattern is elevated, nudge toward investigate; otherwise the standard
  // chain handoffs (pattern_trend for time series, dependency_check before
  // any mute action) are appropriate.
  const nextActions: NextAction[] = [];
  // Offload fetch-back as a STRUCTURED action (not just the prose tail above):
  // event_lookup is a primary "what is this line" entry point, so an agent
  // walking nextActions must be able to fetch the offloaded slice in one step.
  if (offloadStatus && offloadStatus.is_offloaded) {
    if (offloadStatus.recommend_action === 'use_retriever_query') {
      nextActions.push({
        tool: 'log10x_retriever_query',
        args: { pattern, from: 'now-24h' },
        reason: 'this pattern is in the drop/offload cohort; if it is offloaded to S3 (not hard-dropped), fetch the slice back. A zero result means it was hard-dropped, not offloaded',
      });
    } else {
      nextActions.push({
        tool: 'log10x_advise_retriever',
        args: {},
        reason: 'receiver is offloading this pattern but no retriever surface is configured — get the bucket recipe',
      });
    }
  }
  // Compare bytes when no rate is resolved — the regression signal is
  // volume, not the rate that translates it. With a rate set, the same
  // ratio holds (bytes×rate vs bytes×rate cancels), so this is equivalent
  // to the prior cost comparison when costs are available.
  const totalBytesBase = [...baselineByService.values()]
    .flat()
    .reduce((a, b) => a + b, 0) / Math.max(1, tf.baselineOffsets.length);
  const shortElevated = totalBytesBase > 0 && totalBytes > totalBytesBase * 2;
  const hints: string[] = [];
  if (shortElevated) {
    const pctChange = Math.round(((totalBytes - totalBytesBase) / totalBytesBase) * 10) * 10; // nearest 10%: two adjacent live queries must not show 348 vs 347
    // The short baseline (prior comparable tf.label) is diurnal-noise-
    // prone, so a raw "up X%" off it contradicts the 7d view and reads
    // as a false regression. Corroborate against 7d-vs-prior-7d HERE so
    // the suite resolves the contradiction itself instead of emitting
    // it and hoping the agent reconciles. Only 2 extra queries, only on
    // the (rare) elevated path.
    let longNow = 0, longBase = 0, longOk = false;
    try {
      const [ln, lb] = await Promise.all([
        queryInstant(env, pql.patternAcrossServices(pattern, metricsEnv, '7d')),
        queryInstant(env, pql.patternAcrossServices(pattern, metricsEnv, '7d', 7)),
      ]);
      if (ln.status === 'success' && lb.status === 'success') {
        longNow = ln.data.result.reduce((s, r) => s + parsePrometheusValue(r), 0);
        longBase = lb.data.result.reduce((s, r) => s + parsePrometheusValue(r), 0);
        longOk = true;
      }
    } catch { /* corroboration is best-effort */ }
    const longElevated = longOk && longBase > 0 && longNow > longBase * 1.5;
    lines.push('');
    if (longElevated) {
      const longPct = Math.round(((longNow - longBase) / longBase) * 10) * 10;
      lines.push(`_Cost is up ~${pctChange}% vs the prior comparable window, and ALSO up ~${longPct}% over 7d vs the prior 7d. The rise shows on both the short and the longer window, not just short-window noise._`);
      hints.push(`Corroborated regression (up ~${pctChange}% / ${tf.label}, up ~${longPct}% / 7d): trace with log10x_investigate({ starting_point: '${pattern}' }).`);
      nextActions.push({
        tool: 'log10x_investigate',
        args: { starting_point: pattern },
        reason: `corroborated cost regression (up ~${pctChange}% over ${tf.label}, up ~${longPct}% over 7d); trace the cause`,
      });
    } else if (longOk) {
      lines.push(`_${tf.label} cost is up ~${pctChange}% vs the prior comparable window, BUT the 7d view is stable (no comparable rise week-over-week). This is short-window noise, not a regression; no action needed unless it persists into the 7d trend._`);
      hints.push(`Short-window noise: ${tf.label} up ~${pctChange}% but 7d stable. Not a regression. If unsure, confirm the time series with log10x_pattern_trend({ pattern: '${pattern}' }).`);
    } else {
      lines.push(`_Cost is up ~${pctChange}% vs the prior comparable window. The 7d corroboration query did not return; confirm against a 7d/30d trend before treating this as a regression._`);
      hints.push(`Cost up ~${pctChange}% vs prior ${tf.label} (7d corroboration unavailable; confirm with log10x_pattern_trend before calling it a regression).`);
    }
  }
  hints.push(`Time series for this pattern: log10x_pattern_trend({ pattern: '${pattern}' }).`);
  nextActions.push({
    tool: 'log10x_pattern_trend',
    args: { pattern },
    reason: 'time series for the resolved pattern (volume + chart)',
  });
  // pattern_examples is a hub partner of event_lookup: it returns real
  // sample lines + slot variations for this pattern, the content-axis view
  // that complements the time-axis (pattern_trend) and the cost-axis
  // (event_lookup itself) views.
  hints.push(`Sample lines + slot variations: log10x_pattern_examples({ pattern: '${pattern}' }).`);
  nextActions.push({
    tool: 'log10x_pattern_examples',
    args: { pattern },
    reason: 'real events + slot variations for this pattern (content view)',
  });
  hints.push(`Reduce the cost of this pattern: log10x_pattern_mitigate({ pattern: '${pattern}' }) — presents drop @ analyzer / drop @ forwarder / mute @ 10x / compact @ 10x, gated on env capabilities.`);
  nextActions.push({
    tool: 'log10x_pattern_mitigate',
    args: { pattern },
    reason: 'env-gated mitigation options + exact configs for this pattern',
  });
  // investigate is the hub partner for "what else moved with this pattern".
  // The corroborated-regression path above already pushes an investigate
  // action with a stronger reason; only add the generic entry when no
  // regression-specific investigate is already queued so the chassis
  // actions[] doesn't duplicate.
  if (!nextActions.some((a) => a.tool === 'log10x_investigate')) {
    hints.push(`What else moved with this pattern: log10x_investigate({ starting_point: '${pattern}' }).`);
    nextActions.push({
      tool: 'log10x_investigate',
      args: { starting_point: pattern },
      reason: 'cross-pillar trace for anything moving with this pattern',
    });
  }
  lines.push('');
  lines.push(agentOnly(`Suggested next calls: ${hints.join(' ')}`));

  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);

  // Surface the structured nextActions to the outer chassis envelope.
  // Today the prose block (renderNextActions above) is the only way an
  // agent learns about the follow-up handoffs; that leaves the envelope's
  // typed actions[] empty. Pass the list up through sumOut so
  // executeEventLookup can map NextAction → Action and populate the chassis
  // actions[] field.
  if (sumOut) sumOut.nextActions = nextActions;
  return lines.join('\n');
}
