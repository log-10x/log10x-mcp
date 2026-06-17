/**
 * log10x_retriever_query reads the offloaded cohort from the customer-owned S3 overflow bucket.
 *
 * Call when an agent needs the events the Receiver held back from the SIEM for a
 * pattern (the offload action) and routed to S3. Surfaces the down-tiered or
 * dropped cohort the SIEM never received, scoped by a Bloom-filter search
 * expression or a Reporter-named pattern. Not a mirror of what the SIEM ingested.
 *
 * Engine contract: POST returns a queryId; results land in S3 as JSONL files
 * under {bucket}/tenx/{target}/qr/{queryId}/. The client polls the marker
 * prefix for stability, then reads and merges the JSONL result files.
 *
 * Requires __SAVE_LOG10X_RETRIEVER_URL__ and __SAVE_LOG10X_RETRIEVER_BUCKET__ to be set. Falls
 * back gracefully with a "not configured" message otherwise.
 *
 * SQS fallback: when the HTTP POST to the query-handler URL fails with a
 * transport-level error (ENOTFOUND, ECONNREFUSED, ETIMEDOUT — typical when the
 * helm probe resolved a ClusterIP address unreachable from outside the cluster),
 * the tool automatically retries via the Quarkus ingress queue. Requires:
 *   - LOG10X_RETRIEVER_QUERY_QUEUE_URL — the Quarkus ingress queue URL
 *     (same as TENX_QUARKUS_QUERY_QUEUE_URL in the retriever pod env)
 *   - sqs:SendMessage IAM permission on the queue for the MCP process's credentials
 * Response delivery is identical regardless of transport — results land in S3
 * under the same qr/{queryId}/ prefix. The transport used is recorded in
 * data.source_disclosure.transport ("http" | "sqs").
 */

import { z } from 'zod';
import { selectRollups, computeSummaryRollups, type RollupBasis } from '../lib/retriever-rollups.js';
import type { EnvConfig } from '../lib/environments.js';
import {
  runRetrieverQuery,
  isRetrieverConfigured,
  normalizeTimeExpression,
  buildPatternSearch,
  retrieverResultsLocation,
  type RetrieverQueryRequest,
  type RetrieverEvent,
} from '../lib/retriever-api.js';
import { getRetrieverState, type RetrieverStateSource } from '../lib/retriever-state.js';
import {
  explainZeroResults,
  type RetrieverQueryDiagnostics,
} from '../lib/retriever-diagnostics.js';
import type { QueryDiagnosis } from '../lib/query-funnel.js';
import { fmtCount } from '../lib/format.js';
import { renderNextActions, type NextAction } from '../lib/next-actions.js';
import { buildEnvelope, type StructuredOutput } from '../lib/output-types.js';
import { buildNotConfiguredEnvelope } from '../lib/not-configured.js';
import { resolveMetricsEnv } from '../lib/resolve-env.js';
import { getOffloadStatusBatch } from '../lib/offload-status.js';
import { buildChassisErrorEnvelope } from '../lib/chassis-envelope.js';
import { wrapBackendError } from '../lib/primitive-errors.js';
import {
  resolveClusterConfig,
  pickActiveOffload,
} from '../lib/env-config/resolve-cluster-config.js';

export const retrieverQuerySchema = {
  pattern: z
    .string()
    .optional()
    .describe(
      'Reporter-named pattern (Symbol Message) to scope the scan to. Auto-translated to `tenx_user_pattern == "<name>"` Bloom-filter expression. Use this when the agent has a pattern name from event_lookup / top_patterns / cost_drivers and wants the offloaded events for it without authoring the Bloom expression by hand. Mutually exclusive with `search`; if both are provided, `search` wins and `pattern` is ignored. Example: `pattern: "Payment_Gateway_Timeout"`.'
    ),
  pattern_hash: z
    .string()
    .optional()
    .describe(
      'Canonical pattern_hash from top_patterns / event_lookup. When provided, search is auto-built as `tenx_hash == "<hash>"` and no name resolution runs. This is the chain-stable identity emitted by top_patterns.payload.patterns[].pattern_hash — bypasses the name→hash resolver entirely. Precedence: `search` > `pattern_hash` > `pattern`. Example: `pattern_hash: "4Kjc7PHLWqY"`.'
    ),
  search: z
    .string()
    .optional()
    .describe(
      'Bloom-filter search expression using the TenX subset: `==`, `||`, `&&`, `includes(field, "substr")`. Example: `severity_level=="ERROR" && includes(text, "ECONNREFUSED")`. Selective values are dramatically cheaper than open-ended scans. Omit to scan the full window (bounded by limit/processingTime). Pass `pattern` instead for the common case of scoping to one Reporter-named pattern.'
    ),
  from: z
    .string()
    .describe(
      'Start of the query window. Accepts ISO8601 (`2026-01-15T00:00:00Z`), epoch millis, or relative (`now-1h`, `now-24h`, `now-7d`). Normalized to the engine\'s `now("-1h")` form before dispatch.'
    ),
  to: z
    .string()
    .default('now')
    .describe('End of the query window. Same grammar as `from`. Default `now`.'),
  filters: z
    .array(z.string())
    .optional()
    .describe(
      'JavaScript filter expressions evaluated in-memory against each decoded event after the Bloom-scoped fetch. Full TenX JS API: `this.customer_id === "acme-corp"`, `this.http_code.startsWith("5")`. Filters are AND-combined.'
    ),
  target: z
    .string()
    .optional()
    .describe(
      'Target app/service prefix to scope the index scan. Defaults to __SAVE_LOG10X_RETRIEVER_TARGET__ (env var). Required if no default is configured.'
    ),
  result_target: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'must be a bare token [A-Za-z0-9_-]+ (no slashes, separators, or "..")')
    .optional()
    .describe(
      'Tier-1 result-sink redirect: write this query OUTPUT (events, summaries, markers) under tenx/<result_target>/ in the same bucket instead of the default target, e.g. to a prefix a SIEM connector watches. Omit to keep results under the scan target (default). Bare token [A-Za-z0-9_-]+.'
    ),
  limit: z
    .number()
    .min(1)
    .max(10_000)
    .default(500)
    .describe(
      'Hard cap on events returned after merging per-worker result files. Default 500. Typical conversational queries want 10-100; the LLM will render only the first 50.'
    ),
  format: z
    .enum(['events', 'count', 'aggregated', 'ephemeral_series'])
    .default('events')
    .describe(
      '`events` (default: raw events), `count` (total + severity/service rollups, no event bodies), `aggregated` (events bucketed into a time series — use with bucket_size), `ephemeral_series` (bucketed series in Prometheus range-query shape for cross-pillar correlation). All four formats are rolled up client-side from the same events stream.'
    ),
  bucket_size: z
    .string()
    .default('5m')
    .describe('Bucket size when format=aggregated or ephemeral_series. Examples: `1m`, `5m`, `1h`, `1d`.'),
  environment: z.string().optional().describe('Environment nickname — required if multi-env.'),
  view: z
    .literal('summary')
    .default('summary')
    .optional()
    .describe('summary returns the typed envelope (data.events_matched, data.events[], data.query_id, data.diagnostics, data.human_summary). The deprecated markdown view was removed; data.human_summary carries the prose distillation for chat rendering.'),
  debug: z
    .boolean()
    .optional()
    .describe('Escalate the CloudWatch log level to DEBUG for THIS query only — per-blob Bloom decisions, per-fetch S3 reads, per-event results-writer samples. Use only when normal-run diagnostics cannot explain a 0-result or truncated outcome (volume is ~100x higher). Default false.'),
};

