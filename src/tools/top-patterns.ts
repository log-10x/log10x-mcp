/**
 * log10x_top_patterns — top N patterns by cost right now, no baseline filter.
 *
 * Use this when the user wants a quick "what's expensive" snapshot without
 * the "changed recently" framing of log10x_cost_drivers. Equivalent to
 * `/log10x top` in the Slack bot.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant, queryRange } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import { fmtDollar, fmtPattern, fmtSeverity, fmtCount, parseTimeframe, costPeriodLabel } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import { renderPatternStanzas, type PatternStanzaRow } from '../lib/pattern-render.js';
import { fetchSamplesByHashes } from '../lib/siem/sample.js';
import { tenxHash } from '../lib/pattern-hash.js';

/** Top rows that get a verbatim SIEM sample line. Bounded: one SIEM
 * round-trip per row, parallel, so keep it small on this hot tool. */
const SAMPLE_TOP_N = 3;

export const topPatternsSchema = {
  service: z.string().optional().describe('Service name to scope the result. Omit for all services.'),
  severity: z.string().optional().describe('Severity level to scope the result (e.g., `ERROR`, `CRITICAL`, `DEBUG`). Omit for all severities. Caught by the eval-harness anti-hallucination campaign — agents asked for "top CRITICAL patterns" couldn\'t scope without this filter and the synthesis was missing the requested top-N.'),
  timeRange: z.string().regex(/^\d+[mhd]$/, 'Time range must look like `15m`, `48h`, `2d`, etc.').default('7d').describe('Time range to aggregate over. Free-form `<n><m|h|d>` — any number of minutes / hours / days. Examples: `15m`, `48h`, `3d`, `7d`, `30d`. Bounds: minimum 1 minute, maximum 90 days. Sub-day values are useful for incident investigation; day-level values for cost and trend analysis. (cost_drivers, which uses 3-window baseline math, remains snapped to `1d` / `7d` / `30d` for offset symmetry.)'),
  limit: z.number().min(1).max(50).default(10).describe('Number of patterns to return.'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  groupByService: z.boolean().optional().describe('Group the output into per-service sections (each with its own ranked patterns) instead of one global cross-service ranking. Default false: a single global ranking, with the service shown on each pattern.'),
  siemScope: z.string().optional().describe('SIEM scope for the verbatim sample line on the top rows: a CloudWatch log group (`/aws/ecs/my-svc`), ES index, or Splunk index. When omitted, the detected SIEM connector uses its default scope. Best-effort: a real sample replaces the tokenized pattern name as the readable identity on the top few rows; silently skipped if no SIEM resolves.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
};

export async function executeTopPatterns(
  args: { service?: string; severity?: string; timeRange: string; limit: number; analyzerCost?: number; groupByService?: boolean; siemScope?: string },
  env: EnvConfig
): Promise<string> {
  // Defensive defaults so the function is safe to call without the zod schema
  // layer (direct callers, agentic harnesses, programmatic chains). Without
  // these, `topk(undefined, …)` renders as `topk(, …)` and Prometheus returns
  // "expected type scalar in aggregation parameter" — caught by Grok round-2
  // run on otel-demo when it called log10x_top_patterns without `limit`.
  // eslint-disable-next-line no-param-reassign
  if (!args.timeRange) (args as Record<string, unknown>).timeRange = '7d';
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    (args as Record<string, unknown>).limit = 10;
  }
  const tf = parseTimeframe(args.timeRange);
  // Default $/GB when caller doesn't supply analyzerCost. Matches the
  // default in executeServices; without this, every cost cell renders
  // as `$NaN/15m` (bytes * undefined). Caught against the real GC
  // SaaS roundtrip on 2026-05-14.
  const costPerGb = args.analyzerCost ?? 1.0;
  const period = costPeriodLabel(tf.days);

  const filters: Record<string, string> = {};
  if (args.service) filters[LABELS.service] = args.service;
  if (args.severity) filters[LABELS.severity] = args.severity;

  const metricsEnv = Object.keys(filters).length > 0
    ? await resolveMetricsEnvFiltered(env, filters)
    : await resolveMetricsEnv(env);

  // Run the top-N query and a recent-activity probe in parallel.
  // The recent-activity probe is the freshness guardrail: a row that
  // ranks top-N over 7d but has zero rate in the last hour is residue
  // from a closed incident, not an active cost driver. Surface that
  // explicitly so the agent does not treat stale series as current.
  // Trend sparkline window: ~8 buckets across the lookback. step is
  // both the query_range step and the increase() inner range.
  const nowSec = Math.floor(Date.now() / 1000);
  const windowSec = Math.max(600, Math.round(tf.days * 86400));
  const stepSec = Math.max(60, Math.floor(windowSec / 8));
  const startSec = nowSec - windowSec;

  const [res, recentRes, eventsRes, totalRes, trendRes, countRes, svcRes] = await Promise.all([
    queryInstant(env, pql.topPatternsFull(filters, metricsEnv, tf.range, args.limit)),
    queryInstant(env, pql.recentRateByPattern(filters, metricsEnv, '1h')).catch(() => null),
    queryInstant(env, pql.eventsByPatternFull(filters, metricsEnv, tf.range)).catch(() => null),
    queryInstant(env, pql.totalBytesInScope(filters, metricsEnv, tf.range)).catch(() => null),
    queryRange(env, pql.seriesByPatternFull(filters, metricsEnv, stepSec), startSec, nowSec, stepSec).catch(() => null),
    queryInstant(env, pql.distinctPatternCount(filters, metricsEnv, tf.range)).catch(() => null),
    queryInstant(env, pql.servicesByPatternFull(filters, metricsEnv, tf.range)).catch(() => null),
  ]);
  if (res.status !== 'success' || res.data.result.length === 0) {
    return 'No pattern data available. Patterns appear after the first 24h of data collection.';
  }

  // Build recent-rate lookup keyed by (pattern, service, severity).
  // Track whether the probe itself succeeded — on failure we must NOT
  // tag rows as stale (an empty lookup against a failed probe is a
  // false positive: "everything is stale because we couldn't ask").
  const recentRateKey = (p: string, s: string, sv: string) => `${p}\x00${s}\x00${sv}`;
  const recentRates = new Map<string, number>();
  const freshnessProbeOk = !!(recentRes && recentRes.status === 'success');
  if (freshnessProbeOk) {
    for (const r of recentRes!.data.result) {
      const k = recentRateKey(
        r.metric[LABELS.pattern] || '',
        r.metric[LABELS.service] || '',
        r.metric[LABELS.severity] || ''
      );
      const v = parsePrometheusValue(r);
      if (Number.isFinite(v)) recentRates.set(k, v);
    }
  }

  // (no-symbol) replaces the older (unknown) placeholder. An empty
  // message_pattern label means the engine tokenized the event but
  // symbol-lookup did not produce a canonical name — the metric does
  // not tell us what the events were. Agents must not speculate about
  // event content from this row; the rendered output says so below.
  // Event-count lookup, keyed identically (pattern, service, severity)
  // so it joins 1:1 with the byte rows. Non-fatal: a failed probe just
  // omits the "N events" figure, never blocks the ranking.
  const eventsByKey = new Map<string, number>();
  if (eventsRes && eventsRes.status === 'success') {
    for (const r of eventsRes.data.result) {
      const k = recentRateKey(
        r.metric[LABELS.pattern] || '',
        r.metric[LABELS.service] || '',
        r.metric[LABELS.severity] || ''
      );
      const v = parsePrometheusValue(r);
      if (Number.isFinite(v) && v > 0) eventsByKey.set(k, v);
    }
  }

  // Trend series, keyed identically. Each matrix row has .values
  // ([ts, "n"] per bucket); we keep just the numeric sequence for the
  // sparkline. Non-fatal: no series -> the renderer falls back to a bar.
  const trendByKey = new Map<string, number[]>();
  if (trendRes && trendRes.status === 'success' && Array.isArray(trendRes.data.result)) {
    for (const r of trendRes.data.result as Array<{ metric: Record<string, string>; values?: [number, string][] }>) {
      const k = recentRateKey(
        r.metric[LABELS.pattern] || '',
        r.metric[LABELS.service] || '',
        r.metric[LABELS.severity] || ''
      );
      const raw = (r.values || [])
        .map(([, val]) => Number(val))
        .map(n => (Number.isFinite(n) ? n : 0));
      // Drop the first bucket: increase() over the first query_range
      // step double-counts the catch-up from before the window start,
      // so bucket 0 is a spurious spike that mislabels the trend
      // (caught by an independent review: every series showed a
      // leading block then "flat"). The remaining buckets are clean.
      const seq = raw.length > 2 ? raw.slice(1) : raw;
      if (seq.length >= 2) trendByKey.set(k, seq);
    }
  }

  // Which services each pattern impacts (pattern -> services by bytes
  // desc). A pattern can span services; the row's own service is just
  // where it ranked. Non-fatal.
  const svcByPattern = new Map<string, Array<{ svc: string; bytes: number }>>();
  if (svcRes && svcRes.status === 'success') {
    for (const r of svcRes.data.result) {
      const p = r.metric[LABELS.pattern] || '';
      const svc = r.metric[LABELS.service] || '';
      const b = parsePrometheusValue(r);
      if (!p || !svc || !Number.isFinite(b) || b <= 0) continue;
      const arr = svcByPattern.get(p) ?? [];
      arr.push({ svc, bytes: b });
      svcByPattern.set(p, arr);
    }
    for (const arr of svcByPattern.values()) arr.sort((a, b) => b.bytes - a.bytes);
  }
  const impactsLine = (p: string): string | undefined => {
    const arr = svcByPattern.get(p);
    if (!arr || arr.length === 0) return undefined;
    const head = arr.slice(0, 3).map(x => x.svc);
    const extra = arr.length - head.length;
    return extra > 0 ? `${head.join(', ')} (+${extra} more)` : head.join(', ');
  };

  // Distinct pattern count in scope (the "of M" reconciliation).
  let totalPatternCount: number | undefined;
  if (countRes && countRes.status === 'success' && countRes.data.result.length > 0) {
    const n = parsePrometheusValue(countRes.data.result[0]);
    if (Number.isFinite(n) && n > 0) totalPatternCount = Math.round(n);
  }

  // Cut-risk is a SEVERITY HEURISTIC, not a guarantee. ERROR/CRITICAL/
  // FATAL carry diagnostics you usually want to keep; DEBUG/TRACE are
  // typically safe to thin. The tool cannot certify safety; it points
  // the reader at event_lookup / dependency_check to confirm.
  const cutRisk = (sev: string): string => {
    const s = sev.toLowerCase();
    if (s === 'error' || s === 'critical' || s === 'fatal') return 'cut-risk:high';
    if (s === 'warn' || s === 'warning') return 'cut-risk:med';
    return 'cut-risk:low';
  };

  const NO_SYMBOL = '(no-symbol)';
  interface Row { hash: string; tenxHash: string; service: string; severity: string; bytes: number; cost: number; events: number; recentRate: number; isStale: boolean; isNoSymbol: boolean }
  const rows: Row[] = res.data.result.map(r => {
    const rawPattern = r.metric[LABELS.pattern] || '';
    const service = r.metric[LABELS.service] || '';
    const severity = r.metric[LABELS.severity] || '';
    const bytes = parsePrometheusValue(r);
    const rate = recentRates.get(recentRateKey(rawPattern, service, severity)) ?? 0;
    return {
      hash: rawPattern || NO_SYMBOL,
      tenxHash: r.metric[LABELS.hash] || '',
      service,
      severity,
      bytes,
      cost: bytesToCost(bytes, costPerGb),
      events: eventsByKey.get(recentRateKey(rawPattern, service, severity)) ?? 0,
      recentRate: rate,
      isStale: freshnessProbeOk && rate <= 0,
      isNoSymbol: !rawPattern,
    };
  });
  // Collapse rows that are the same (pattern, service, severity) but
  // split across tenx_hash values. During the tenx_hash rollout the
  // backend holds an unhashed and a hashed series per pattern; topk
  // groups by hash, so they surface as duplicate-looking rows. Every
  // hash-agnostic tool (services, cost_drivers) sums these the same
  // way and produces the product's trusted totals, so the engine
  // writes each event to exactly one series: summing is correct, not
  // double-counting. Keep the non-empty hash for the agent block.
  const mergedByKey = new Map<string, Row>();
  for (const r of rows) {
    const k = recentRateKey(r.isNoSymbol ? '' : r.hash, r.service, r.severity);
    const ex = mergedByKey.get(k);
    if (!ex) { mergedByKey.set(k, { ...r }); continue; }
    // bytes come from topPatternsFull (hash IS in the group-by) so the
    // split rows partition the volume -> sum. events come from
    // eventsByPatternFull (hash-agnostic) so both split rows already
    // carry the full logical total -> take max, not sum (summing would
    // double-count). recentRate is likewise hash-agnostic -> max.
    ex.bytes += r.bytes;
    ex.cost += r.cost;
    ex.events = Math.max(ex.events, r.events);
    ex.recentRate = Math.max(ex.recentRate, r.recentRate);
    ex.isStale = ex.isStale && r.isStale; // active if ANY split series is active
    if (!ex.tenxHash && r.tenxHash) ex.tenxHash = r.tenxHash;
  }
  const merged = [...mergedByKey.values()].sort((a, b) => b.cost - a.cost);
  rows.length = 0;
  rows.push(...merged);

  // Verbatim SIEM sample for the top rows: the readable identity (the
  // tokenized name degenerates to field-soup for JSON logs). Bounded
  // to SAMPLE_TOP_N, parallel, raced against a hard timeout so a
  // slow/absent SIEM never stalls this hot tool. No new data plane:
  // reads the user's own SIEM by exact tenx_hash.
  //
  // The join hash is COMPUTED locally (tenxHash(pattern)) rather than
  // read from the metric's tenx_hash label: that label is unreliable
  // mid-rollout (a pattern has a hashed and an unhashed series; topk
  // may surface either, so the label flickers between the real hash
  // and ""). tenxHash(pattern) is conformance-proven byte-identical
  // to the engine's emitted hash (harness Gate 3, 0 mismatch), so it
  // is snapshot-independent and always correct.
  const localHash = (r: { isNoSymbol: boolean; hash: string }): string =>
    r.isNoSymbol ? '' : tenxHash(r.hash);
  const sampleSpecs = rows
    .filter(r => !r.isNoSymbol)
    .slice(0, SAMPLE_TOP_N)
    .map(r => ({ hash: localHash(r), severity: r.severity, service: r.service }))
    .filter(s => s.hash);
  const sampleByHash: Map<string, string> = sampleSpecs.length === 0
    ? new Map()
    : await Promise.race([
        fetchSamplesByHashes(sampleSpecs, { scope: args.siemScope }),
        new Promise<Map<string, string>>(res => setTimeout(() => res(new Map()), 5000)),
      ]);

  const displayName = args.service || 'all services';
  const totalTopBytes = rows.reduce((s, r) => s + r.bytes, 0);
  const totalTopCost = rows.reduce((s, r) => s + r.cost, 0);

  // Total volume in scope (from the parallel probe): the share-bar
  // denominator and the "top-N vs total" coverage footer. Non-fatal:
  // a failed probe falls back to the top-N sum, which still renders a
  // sensible (relative) bar. At high volume this is load-bearing:
  // "Top 10 = 18% of total" vs "Top 10 = 92% of total" are very
  // different situations and change the next-action recommendation.
  let scopeTotalBytes: number | undefined;
  if (totalRes && totalRes.status === 'success' && totalRes.data.result.length > 0) {
    const v = parsePrometheusValue(totalRes.data.result[0]);
    if (Number.isFinite(v) && v > 0) scopeTotalBytes = v;
  }
  const scopeCoveragePct = scopeTotalBytes ? (totalTopBytes / scopeTotalBytes) * 100 : undefined;

  let staleCount = 0;
  let noSymbolCount = 0;
  for (const r of rows) { if (r.isStale) staleCount++; if (r.isNoSymbol) noSymbolCount++; }

  // tenx_hash is intentionally NOT shown in the human stanza: it is a
  // cross-pillar join key, noise in a "what is expensive" view. It
  // stays in the agent-only join-keys block below (machine use) and
  // surfaces to humans only in the tools where they act on it
  // (event_lookup reverse, exclusion_filter exact-drop).
  const stanzaRows: PatternStanzaRow[] = rows.map(r => ({
    pattern: r.hash,
    service: r.service,
    severity: r.severity,
    bytes: r.bytes,
    cost: r.cost,
    events: r.events,
    spark: trendByKey.get(recentRateKey(r.isNoSymbol ? '' : r.hash, r.service, r.severity)),
    sample: r.isNoSymbol ? undefined : sampleByHash.get(localHash(r)),
    impacts: impactsLine(r.isNoSymbol ? '' : r.hash),
    flags: [
      ...(r.isStale ? ['stale'] : []),
      ...(r.isNoSymbol ? ['no-symbol'] : []),
      cutRisk(r.severity),
    ],
  }));

  // Single dominant service -> hoist into the header instead of
  // repeating it on every row (a real env with one noisy service).
  const svcSet = new Set(rows.map(r => r.service).filter(Boolean));
  const hoistedService = svcSet.size === 1 ? [...svcSet][0] : undefined;

  const scopeCostNum = scopeTotalBytes ? bytesToCost(scopeTotalBytes, costPerGb) : totalTopCost;
  const annualMult = tf.days > 0 ? 365 / tf.days : 0;
  const annualNote = annualMult > 0 ? `~${fmtDollar(scopeCostNum * annualMult)}/yr at this rate` : undefined;

  const lines: string[] = [];
  lines.push(renderPatternStanzas(stanzaRows, {
    title: 'Top patterns',
    scopeLabel: displayName,
    windowLabel: tf.label,
    periodSuffix: period,
    scopeBytes: scopeTotalBytes ?? totalTopBytes,
    shownBytes: totalTopBytes,
    scopeCost: scopeCostNum,
    totalPatternCount,
    annualNote,
    hoistedService,
    groupByService: !!args.groupByService,
  }));
  // User-facing caveat: short, factual, no directives or tool names.
  lines.push('');
  lines.push(`_Current rank by cost, point-in-time, not a growth or week-over-week ranking._`);
  // Agent-facing constraint: don't re-label, and the tool name to use for growth.
  lines.push(agentOnly(`Constraint: these rows are CURRENT RANK by cost over the window, not a growth/delta ranking. Do not re-label as "cost drivers" or quote these as week-over-week changes. For growth, call log10x_cost_drivers.`));

  // Explicit guardrail for the (no-symbol) row: the metric does NOT
  // tell us what the events were. Agents must not invent a name or
  // speculate about content from this row's other labels alone.
  if (noSymbolCount > 0) {
    lines.push('');
    // User-facing: one line, not an essay.
    lines.push(`_\`${NO_SYMBOL}\`: engine tokenized but produced no canonical name; volume is real, event text is unknown._`);
    // Agent-facing: don't speculate; specific follow-up tool.
    lines.push(agentOnly(
      `Constraint: do not speculate about event content from a (no-symbol) row. To inspect the actual events, use log10x_retriever_query (if Retriever is deployed for this env) or check the source pod's stdout directly.`
    ));
  }
  if (staleCount > 0) {
    lines.push('');
    // User-facing: explain what stale means.
    lines.push(
      `_${staleCount} row${staleCount > 1 ? 's' : ''} above tagged \`stale\`: ranked top-N over ${tf.label} but produced zero events in the last hour. Residue of a past incident inside the lookback window, not a current cost driver._`
    );
    lines.push(agentOnly(
      `Constraint: when recommending action, discount stale rows — they aren't currently firing. Prefer non-stale rows as starting_point.`
    ));
  }

  if (scopeCoveragePct !== undefined) {
    const shownPct = Math.round(scopeCoveragePct);
    const tailPct = Math.max(0, 100 - shownPct);
    lines.push('');
    lines.push(`Top ${rows.length} = ${shownPct}% of total volume in scope / ${tailPct}% in the long tail.`);
  }

  // cut-risk framing: it is a severity heuristic, NOT a safety
  // guarantee. Say so plainly so nobody drops an ERROR pattern on the
  // strength of a tag, and point at the tools that actually confirm.
  lines.push('');
  lines.push(`_cut-risk is a severity heuristic, not a guarantee: high = ERROR/CRITICAL/FATAL (usually keep), low = DEBUG/TRACE/INFO. Check a real sample and downstream consumers before dropping._`);
  lines.push(agentOnly(
    `Constraint: cut-risk is derived only from severity. Do NOT assert a pattern is "safe to cut" from the tag alone. Before recommending a drop/mute, confirm with log10x_event_lookup({ pattern }) (or { tenxHash }) for the real events and log10x_dependency_check for downstream consumers. To EXPLAIN what a pattern is, do not synthesize from the tokenized name: pull a real sample via log10x_event_lookup or log10x_pattern_examples and explain from that. The tokenized pattern name is an identity, not a description.`
  ));

  // ── Newly-emerged-patterns probe ──
  // The main ranking above is cost-weighted over `tf.range`, which buries
  // freshly-appearing patterns by design: a pattern that's been firing for
  // 90 seconds at 6 events/sec has ~540 events total, which is invisible
  // next to 24h-integrated steady-state patterns with billions of events.
  // Caught by sub-agent S10 (seeded retry-storm canary): the canary was at
  // rank #37 and the agent missed it entirely, finding a different
  // long-running APM-invisible bug instead.
  //
  // Fix: ALSO probe for patterns with significant current (5m) rate and
  // zero rate at 1h-ago. These are "newly emerged" by construction and
  // deserve a prominent section regardless of their cumulative cost.
  // Query cost: +1 PromQL query. Returns a small result set (typically 0-3
  // rows). No-op for steady-state environments.
  interface NewRow { hash: string; service: string; severity: string; rate: number }
  const newlyEmerged: NewRow[] = [];
  try {
    const scopeFilter = args.service ? `,${LABELS.service}="${args.service.replace(/"/g, '\\"')}"` : '';
    const newlyEmergedQ =
      `topk(5, sum by (${LABELS.pattern}, ${LABELS.service}, ${LABELS.severity}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"${scopeFilter}}[5m])) > 0.001) ` +
      `unless on (${LABELS.pattern}) ` +
      `(sum by (${LABELS.pattern}) (rate(all_events_summaryVolume_total{${LABELS.env}="${metricsEnv}"${scopeFilter}}[5m] offset 1h)) > 0)`;
    const newRes = await queryInstant(env, newlyEmergedQ);
    if (newRes.status === 'success') {
      for (const r of newRes.data.result) {
        const rate = parsePrometheusValue(r);
        if (!Number.isFinite(rate) || rate <= 0) continue;
        newlyEmerged.push({
          hash: r.metric[LABELS.pattern] || '(unknown)',
          service: r.metric[LABELS.service] || '',
          severity: r.metric[LABELS.severity] || '',
          rate,
        });
      }
      newlyEmerged.sort((a, b) => b.rate - a.rate);
    }
  } catch {
    // non-fatal
  }

  if (newlyEmerged.length > 0) {
    lines.push('');
    lines.push('### ⚡ Newly emerged patterns (last 5 min, no activity 1h ago)');
    lines.push('');
    lines.push('_These patterns are firing right now but were silent 1h ago. They are likely too fresh to appear in the cost ranking above (which integrates over a longer window). Investigate individually if unexpected._');
    lines.push('');
    for (let i = 0; i < newlyEmerged.length; i++) {
      const r = newlyEmerged[i];
      const name = fmtPattern(r.hash).padEnd(35);
      const rateLabel = `${r.rate.toFixed(3)} events/s`;
      const sev = fmtSeverity(r.severity);
      const svc = r.service ? `  ${r.service}` : '';
      lines.push(`  ${name} ${rateLabel.padEnd(18)} ${sev}${svc}`);
    }
  }

  // ── Cross-pillar join keys (tenx_hash) ──
  // tenx_hash is the engine's stable, portable pattern identity. A
  // 10x-powered forwarder ships this exact value on every matching event
  // into the customer SIEM / CloudWatch Logs, so it is the exact-match
  // join key between a pattern here and the raw events there. Surfaced
  // agent-only (machine cross-reference, not user prose). Doubles as
  // capability detection: derived from the live result, no extra query.
  const hashed = rows.filter(r => !r.isNoSymbol && r.tenxHash);
  if (hashed.length > 0) {
    const map = hashed.slice(0, 10).map(r => `${r.hash} = ${r.tenxHash}`).join('; ');
    lines.push('');
    lines.push(agentOnly(
      `Cross-pillar join keys — tenx_hash: ${map}. ` +
      `To correlate a pattern here with raw events shipped by a 10x-powered forwarder, ` +
      `filter the SIEM / CloudWatch Logs group on the field tenx_hash="<value>" — exact match, no regex.`
    ));
  } else if (rows.some(r => !r.isNoSymbol)) {
    lines.push('');
    lines.push(agentOnly(
      `Capability: this env's metrics carry no tenx_hash label (engine symbolMessageHashField unset or pre-dates the tenx_hash build). ` +
      `Exact cross-pillar hash correlation is unavailable here; fall back to message_pattern matching.`
    ));
  }

  const nextActions: NextAction[] = [];
  // Pick the first row that is BOTH a real pattern identity AND
  // currently active. A stale row or a (no-symbol) row is not a
  // useful starting_point — investigate can't resolve (no-symbol),
  // and stale rows just lead the agent back to a closed incident.
  const topActiveRow = rows.find(r => !r.isNoSymbol && !r.isStale && r.hash);
  if (rows[0]) {
    // Build the structured + prose next-action hints for the agent.
    // The user has no use for "call log10x_X" instructions; the agent does.
    const hints: string[] = [];
    if (topActiveRow) {
      hints.push(`Trace the top active pattern (skipping stale/no-symbol rows): log10x_investigate({ starting_point: '${topActiveRow.hash}' }).`);
      nextActions.push({
        tool: 'log10x_investigate',
        args: { starting_point: topActiveRow.hash },
        reason: 'trace the top active pattern (skipping stale/no-symbol rows)',
      });
    }
    if (newlyEmerged.length > 0 && newlyEmerged[0].hash && newlyEmerged[0].hash !== '(no-symbol)' && newlyEmerged[0].hash !== '(unknown)') {
      hints.push(`Newly-emerged pattern (firing now, not yet in the cost ranking): log10x_investigate({ starting_point: '${newlyEmerged[0].hash}', window: '15m' }).`);
      nextActions.push({
        tool: 'log10x_investigate',
        args: { starting_point: newlyEmerged[0].hash, window: '15m' },
        reason: 'investigate newly-emerged pattern',
      });
    }
    const svcHint = args.service || topActiveRow?.service || rows[0]?.service;
    if (svcHint) {
      hints.push(`Week-over-week deltas on the top service: log10x_cost_drivers({ service: '${svcHint}', timeRange: '7d' }).`);
      nextActions.push({
        tool: 'log10x_cost_drivers',
        args: { service: svcHint, timeRange: '7d' },
        reason: 'week-over-week deltas on the top service',
      });
    } else {
      hints.push(`Week-over-week deltas across all services: log10x_cost_drivers({ timeRange: '7d' }).`);
      nextActions.push({
        tool: 'log10x_cost_drivers',
        args: { timeRange: '7d' },
        reason: 'week-over-week deltas across all services',
      });
    }
    // Drop-routine-pattern path: discoverable only if the agent reads
    // this hint. Gated on topActiveRow so we don't recommend dropping
    // a (no-symbol) or stale series.
    if (topActiveRow) {
      hints.push(`Reduce the cost of a high-volume pattern: log10x_pattern_mitigate({ pattern: '${topActiveRow.hash}' }) — presents the four options (drop @ analyzer / drop @ forwarder / mute @ 10x / compact @ 10x) gated on this env's capabilities, then routes to the right sub-tool based on user choice.`);
    }
    if (hints.length > 0) {
      lines.push('');
      lines.push(agentOnly(`Suggested next calls: ${hints.join(' ')}`));
    }
  }
  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);
  return lines.join('\n');
}
