/**
 * log10x_services — list all monitored services with volume + action-axis summary.
 *
 * Per-service rows now carry the
 * four action-axis columns that let an agent / FinOps reader see where
 * each service's savings are coming from:
 *
 *   - `bytes_offloaded`  : routeState="drop" bytes whose cap-CSV row's
 *                          action is `offload` (routed to customer S3)
 *   - `bytes_compacted`  : action == `compact` (in-engine encode() wins)
 *   - `bytes_dropped`    : action == `drop` (hard kill at the receiver)
 *   - `bytes_passed`     : routeState!="drop" bytes (the kept cohort)
 *
 * The split is computed MCP-side by joining the per-(service, hash)
 * `routeState="drop"` byte sum against the cap-CSV the MCP itself wrote
 * (see `lib/cap-csv-parser.ts`). No engine label change is required;
 * `tier_down` and `sample` collapse into the action lookup but don't
 * surface as their own columns (they're rendered as `bytes_dropped` for
 * the column-axis cohort — the receiver-side action is "filter out", the
 * destination tier is the forwarder-side detail).
 *
 * When no cap-CSV is available (no gitops repo configured, gh not
 * installed, or empty CSV) the four action columns are still populated
 * but everything dropped lands in `bytes_dropped` with the row's
 * `attribution: 'unattributed'` flag set. The kept-side bytes are always
 * accurate.
 *
 * Exception-service input (`exception_services`): when supplied, those
 * service rows are marked with `current_mode: 'pass'` as a hint — the
 * agent knows the customer flagged these as audit/regulatory/critical
 * and the row's `next_action` points at `log10x_pattern_mitigate` for
 * per-pattern tuning rather than the configure_engine bulk path.
 */