interface RetrieverQuerySummary {
  status: 'success' | 'no_signal' | 'error' | 'not_configured';
  human_summary: string;
  query_id?: string;
  target?: string;
  from: string;
  to: string;
  search?: string;
  pattern?: string;
  filters: string[];
  format: 'events' | 'count' | 'aggregated' | 'ephemeral_series';
  events_matched: number;
  /**
   * Where events_matched came from:
   *  - 'events_downloaded' — count of the (full) qr/ download.
   *  - 'qrs_summaries_nondropped' — whole-match volume from the engine
   *    summaries because the qr/ download was capped; EXCLUDES engine-dropped
   *    events (the summaries aggregator filters routeState!="drop").
   */
  events_matched_basis?: 'events_downloaded' | 'qrs_summaries_nondropped';
  /** How events_preview was selected: earliest-by-timestamp, a sampled subset (download capped), or none (count). */
  preview_basis?: 'earliest_sorted' | 'sampled' | 'none';
  /** True when the qr/ download was capped because summaries served the rollups. */
  download_capped?: boolean;
  /** Total qr/ worker files for the query (vs how many were downloaded). */
  total_worker_files?: number;
  events_returned: number;
  worker_files: number;
  wall_time_ms: number;
  truncated: boolean;
  partial_results: boolean;
  /**
   * Where the FULL matched-event set lives in S3 (one `*.jsonl` per stream
   * worker). `events_preview` is an in-context sample capped at `limit`;
   * this is the complete object list a capable agent reads directly, or
   * hands to the customer's own S3 -> SIEM path. Absent only when nothing
   * was written (count-only / zero matches / not configured).
   */
  results_location?: { bucket: string; prefix: string; uri: string };
  diagnostics_zero_reason?: string;
  /** Structured zero-result funnel: verdict + per-stage counts + actionable
   *  hint. When the query was blind (remote dispatch), this is the LOCALIZED
   *  verdict the MCP recovered via an auto-submitted narrowed local-dispatch
   *  probe. Agents branch on diagnostics_funnel.verdict. */
  diagnostics_funnel?: QueryDiagnosis;
  /**
   * Where by_severity/by_service/by_day came from:
   *  - 'qrs_summaries' — engine per-slice summaries; WHOLE-match counts.
   *  - 'events_capped' — derived from the downloaded events (capped at
   *    `limit`); for >limit matches these undercount.
   *  - 'mixed' — summaries served some dimensions, events the rest
   *    (deployment's enrichmentFields lack severity or service).
   */
  rollup_basis?: 'qrs_summaries' | 'events_capped' | 'mixed';
  by_severity?: Record<string, number>;
  by_service?: Record<string, number>;
  by_day?: Record<string, number>;
  events_preview: Array<{
    timestamp?: string | number;
    severity?: string;
    service?: string;
    text?: string;
  }>;
  /**
   * Per-`tenx_hash` offload status for hashes that appear on the returned
   * events. Populated best-effort via a single batched PromQL lookup
   * (`getOffloadStatusBatch`) against the metric surface — the receiver
   * stamps `routeState="drop"` on every event it routes to the
   * customer-owned offload bucket, so a non-zero dropped share over the
   * lookup window means the pattern is currently being offloaded.
   *
   * Absent when no events were returned, the lookup timed out, or no hash
   * had non-zero `ok` data. Subset of `OffloadStatus` — only the fields
   * a caller needs to route to retriever_query / advise_retriever.
   */
  offload_status_by_hash?: Record<string, {
    is_offloaded: boolean;
    /** Null when the kept-cohort scan timed out on a heavy pattern. */
    dropped_share_pct: number | null;
    last_seen_dropped_ts: number | null;
    /** True when the kept-cohort PromQL scan timed out — share math suppressed. */
    kept_timed_out?: boolean;
  }>;
  /**
   * Which ingress path was used to deliver the query to the retriever engine.
   * `"http"` — normal path (POST /streamer/query to the query-handler URL).
   * `"sqs"` — fallback path (SQS ingress queue), used when the HTTP URL is
   *   a ClusterIP address unreachable from outside the cluster.
   * Absent on older callers that did not record transport.
   */
  transport?: 'http' | 'sqs';
  /**
   * Total wall time in ms from SQS SendMessage until S3 polling completed.
   * Populated only when transport="sqs".
   */
  sqs_latency_ms?: number;
}

/**
 * Bridge env-config (k8s ConfigMap / AWS SSM / GCP SM / Azure AC / local file)
 * into the LOG10X_* / __SAVE_LOG10X_* env vars that retriever-api.ts +
 * retriever-state.ts + retriever-diagnostics.ts read directly.
 *
 * Without this bridge, retriever_query would only see __SAVE_LOG10X_RETRIEVER_URL__
 * / __SAVE_LOG10X_RETRIEVER_BUCKET__ / LOG10X_RETRIEVER_LOG_GROUP — leaving the
 * on-prem env-config document (which env_register writes, retriever-probe /
 * overflow-contents / doctor read) invisible to this tool. Same plumbing as
 * retriever-probe, advise-retriever, and doctor: env-config is authoritative,
 * env vars are fallback.
 *
 * Bridging is best-effort and one-way: an already-set env var is NEVER
 * overwritten (the explicit env var wins, mirroring the resolver's
 * precedence chain). Returns `true` when at least one env var was newly
 * populated from env-config so the caller can override
 * `source_disclosure.retriever_state_source` to `env_config`.
 */
async function bridgeEnvConfigToRetrieverEnvVars(): Promise<boolean> {
  // Fast-path: every env var the downstream tools read is already set →
  // env-config can't add anything. Skip the resolver to avoid spawning k8s /
  // SSM clients on every query.
  if (
    process.env.__SAVE_LOG10X_RETRIEVER_URL__ &&
    process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__ &&
    process.env.LOG10X_RETRIEVER_LOG_GROUP &&
    (process.env.LOG10X_OFFLOAD_BUCKET || process.env.LOG10X_STREAMER_BUCKET)
  ) {
    return false;
  }

  let resolved;
  try {
    resolved = await resolveClusterConfig();
  } catch {
    // Resolver failures are non-fatal — we fall through to whatever env vars
    // are set, and the existing not-configured envelope will fire if the
    // result is incomplete. This matches the doctor / retriever-probe pattern.
    return false;
  }
  if (!resolved.ok) return false;
  const cfg = resolved.config;

  let bridged = false;

  // Retriever URL → __SAVE_LOG10X_RETRIEVER_URL__
  if (!process.env.__SAVE_LOG10X_RETRIEVER_URL__ && cfg.retriever.url) {
    process.env.__SAVE_LOG10X_RETRIEVER_URL__ = cfg.retriever.url.replace(/\/+$/, '');
    bridged = true;
  }

  // Retriever input bucket (where qr/<id>/*.jsonl result objects land) →
  // __SAVE_LOG10X_RETRIEVER_BUCKET__. This is the bucket retriever-api
  // reads back for results polling; distinct from the offload bucket.
  if (!process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__ && cfg.retriever.input_bucket) {
    process.env.__SAVE_LOG10X_RETRIEVER_BUCKET__ = cfg.retriever.input_bucket;
    bridged = true;
  }

  // Retriever query log group → LOG10X_RETRIEVER_LOG_GROUP. Closes the
  // "Diagnostics unavailable: LOG10X_RETRIEVER_LOG_GROUP not set" gap on
  // zero-event queries: env_register writes this field, so a properly
  // registered env-config doc lets diagnostics run without a separate env var.
  if (!process.env.LOG10X_RETRIEVER_LOG_GROUP && cfg.retriever.query_log_group) {
    process.env.LOG10X_RETRIEVER_LOG_GROUP = cfg.retriever.query_log_group;
    bridged = true;
  }

  // Active offload bucket → LOG10X_STREAMER_BUCKET (legacy alias).
  // The receiver writes offloaded events here; downstream tools that surface
  // the offload bucket name (e.g., the "advise_retriever" recipe) read it via
  // this env var. Skip when no active destination — multi-active picks the
  // first per pickActiveOffload's documented order.
  if (
    !process.env.LOG10X_OFFLOAD_BUCKET &&
    !process.env.LOG10X_STREAMER_BUCKET
  ) {
    const active = pickActiveOffload(cfg);
    if (active?.bucket) {
      process.env.LOG10X_STREAMER_BUCKET = active.bucket;
      bridged = true;
    }
  }

  return bridged;
}

