/**
 * log10x_top_patterns — v2 layout.
 *
 * Hero MCP tool: "show me what's expensive and help me decide what to
 * drop, mute, or compact." Three pillars over the legacy implementation:
 *   1. Identity-first table + per-pattern cards
 *   2. Inline cost trend chart (24h) for the top-3 + NEW rows
 *   3. Field-variation block from real SIEM events (not slot-cardinality
 *      heuristics) — answers "what does this hash actually group?"
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant, queryRange } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, parsePrometheusValue } from '../lib/cost.js';
import { resolveMetricsEnv, resolveMetricsEnvFiltered } from '../lib/resolve-env.js';
import { parseTimeframe } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import { fetchEventsByHashes } from '../lib/siem/sample.js';
import { tenxHash } from '../lib/pattern-hash.js';
import { fetchFirstSeenBatch } from '../lib/first-seen.js';
import { fieldVariation } from '../lib/field-variation.js';
import { renderTopPatterns, type TopPatternRow } from '../lib/top-patterns-render.js';
import { detectIncidents, type IncidentInput } from '../lib/detectors/incident-cluster.js';
import { buildEnvelope, buildMarkdownEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { newTelemetry, buildUnifiedFields } from '../lib/unified-envelope.js';
import type { ForwarderId } from '../lib/forwarder-snippets.js';
import { resolveSiemSelection } from '../lib/siem/resolve.js';
import {
  classifyBadge,
  fetchBaselineBytes,
  fetchServiceBreadth,
  fetchDepsPerHash,
  datadogAnalyzerQuery,
  healthBanner,
} from '../lib/top-patterns-extras.js';

export const topPatternsSchema = {
  service: z.string().optional().describe('Service name to scope the result. Omit for all services.'),
  severity: z.string().optional().describe('Severity level to scope the result (e.g., `ERROR`, `CRITICAL`, `DEBUG`).'),
  timeRange: z.string().regex(/^\d+[mhd]$/).default('1h').describe('Time range to aggregate over. Default 1h.'),
  limit: z.number().min(1).max(50).default(5).describe('Number of patterns to return. Default 5.'),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB. Auto-detected from profile if omitted.'),
  siemScope: z.string().optional().describe('SIEM scope for the verbatim sample line on the top rows.'),
  environment: z.string().optional().describe('Environment nickname (for multi-env setups).'),
  verbose: z
    .boolean()
    .default(false)
    .describe(
      'When true, every card carries the full forwarder snippet inline, every CTA renders unconditionally, ' +
      'and the volume-trend chart shows on every top-3 card. Default: compact mode (snippet templated once at top, ' +
      'CTAs gated to where they earn their line, chart only on ACUTE/NEW patterns).'
    ),
  view: z
    .enum(['summary', 'markdown'])
    .default('summary')
    .describe(
      'Output format. "summary" (default) returns a structured JSON envelope with patterns, incidents, totals, and chained-tool action hints. "markdown" returns the existing rendered cards for human-consumable deliverables.'
    ),
};

/** Normalize the env's forwarder enum to the ForwarderId type the
 * renderer expects. */
function normalizeForwarder(
  v: EnvConfig['forwarder']
): ForwarderId | null {
  if (!v || v === 'unknown') return null;
  if (v === 'fluentbit') return 'fluent-bit';
  return v;
}