import { z } from 'zod';
import type { EnvConfig } from '../lib/environments.js';
import { queryInstant } from '../lib/api.js';
import * as pql from '../lib/promql.js';
import { LABELS } from '../lib/promql.js';
import { bytesToCost, bytesToGb, parsePrometheusValue } from '../lib/cost.js';
import type { Action } from '../lib/cost.js';
import { resolveRate, destinationFromEnvAnalyzer } from '../lib/rate-resolution.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { fmtDollar, fmtBytes, fmtPct, parseTimeframe, costPeriodLabel } from '../lib/format.js';
import { shareBar } from '../lib/pattern-render.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { agentOnly } from '../lib/agent-only.js';
import { type StructuredOutput } from '../lib/output-types.js';
import { newChassisTelemetry, buildChassisEnvelope, buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import { fetchCapCsvForEnv, fetchActionIntentForEnv, buildCapCsvStatus, envWithResolvedGitops, type CapCsvStatus } from '../lib/cap-csv-fetch.js';
import { parseCapCsv, buildPatternActionLookup } from '../lib/cap-csv-parser.js';
import { normalizeTimeRange } from '../lib/time-range.js';
import { renderMonospaceTable } from '../lib/render-table.js';

/**
 * The rank cutoff that gates whether a service gets a next_action vs is
 * "omitted from next_action" in the headline. Hand-picked at 10, tagged as
 * the operational threshold in the chassis decisions block so consumers can
 * audit. The MIN_PCT_FLOOR below acts as the secondary cutoff for
 * "below_signal_floor".
 */
export const NEXT_ACTION_RANK_CUTOFF = 10;
const NEXT_ACTION_MIN_PCT_FLOOR = 0.1;

export const servicesSchema = {
  timeRange: z.enum(['15m', '1h', '6h', '24h', '1d', '7d', '30d']).default('7d').describe("Time range. Sub-day values available for incident-window service ranking. '24h' and '1d' are equivalent."),
  analyzerCost: z.number().optional().describe('SIEM ingestion cost in $/GB'),
  environment: z.string().optional().describe('Environment nickname'),
  exception_services: z
    .array(z.string())
    .max(50)
    .optional()
    .describe('Customer-flagged services that must stay in the SIEM with full retention (audit / regulatory / executive). Per row, marks current_mode="pass" and points next_action at pattern_mitigate instead of the configure_engine bulk path.'),
  view: z.literal('summary').default('summary').optional().describe('Output format. Always "summary" — the typed envelope (data.services[], data.totals). Field retained for backward-compat.'),
};

/**
 * Per-service action-axis figures. All bytes values are absolute over
 * `time_range`. Unattributed dropped bytes (no CSV row) are folded into
 * `bytes_dropped` with the row-level `attribution: 'unattributed'` flag.
 */
interface ServiceActionAxis {
  bytes_passed: number;
  bytes_offloaded: number;
  bytes_compacted: number;
  bytes_dropped: number;
}

interface ServiceRow extends ServiceActionAxis {
  rank: number;
  name: string;
  bytes: number;
  /** Null when rate_source==='unset' (no $/GB rate configured). */
  cost: number | null;
  pct: number;
  /**
   * Customer-supplied policy hint. `pass` when the service appears in
   * `exception_services`; otherwise undefined (the configure_engine
   * default applies). NOT a query result — this is the input echo.
   */
  current_mode?: Action;
  /**
   * Whether the action-axis split came from the cap-CSV join or fell
   * back to the unattributed path. `csv` is the fully-attributed happy
   * path; `unattributed` means dropped bytes exist but no CSV row
   * matched (or no CSV was fetched).
   */
  attribution: 'csv' | 'unattributed' | 'no_drops';
  /** Suggested next-tool call for the agent to chain on this row. Null for tail services below the signal floor. */
  next_action: NextAction | null;
  /** Reason next_action is null, when applicable. */
  next_action_reason?: string;
}

interface ServicesSummary {
  time_range: string;
  /** Null when rate_source==='unset'. */
  cost_per_gb: number | null;
  /** Provenance of cost_per_gb — set by the shared rate resolver. */
  rate_source: 'customer_supplied' | 'list_price' | 'unset';
  /** Plain-English caveat for cost_per_gb (null for customer_supplied). */
  rate_disclosure: string | null;
  period: string;
  total_bytes: number;
  /** Null when rate_source==='unset'. */
  total_cost: number | null;
  service_count: number;
  top_n_share_pct: number;
  /**
   * Structured status for the cap-CSV / action-intent fetch.
   * kind: 'loaded' means the action-split is applied.
   * Other kinds mean dropped bytes are unattributed.
   */
  cap_csv_status: CapCsvStatus;
  /** Echo of the exception_services input so downstream UIs can highlight. */
  exception_services: string[];
  services: ServiceRow[];
}

export async function executeServices(
  args: { timeRange?: string; analyzerCost?: number; effective_ingest_per_gb?: number; view?: 'summary'; exception_services?: string[] },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  const telemetry = newChassisTelemetry();
  const sumOut: { data?: ServicesSummary } = {};
  await executeServicesInner(args, env, sumOut);
  if (!sumOut.data) {
    const headline = 'No service data available. Data appears after the first 24h of collection.';
    return buildChassisEnvelope({
      tool: 'log10x_services',
      view: 'summary',
      headline,
      status: 'insufficient_data',
      decisions: { threshold_used: null, threshold_basis: 'default' },
      source_disclosure: { bytes_source: 'tsdb' },
      scope: { window: args.timeRange ?? '7d', window_basis: 'auto_default' },
      payload: {},
      human_summary: headline,
      telemetry,
    });
  }
  const d = sumOut.data;
  const top = d.services[0];
  // Headline reconstructs from a SINGLE share number — the one in
  // d.top_n_share_pct, which is computed over the actionable set (services
  // with non-null next_action) so the headline's N and % tell the same
  // story. Earlier the headline used Top-{actionableCount} services with
  // a Top-5 share % — three different numbers for the same quantity.
  const actionableCount = d.services.filter((s) => s.next_action !== null).length;
  const tailCount = d.services.length - actionableCount;
  // tailCount counts services with null next_action, which is the union of
  // two groups: ranks 11-13 above 0.1% (tail_rank) + ranks 14+ or <0.1%
  // (below_signal_floor). Earlier the headline labeled all of them
  // "below signal floor" which was wrong for the tail_rank group; now
  // it just says "tail services omitted from next_action".
  const tailNote = tailCount > 0
    ? ` Top ${actionableCount} service${actionableCount !== 1 ? 's' : ''} account for ${d.top_n_share_pct}% of cost; ${tailCount} tail service${tailCount !== 1 ? 's' : ''} omitted from next_action.`
    : '';
  // C-policy: the headline quotes a dollar only when it is grounded in the
  // customer's real (contracted) rate. At `list_price` the dollar is the SIEM
  // vendor rack rate, not their number, so the headline leads with volume
  // (GB / %, always exact) and the chassis attaches the list-rate calibration
  // callout. At `unset` there is no rate at all, so we add the set-your-rate
  // hint inline.
  const headline = top
    ? (d.rate_source === 'customer_supplied'
      ? `${d.service_count} services over ${d.time_range}: ${top.name} leads at ${fmtDollar(top.cost ?? 0)}${d.period} (${Math.round(top.pct)}% of total ${fmtDollar(d.total_cost ?? 0)}${d.period}).${tailNote}`
      : `${d.service_count} services over ${d.time_range}: ${top.name} leads at ${fmtBytes(top.bytes)} (${Math.round(top.pct)}% of total ${fmtBytes(d.total_bytes)}).${tailNote}${d.rate_source === 'unset' ? ' (no $/GB rate configured; pass effective_ingest_per_gb to see dollars.)' : ''}`)
    : `No services with data in ${d.time_range}.`;
  return buildChassisEnvelope({
    tool: 'log10x_services',
    view: 'summary',
    headline,
    status: d.service_count > 0 ? 'success' : 'no_signal',
    decisions: {
      // Prior code aliased threshold_used to cost_per_gb, but rate is not a
      // threshold. The chassis decision block describes the OPERATIONAL
      // THRESHOLD: here, the tail-rank cutoff that determines which services
      // get a next_action (rank <= 10) vs which are omitted (the "16 tail
      // services omitted" headline phrase). 10 is hand-picked; tag as
      // unvalidated_default. rate_source provenance stays in
      // source_disclosure.rate_source where it belongs.
      threshold_used: NEXT_ACTION_RANK_CUTOFF,
      threshold_basis: 'unvalidated_default',
    },
    source_disclosure: {
      bytes_source: 'tsdb',
      // Routed through the shared rate resolver so services/top_patterns/
      // event_lookup/explain_mode/estimate_savings agree on the SAME tag
      // for the same env/window. 'unset' collapses to undefined here per
      // the chassis schema (only customer_supplied/list_price are emitted).
      rate_source: d.rate_source === 'customer_supplied'
        ? 'customer_supplied'
        : d.rate_source === 'list_price'
          ? 'list_price'
          : undefined,
      service_count_source: {
        kind: 'above_volume_floor',
        count: d.service_count,
        denominator_meaning:
          'Services emitting >= 1 KB/s in the window (wait-for-* + low-volume init containers filtered)',
      },
    },
    scope: {
      window: d.time_range,
      window_basis: 'explicit',
      candidates_count: d.service_count,
      candidates_usable: d.service_count,
    },
    payload: d,
    human_summary: headline,
    must_render_verbatim: d.services.length > 0
      ? renderMonospaceTable(
          d.services,
          [
            { header: '#',             align: 'right',  get: (s) => String(s.rank) },
            { header: 'Service',       align: 'left',   get: (s) => s.name, max_width: 32 },
            { header: `Vol/${d.time_range}`, align: 'right', get: (s) => fmtBytes(s.bytes) },
            { header: '%',             align: 'right',  get: (s) => fmtPct(s.pct) },
            { header: `$/${d.time_range}`,  align: 'right', get: (s) => s.cost == null ? '—' : fmtDollar(s.cost) },
            { header: 'Attribution',   align: 'left',   get: (s) => s.attribution },
          ],
          {
            title: `Services — ${d.time_range}`,
            footer: tailCount > 0
              ? `${tailCount} tail service${tailCount !== 1 ? 's' : ''} omitted from next_action (rank > 10 or < 0.1% share).`
              : undefined,
          },
        )
      : undefined,
    actions: top
      ? [
          { tool: 'log10x_top_patterns', args: { service: top.name }, reason: 'current top patterns for the highest-cost service' },
          { tool: 'log10x_investigate', args: { starting_point: top.name }, reason: 'causal-chain analysis on the top service' },
        ]
      : [],
    telemetry,
  });
}

async function executeServicesInner(
  args: { timeRange?: string; analyzerCost?: number; effective_ingest_per_gb?: number; view?: 'summary'; exception_services?: string[] },
  env: EnvConfig,
  sumOut?: { data?: ServicesSummary }
): Promise<string> {
  // Defensive defaults — match servicesSchema.
  // Normalise '1d' legacy alias → '24h' before query.
  const timeRange = normalizeTimeRange(args.timeRange ?? '7d');
  const tf = parseTimeframe(timeRange);
  // SHARED rate resolver (lib/rate-resolution.ts) — every cost-emitting
  // tool walks the SAME priority chain (caller arg → envs.json analyzerCost
  // → LOG10X_ANALYZER_COST → destination list price → unset) so services,
  // top_patterns, event_lookup, explain_mode, and estimate_savings tag the
  // identical (env, window) rate with the SAME rate_source. Prior to this
  // wiring, services fell back to a fictitious $1/GB AND mislabeled it
  // 'list_price' when no arg was passed.
  const rate = resolveRate(
    { effective_ingest_per_gb: args.effective_ingest_per_gb, analyzerCost: args.analyzerCost },
    env,
    destinationFromEnvAnalyzer(env),
  );
  const costPerGb: number | null = rate.rate_per_gb;
  const period = costPeriodLabel(tf.days);
  const metricsEnv = await resolveMetricsEnv(env);
  const exceptionServices = (args.exception_services ?? []).filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  const exceptionSet = new Set(exceptionServices.map((s) => s.toLowerCase()));

  // ── Bytes per service (the existing query) ──
  const res = await queryInstant(env, pql.bytesPerService(metricsEnv, tf.range));

  if (res.status !== 'success' || res.data.result.length === 0) {
    return 'No service data available. Data appears after the first 24h of collection.';
  }

  // ── Action-axis queries ──
  // Two parallel `sum by (service, hash)` queries (kept + dropped),
  // joined locally to the cap-CSV action lookup. We deliberately key on
  // BOTH service + hash so a pattern that fires in two services is
  // attributed once per (service, hash) row, not once globally.
  //
  // The third query — `sum by (service, hash, container)` for the
  // dropped cohort — is what the cap-CSV's container-default rows hook
  // into (the CSV's container key is k8s_container). Without the
  // container we cannot fall back to the container default when no
  // `pat:<hash>` override exists; we just leave the row unattributed.
  const containerLabel = 'k8s_container';
  const droppedPerServicePatternQ = `sum by (${LABELS.service}, ${LABELS.hash}, ${containerLabel}) (increase(all_events_summaryBytes_total{${LABELS.env}="${metricsEnv}",routeState="drop"}[${tf.range}]))`;
  const passedPerServiceQ = `sum by (${LABELS.service}) (increase(all_events_summaryBytes_total{${LABELS.env}="${metricsEnv}",routeState!="drop"}[${tf.range}]))`;

  // Resolve gitops repo via the same fallback chain configure_engine /
  // pattern_mitigate use: envs.json field → LOG10X_GH_REPO env var →
  // most-recent discover_env snapshot. Without this, services reported
  // `cap_csv_status: not_configured` whenever envs.json lacked the field,
  // even when a snapshot or env-var already exposed the repo.
  const envForGitops = envWithResolvedGitops(env);
  const [droppedRes, passedRes, capCsvContent, actionIntent] = await Promise.all([
    queryInstant(env, droppedPerServicePatternQ).catch(() => null),
    queryInstant(env, passedPerServiceQ).catch(() => null),
    fetchCapCsvForEnv(envForGitops).catch(() => undefined),
    fetchActionIntentForEnv(envForGitops).catch(() => undefined),
  ]);

  // action-intent.json is the canonical source for pattern→action.
  // Fall back to legacy cap-CSV action suffixes when action-intent is absent.
  const actionIntentLookup: Map<string, Action> = actionIntent?.by_pattern ?? new Map();
  const parsedCsv = capCsvContent ? parseCapCsv(capCsvContent) : null;
  const hasActionSource = actionIntentLookup.size > 0 || (parsedCsv !== null && parsedCsv.rows.length > 0);
  // Both fetchers were called when the resolved env exposes a gitops repo
  // (envs.json field, LOG10X_GH_REPO, or snapshot fallback). When the
  // repo is set but both returned undefined, it means the fetch failed.
  const capCsvFetchAttempted = !!envForGitops.gitops?.repo;
  const capCsvFetchSucceeded = capCsvContent !== undefined || actionIntent !== undefined;
  const capCsvStatus: CapCsvStatus = buildCapCsvStatus(
    envForGitops.gitops?.repo,
    capCsvFetchAttempted,
    capCsvFetchSucceeded,
    hasActionSource,
  );

  // Build a (service → action-axis) map from the per-(service, hash,
  // container) dropped result, using buildPatternActionLookup to resolve
  // each (hash, container) to its action.
  const perService = new Map<string, ServiceActionAxis & { had_drops: boolean; had_csv_hit: boolean }>();

  // Seed with passed bytes per service.
  if (passedRes && passedRes.status === 'success') {
    for (const r of passedRes.data.result) {
      const name = r.metric[LABELS.service] || '(unknown)';
      const v = parsePrometheusValue(r);
      const cur = perService.get(name) ?? {
        bytes_passed: 0,
        bytes_offloaded: 0,
        bytes_compacted: 0,
        bytes_dropped: 0,
        had_drops: false,
        had_csv_hit: false,
      };
      cur.bytes_passed += v;
      perService.set(name, cur);
    }
  }

  // Layer dropped bytes, attributed via cap-CSV.
  if (droppedRes && droppedRes.status === 'success') {
    // First pass: gather (hash → container) pairs so we can resolve
    // each hash's action with the same fallback logic the commitment
    // report uses (pat: override → container default → unattributed).
    const hashToContainer = new Map<string, string>();
    interface DropRow { service: string; hash: string; container: string; bytes: number }
    const dropRows: DropRow[] = [];
    for (const r of droppedRes.data.result) {
      const service = r.metric[LABELS.service] || '(unknown)';
      const hash = r.metric[LABELS.hash] ?? '';
      const container = r.metric[containerLabel] ?? '';
      const bytes = parsePrometheusValue(r);
      if (!hash || bytes <= 0) continue;
      dropRows.push({ service, hash, container, bytes });
      // Container-pick rule: highest bytes wins (mirrors
      // extractHashContainerMap in estimate-savings).
      const prior = hashToContainer.get(hash);
      if (!prior || (container && container.localeCompare(prior) < 0)) {
        // Cheap deterministic pick — bytes-weighted variant would need
        // an aggregator; for services we keep the lighter lexical pick
        // since the column is for explanation, not arithmetic
        // attribution (the commitment_report does the heavy version).
        if (container) hashToContainer.set(hash, container);
      }
    }
    // Build legacy cap-CSV lookup for fallback when action-intent is absent.
    const legacyActionLookup = parsedCsv
      ? buildPatternActionLookup(parsedCsv, hashToContainer)
      : new Map<string, Action>();

    for (const row of dropRows) {
      const cur = perService.get(row.service) ?? {
        bytes_passed: 0,
        bytes_offloaded: 0,
        bytes_compacted: 0,
        bytes_dropped: 0,
        had_drops: false,
        had_csv_hit: false,
      };
      cur.had_drops = true;
      // Resolution order: action-intent.json (canonical) → legacy cap-CSV suffix.
      const action =
        actionIntentLookup.get(row.hash) ?? legacyActionLookup.get(row.hash);
      if (action === 'offload') {
        cur.bytes_offloaded += row.bytes;
        cur.had_csv_hit = true;
      } else if (action === 'compact') {
        cur.bytes_compacted += row.bytes;
        cur.had_csv_hit = true;
      } else if (action === 'drop' || action === 'tier_down' || action === 'sample') {
        cur.bytes_dropped += row.bytes;
        cur.had_csv_hit = true;
      } else if (action === 'pass') {
        // `pass` shouldn't appear in the dropped cohort, but if it does
        // the engine ignored a customer override — bucket as passed so
        // the totals reconcile.
        cur.bytes_passed += row.bytes;
        cur.had_csv_hit = true;
      } else {
        // No CSV hit at all → unattributed; fold into bytes_dropped so
        // the action-axis still sums to the right total. Row-level
        // attribution flag will surface this to the agent.
        cur.bytes_dropped += row.bytes;
      }
      perService.set(row.service, cur);
    }
  }

  interface SvcRow { name: string; bytes: number; cost: number | null; pct: number; axis: ServiceActionAxis; attribution: ServiceRow['attribution']; current_mode?: Action }
  const rows: SvcRow[] = [];
  let totalBytes = 0;

  for (const r of res.data.result) {
    const name = r.metric[LABELS.service] || '(unknown)';
    const bytes = parsePrometheusValue(r);
    totalBytes += bytes;
    const axisRaw = perService.get(name);
    // Reconcile the action decomposition to the authoritative per-service
    // total `bytes` (from bytesPerService). bytes_passed is DERIVED as the
    // remainder so passed + offloaded + compacted + dropped == bytes exactly.
    // Previously bytes_passed came from a SEPARATE `sum by(service,hash)`
    // read, so two independently-rounded TSDB queries disagreed and the
    // parts could overshoot the whole (e.g. payment bytes_passed > bytes
    // with zero drops). Deriving the remainder makes the buckets sum to the
    // reported total by construction; clamp at 0 for the rare case where the
    // dropped-cohort read exceeds the total read.
    const axis: ServiceActionAxis = axisRaw
      ? {
          bytes_offloaded: axisRaw.bytes_offloaded,
          bytes_compacted: axisRaw.bytes_compacted,
          bytes_dropped: axisRaw.bytes_dropped,
          bytes_passed: Math.max(
            0,
            bytes - axisRaw.bytes_offloaded - axisRaw.bytes_compacted - axisRaw.bytes_dropped,
          ),
        }
      : {
          bytes_passed: bytes,
          bytes_offloaded: 0,
          bytes_compacted: 0,
          bytes_dropped: 0,
        };
    const attribution: ServiceRow['attribution'] = !axisRaw || !axisRaw.had_drops
      ? 'no_drops'
      : axisRaw.had_csv_hit
        ? 'csv'
        : 'unattributed';
    const current_mode: Action | undefined = exceptionSet.has(name.toLowerCase()) ? 'pass' : undefined;
    // Cost collapses to null when the shared rate resolver returned 'unset'
    // (no fictitious $1/GB fallback). Renderers + the envelope gate on this.
    rows.push({ name, bytes, cost: costPerGb != null ? bytesToCost(bytes, costPerGb) : null, pct: 0, axis, attribution, current_mode });
  }

  // Calculate percentages
  for (const r of rows) {
    r.pct = totalBytes > 0 ? (r.bytes / totalBytes) * 100 : 0;
  }

  rows.sort((a, b) => b.bytes - a.bytes);

  // Align columns to the longest service name (min 20, max 40)
  const nameWidth = Math.min(40, Math.max(20, ...rows.map(r => r.name.length)));

  const lines: string[] = [];
  lines.push(`Monitored Services (${tf.label})`);
  lines.push('(bar scaled to the largest service; % is share of total volume)');
  lines.push('');

  const maxBytes = rows.length ? rows[0].bytes : 0;
  for (const r of rows) {
    const name = r.name.padEnd(nameWidth);
    const vol = fmtBytes(r.bytes).padEnd(10);
    const pct = fmtPct(r.pct).padStart(5);
    const bar = shareBar(maxBytes > 0 ? r.bytes / maxBytes : 0, 16);
    const cost = r.cost == null ? '—' : `${fmtDollar(r.cost)}${period}`;
    lines.push(`  ${name} ${vol} ${pct}  ${bar}  ${cost}`);
  }

  // Total cost collapses to null when the shared rate resolver returned 'unset'.
  const totalCost: number | null = costPerGb != null ? bytesToCost(totalBytes, costPerGb) : null;
  lines.push('');
  lines.push(
    costPerGb != null
      ? `  ${rows.length} service${rows.length !== 1 ? 's' : ''} · ${fmtBytes(totalBytes)} total · ${fmtDollar(totalCost ?? 0)}${period} at ${fmtDollar(costPerGb)}/GB`
      : `  ${rows.length} service${rows.length !== 1 ? 's' : ''} · ${fmtBytes(totalBytes)} total · (no $/GB rate configured — pass effective_ingest_per_gb)`
  );

  // Coverage line: how concentrated is the volume at the top? Tells the agent
  // whether a drill-down on the top few services captures the question or
  // whether the long tail matters. Especially load-bearing at high volume,
  // where "Top 10 patterns" can mean 90% of cost or 10%.
  if (rows.length > 1 && totalBytes > 0) {
    const topN = Math.min(3, rows.length);
    const topBytes = rows.slice(0, topN).reduce((s, r) => s + r.bytes, 0);
    const topPct = Math.round((topBytes / totalBytes) * 100);
    lines.push(`  Top ${topN} service${topN !== 1 ? 's' : ''} = ${topPct}% of volume.`);
  }

  // Action-axis caveat surface. Render only when at least one row had
  // dropped bytes — otherwise the whole block is noise.
  const anyDrops = rows.some(
    (r) => r.axis.bytes_offloaded + r.axis.bytes_compacted + r.axis.bytes_dropped > 0,
  );
  if (anyDrops) {
    lines.push('');
    if (capCsvStatus.kind === 'loaded') {
      lines.push(`  Action axis: split via cap-CSV (${envForGitops.gitops?.repo}${envForGitops.gitops?.lookupPath ? `:${envForGitops.gitops.lookupPath}` : ''}).`);
    } else {
      lines.push(`  Action axis: ${capCsvStatus.reason} Dropped bytes folded into bytes_dropped (unattributed).`);
    }
  }

  if (exceptionServices.length > 0) {
    lines.push('');
    lines.push(`  Exception services (current_mode=pass): ${exceptionServices.join(', ')}`);
  }

  const nextActions: NextAction[] = [];
  if (rows[0]) {
    lines.push('');
    lines.push(agentOnly(
      `Suggested next calls: ` +
      `Drill into the top service for current top patterns — log10x_top_patterns({ service: '${rows[0].name}' }). ` +
      `Full causal-chain analysis on any spike: log10x_investigate({ starting_point: '${rows[0].name}' }). ` +
      `To reduce the cost of a specific pattern in this service, first run log10x_top_patterns({ service: '${rows[0].name}' }) and then call log10x_pattern_mitigate on a row's pattern identity — gives the user the four cost-reduction options gated on env capabilities.`
    ));
    nextActions.push(
      { tool: 'log10x_top_patterns', args: { service: rows[0].name }, reason: 'current top patterns for the top service' },
      { tool: 'log10x_investigate', args: { starting_point: rows[0].name }, reason: 'causal-chain analysis on the top service' },
    );
  }

  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);

  if (sumOut) {
    // top_n_share_pct: cost concentration in the ACTIONABLE set (services
    // with a non-null next_action, the ones a CFO can act on this week).
    // This field used to slice [0:3] and was rendered alongside a headline
    // saying "Top {actionableCount}", three different numbers for the same
    // quantity in one envelope. N now matches the headline's actionable
    // count so the field reconstructs from the data.
    // Mirror the per-row next_action logic (rank <= 10 AND pct >= 0.1)
    // so the share % counts exactly the services the per-row routing
    // marks actionable. Exception-mode services aren't subtracted;
    // they route to pattern_mitigate but still count as actionable.
    const actionableRowCount = Math.min(
      10,
      rows.filter((r) => r.pct >= 0.1).length
    );
    const topN = actionableRowCount;
    const topBytes = rows.slice(0, topN).reduce((s, r) => s + r.bytes, 0);
    const topShare = totalBytes > 0 ? Math.round((topBytes / totalBytes) * 100) : 0;
    sumOut.data = {
      time_range: tf.label,
      cost_per_gb: costPerGb,
      rate_source: rate.source,
      rate_disclosure: rate.disclosure,
      period,
      total_bytes: totalBytes,
      total_cost: totalCost,
      service_count: rows.length,
      top_n_share_pct: topShare,
      cap_csv_status: capCsvStatus,
      exception_services: exceptionServices,
      services: rows.map((r, i) => {
        const rank = i + 1;
        // Per-row next_action — tier-aware routing:
        //   exception services → pattern_mitigate (per-pattern tuning)
        //   rank 1-5 AND >= 0.1% share → configure_engine (bulk plan)
        //   rank 6-10 AND >= 0.1% share → top_patterns (drill first)
        //   rank 11+ OR < 0.1% share → null (below signal floor)
        let next_action: NextAction | null;
        if (r.current_mode === 'pass') {
          next_action = {
            tool: 'log10x_pattern_mitigate',
            args: { service: r.name },
            reason: `Per-pattern mitigation for exception service "${r.name}" — the customer flagged this service as pass, so each cost change is a per-pattern decision.`,
          };
        } else if (r.pct < 0.1) {
          next_action = null;
        } else if (rank <= 5) {
          next_action = {
            tool: 'log10x_configure_engine',
            args: { service: r.name },
            reason: `Re-tune the per-pattern action plan for "${r.name}" via configure_engine — the bulk-plan path that lands a refreshed cap-CSV (gitops PR, or kubectl ConfigMap when no gitops repo is configured).`,
          };
        } else if (rank <= NEXT_ACTION_RANK_CUTOFF) {
          next_action = {
            tool: 'log10x_top_patterns',
            args: { service: r.name },
            reason: `Drill into top patterns for "${r.name}" before deciding on a bulk action plan — mid-rank service, pattern-level breakdown first.`,
          };
        } else {
          next_action = null;
        }
        const droppedTotal = r.axis.bytes_offloaded + r.axis.bytes_compacted + r.axis.bytes_dropped;
        let attribution_reason: string;
        if (droppedTotal <= 0) {
          attribution_reason = 'No dropped bytes in this window for this service.';
        } else if (r.attribution === 'csv') {
          attribution_reason = 'Drop counts available per pattern via cap-CSV / action-intent join on the receiver.';
        } else if (r.attribution === 'unattributed') {
          attribution_reason =
            'Engine reported dropped bytes but no per-pattern attribution metric is available — confirm cap-CSV is configured + receiver_in_path.';
        } else {
          attribution_reason = 'No dropped bytes in this window for this service.';
        }
        const next_action_reason = next_action === null
          ? (r.pct < 0.1 ? 'below_signal_floor' : 'tail_rank')
          : undefined;
        return {
          rank,
          name: r.name,
          bytes: r.bytes,
          cost: r.cost,
          pct: r.pct,
          bytes_passed: r.axis.bytes_passed,
          bytes_offloaded: r.axis.bytes_offloaded,
          bytes_compacted: r.axis.bytes_compacted,
          bytes_dropped: r.axis.bytes_dropped,
          current_mode: r.current_mode,
          attribution: r.attribution,
          attribution_reason,
          next_action,
          ...(next_action_reason !== undefined ? { next_action_reason } : {}),
        };
      }),
    };
  }

  // Surface bytes_passed in GB in a debug-tier check if needed by future
  // diagnostics. Currently unused by the markdown render but the import
  // is kept live so future $/GB-aware rollups don't have to re-introduce
  // the helper alongside their unit-conversion.
  void bytesToGb;

  return lines.join('\n');
}