export async function executeRetrieverQuery(
  args: {
    pattern?: string;
    pattern_hash?: string;
    search?: string;
    from: string;
    to: string;
    filters?: string[];
    target?: string;
    result_target?: string;
    limit?: number;
    format?: 'events' | 'count' | 'aggregated' | 'ephemeral_series';
    bucket_size?: string;
    environment?: string;
    view?: 'summary';
    debug?: boolean;
  },
  env: EnvConfig
): Promise<string | StructuredOutput> {
  // Bridge env-config → env vars BEFORE the configured check / state probe.
  // env-config (k8s ConfigMap, AWS SSM, GCP SM, Azure AC, local file) is the
  // on-prem source of truth that env_register writes and retriever-probe /
  // overflow-contents / doctor read — this tool was the gap.
  const envConfigBridged = await bridgeEnvConfigToRetrieverEnvVars();

  // Fix 83: resolve Retriever state for source_disclosure.
  const retrieverState = await getRetrieverState(null);
  // When env-config supplied the bridged vars, prefer that label over the
  // post-bridge `env_var` reading so the audit reflects the real upstream.
  const retrieverStateSource: RetrieverStateSource = envConfigBridged
    ? 'env_config'
    : retrieverState.source;
  if (!(await isRetrieverConfigured())) {
    // Typed not_configured (status + advise_retriever action) so an agent
    // branches on data.status; the framework chokepoint also normalises to
    // the same shape if a tool throws a NotConfiguredError later.
    return buildNotConfiguredEnvelope({
      tool: 'log10x_retriever_query',
      kind: 'retriever',
      remediation: retrieverNotConfiguredMessage(),
    });
  }

  // Y2: pattern_hash → search auto-build BEFORE the inner executor runs.
  // Bypasses the name→hash resolver entirely so a chain that arrives with
  // a canonical pattern_hash from top_patterns / event_lookup never enters
  // the pattern_not_resolved error path. Precedence: explicit `search`
  // wins (agent authored it), then `pattern_hash` (chain-stable identity),
  // then `pattern` (Reporter name, may resolve later via buildPatternSearch).
  if (!args.search && args.pattern_hash) {
    const safeHash = args.pattern_hash.trim().replace(/"/g, '');
    args.search = `tenx_hash == "${safeHash}"`;
  }

  const sumOut: { data?: RetrieverQuerySummary } = {};
  try {
    await executeRetrieverQueryInner(args, env, sumOut);
  } catch (err: unknown) {
    // Wave 2.F: classify time-window parse failures as schema_invalid
    // instead of the generic 'unknown' wrapBackendError returns for
    // non-HTTP/non-network errors. The inner throws `Invalid time window:
    // ...` when normalizeTimeExpression rejects from/to; that's a caller-
    // side input bug (retryable=false, no backoff) — distinct from a
    // transient backend failure.
    const errMsg = err instanceof Error ? err.message : String(err);
    const isTimeWindowError = errMsg.startsWith('Invalid time window:');
    const primitiveErr = isTimeWindowError
      ? {
          error_type: 'schema_invalid' as const,
          retryable: false,
          suggested_backoff_ms: null,
          hint: errMsg.slice(0, 300),
        }
      : wrapBackendError(err);
    // Extract dual-failure breadcrumbs written by the SQS fallback path
    // when both HTTP and SQS transports were attempted and both failed.
    const dualErr = err as Record<string, unknown>;
    const transportsBreadcrumbs =
      Array.isArray(dualErr?.transports_attempted)
        ? {
            transports_attempted: dualErr.transports_attempted,
            http_error_message: dualErr.http_error_message,
            sqs_error_type: dualErr.sqs_error_type,
            sqs_error_message: dualErr.sqs_error_message,
          }
        : {};
    // Y2: Populate a `query_id` sentinel on the error envelope so the
    // forward chain (retriever_query_status) stays composable even when
    // the original query never produced a UUID. The sentinel encodes the
    // error_type so the status tool can early-return a typed envelope
    // without an opaque "not found" S3 probe. Format: `error:<error_type>`.
    const sentinelQueryId = `error:${primitiveErr.error_type ?? 'unknown'}`;
    return buildChassisErrorEnvelope({
      tool: 'log10x_retriever_query',
      err: primitiveErr,
      contextPayload: {
        query_id: sentinelQueryId,
        pattern: args.pattern,
        pattern_hash: args.pattern_hash,
        search: args.search,
        from: args.from,
        to: args.to,
        target: args.target,
        format: args.format,
        environment: args.environment,
        ...transportsBreadcrumbs,
      },
      source_disclosure: {},
    });
  }
  if (!sumOut.data) {
    // Internal-state safety net: inner ran without throwing but produced no data.
    throw new Error('retriever_query: inner pipeline returned no data.');
  }
  const d = sumOut.data;
  // Headline used to say "X returned" for every format, which is
  // meaningless for `count` (we don't return events at all) and
  // misleading for `aggregated`/`ephemeral_series` (we return buckets,
  // not raw events). Branch on format so the headline names the actual
  // deliverable. Also surface a perf caveat when wall_time crosses the
  // practical degradation floor (30s) so chain agents can pace themselves.
  const formatLabel = d.format ?? 'events';
  const deliverableClause =
    formatLabel === 'count'
      ? `count-only summary`
      : formatLabel === 'aggregated'
        ? `${d.events_returned} events bucketed`
        : formatLabel === 'ephemeral_series'
          ? `${d.events_returned} events as range-query series`
          : `${d.events_returned} returned`;
  const perfCaveat = d.wall_time_ms > 30000
    ? `, slow scan — consider narrowing search or window`
    : '';
  const matchedQual = d.events_matched_basis === 'qrs_summaries_nondropped' ? ' (engine summaries, excludes dropped)' : '';
  const headline = `Retriever query \`${d.query_id ?? '?'}\` over ${d.from} → ${d.to}: ${fmtCount(d.events_matched)} events matched${matchedQual}, ${deliverableClause} (${d.wall_time_ms}ms${d.truncated ? ', truncated' : ''}${perfCaveat}).`;
  const actions: Array<{ tool: string; args: Record<string, unknown>; reason: string }> = [];
  if (d.partial_results) {
    actions.push({ tool: 'log10x_retriever_query', args: { from: d.from, to: d.to, pattern: d.pattern, search: d.search, target: d.target }, reason: 'partialResults — re-run with same args to resume from cached scan progress' });
  }
  // Prior code chained retriever_series only when `d.pattern` was set.
  // Hash-keyed callers (pattern_hash auto-built a `tenx_hash == "..."`
  // search) had pattern undefined and lost the follow-on action entirely.
  // Use pattern_hash → search as the chained identity when pattern is absent.
  if (d.events_matched > 0) {
    if (d.pattern) {
      actions.push(
        { tool: 'log10x_retriever_series', args: { pattern: d.pattern, from: d.from, to: d.to, bucket_size: '1h' }, reason: 'time-bucketed series across the same window (exact vs sampled)' }
      );
    } else if (args.pattern_hash) {
      actions.push(
        { tool: 'log10x_retriever_series', args: { pattern_hash: args.pattern_hash, from: d.from, to: d.to, bucket_size: '1h' }, reason: 'time-bucketed series for the hash-keyed pattern across the same window' }
      );
    }
  }
  // Dispatcher-failure drill-in: zero events + tasks dispatched but nothing scanned.
  // This is the chart 1.0.20 streamer->retriever rename signature detected in the
  // inner pipeline via resp.diagnostics. Surface the query_status tool so an agent
  // can confirm via pod logs without a separate manual step.
  if (d.query_id && d.events_matched === 0) {
    // The human_summary already explains the fingerprint when scanned=0 + streamReqs>0.
    // Add the structured action so agents can chain directly without parsing prose.
    if (d.human_summary && (
      d.human_summary.includes('log10x_retriever_query_status') ||
      d.human_summary.includes('dispatcher') ||
      d.human_summary.includes('chart 1.0.20')
    )) {
      actions.push({
        tool: 'log10x_retriever_query_status',
        args: { query_id: d.query_id, target: d.target, include_pod_logs: true },
        reason: '0 events matched — confirm chart 1.0.20 dispatcher-failure signature via pod logs and _DONE.json',
      });
    }
  }
  return buildEnvelope({
    tool: 'log10x_retriever_query',
    view: 'summary',
    summary: { headline },
    data: {
      ...d,
      source_disclosure: {
        retriever_state_source: retrieverStateSource,
        transport: d.transport ?? 'http',
        ...(d.rollup_basis ? { rollup_basis: d.rollup_basis } : {}),
        ...(d.sqs_latency_ms !== undefined ? { sqs_latency_ms: d.sqs_latency_ms } : {}),
      },
    },
    truncated: d.truncated || d.partial_results,
    actions,
  });
}

/**
 * Three-sentence plain-prose distillation of a successful retriever_query
 * run. No markdown syntax, no dollar figures. Mirrors the canonical
 * buildHumanSummary pattern in src/tools/find-skew.ts:216.
 */
function buildRetrieverQueryHumanSummary(s: {
  eventsMatched: number;
  eventsReturned: number;
  from: string;
  to: string;
  target: string;
  truncated: boolean;
  partialResults: boolean;
  pattern?: string;
  search?: string;
  wallTimeMs: number;
  offloadedHashCount: number;
  zeroReason?: string;
  /** queryId of the completed query — used to surface the dispatcher-failure
   * diagnostic when scanned=0 + submittedTasks>0. */
  queryId?: string;
  /** Scan/dispatch stats from the _DONE.json equivalent (diagnostics object). */
  diagnosticsScanned?: number;
  diagnosticsSubmittedTasks?: number;
  /** Part A: eventsMatched came from engine summaries (excludes dropped). */
  countFromSummaries?: boolean;
  /** Part A: the preview/return is a sampled subset (download capped). */
  sampledPreview?: boolean;
}): string {
  const scope = s.pattern
    ? `pattern ${s.pattern}`
    : s.search
      ? `search ${s.search}`
      : 'open scan';
  if (s.eventsMatched === 0) {
    // Dispatcher-failure detection: coordinator submitted tasks but nothing was scanned.
    // This is the chart 1.0.20 incomplete-streamer-rename signature.
    if (
      s.diagnosticsScanned === 0 &&
      s.diagnosticsSubmittedTasks !== undefined &&
      s.diagnosticsSubmittedTasks > 0
    ) {
      return (
        `Retriever returned 0 events but the coordinator submitted ${s.diagnosticsSubmittedTasks} scan task(s) ` +
        `that scanned nothing. This is the chart 1.0.20 incomplete-streamer-rename signature — scan/stream workers ` +
        `fail to launch because the cloud/streamer/subquery include was not renamed. ` +
        `Verify via log10x_retriever_query_status({query_id: '${s.queryId ?? '?'}', include_pod_logs: true}) — ` +
        `if the pod logs show 'could not resolve include: cloud/streamer/subquery', upgrade to chart 1.0.21+ ` +
        `or apply the rename-residual fix in modules/feat/soft-drop.`
      );
    }
    const reason = s.zeroReason ? ` ${s.zeroReason}` : '';
    return `Retriever returned zero events for ${scope} over ${s.from} to ${s.to} on target ${s.target} (${s.wallTimeMs}ms).${reason} Widen the window or relax the filter before declaring the pattern absent.`;
  }
  const countQual = s.countFromSummaries
    ? ' (from engine summaries; excludes dropped events — run an uncapped query to include the dropped cohort)'
    : '';
  const returnedQual = s.sampledPreview
    ? ` ${fmtCount(s.eventsReturned)} sampled (not earliest)`
    : `returned ${fmtCount(s.eventsReturned)}`;
  const first = `Retriever matched ${fmtCount(s.eventsMatched)} events${countQual} for ${scope} over ${s.from} to ${s.to} on target ${s.target}; ${returnedQual} in ${s.wallTimeMs}ms.`;
  const flags: string[] = [];
  if (s.truncated) flags.push('result set was truncated at the per-worker cap');
  if (s.partialResults) flags.push('one or more workers were partial');
  const second = flags.length > 0
    ? `Caveats: ${flags.join('; ')} — narrow the search or re-run to resume.`
    : `Wall time was clean and no worker reported partial results.`;
  const third = s.offloadedHashCount > 0
    ? `${s.offloadedHashCount} hash(es) in this result set are currently routed to forwarder offload; live events continue to land in the offload bucket.`
    : `No hash in this result set is currently routed to forwarder offload.`;
  return `${first} ${second} ${third}`;
}

async function executeRetrieverQueryInner(
  args: {
    pattern?: string;
    search?: string;
    from: string;
    to: string;
    filters?: string[];
    target?: string;
    result_target?: string;
    limit?: number;
    format?: 'events' | 'count' | 'aggregated' | 'ephemeral_series';
    bucket_size?: string;
    environment?: string;
    debug?: boolean;
  },
  env: EnvConfig,
  sumOut?: { data?: RetrieverQuerySummary }
): Promise<string> {
  // Defensive defaults — match retrieverQuerySchema. Direct/chain
  // callers bypass the SDK Zod boundary; without these the rendering
  // path renders `${undefined}`.
  args.limit = args.limit ?? 500;
  args.format = args.format ?? 'events';
  args.bucket_size = args.bucket_size ?? '5m';
  args.to = args.to ?? 'now';

  try {
    normalizeTimeExpression(args.from);
    normalizeTimeExpression(args.to);
  } catch (e) {
    throw new Error(`Invalid time window: ${(e as Error).message}`);
  }

  // Resolve pattern → search. When both are provided, `search` wins so the
  // explicit form is never overwritten by an auto-translation. Tools that
  // pass `pattern` (the Reporter-named Symbol Message) want the engine to
  // scope to that pattern without the agent having to author the TenX
  // expression by hand. See buildPatternSearch in retriever-api.
  const effectiveSearch = args.search || (args.pattern ? buildPatternSearch(args.pattern) : undefined);

  const req: RetrieverQueryRequest = {
    from: args.from,
    to: args.to,
    search: effectiveSearch,
    filters: args.filters,
    target: args.target,
    resultTarget: args.result_target,
    limit: args.limit,
    logLevels: args.debug ? 'ERROR,INFO,PERF,DEBUG' : undefined,
    // Per-slice summaries cost almost nothing to write/read and give the
    // rollups whole-match correctness (see lib/retriever-rollups.ts).
    writeSummaries: true,
    // Part A download cap (only engages when the engine actually wrote qrs/):
    //  - count: pull NO qr/ events — summaries supply count + rollups.
    //  - events/aggregated/ephemeral_series: pull only enough to fill the
    //    returned/previewed set (limit), not the whole match.
    // The engine always WROTE the full set; results_location carries the
    // bulk. With no summaries the full set is downloaded regardless.
    maxDownloadEvents: args.format === 'count' ? 0 : (args.limit ?? 10_000),
  };

  const resp = await runRetrieverQuery(env, req);

  const lines: string[] = [];
  lines.push(`## Retriever Query`);
  lines.push('');
  lines.push(`**Window**: ${args.from} → ${args.to}`);
  if (effectiveSearch) {
    if (args.pattern && !args.search) {
      lines.push(`**Pattern**: \`${args.pattern}\` (auto-translated to \`${effectiveSearch}\`)`);
    } else {
      lines.push(`**Search**: \`${effectiveSearch}\``);
    }
  }
  if (args.filters && args.filters.length > 0) {
    lines.push(`**Filters**: ${args.filters.map((f) => `\`${f}\``).join(' AND ')}`);
  }
  lines.push(`**Target**: \`${resp.target}\``);
  lines.push(`**Query ID**: \`${resp.queryId}\``);
  lines.push('');
  lines.push(
    `**Execution**: ${fmtCount(resp.execution.eventsMatched)} events matched · ` +
      `${resp.execution.workerFiles} worker result files · ` +
      `${resp.execution.wallTimeMs}ms wall time` +
      (resp.execution.truncated ? ` · _truncated_` : '')
  );
  renderDiagnostics(resp.diagnostics, resp.execution.eventsMatched, lines);
  lines.push('');

  if (args.format === 'count') {
    renderCount(resp.events, lines);
  } else if (args.format === 'aggregated') {
    renderAggregated(resp.events, args.bucket_size, lines);
  } else if (args.format === 'ephemeral_series') {
    renderEphemeralSeries(resp.events, args.bucket_size, args.search, lines);
  } else {
    // events format
    const events = resp.events;
    lines.push(`### Events (${Math.min(events.length, 50)} of ${events.length} shown)`);
    lines.push('');
    for (let i = 0; i < Math.min(events.length, 50); i++) {
      lines.push(formatEvent(events[i]));
    }
    if (events.length > 50) {
      lines.push('');
      lines.push(
        `_${events.length - 50} additional events omitted. Switch to \`format: "aggregated"\` or \`"count"\` for a summary, or narrow the search/filter._`
      );
    }
    if (events.length === 0) {
      lines.push(
        '_Retriever returned zero events. Verify the search expression matches at least one real value, check the window, or widen the filter._'
      );
    }

    if (resp.execution.truncated) {
      lines.push('');
      lines.push(
        '> **Truncated**: one or more stream workers hit the per-worker result cap. Narrow the search expression or add a more selective filter to see the full match set.'
      );
    }
  }

  // Where the full result set lives in S3: the object list a capable
  // agent reads directly (beyond the in-context preview), or hands to the
  // customer's own S3 -> SIEM path. Computed for event-bearing formats.
  let resultsLoc: { bucket: string; prefix: string; uri: string } | undefined;
  if (args.format !== 'count' && resp.events.length > 0) {
    resultsLoc = await retrieverResultsLocation(resp.target, resp.queryId).catch(() => undefined);
    if (resultsLoc) {
      lines.push('');
      lines.push(`**Full results in S3** (${resp.execution.eventsMatched} matched, ${resp.execution.workerFiles} object(s)): \`${resultsLoc.uri}\``);
      lines.push(`_The reply previews up to \`limit\` events; the full match set is the \`*.jsonl\` objects under that prefix. Read them directly, or point a SIEM S3-ingest / loader at the prefix._`);
    }
  }

  // Offload-status lookup: for each distinct tenx_hash that appeared on
  // the returned events, ask the metric surface whether the receiver is
  // currently routing it to forwarder offload. Best-effort, 2s budget;
  // failures surface as `undefined` and never block the response.
  let offloadByHash: Record<string, {
    is_offloaded: boolean;
    dropped_share_pct: number | null;
    last_seen_dropped_ts: number | null;
    kept_timed_out?: boolean;
  }> | undefined;
  let patternHashForNudge: string | undefined;
  if (resp.events.length > 0) {
    const hashes = new Set<string>();
    for (const ev of resp.events) {
      const h = (ev as unknown as Record<string, unknown>).tenx_hash;
      if (typeof h === 'string' && h.length > 0) hashes.add(h);
    }
    if (hashes.size > 0) {
      try {
        const metricsEnv = await resolveMetricsEnv(env);
        const batch = await getOffloadStatusBatch(env, {
          patternHashes: [...hashes],
          metricsEnv,
          range: '24h',
          timeoutMs: 2000,
        });
        const projected: Record<string, {
          is_offloaded: boolean;
          dropped_share_pct: number | null;
          last_seen_dropped_ts: number | null;
          kept_timed_out?: boolean;
        }> = {};
        for (const [h, s] of Object.entries(batch)) {
          if (!s.ok) continue;
          projected[h] = {
            is_offloaded: s.is_offloaded,
            dropped_share_pct: s.dropped_share_pct,
            last_seen_dropped_ts: s.last_seen_dropped_ts,
            ...(s.kept_timed_out ? { kept_timed_out: true } : {}),
          };
        }
        if (Object.keys(projected).length > 0) offloadByHash = projected;

        // Markdown nudge — fires only when the caller scoped to ONE
        // pattern (args.pattern is set), that pattern's hash is in the
        // offload-positive set, and the retriever is configured (we
        // checked at the outer entry, so it is here). The hash is read
        // off any event carrying args.pattern. See spec section B.
        if (offloadByHash && args.pattern) {
          for (const ev of resp.events) {
            const evRec = ev as unknown as Record<string, unknown>;
            const evPattern = evRec.tenx_user_pattern;
            const evHash = evRec.tenx_hash;
            if (typeof evPattern === 'string' && evPattern === args.pattern &&
                typeof evHash === 'string' && offloadByHash[evHash]?.is_offloaded) {
              patternHashForNudge = evHash;
              break;
            }
          }
          if (!patternHashForNudge) {
            // Pattern name didn't ride on the event payload (older
            // archive shape). Fall back to "any single hash is
            // offloaded" — we already scoped the search to one pattern,
            // so a single hash in the result set is overwhelmingly the
            // same pattern.
            const offloadedHashes = Object.entries(offloadByHash).filter(([, s]) => s.is_offloaded);
            if (offloadedHashes.length === 1) patternHashForNudge = offloadedHashes[0][0];
          }
          if (patternHashForNudge) {
            const projected = offloadByHash[patternHashForNudge];
            const share = projected.dropped_share_pct;
            lines.push('');
            // HONESTY: routeState="drop" is the engine's drop/offload cohort and does
            // NOT distinguish offload-to-S3 (fetchable here) from hard-drop
            // (gone). So the nudge is RESULT-AWARE: events found => the slice is
            // really in the bucket; zero events => the honest read is hard-drop
            // or an unwired bucket, not "query again".
            const sharePhrase =
              share === null || projected.kept_timed_out
                ? 'kept-side share query slow on a heavy cohort, share not computed'
                : `~${share.toFixed(0)}% of recent volume marked \`routeState="drop"\``;
            if (resp.events.length === 0) {
              lines.push(
                `> **Reduction detected, no events found**: this pattern is in the receiver's drop/offload cohort (${sharePhrase}), but this query returned no events. The likely reason: it was HARD-DROPPED (not archived), or the offload bucket is not wired into this retriever. Only patterns the receiver OFFLOADS to S3 are fetchable here — check \`log10x_advise_retriever\` for the bucket recipe.`,
              );
            } else {
              lines.push(
                `> **Reduction detected**: this pattern is in the receiver's drop/offload cohort (${sharePhrase}); this query found events, so the offloaded slice is in your bucket. Widen the window with \`log10x_retriever_query{pattern: "${args.pattern}", from: "now-1h"}\` for more, or check \`log10x_advise_retriever\`.`,
              );
            }
          }
        }
      } catch { /* best-effort */ }
    }
  }

  // Structured NEXT_ACTIONS for autonomous chains.
  const nextActions: NextAction[] = [];
  const partialDiag = (resp.diagnostics as RetrieverQueryDiagnostics & { partialResults?: boolean })?.partialResults;
  const failedDl = resp.execution.failedWorkerFiles ?? 0;
  if (partialDiag || failedDl > 0) {
    nextActions.push({
      tool: 'log10x_retriever_query_status',
      args: { query_id: resp.queryId, fetch_results: true, target: resp.target },
      reason: failedDl > 0
        ? `${failedDl} worker file(s) failed download after retries — re-fetch from S3 without resubmitting (the full set is intact there)`
        : 'partialResults: recover stranded events from S3 without resubmitting',
    });
  }
  // Zero-events + dispatcher-failure fingerprint: surface retriever_query_status drill-in.
  if (resp.execution.eventsMatched === 0 && resp.diagnostics?.scanStats?.scanned === 0) {
    const streamReqs = resp.diagnostics?.streamDispatch?.requests ?? 0;
    if (streamReqs > 0) {
      nextActions.push({
        tool: 'log10x_retriever_query_status',
        args: { query_id: resp.queryId, target: resp.target, include_pod_logs: true },
        reason: `0 events scanned despite ${streamReqs} dispatch requests — confirm chart 1.0.20 dispatcher-failure via pod logs`,
      });
    }
  }
  if (args.pattern && resp.events.length > 0) {
    nextActions.push({
      tool: 'log10x_retriever_series',
      args: { pattern: args.pattern, from: args.from, to: args.to, bucket_size: '1h' },
      reason: 'time-bucketed series across the same window (exact vs sampled)',
    });
  }
  if (offloadByHash && Object.values(offloadByHash).some((s) => s.is_offloaded)) {
    nextActions.push({
      tool: 'log10x_advise_retriever',
      args: {},
      reason: 'pattern(s) in the drop/offload cohort (routeState="drop") — verify the offload bucket recipe is wired; only patterns offloaded to S3 (not hard-dropped) are fetchable here',
    });
  }
  const block = renderNextActions(nextActions);
  if (block) lines.push('', block);

  if (sumOut) {
    // Event-derived rollups see only the capped download; summaries see the
    // WHOLE match. Prefer summaries per-dimension when available, with two
    // honesty guards: never under filters[] (whether the engine's summary
    // writer applies filters is unverified — overcount risk), and never for
    // a dimension the deployment's enrichmentFields don't cover.
    const evSeverity: Record<string, number> = {};
    const evService: Record<string, number> = {};
    const evDay: Record<string, number> = {};
    for (const ev of resp.events) {
      const sev = (ev.severity_level as string) || 'unknown';
      evSeverity[sev] = (evSeverity[sev] ?? 0) + 1;
      const svc = (ev.tenx_user_service as string) || 'unknown';
      evService[svc] = (evService[svc] ?? 0) + 1;
      const ts = ev.timestamp;
      if (ts) {
        const d = new Date(typeof ts === 'number' ? ts : String(ts));
        if (!isNaN(d.getTime())) {
          const day = d.toISOString().slice(0, 10);
          evDay[day] = (evDay[day] ?? 0) + 1;
        }
      }
    }
    const sel = selectRollups({
      eventDerived: { by_severity: evSeverity, by_service: evService, by_day: evDay },
      summaries: resp.summaries,
      filtersActive: Array.isArray(args.filters) && args.filters.length > 0,
    });
    const bySeverity = sel.by_severity;
    const byService = sel.by_service;
    const byDay = sel.by_day;
    const rollupBasis: RollupBasis = sel.rollup_basis;

    // events_matched provenance. When the qr/ download was capped (Part A),
    // resp.execution.eventsMatched is only the downloaded subset — the true
    // whole-match count comes from the summaries' summed volume. Stamp which.
    // Defensive: never source the count from summaries under filters[] — the
    // summary writer's filter behavior is unverified (the same guard
    // selectRollups uses). With the API-layer cap also gated on !filtersActive
    // this is belt-and-suspenders, but keeps the invariant local.
    const filtersActiveForCount = Array.isArray(args.filters) && args.filters.length > 0;
    const downloadWasCapped = resp.execution.downloadCapped === true;
    const summaryTotalVolume =
      !filtersActiveForCount && resp.summaries && resp.summaries.length > 0
        ? computeSummaryRollups(resp.summaries).total_volume
        : 0;
    const eventsMatched =
      downloadWasCapped && summaryTotalVolume > 0
        ? summaryTotalVolume
        : resp.execution.eventsMatched;
    // Non-dropped caveat: summary volume excludes engine-dropped events,
    // while a full qr/ download includes them — disclose the basis.
    const eventsMatchedBasis: 'qrs_summaries_nondropped' | 'events_downloaded' =
      downloadWasCapped && summaryTotalVolume > 0 ? 'qrs_summaries_nondropped' : 'events_downloaded';
    const previewBasis: 'earliest_sorted' | 'sampled' | 'none' =
      args.format === 'count' ? 'none' : downloadWasCapped ? 'sampled' : 'earliest_sorted';
    // When the caller asked for `count`, they wanted aggregates, not bodies.
    // Returning events_preview from a count call ships event payloads the
    // caller didn't ask for (bandwidth waste, and confusing in the envelope
    // because the rollups disagree with what a 10-event preview suggests).
    // Suppress.
    const previewEvents = args.format === 'count'
      ? []
      : resp.events.slice(0, 10).map((ev) => ({
          timestamp: ev.timestamp as string | number | undefined,
          severity: ev.severity_level as string | undefined,
          service: ev.tenx_user_service as string | undefined,
          text: typeof ev.text === 'string' ? (ev.text as string).slice(0, 240) : undefined,
        }));
    // Worker files that failed download after retries make the event set
    // (and event-derived rollups) incomplete — same agent-facing semantics
    // as engine-side partial workers, so fold into the partial flag.
    const failedDownloads = resp.execution.failedWorkerFiles ?? 0;
    const partialResults =
      !!(resp.diagnostics as RetrieverQueryDiagnostics & { partialResults?: boolean })?.partialResults ||
      failedDownloads > 0;
    const offloadedHashCount = offloadByHash
      ? Object.values(offloadByHash).filter((s) => s.is_offloaded).length
      : 0;
    const human_summary = buildRetrieverQueryHumanSummary({
      eventsMatched,
      eventsReturned: resp.events.length,
      from: args.from,
      to: args.to,
      target: resp.target,
      truncated: !!resp.execution.truncated,
      partialResults,
      pattern: args.pattern,
      search: effectiveSearch,
      wallTimeMs: resp.execution.wallTimeMs,
      offloadedHashCount,
      countFromSummaries: eventsMatchedBasis === 'qrs_summaries_nondropped',
      sampledPreview: previewBasis === 'sampled',
      // Zero-reason only when the WHOLE-MATCH count (not the skipped download)
      // is zero — a capped count with 167 matched is not "no signal".
      zeroReason: eventsMatched === 0 && resp.diagnostics ? (explainZeroResults(resp.diagnostics) ?? undefined) : undefined,
      queryId: resp.queryId,
      diagnosticsScanned: resp.diagnostics?.scanStats?.scanned,
      diagnosticsSubmittedTasks: (resp.diagnostics?.streamDispatch?.requests !== undefined)
        ? resp.diagnostics.streamDispatch.requests
        : undefined,
    });
    sumOut.data = {
      status: eventsMatched === 0 ? 'no_signal' : 'success',
      human_summary,
      query_id: resp.queryId,
      target: resp.target,
      from: args.from,
      to: args.to,
      search: effectiveSearch,
      pattern: args.pattern,
      filters: args.filters ?? [],
      format: args.format ?? 'events',
      events_matched: eventsMatched,
      events_matched_basis: eventsMatchedBasis,
      preview_basis: previewBasis,
      ...(downloadWasCapped ? { download_capped: true, total_worker_files: resp.execution.totalWorkerFiles } : {}),
      events_returned: resp.events.length,
      worker_files: resp.execution.workerFiles,
      wall_time_ms: resp.execution.wallTimeMs,
      truncated: !!resp.execution.truncated,
      partial_results: partialResults,
      results_location: resultsLoc,
      diagnostics_zero_reason: eventsMatched === 0 && resp.diagnostics ? (explainZeroResults(resp.diagnostics) ?? undefined) : undefined,
      // Structured funnel verdict for a zero-result query: stage counts +
      // verdict (OK / EMPTY_RANGE / BLOOM_REJECTED_ALL / MATCHED_NO_EVENTS /
      // DISPATCHED_BLIND / ...) + an actionable hint. When the original query
      // was blind (remote dispatch), this carries the LOCALIZED verdict the
      // MCP recovered by auto-submitting a narrowed local-dispatch probe.
      // Agents branch on diagnostics_funnel.verdict.
      diagnostics_funnel: eventsMatched === 0 ? resp.diagnostics?.funnel : undefined,
      rollup_basis: rollupBasis,
      by_severity: Object.keys(bySeverity).length > 0 ? bySeverity : undefined,
      by_service: Object.keys(byService).length > 0 ? byService : undefined,
      by_day: Object.keys(byDay).length > 0 ? byDay : undefined,
      events_preview: previewEvents,
      offload_status_by_hash: offloadByHash,
      transport: resp.transport,
      ...(resp.sqsLatencyMs !== undefined ? { sqs_latency_ms: resp.sqsLatencyMs } : {}),
    };
  }

  return lines.join('\n');
}

