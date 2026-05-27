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
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import {
  fmtDollar, fmtPattern, fmtSeverity, fmtCount, fmtBytes,
  parseTimeframe, costPeriodLabel, normalizePattern
} from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import { fetchOneSampleByHash } from '../lib/siem/sample.js';
import { patternDisplay } from '../lib/pattern-descriptor.js';
import { buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';

export const eventLookupSchema = {
  pattern: z.string().optional().describe('Pattern name or search term to look up (e.g., "Payment_Gateway_Timeout"). Omit when passing `tenxHash` instead.'),
  tenxHash: z.string().optional().describe('A tenx_hash value (e.g. seen on an event in your SIEM / CloudWatch Logs). Resolved against the 10x metrics to recover the pattern, then the normal cost/services breakdown is shown. This is the reverse of the cross-pillar join: opaque SIEM hash → named pattern + cost.'),
  service: z.string().optional().describe('Service to scope the lookup'),
  timeRange: z.enum(['1d', '7d', '30d']).default('7d').describe('Time range'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB'),
  siemScope: z.string().optional().describe('SIEM scope for the live sample line on a tenxHash reverse lookup: a CloudWatch log group (`/aws/ecs/my-svc`), ES index, or Splunk index. When omitted, the detected SIEM connector uses its own default scope. Only consulted when `tenxHash` was passed (the cross-pillar correlation case).'),
  environment: z.string().optional().describe('Environment nickname'),
  view: z.enum(['summary', 'markdown']).default('summary').describe('Output format. summary returns a structured envelope; markdown returns the rendered table.'),
};

interface EventLookupSummary {
  pattern: string;
  window: string;
  services: Array<{ service: string; severity: string; bytes: number; cost_per_window_usd: number; cost_baseline_usd: number; events: number; is_new: boolean }>;
  totals: { bytes: number; cost_per_window_usd: number; cost_baseline_usd: number; events: number; service_count: number };
  resolved_from_hash?: string;
}

export async function executeEventLookup(
  args: { pattern?: string; tenxHash?: string; service?: string; timeRange?: string; analyzerCost?: number; siemScope?: string; view?: 'summary' | 'markdown' },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const view = args.view ?? 'summary';
  const sumOut: { data?: EventLookupSummary } = {};
  const md = await executeEventLookupInner(args, env, sumOut);
  if (view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_event_lookup',
      summary: { headline: md.split('\n')[0]?.slice(0, 200) || 'event_lookup result' },
      markdown: md,
    });
  }
  // Summary view: typed envelope when data was computed; fall back to
  // markdown envelope for early-return cases (no data, raw line, etc).
  if (!sumOut.data) {
    return buildMarkdownEnvelope({
      tool: 'log10x_event_lookup',
      summary: { headline: md.split('\n')[0]?.slice(0, 200) || 'event_lookup result' },
      markdown: md,
    });
  }
  const d = sumOut.data;
  const headline = `\`${d.pattern}\` over ${d.window}: $${d.totals.cost_per_window_usd.toFixed(2)} across ${d.totals.service_count} service${d.totals.service_count === 1 ? '' : 's'} (${d.totals.events} events, ${(d.totals.bytes / 1_000_000).toFixed(1)} MB)`;
  const { buildEnvelope } = await import('../lib/output-types.js');
  return buildEnvelope({
    tool: 'log10x_event_lookup',
    view: 'summary',
    summary: { headline },
    data: d,
  });
}

async function executeEventLookupInner(
  args: { pattern?: string; tenxHash?: string; service?: string; timeRange?: string; analyzerCost?: number; siemScope?: string },
  env: EnvConfig,
  sumOut?: { data?: EventLookupSummary }
): Promise<string> {
  // Defensive defaults — schema defaults only apply at the MCP-SDK
  // boundary; chain-walkers, internal callers, and the eval harness
  // can land here with raw args. Match eventLookupSchema defaults.
  const timeRange = args.timeRange ?? '7d';
  const tf = parseTimeframe(timeRange);
  const costPerGb = args.analyzerCost ?? 1.0;
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
    return 'Pass either `pattern` (a pattern name) or `tenxHash` (a hash seen on a SIEM / CloudWatch Logs event).';
  }

  // Reporter pattern labels are always snake_case. The agent may have picked
  // up a display form (space-separated) from top_patterns / cost_drivers and
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
            reason: 'raw log line — templatize via resolve_batch to get a stable pattern identity',
          },
        ];
        return [
          'No match found for raw log line via pattern matcher.',
          '',
          'This input looks like a raw log line (contains spaces + punctuation). `log10x_event_lookup` is for canonical pattern identities (snake_case, no punctuation). For raw-line triage, use `log10x_resolve_batch({ events: ["<line>"] })` which templatizes lines into pattern identities first.',
          '',
          renderNextActions(rawHint),
        ]
          .filter(Boolean)
          .join('\n');
      }
      return `No data found for pattern "${pattern}". Check the pattern name (use underscores, e.g., Payment_Gateway_Timeout).`;
    }
    // Use fuzzy results
    return finalize(await formatResults(fuzzyRes.data.result, pattern, metricsEnv, tf, costPerGb, period, env, sumOut, resolvedFromHash));
  }

  return finalize(await formatResults(currentRes.data.result, pattern, metricsEnv, tf, costPerGb, period, env, sumOut, resolvedFromHash));
}