export async function executeTopPatterns(
  args: {
    service?: string;
    severity?: string;
    timeRange: string;
    limit: number;
    analyzerCost?: number;
    siemScope?: string;
    verbose?: boolean;
    view?: 'summary' | 'markdown';
  },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  if (!args.timeRange) (args as Record<string, unknown>).timeRange = '1h';
  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    (args as Record<string, unknown>).limit = 5;
  }
  const tf = parseTimeframe(args.timeRange);
  // Cost normalization. r.bytes / totalBytes are volumes over the WHOLE
  // window (tf), so the per-hour rate is window-cost / window-hours. The old
  // code assigned the window cost straight to costPerHour and ×720 for
  // monthly — correct ONLY for the 1h default; a 24h/7d window over-stated
  // $/h and $/mo by the window-hours factor (24×, 168×). Caught by the
  // top_patterns-vs-SRE contest: a 24h run reported "$5323/mo" that was ~24×
  // too high. windowHours from tf.days (fractional for sub-day windows).
  const windowHours = tf.days * 24;
  const costPerGb = args.analyzerCost ?? 1.0;

  const filters: Record<string, string> = {};
  if (args.service) filters[LABELS.service] = args.service;
  if (args.severity) filters[LABELS.severity] = args.severity;

  const metricsEnv = Object.keys(filters).length > 0
    ? await resolveMetricsEnvFiltered(env, filters)
    : await resolveMetricsEnv(env);

  // --- Phase 1: PromQL — ranking, event counts, total-in-scope, distinct,
  //              cost-by-service rollup ---
  const [res, eventsRes, totalRes, countRes, serviceRollupRes] = await Promise.all([
    queryInstant(env, pql.topPatternsFull(filters, metricsEnv, tf.range, args.limit)),
    queryInstant(env, pql.eventsByPatternFull(filters, metricsEnv, tf.range)).catch(() => null),
    queryInstant(env, pql.totalBytesInScope(filters, metricsEnv, tf.range)).catch(() => null),
    queryInstant(env, pql.distinctPatternCount(filters, metricsEnv, tf.range)).catch(() => null),
    // Cost-by-service rollup — the "where is the money" headline. One
    // grouped query; answers the question a vanilla-SIEM SRE has to
    // hand-roll (stats by container_name) and which the per-pattern
    // list buries under fragmentation.
    queryInstant(env, pql.bytesPerServiceScoped(filters, metricsEnv, tf.range)).catch(() => null),
  ]);

  if (res.status !== 'success' || res.data.result.length === 0) {
    return 'No pattern data available. Patterns appear after the first 24h of data collection.';
  }

  // Build event-count lookup (pattern, service, severity) -> events
  const key = (p: string, s: string, sv: string) => `${p}\x00${s}\x00${sv}`;
  const eventsByKey = new Map<string, number>();
  if (eventsRes && eventsRes.status === 'success') {
    for (const r of eventsRes.data.result) {
      const k = key(
        r.metric[LABELS.pattern] || '',
        r.metric[LABELS.service] || '',
        r.metric[LABELS.severity] || ''
      );
      const v = parsePrometheusValue(r);
      if (Number.isFinite(v) && v > 0) eventsByKey.set(k, v);
    }
  }

  // Build initial row list (sorted by cost desc)
  interface RawRow {
    pattern: string;
    service: string;
    severity: string;
    bytes: number;
    events: number;
    hash: string;
  }
  const rawRows: RawRow[] = res.data.result.map((r): RawRow => {
    const p = r.metric[LABELS.pattern] || '';
    const s = r.metric[LABELS.service] || '';
    const sv = r.metric[LABELS.severity] || '';
    const b = parsePrometheusValue(r);
    return {
      pattern: p,
      service: s,
      severity: sv,
      bytes: b,
      events: eventsByKey.get(key(p, s, sv)) ?? 0,
      // Derive tenx_hash locally from the pattern (conformance-proven
      // byte-identical to engine output, snapshot-independent).
      hash: p ? tenxHash(p) : '',
    };
  });
  rawRows.sort((a, b) => b.bytes - a.bytes);

  // --- Phase 2: first_seen + 24h trend + SIEM events + baseline bytes +
  //              services breadth + per-hash deps + analyzer detection
  //              (all parallel) ---
  const hashes = rawRows.map(r => r.hash).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);
  const trendWindowSec = 24 * 3600;
  const trendStepSec = 600;
  const trendStart = now - trendWindowSec;

  // Detect analyzer up-front (best-effort) so we can decide whether to
  // run dep_check + emit Datadog inline snippet. resolveSiemSelection
  // is cheap (no network); doing it here in parallel with the heavy
  // Phase-2 fetches saves a round-trip.
  let analyzer: string | null = null;
  try {
    const sel = await resolveSiemSelection({});
    if (sel.kind === 'resolved') analyzer = sel.id;
  } catch {
    /* leave null */
  }

  const [
    firstSeenByHash,
    eventsByHash,
    baselineByKey,
    serviceBreadthByHash,
    depsByHash,
    ...trendResults
  ] = await Promise.all([
    fetchFirstSeenBatch(env, hashes),
    fetchEventsByHashes(
      rawRows.map(r => ({ hash: r.hash, service: r.service, severity: r.severity })),
      { scope: args.siemScope, perHash: 250 }
    ),
    // Baseline bytes at 7d/14d/21d offsets — drives the trajectory
    // badge (NEW / ACUTE / GROWING / STABLE / SHRINKING). Mirrors
    // cost_drivers' 3-window baseline so the badge tells the same
    // story log10x_cost_drivers would for the same hash.
    fetchBaselineBytes(env, filters, metricsEnv, tf.range),
    // Distinct services emitting each hash — single grouped query,
    // post-processed locally. Gates the "service breakdown" CTA.
    fetchServiceBreadth(env, metricsEnv, tf.range, hashes),
    // Per-hash dependency check — token-AND match against the
    // detected analyzer's saved searches / alerts / dashboards.
    // Returns null when no supported analyzer is detected.
    fetchDepsPerHash(
      analyzer,
      rawRows.map(r => ({ hash: r.hash, service: r.service, severity: r.severity }))
    ).catch(() => null),
    // 24h trend per hash, sum'd across all series with that hash. One query
    // per hash, parallel; cheap to spawn. trendResults[i] aligns with
    // hashes[i] (skipping empties).
    ...rawRows.map(r =>
      r.hash
        ? queryRange(
            env,
            `sum by (${LABELS.hash}) (rate(emitted_events_summaryBytes_total{${LABELS.hash}="${r.hash}"}[5m]))`,
            trendStart,
            now,
            trendStepSec
          ).catch(() => null)
        : Promise.resolve(null)
    ),
  ]);

  // --- Phase 3: Assemble TopPatternRow[] ---
  const renderRows: TopPatternRow[] = rawRows.map((r, idx): TopPatternRow => {
    const trendRes = trendResults[idx];
    let trendVals: number[] = [];
    if (trendRes && trendRes.status === 'success' && Array.isArray(trendRes.data.result) && trendRes.data.result[0]?.values) {
      trendVals = (trendRes.data.result[0].values as [number, string][]).map(([, v]) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      });
    }
    const events = eventsByHash.get(r.hash) ?? [];
    const fv = events.length > 0 ? fieldVariation(events) : undefined;
    const fsRes = firstSeenByHash.get(r.hash);
    const cost = bytesToCost(r.bytes, costPerGb);
    const costPerHour = windowHours > 0 ? cost / windowHours : cost;
    // Badge = trajectory classification. Key the baseline lookup by
    // the same (pattern, service, severity) triple `topPatternsFull`
    // and `bytesPerPattern` both group on. Cross-check NEW against
    // first-seen so unstable-pattern-name envs (where every pattern
    // looks "new" on the baseline horizon) don't render misleading
    // NEW badges for established patterns.
    const baselineKey = `${r.pattern}|${r.service}|${r.severity}`;
    const baselineSamples = baselineByKey.get(baselineKey) ?? [];
    const firstSeenSec = fsRes?.ageSeconds ?? null;
    const badgeInfo = classifyBadge(r.bytes, baselineSamples, firstSeenSec);
    const badge = badgeInfo.kind;
    const serviceCount = serviceBreadthByHash.get(r.hash);
    const deps = depsByHash?.get(r.hash);
    // Datadog inline snippet — only when the env's analyzer is
    // datadog. Other analyzers get a CTA (splunk) or omitted (cloudwatch).
    const datadogQuery = analyzer === 'datadog'
      ? datadogAnalyzerQuery(r.hash, r.service, r.severity)
      : undefined;
    return {
      rank: idx + 1,
      hash: r.hash,
      pattern: r.pattern,
      service: r.service,
      severity: r.severity,
      bytes: r.bytes,
      costPerHour,
      costPerMonth: costPerHour * 720,
      events: r.events,
      firstSeenAgeSeconds: fsRes?.ageSeconds ?? null,
      trendBytesPerSec: trendVals,
      sample: events[0],
      fieldVar: fv,
      badge,
      badgeInfo,
      serviceCount,
      deps,
      datadogAnalyzerQuery: datadogQuery,
    };
  });

  // Totals + analyzer detection
  const totalBytes = totalRes && totalRes.status === 'success' && totalRes.data.result.length > 0
    ? parsePrometheusValue(totalRes.data.result[0])
    : renderRows.reduce((s, r) => s + r.bytes, 0);
  const totalCostPerHour = windowHours > 0 ? bytesToCost(totalBytes, costPerGb) / windowHours : bytesToCost(totalBytes, costPerGb);

  let patternCountTotal: number | undefined;
  if (countRes && countRes.status === 'success' && countRes.data.result.length > 0) {
    const n = parsePrometheusValue(countRes.data.result[0]);
    if (Number.isFinite(n) && n > 0) patternCountTotal = Math.round(n);
  }

  // Cost-by-service rollup — "where is the money". Parse the grouped
  // query, compute each service's share of total, sort desc. This is
  // the headline a vanilla-SIEM SRE has to hand-roll; surfacing it up
  // front is the differentiator the per-pattern list alone misses.
  const serviceRollup: Array<{ service: string; bytes: number; pct: number }> = [];
  if (serviceRollupRes && serviceRollupRes.status === 'success' && totalBytes > 0) {
    for (const r of serviceRollupRes.data.result) {
      const svc = r.metric[LABELS.service] || '(unattributed)';
      const b = parsePrometheusValue(r);
      if (Number.isFinite(b) && b > 0) {
        serviceRollup.push({ service: svc, bytes: b, pct: b / totalBytes });
      }
    }
    serviceRollup.sort((a, b) => b.bytes - a.bytes);
  }

  // Analyzer is already resolved up-front in Phase 2 (so dep_check
  // could be dispatched in parallel). No second call needed here.
  // Forwarder from env config (set in env profile / envs.json)
  const forwarder = normalizeForwarder(env.forwarder);

  // Lightweight degraded-state banner — surfaces the cases top_patterns
  // can already see (empty bytes, missing events metric) without
  // running a full log10x_doctor pass on every invocation.
  const banner = healthBanner({
    totalBytes,
    patternCountTotal,
    eventsAvailable: eventsRes !== null && eventsRes.status === 'success',
  });

  // --- Phase 4: Render ---
  const rendered = renderTopPatterns(renderRows, {
    windowLabel: tf.label,
    totalBytesInScope: totalBytes,
    totalCostPerHour,
    totalCostMonthly: totalCostPerHour * 720,
    patternCountShown: renderRows.length,
    patternCountTotal,
    forwarder,
    analyzer,
    hashField: LABELS.hash,
    analyzerScope: args.siemScope,
    healthBanner: banner,
    verbose: args.verbose ?? false,
    costByService: serviceRollup,
    costPerGb,
  });

  // --- Phase 5: Agent-only routing block ---
  const lines: string[] = [rendered, ''];
  lines.push(
    `_Ranked by current cost, not by growth. To see what's rising or fading over time, ask for cost drivers over a longer window._`
  );
  lines.push(
    agentOnly(
      `Constraint: these rows are CURRENT RANK by cost over the window, not a growth/delta ranking. For growth use log10x_cost_drivers.`
    )
  );

  // Cross-pillar join keys for agents
  const hashMap = renderRows
    .filter(r => r.hash)
    .slice(0, 10)
    .map(r => `${r.pattern} = ${r.hash}`)
    .join('; ');
  if (hashMap) {
    lines.push('');
    lines.push(
      agentOnly(
        `Cross-pillar join keys — ${LABELS.hash}: ${hashMap}. ` +
        `Filter the SIEM / CloudWatch Logs on ${LABELS.hash}="<value>" — exact match.`
      )
    );
  }

  // Next-action hints — pre-filled so a downstream agent with poor
  // context can EXECUTE the differentiated follow-ups instead of having
  // to compose the right call. Every arg is verified against the target
  // tool's schema (investigate=starting_point, correlate=anchor+
  // anchor_type, savings/cost_drivers=timeRange; tf.range is the PromQL
  // form, e.g. "1h"). Ordered by differentiated value.
  const nextActions: NextAction[] = [];
  const topActive = renderRows.find(r => r.hash);
  const errSev = (s: string) => ['ERROR', 'WARN', 'CRITICAL'].includes((s || '').toUpperCase());

  // Root-cause the top error loop (the "investigation" route). Anchor on
  // the highest-cost error-severity pattern with sustained volume.
  // Use a >= 24h window for the "why did this start / what co-moves"
  // routes: the 1h cost-scan window is too narrow to show a pattern's
  // emergence or to give Pearson enough points. tf.range is fine when
  // the scan was already wide.
  const rcaWindow = /^(\d+)(s|m|h)$/.test(tf.range) && !/d|w|y/.test(tf.range) ? '24h' : tf.range;
  const topErrorLoop = renderRows.find(r => r.hash && errSev(r.severity) && r.events >= 100);
  if (topErrorLoop) {
    nextActions.push({
      tool: 'log10x_investigate',
      args: { starting_point: topErrorLoop.pattern, window: rcaWindow },
      reason: 'root-cause the top error loop before suppressing it (surfaces log-only signals: DNS, connection-pool, dependency failures)',
    });
  }

  // Cross-pillar: find k8s/metric signals co-moving with the top spike.
  const topSpiking = renderRows.find(r => r.hash && (r.badge === 'NEW' || r.badge === 'ACUTE'));
  if (topSpiking) {
    nextActions.push({
      tool: 'log10x_metrics_that_moved',
      args: { anchor: topSpiking.pattern, anchor_type: 'log10x_pattern', timeRange: rcaWindow },
      reason: 'find k8s/metric signals (deploys, pod restarts, OOM) that moved with the top spike. Compose with log10x_rank_by_shape_similarity + log10x_metric_overlay for direction',
    });
  }

  if (topActive) {
    nextActions.push({
      tool: 'log10x_pattern_mitigate',
      args: { pattern: topActive.pattern },
      reason: 'env-gated mitigation options + exact configs for this pattern',
    });
  }

  // Env-level projections (always available, no per-pattern arg).
  nextActions.push({
    tool: 'log10x_savings',
    args: { timeRange: tf.range },
    reason: 'projected savings across the env if you act — drop vs compact vs sample',
  });
  nextActions.push({
    tool: 'log10x_cost_drivers',
    args: { timeRange: '7d' },
    reason: 'growth/delta ranking over 7d — what is rising, vs the current-cost ranking shown here',
  });

  if (topActive) {
    nextActions.push({
      tool: 'log10x_pattern_examples',
      args: { pattern: topActive.pattern },
      reason: 'deeper sample retrieval + slot distribution for the top pattern',
    });
  }

  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);

  const markdown = lines.join('\n');
  const view = args.view ?? 'summary';
  const telemetry = newTelemetry();

  // Build the structured-summary envelope from the same rows the
  // renderer used. This is the agent-default path; the markdown
  // path is the deliverable / human-consumable opt-in.
  const incidentInputs: IncidentInput[] = renderRows
    .filter((r) => r.hash)
    .map((r) => ({
      identity: r.hash!,
      service: r.service,
      descriptor: r.pattern ?? r.hash!,
      costPerMonthUsd: r.costPerMonth,
      trendBytesPerSec: r.trendBytesPerSec,
    }));
  const incidents = detectIncidents(incidentInputs);

  const dataPatterns = renderRows.map((r) => ({
    rank: r.rank,
    identity: r.pattern ?? r.hash ?? '',
    template_hash: r.hash ?? '',
    service: r.service,
    severity: r.severity,
    cost_per_hour_usd: r.costPerHour,
    cost_per_month_usd: r.costPerMonth,
    bytes: r.bytes,
    events: r.events,
    first_seen_age_seconds: r.firstSeenAgeSeconds,
    badge: r.badge,
    descriptor: r.pattern ?? r.hash ?? '',
    trend_bytes_per_sec: r.trendBytesPerSec,
  }));

  const totals = {
    monthly_usd: totalCostPerHour * 720,
    bytes_per_sec: totalBytes / Math.max(1, windowHours * 3600),
    pattern_count_shown: renderRows.length,
    pattern_count_total: patternCountTotal,
  };

  const headline =
    renderRows.length === 0
      ? `No patterns in scope over ${tf.label}.`
      : `Top ${renderRows.length} patterns over ${tf.label} cost ~$${(totals.monthly_usd).toFixed(0)}/mo total.${incidents.length > 0 ? ` ${incidents.length} incident cluster${incidents.length === 1 ? '' : 's'} detected.` : ''}`;

  const callout =
    incidents.length > 0
      ? `These look like ${incidents.length === 1 ? 'one incident' : `${incidents.length} incidents`}: ` +
        incidents
          .slice(0, 2)
          .map((c) => `${c.members.length} patterns in \`${c.service}\` share \`${c.representativeLabel.slice(0, 50)}\``)
          .join('; ')
      : undefined;

  if (view === 'markdown') {
    return buildMarkdownEnvelope({
      tool: 'log10x_top_patterns',
      summary: { headline, callout },
      markdown,
      actions: nextActions.map((a) => ({ tool: a.tool, args: a.args, reason: a.reason })),
    });
  }

  // Truncation signal: the engine query is capped at args.limit. If we got
  // a separate count of total patterns matching the filters, we can tell the
  // agent there's more to see; otherwise we fall back to "the query returned
  // exactly limit rows" which is a reasonable heuristic for truncation.
  const totalAvailable = patternCountTotal ?? (renderRows.length === args.limit ? args.limit + 1 : renderRows.length);
  const truncated = totalAvailable > renderRows.length;

  // G6: horizontal-bar PNG of top patterns by monthly cost. Hosts that render
  // image content (Claude Desktop, ChatGPT Desktop) show it; legacy hosts
  // ignore. Skip silently if rendering fails (missing Cairo etc.).
  let images: import('../lib/output-types.js').InlineImage[] | undefined;
  try {
    const { renderHorizontalBar } = await import('../lib/chart-renderer.js');
    if (dataPatterns.length > 0) {
      const png = await renderHorizontalBar(
        dataPatterns
          .slice()
          .sort((a, b) => b.cost_per_month_usd - a.cost_per_month_usd)
          .map((p, i) => ({ label: `#${i + 1} ${p.identity}`, value: p.cost_per_month_usd })),
        { title: `Top ${dataPatterns.length} patterns by $/mo (${tf.label})`, xLabel: '$/mo' }
      );
      if (png) {
        images = [{ data: png.base64, mimeType: png.mimeType, alt: `Top ${dataPatterns.length} patterns by monthly cost over ${tf.label}` }];
      }
    }
  } catch (_e) {
    /* best-effort; never block */
  }

  return buildEnvelope({
    tool: 'log10x_top_patterns',
    view: 'summary',
    summary: { headline, callout },
    data: {
      patterns: dataPatterns,
      incidents: incidents.map((c) => ({
        members: c.members.map((m) => ({
          identity: m.identity,
          cost_per_month_usd: m.costPerMonthUsd,
          descriptor: m.descriptor,
        })),
        representative_label: c.representativeLabel,
        service: c.service,
        combined_monthly_usd: c.combinedMonthlyUsd,
        join_signal: c.joinSignal,
        confidence: c.confidence,
      })),
      totals,
      window: tf.label,
      pattern_count_shown: renderRows.length,
      pattern_count_total: patternCountTotal,
      ...buildUnifiedFields({ status: 'success', telemetry, humanSummary: headline }),
    },
    actions: nextActions.map((a) => ({ tool: a.tool, args: a.args, reason: a.reason })),
    render_hint: { chart: 'timeseries', units: '$/mo' },
    truncated,
    images,
  });
}