function renderCount(events: RetrieverEvent[], lines: string[]): string[] {
  lines.push(`### Count summary`);
  lines.push('');
  lines.push(`Total matched: **${fmtCount(events.length)}**`);

  const byService = new Map<string, number>();
  const bySeverity = new Map<string, number>();
  const byDay = new Map<string, number>();

  for (const ev of events) {
    const svc = (ev.tenx_user_service as string) || 'unknown';
    byService.set(svc, (byService.get(svc) || 0) + 1);

    const sev = (ev.severity_level as string) || 'unknown';
    bySeverity.set(sev, (bySeverity.get(sev) || 0) + 1);

    const ts = ev.timestamp;
    if (ts) {
      const d = new Date(typeof ts === 'number' ? ts : String(ts));
      if (!isNaN(d.getTime())) {
        const day = d.toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) || 0) + 1);
      }
    }
  }

  if (bySeverity.size > 0) {
    lines.push('');
    lines.push('By severity:');
    for (const [sev, n] of [...bySeverity.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  - ${sev}: ${fmtCount(n)}`);
    }
  }
  if (byService.size > 0) {
    lines.push('');
    lines.push('By service (top 10):');
    for (const [svc, n] of [...byService.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      lines.push(`  - ${svc}: ${fmtCount(n)}`);
    }
  }
  if (byDay.size > 0) {
    lines.push('');
    lines.push('By day:');
    for (const [day, n] of [...byDay.entries()].sort()) {
      lines.push(`  - ${day}: ${fmtCount(n)}`);
    }
  }
  return lines;
}

function bucketEvents(events: RetrieverEvent[], bucketSize: string): Array<{ timestamp: string; count: number }> {
  const bucketMs = parseBucketSize(bucketSize);
  const buckets = new Map<number, number>();

  for (const ev of events) {
    const ts = ev.timestamp;
    if (!ts) continue;
    const d = new Date(typeof ts === 'number' ? ts : String(ts));
    if (isNaN(d.getTime())) continue;
    const key = Math.floor(d.getTime() / bucketMs) * bucketMs;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, count]) => ({ timestamp: new Date(ts).toISOString(), count }));
}

function parseBucketSize(expr: string): number {
  const m = expr.trim().match(/^(\d+)([smhd])$/);
  if (!m) return 5 * 60 * 1000;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    case 'h':
      return n * 3_600_000;
    case 'd':
      return n * 86_400_000;
    default:
      return 5 * 60 * 1000;
  }
}

function renderAggregated(events: RetrieverEvent[], bucketSize: string, lines: string[]): string[] {
  const buckets = bucketEvents(events, bucketSize);
  lines.push(`### Time-bucketed (${bucketSize})`);
  lines.push('');
  if (buckets.length === 0) {
    lines.push('_No events with parseable timestamps in the result set._');
    return lines;
  }
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  for (const b of buckets.slice(0, 80)) {
    const bar = max > 0 ? renderBar(b.count / max, 30) : '';
    lines.push(`  ${b.timestamp}  ${fmtCount(b.count).padStart(8)}  ${bar}`);
  }
  if (buckets.length > 80) {
    lines.push('');
    lines.push(`_${buckets.length - 80} additional buckets omitted from the rendering._`);
  }
  return lines;
}

function renderEphemeralSeries(
  events: RetrieverEvent[],
  bucketSize: string,
  search: string | undefined,
  lines: string[]
): string[] {
  const buckets = bucketEvents(events, bucketSize);
  lines.push(`### Ephemeral series (Prometheus range-query shape)`);
  lines.push('');
  if (buckets.length === 0) {
    lines.push('_No events with parseable timestamps in the result set._');
    return lines;
  }
  const values: Array<[number, string]> = buckets.map((b) => [
    Math.floor(new Date(b.timestamp).getTime() / 1000),
    String(b.count),
  ]);
  const promResponse = {
    status: 'success' as const,
    data: {
      resultType: 'matrix' as const,
      result: [
        {
          metric: {
            __name__: 'log10x_ephemeral',
            source: 'retriever_archive',
            search: search || '',
          },
          values,
        },
      ],
    },
  };
  lines.push('```json');
  lines.push(JSON.stringify(promResponse, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(
    `**${values.length} data points** over the window in Prometheus range-query format.`
  );
  return lines;
}

function formatEvent(ev: RetrieverEvent): string {
  // The retriever returns events in two shapes depending on whether the
  // query-handler pipeline enriched them:
  //
  // 1. **log10x canonical** — `text`, `severity_level`, `tenx_user_service`,
  //    `k8s_*` fields. Present when the archive was written by a Reporter/
  //    Receiver pipeline that had tokenization + enrichment enabled.
  //
  // 2. **raw fluent-bit** — `log`, `stream`, `kubernetes.namespace_name`,
  //    `kubernetes.pod_name`, `kubernetes.container_name`. Present when the
  //    archive holds pre-enrichment events (e.g., a fluent-bit → S3 feed
  //    that bypassed log10x enrichment).
  //
  // Previously this function only handled shape 1, silently rendering
  // empty rows for shape 2. Caught during retriever end-to-end validation
  // on the demo env (2026-04-15). Now handles both shapes explicitly.
  const parts: string[] = [];
  const evRec = ev as unknown as Record<string, unknown>;
  const kube = (evRec.kubernetes ?? {}) as Record<string, unknown>;

  if (ev.timestamp) parts.push(`**${ev.timestamp}**`);
  const service = ev.tenx_user_service
    ?? (kube.labels && (kube.labels as Record<string, unknown>)['app.kubernetes.io/name'])
    ?? kube.container_name;
  if (service) parts.push(`service=${service}`);
  if (ev.severity_level) parts.push(`sev=${ev.severity_level}`);
  else if (evRec.stream) parts.push(`stream=${evRec.stream}`);
  const ns = ev.k8s_namespace ?? kube.namespace_name;
  if (ns) parts.push(`ns=${ns}`);
  const pod = ev.k8s_pod ?? kube.pod_name;
  if (pod) parts.push(`pod=${pod}`);
  if (ev.http_code) parts.push(`http=${ev.http_code}`);

  const meta = parts.join(' · ');
  const rawText = ev.text ?? evRec.log ?? evRec.message ?? '';
  const text = rawText ? String(rawText).replace(/\n/g, ' ').slice(0, 400) : '';
  return `- ${meta}\n  ${text}`;
}

function renderBar(ratio: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function retrieverNotConfiguredMessage(): string {
  return [
    '## Retriever not configured',
    '',
    "This MCP server doesn't currently have a Log10x Retriever endpoint configured. The Retriever reads the customer-owned S3 overflow bucket where the Receiver routes the offloaded cohort, so this tool can fetch the events held back from the SIEM for a pattern by Bloom-indexed variable values and template hashes.",
    '',
    "**What's out of reach without the Retriever**:",
    '',
    '- The offloaded cohort the Receiver routes to S3 for a pattern (the events held back from the SIEM)',
    '- Events the forwarder dropped or down-tiered upstream of the SIEM (10x metrics see them, the SIEM does not)',
    '- Verifying an offload decision by sampling what is being held back for a pattern',
    '- Sample-reversal verification when the SIEM returns sampled results at high volume',
    '',
    '**Options for the agent right now**:',
    '',
    "- (a) Deploy the Log10x Retriever — best long-term answer. Guide: https://doc.log10x.com/apps/cloud/retriever/",
    "- (b) Point the customer's own pipeline at the offload bucket and re-ingest the held-back cohort, slow, but preserves the current setup",
    "- (c) Rescope the question to what the SIEM still holds and use the SIEM MCP directly",
    '',
    '**To enable the Retriever later**:',
    '',
    '1. Deploy per the guide above',
    '2. Set `__SAVE_LOG10X_RETRIEVER_URL__` to the query handler endpoint (e.g., the NLB for the query-handler service)',
    '3. Set `__SAVE_LOG10X_RETRIEVER_BUCKET__` to the S3 bucket holding the retriever index',
    '4. Optionally set `__SAVE_LOG10X_RETRIEVER_TARGET__` to the default target app prefix (e.g., `app`)',
    '5. Re-run this tool',
  ].join('\n');
}

/**
 * Append execution diagnostics (Bloom scan counts, worker stats, classification
 * reason) to the output. Runs post-response using CloudWatch-sourced events.
 * Renders nothing when diagnostics were unavailable and the query succeeded —
 * noisy lines are only useful when something went wrong.
 */
function renderDiagnostics(
  diag: RetrieverQueryDiagnostics | undefined,
  eventsMatched: number,
  lines: string[],
): void {
  if (!diag) return;

  if (diag.pollingError) {
    lines.push(`**Diagnostics**: _unavailable — ${diag.pollingError}_`);
    return;
  }

  const parts: string[] = [];
  if (diag.scanStats) {
    parts.push(
      `scanned=${diag.scanStats.scanned} matched=${diag.scanStats.matched} ` +
        `skippedSearch=${diag.scanStats.skippedSearch} skippedTemplate=${diag.scanStats.skippedTemplate}`,
    );
  }
  if (diag.streamDispatch) {
    parts.push(
      `streamRequests=${diag.streamDispatch.requests} streamObjects=${diag.streamDispatch.objects} streamBlobs=${diag.streamDispatch.blobs}`,
    );
  }
  if (diag.workerStats) {
    parts.push(
      `workers=${diag.workerStats.complete}/${diag.workerStats.started} workerEvents=${diag.workerStats.totalResultEvents}`,
    );
  }
  if (diag.partialResults) parts.push('partialResults=true');

  if (parts.length > 0) {
    lines.push(`**Diagnostics**: ${parts.join(' · ')}`);
  }

  // On zero-result queries, add a classification sentence derived from the
  // diagnostics — this is the whole point: distinguish bloom-miss from
  // stale-indexer from field-not-indexed.
  if (eventsMatched === 0) {
    const reason = explainZeroResults(diag);
    if (reason) {
      lines.push(`**Why zero events**: ${reason}`);
    }
  }

  if (diag.errors && diag.errors.length > 0) {
    lines.push(`**Errors**: ${diag.errors.length} logged — first: ${diag.errors[0]}`);
  }
}