async function formatResults(
  results: Array<{ metric: Record<string, string>; value?: [number, string] }>,
  pattern: string,
  metricsEnv: string,
  tf: ReturnType<typeof parseTimeframe>,
  costPerGb: number,
  period: string,
  env: EnvConfig,
  sumOut?: { data?: EventLookupSummary },
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

  // Build service rows
  interface SvcRow {
    service: string; severity: string; bytes: number;
    costNow: number; costBaseline: number; events: number; isNew: boolean;
  }
  const rows: SvcRow[] = [];
  let totalCostNow = 0;
  let totalCostBase = 0;
  let totalEvents = 0;
  let totalBytes = 0;

  for (const [svc, bytes] of serviceBytes) {
    const costNow = bytesToCost(bytes, costPerGb);
    const baseWeeks = baselineByService.get(svc) || [];
    const isNew = baseWeeks.length === 0;
    const costBase = isNew ? 0 : bytesToCost(
      baseWeeks.reduce((a, b) => a + b, 0) / baseWeeks.length,
      costPerGb
    );
    const events = eventsBySvc.get(svc) || 0;

    rows.push({ service: svc, severity: serviceSev.get(svc)?.sev || '', bytes, costNow, costBaseline: costBase, events, isNew });
    totalCostNow += costNow;
    totalCostBase += costBase;
    totalEvents += events;
    totalBytes += bytes;
  }

  rows.sort((a, b) => b.costNow - a.costNow);
  const maxBytes = rows.length ? Math.max(...rows.map(r => r.bytes)) : 0;

  // Populate the typed summary output for view='summary' callers.
  if (sumOut) {
    sumOut.data = {
      pattern,
      window: tf.label,
      services: rows.map(r => ({
        service: r.service,
        severity: r.severity,
        bytes: r.bytes,
        cost_per_window_usd: r.costNow,
        cost_baseline_usd: r.costBaseline,
        events: r.events,
        is_new: r.isNew,
      })),
      totals: {
        bytes: totalBytes,
        cost_per_window_usd: totalCostNow,
        cost_baseline_usd: totalCostBase,
        events: totalEvents,
        service_count: rows.length,
      },
      resolved_from_hash: resolvedFromHash,
    };
  }

  // Format output. One stanza per service for this single pattern:
  // header (service · severity · NEW), share-bar scaled to the busiest
  // service, then volume · baseline -> now · events.
  const lines: string[] = [];
  lines.push(`${patternDisplay(pattern).title}  ·  ${tf.label}`);
  lines.push(`Total: ${fmtBytes(totalBytes)} over ${tf.label} · cost was ${fmtDollar(totalCostBase)} -> now ${fmtDollar(totalCostNow)}${period} · ${rows.length} service${rows.length !== 1 ? 's' : ''}`);
  lines.push(`(cost: prior comparable ${tf.label} baseline -> current)`);
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
    const m = [
      fmtBytes(r.bytes),
      `was ${fmtDollar(r.costBaseline)} -> now ${fmtDollar(r.costNow)}${period}`,
    ];
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

  // AI analysis
  try {
    const queryResultJson = JSON.stringify(results.slice(0, 5));
    // De-verdict (TOOL-AUDIT Phase 2): ask the classifier for the FACTUAL
    // category only, not a routing verdict. The old prompt asked for
    // ACTION (filter/keep/reduce) + FILTER_PCT (% safe to filter) — an
    // asserted drop-recommendation the agent/user is better placed to judge
    // from the cost / severity / sample context this tool already returns.
    const aiPrompt = `Classify this log pattern. Pattern: ${pattern}. Provide: CATEGORY (error/debug/info/metric/health), CONFIDENCE (high/medium/low), EXPLANATION (one factual line on what the pattern represents, no recommendation).`;
    const aiResult = await queryAi(env, queryResultJson, aiPrompt, costPerGb);

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

  lines.push('');
  lines.push(`${rows.length} service${rows.length !== 1 ? 's' : ''} · ${fmtCount(totalEvents)} events`);

  // next_action hints — provide both prose (for human readers) and a
  // structured NEXT_ACTIONS block (for autonomous-chain agents). When the
  // pattern is elevated, nudge toward investigate; otherwise the standard
  // chain handoffs (pattern_trend for time series, dependency_check before
  // any mute action) are appropriate.
  const nextActions: NextAction[] = [];
  const shortElevated = totalCostBase > 0 && totalCostNow > totalCostBase * 2;
  const hints: string[] = [];
  if (shortElevated) {
    const pctChange = Math.round(((totalCostNow - totalCostBase) / totalCostBase) * 10) * 10; // nearest 10%: two adjacent live queries must not show 348 vs 347
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
    reason: 'time series for the resolved pattern',
  });
  hints.push(`Reduce the cost of this pattern: log10x_pattern_mitigate({ pattern: '${pattern}' }) — presents drop @ analyzer / drop @ forwarder / mute @ 10x / compact @ 10x, gated on env capabilities.`);
  nextActions.push({
    tool: 'log10x_pattern_mitigate',
    args: { pattern },
    reason: 'env-gated mitigation options + exact configs for this pattern',
  });
  lines.push('');
  lines.push(agentOnly(`Suggested next calls: ${hints.join(' ')}`));

  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);
  return lines.join('\n');
}
